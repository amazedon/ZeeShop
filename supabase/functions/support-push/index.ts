// supabase/functions/support-push/index.ts
// Phone alerts for the support chat. Deploy normally (JWT verification ON): the app and Super Admin both send a signed-in session.
//   admin_reply     (super admin)       -> pushes "ZeeShop Support: <preview>" to that business's devices
//   user_message    (any business user) -> pushes "<business>: <preview>" to the support devices registered below
//   admin_config    (super admin)       -> { vapid_public_key }
//   admin_subscribe (super admin)       -> remembers this phone/browser for new-chat alerts
// Uses the same VAPID secrets as send-broadcast.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (b: Record<string, unknown>, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

function vapidReady(): string | null {
  const pub = (Deno.env.get("VAPID_PUBLIC_KEY") || "").trim(), priv = (Deno.env.get("VAPID_PRIVATE_KEY") || "").trim();
  const subj = (Deno.env.get("VAPID_SUBJECT") || "mailto:help@ememart.com").trim();
  if (!pub || !priv || !/^(mailto:|https:\/\/)/i.test(subj)) return "Push is not configured on the server.";
  try { webpush.setVapidDetails(subj, pub, priv); } catch (e) { return "VAPID keys are invalid: " + ((e as Error).message || e); }
  return null;
}
async function pushTo(subs: { endpoint: string; p256dh: string; auth_key: string }[], payload: Record<string, string>) {
  let sent = 0; const dead: string[] = [];
  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth_key } }, JSON.stringify(payload), { TTL: 86400, urgency: "high" });
      sent++;
    } catch (e) {
      const c = (e as { statusCode?: number }).statusCode; if (c === 404 || c === 410) dead.push(s.endpoint);
    }
  }));
  return { sent, dead };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);
  try {
    const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    if (!token) return json({ error: "Not authenticated." }, 401);
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: who } = await admin.auth.getUser(token);
    if (!who?.user) return json({ error: "Not authenticated." }, 401);
    const input = await req.json().catch(() => ({}));
    const action = String(input.action || "");
    const { data: sa } = await admin.from("super_admins").select("auth_user_id").eq("auth_user_id", who.user.id).maybeSingle();
    const isSuper = !!sa;

    if (action === "admin_config") {
      if (!isSuper) return json({ error: "Not allowed." }, 403);
      return json({ vapid_public_key: (Deno.env.get("VAPID_PUBLIC_KEY") || "").trim() });
    }
    if (action === "admin_subscribe") {
      if (!isSuper) return json({ error: "Not allowed." }, 403);
      const s = input.subscription || {};
      const endpoint = String(s.endpoint || ""), p256dh = String(s.keys?.p256dh || ""), authKey = String(s.keys?.auth || "");
      if (!endpoint.startsWith("https://") || !p256dh || !authKey) return json({ error: "Invalid subscription." }, 400);
      const { error } = await admin.from("support_admin_push").upsert({ endpoint, p256dh, auth_key: authKey, auth_user_id: who.user.id });
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    // AUTOMATIC REPLY: when nobody has answered yet, tell the customer they are in the queue (once per 30 minutes per business).
    // Runs before the push check so it works even if phone alerts are not set up.
    if (action === "user_message") {
      try {
        const { data: me0 } = await admin.from("app_users").select("business_id").eq("auth_user_id", who.user.id).maybeSingle();
        if (me0) {
          const since = new Date(Date.now() - 30 * 60000).toISOString();
          const { data: lastU } = await admin.from("support_messages").select("convo_id").eq("business_id", me0.business_id).eq("sender_role", "user").order("created_at", { ascending: false }).limit(1).maybeSingle();
          const convoId = lastU?.convo_id || null;
          let rq = admin.from("support_messages").select("id").eq("business_id", me0.business_id).in("sender_role", ["admin", "auto"]).gt("created_at", since);
          rq = convoId ? rq.eq("convo_id", convoId) : rq.is("convo_id", null);
          const { data: recent } = await rq.limit(1);
          if (!recent || !recent.length) {
            const { data: pres } = await admin.from("support_presence").select("last_seen").eq("id", 1).maybeSingle();
            const online = !!pres && Date.now() - new Date(pres.last_seen).getTime() < 3 * 60000;
            const body = online
              ? "Thanks for your message 🙏 Hold on a moment, someone from support will be with you shortly."
              : "Thanks for your message 🙏 You're in the queue. We've been notified and will reply here as soon as we can. You'll get a notification on your phone when we do.";
            await admin.from("support_messages").insert({ business_id: me0.business_id, sender_role: "auto", sender_name: "ZeeShop Support (auto)", body, convo_id: convoId });
          }
        }
      } catch (e) { console.error("auto reply failed", e); }
    }

    const cfg = vapidReady(); if (cfg) return json({ error: cfg, sent: 0 }, 200);   // chat still works; only the phone alert is skipped

    if (action === "admin_reply") {
      if (!isSuper) return json({ error: "Not allowed." }, 403);
      const businessId = String(input.business_id || ""); if (!businessId) return json({ error: "Missing business." }, 400);
      const preview = String(input.preview || "You have a new reply").slice(0, 110);
      const { data: subs } = await admin.from("push_subscriptions").select("endpoint, p256dh, auth_key").eq("is_active", true).eq("business_id", businessId);
      const r = await pushTo(subs || [], { title: "ZeeShop Support", body: preview, url: "/app.html#support", tag: "zeeshop-support" });
      if (r.dead.length) await admin.from("push_subscriptions").delete().in("endpoint", r.dead);
      return json({ sent: r.sent });
    }

    if (action === "user_message") {
      // who is writing? must be a real member of a business
      const { data: me } = await admin.from("app_users").select("business_id").eq("auth_user_id", who.user.id).maybeSingle();
      if (!me) return json({ error: "No account linked." }, 403);
      const businessId = me.business_id;
      const { data: lastTwo } = await admin.from("support_messages").select("body, photo, created_at").eq("business_id", businessId).eq("sender_role", "user").order("created_at", { ascending: false }).limit(2);
      if (!lastTwo || !lastTwo.length) return json({ sent: 0 });
      // at most one alert every 2 minutes per business, so a burst of messages is one buzz
      if (lastTwo[1] && Date.now() - new Date(lastTwo[1].created_at).getTime() < 120000) return json({ sent: 0, skipped: true });
      const { data: biz } = await admin.from("businesses").select("name").eq("id", businessId).maybeSingle();
      const preview = (lastTwo[0].body || "Sent a picture").slice(0, 100);
      const { data: subs } = await admin.from("support_admin_push").select("endpoint, p256dh, auth_key");
      const r = await pushTo(subs || [], { title: "New support message", body: `${biz?.name || "A shop"}: ${preview}`, url: "/super-admin.html", tag: "zeeshop-support-admin" });
      if (r.dead.length) await admin.from("support_admin_push").delete().in("endpoint", r.dead);
      return json({ sent: r.sent });
    }
    return json({ error: "Unknown action." }, 400);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "Unexpected error" }, 500);
  }
});
