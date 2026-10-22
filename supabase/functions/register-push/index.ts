// supabase/functions/register-push/index.ts
//
// One door for everything push/notification-preference related, for EVERY kind of account (owner, staff, PIN users,
// viewers). It runs with the service role key, so RLS can never silently block a staff device — and it does its OWN
// authorization (same pattern as sync-relay): the caller must hold a valid Supabase Auth session, and any
// `app_user_id` they send (a PIN user picked on a shared device) must belong to the SAME business as that session.
//
// Actions (POST JSON { action, ... }):
//   config        -> { vapid_public_key }                          (lets the app detect a rotated key and re-subscribe)
//   get_state     -> { push_enabled, inapp_alerts_enabled, last_messages_read_at, vapid_public_key, can_edit_business }
//   subscribe     -> { subscription:{endpoint,keys:{p256dh,auth}}, app_user_id?, vapid_key? }
//   unsubscribe   -> { endpoint?, app_user_id? }                   (explicit OFF — remembered server-side)
//   set_prefs     -> { app_user_id?, inapp_alerts_enabled?: boolean }
//   mark_read     -> { app_user_id? }                              (clears the unread dot on every device)
//   inbox         -> { messages: [...] }                           (announcements for this business, even with no push)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
function getVapidPublicKey(): string {
  return (Deno.env.get("VAPID_PUBLIC_KEY") || "").trim();
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);

  try {
    const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    if (!token) return json({ error: "Not authenticated." }, 401);

    const url = Deno.env.get("SUPABASE_URL");
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !key) return json({ error: "Server is missing Supabase secrets." }, 500);
    const admin = createClient(url, key);

    const { data: who, error: whoErr } = await admin.auth.getUser(token);
    if (whoErr || !who?.user) return json({ error: "Not authenticated." }, 401);

    const COLS = "id, business_id, role, auth_user_id, is_active, push_enabled, inapp_alerts_override, last_messages_read_at";
    let { data: sessionRow } = await admin.from("app_users").select(COLS).eq("auth_user_id", who.user.id).maybeSingle();
    if (!sessionRow && who.user.email) {
      const { data: byEmail } = await admin.from("app_users").select(COLS).eq("email", who.user.email).maybeSingle();
      if (byEmail) {
        sessionRow = byEmail;
        await admin.from("app_users").update({ auth_user_id: who.user.id }).eq("id", byEmail.id);
      }
    }
    if (!sessionRow) return json({ error: "No ZeeShop account is linked to this login." }, 403);
    if (sessionRow.is_active === false) return json({ error: "This account has been deactivated." }, 403);

    const input = await req.json().catch(() => ({}));
    const action = String(input.action || "");
    const businessId = sessionRow.business_id;

    // Which person is this for? Default: the session's own user. A PIN user on a shared device may be named, but only
    // if they belong to the same business as the signed-in session.
    let target = sessionRow;
    if (input.app_user_id && String(input.app_user_id) !== String(sessionRow.id)) {
      const { data: other } = await admin.from("app_users").select(COLS).eq("id", String(input.app_user_id)).maybeSingle();
      if (!other || String(other.business_id) !== String(businessId)) return json({ error: "That user is not in your business." }, 403);
      if (other.is_active === false) return json({ error: "That account has been deactivated." }, 403);
      target = other;
    }

    switch (action) {
      case "config":
        return json({ vapid_public_key: getVapidPublicKey() }, 200);

      case "get_state": {
        const { data: biz } = await admin.from("businesses").select("inapp_alerts_enabled").eq("id", businessId).maybeSingle();
        const bizOn = biz?.inapp_alerts_enabled !== false;
        const effective = target.inapp_alerts_override === null || target.inapp_alerts_override === undefined
          ? bizOn : !!target.inapp_alerts_override;
        return json({
          push_enabled: target.push_enabled !== false,
          inapp_alerts_enabled: effective,
          last_messages_read_at: target.last_messages_read_at || null,
          vapid_public_key: getVapidPublicKey(),
          can_edit_business: target.role === "master",
        }, 200);
      }

      case "subscribe": {
        const sub = input.subscription || {};
        const endpoint = String(sub.endpoint || "");
        const p256dh = String(sub.keys?.p256dh || "");
        const authKey = String(sub.keys?.auth || "");
        if (!endpoint.startsWith("https://") || !p256dh || !authKey) return json({ error: "Invalid push subscription." }, 400);
        const { error } = await admin.from("push_subscriptions").upsert({
          business_id: businessId, user_id: target.id, endpoint, p256dh, auth_key: authKey,
          is_active: true, vapid_key: input.vapid_key ? String(input.vapid_key).slice(0, 200) : null,
          updated_at: new Date().toISOString(),
        }, { onConflict: "endpoint" });
        if (error) return json({ error: error.message }, 500);
        await admin.from("app_users").update({ push_enabled: true }).eq("id", target.id);
        return json({ ok: true }, 200);
      }

      case "unsubscribe": {
        // Explicit OFF: remember it on the profile (so auto-enable never overrides it) and drop this device's endpoint.
        await admin.from("app_users").update({ push_enabled: false }).eq("id", target.id);
        const endpoint = input.endpoint ? String(input.endpoint) : null;
        if (endpoint) await admin.from("push_subscriptions").delete().eq("endpoint", endpoint).eq("business_id", businessId);
        else await admin.from("push_subscriptions").delete().eq("user_id", target.id);
        return json({ ok: true }, 200);
      }

      case "set_prefs": {
        if (typeof input.inapp_alerts_enabled === "boolean") {
          if (target.role === "master") {
            const { error } = await admin.from("businesses").update({ inapp_alerts_enabled: input.inapp_alerts_enabled }).eq("id", businessId);
            if (error) return json({ error: error.message }, 500);
            await admin.from("app_users").update({ inapp_alerts_override: null }).eq("id", target.id);
          } else {
            // Staff / viewers only change their OWN view of the alerts; the business-wide switch stays the owner's.
            const { error } = await admin.from("app_users").update({ inapp_alerts_override: input.inapp_alerts_enabled }).eq("id", target.id);
            if (error) return json({ error: error.message }, 500);
          }
        }
        return json({ ok: true }, 200);
      }

      case "mark_read": {
        const now = new Date().toISOString();
        await admin.from("app_users").update({ last_messages_read_at: now }).eq("id", target.id);
        return json({ ok: true, last_messages_read_at: now }, 200);
      }

      case "inbox": {
        const { data, error } = await admin
          .from("announcements").select("id, title, body, created_at, target_business_id")
          .or(`target_business_id.is.null,target_business_id.eq.${businessId}`)
          .order("created_at", { ascending: false }).limit(30);
        if (error) return json({ error: error.message }, 500);
        return json({ messages: data || [] }, 200);
      }

      default:
        return json({ error: "Unknown action." }, 400);
    }
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "Unexpected error" }, 500);
  }
});

function json(body: Record<string, unknown>, status: number) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
