import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

// ---- push helper (inlined so this works in the dashboard editor) ----
// supabase/functions/_shared/push.ts
//
// Shared helper — sends a Web Push notification to one subscription using VAPID.
// Used by daily-alerts and send-broadcast.
//
// FIX: the old version used Deno.env.get("VAPID_PUBLIC_KEY")! — the "!" only silences TypeScript, so a missing or
// misnamed secret reached web-push as `undefined` and threw "No key set vapidDetails.publicKey". Now the secrets are
// checked explicitly, and callers get a clean { ok:false, error } they can return as JSON.
//
// Secrets (set once):
//   supabase secrets set VAPID_PUBLIC_KEY=... VAPID_PRIVATE_KEY=... VAPID_SUBJECT=mailto:help@ememart.com


export type VapidCheck = { ok: true; publicKey: string } | { ok: false; error: string; missing: string[] };

export function checkVapid(): VapidCheck {
  const publicKey = (Deno.env.get("VAPID_PUBLIC_KEY") || "").trim();
  const privateKey = (Deno.env.get("VAPID_PRIVATE_KEY") || "").trim();
  const subject = (Deno.env.get("VAPID_SUBJECT") || "mailto:help@ememart.com").trim();
  const missing: string[] = [];
  if (!publicKey) missing.push("VAPID_PUBLIC_KEY");
  if (!privateKey) missing.push("VAPID_PRIVATE_KEY");
  if (!/^(mailto:|https:\/\/)/i.test(subject)) missing.push("VAPID_SUBJECT (must start with mailto: or https://)");
  if (missing.length) {
    return {
      ok: false,
      missing,
      error: `Push is not configured on the server. Missing/invalid secret(s): ${missing.join(", ")}. ` +
        `Run: supabase secrets set VAPID_PUBLIC_KEY=... VAPID_PRIVATE_KEY=... VAPID_SUBJECT=mailto:help@ememart.com`,
    };
  }
  return { ok: true, publicKey };
}

export function getVapidPublicKey(): string {
  return (Deno.env.get("VAPID_PUBLIC_KEY") || "").trim();
}

let configured = false;
function ensureConfigured(): string | null {
  if (configured) return null;
  const check = checkVapid();
  if (!check.ok) return check.error;
  try {
    webpush.setVapidDetails(
      (Deno.env.get("VAPID_SUBJECT") || "mailto:help@ememart.com").trim(),
      (Deno.env.get("VAPID_PUBLIC_KEY") || "").trim(),
      (Deno.env.get("VAPID_PRIVATE_KEY") || "").trim(),
    );
  } catch (e) {
    return "VAPID keys are invalid (regenerate with: npx web-push generate-vapid-keys): " + ((e as Error).message || e);
  }
  configured = true;
  return null;
}

export async function sendPushToSubscription(
  sub: { endpoint: string; p256dh: string; auth_key: string },
  payload: { title: string; body: string; url?: string; tag?: string },
): Promise<{ success: boolean; shouldDeactivate: boolean; error?: string }> {
  const cfgError = ensureConfigured();
  if (cfgError) return { success: false, shouldDeactivate: false, error: cfgError };
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth_key } },
      JSON.stringify(payload),
      { TTL: 60 * 60 * 24, urgency: "high" },
    );
    return { success: true, shouldDeactivate: false };
  } catch (e) {
    const err = e as { statusCode?: number; message?: string };
    // 404/410 = the subscription is gone for good (browser data cleared, app uninstalled, permission revoked).
    const shouldDeactivate = err.statusCode === 404 || err.statusCode === 410;
    return { success: false, shouldDeactivate, error: err.message || "Unknown push error" };
  }
}

// ---- function ----
// supabase/functions/send-broadcast/index.ts
//
// Called from super-admin.html. Requires a valid Supabase session belonging to a listed super admin
// (same super_admins table as super-admin/index.ts). The push_subscriptions read uses the SERVICE ROLE key, so this
// check is the only gate on a platform-wide message.
//
// Flow: validate -> check VAPID -> save the in-app message FIRST (so people see it even with push off) ->
// send push to active subscriptions (all, or one business) -> purge dead endpoints (404/410) -> audit log.


const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);

  try {
    const authHeader = req.headers.get("Authorization") || "";
    const token = authHeader.replace(/^Bearer\s+/i, "");
    if (!token) return json({ error: "Not authenticated." }, 401);

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceKey) return json({ error: "Server is missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY." }, 500);
    const admin = createClient(supabaseUrl, serviceKey);

    const { data: callerData, error: callerErr } = await admin.auth.getUser(token);
    if (callerErr || !callerData?.user) return json({ error: "Not authenticated." }, 401);

    const { data: adminRow } = await admin
      .from("super_admins").select("auth_user_id").eq("auth_user_id", callerData.user.id).maybeSingle();
    if (!adminRow) return json({ error: "This account is not authorized for super admin access." }, 403);

    // Accept both the old field names (title, body, business_id) and the new ones (title, message, target_business_id).
    const input = await req.json().catch(() => ({}));
    const title = String(input.title ?? "").trim();
    const body = String(input.body ?? input.message ?? "").trim();
    const businessIdRaw = input.business_id ?? input.target_business_id ?? null;
    const businessId = businessIdRaw ? String(businessIdRaw).trim() : null;

    if (!title || !body) return json({ error: "Title and message are required." }, 400);
    if (title.length > 100 || body.length > 500) return json({ error: "Title (max 100) or message (max 500) is too long." }, 400);

    // Save the in-app message first. This must work even if push is not configured yet.
    let announcementSaved = false;
    const { error: annErr } = await admin.from("announcements").insert({
      title, body, target_business_id: businessId,
    });
    if (annErr) console.log("announcement not saved (run banners-setup.sql):", annErr.message);
    else announcementSaved = true;

    // Strict VAPID check — clean JSON error instead of a stack trace. The in-app message is already saved.
    const vapid = checkVapid();
    if (!vapid.ok) {
      return json({
        error: vapid.error, missingSecrets: vapid.missing, announcementSaved,
        sent: 0, failed: 0, totalTargeted: 0,
      }, 500);
    }

    // Everyone who is subscribed AND has not switched push off. (register-push removes the subscription when a
    // person switches it off, and marks it inactive when it expires, so is_active is the single source of truth.)
    let query = admin.from("push_subscriptions").select("id, endpoint, p256dh, auth_key, business_id, user_id").eq("is_active", true);
    if (businessId) query = query.eq("business_id", businessId);
    const { data: subs, error: subsErr } = await query;
    if (subsErr) return json({ error: subsErr.message, announcementSaved }, 500);

    const list = subs || [];
    let sent = 0, failed = 0, purged = 0;
    const deadIds: string[] = [];
    const errors: Record<string, number> = {};

    // Send in small parallel batches so a large audience does not hit the function time limit.
    const BATCH = 25;
    for (let i = 0; i < list.length; i += BATCH) {
      const chunk = list.slice(i, i + BATCH);
      const results = await Promise.all(chunk.map((s: any) =>
        sendPushToSubscription(s, { title, body, url: "/app.html#messages", tag: "zeeshop-broadcast" })
      ));
      results.forEach((r, idx) => {
        if (r.success) sent++;
        else {
          failed++;
          if (r.error) errors[r.error.slice(0, 120)] = (errors[r.error.slice(0, 120)] || 0) + 1;
          if (r.shouldDeactivate) deadIds.push((chunk[idx] as any).id);
        }
      });
    }

    // Purge expired / unsubscribed endpoints (HTTP 404 / 410) so they are never tried again.
    if (deadIds.length) {
      const { error: delErr } = await admin.from("push_subscriptions").delete().in("id", deadIds);
      if (delErr) await admin.from("push_subscriptions").update({ is_active: false }).in("id", deadIds);
      purged = deadIds.length;
    }

    await admin.from("audit_log_platform").insert({
      actor_auth_user_id: callerData.user.id,
      action: "send_broadcast",
      target_business_id: businessId,
      detail: `"${title}" — sent to ${sent}${businessId ? "" : " (all businesses)"}, ${failed} failed, ${purged} expired removed`,
    }).then((r: any) => { if (r.error) console.log("audit_log_platform insert skipped:", r.error.message); });

    return json({ sent, failed, purged, totalTargeted: list.length, announcementSaved, errors }, 200);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "Unexpected error" }, 500);
  }
});

function json(body: Record<string, unknown>, status: number) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
