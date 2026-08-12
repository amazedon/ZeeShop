// supabase/functions/send-broadcast/index.ts
//
// Called from super-admin.html. Requires a valid Supabase session belonging
// to a listed super admin — checked here against the SAME super_admins
// table every other admin action uses (see super-admin/index.ts), not a
// hardcoded email. That matters for two reasons:
//   1. Previously this hardcoded a single ADMIN_EMAIL string, completely
//      separate from super_admins — adding a second admin, or changing the
//      existing admin's login email, would silently do nothing here even
//      though it'd work everywhere else in the panel.
//   2. The push_subscriptions read below uses the SERVICE ROLE key, which
//      bypasses RLS entirely — so despite an earlier comment claiming RLS
//      as "a second layer," there was really only ever one layer of
//      protection on an action that can message every business on the
//      platform at once. This check is genuinely the only gate.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sendPushToSubscription } from "../_shared/push.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization") || "";
    const token = authHeader.replace(/^Bearer\s+/i, "");
    if (!token) return json({ error: "Not authenticated." }, 401);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const admin = createClient(supabaseUrl, serviceKey);

    const { data: callerData, error: callerErr } = await admin.auth.getUser(token);
    if (callerErr || !callerData?.user) return json({ error: "Not authenticated." }, 401);

    const { data: adminRow } = await admin
      .from("super_admins")
      .select("auth_user_id")
      .eq("auth_user_id", callerData.user.id)
      .maybeSingle();
    if (!adminRow) return json({ error: "This account is not authorized for super admin access." }, 403);

    const { title, body, business_id } = await req.json();
    if (!title || !body) return json({ error: "Title and body are required" }, 400);
    if (title.length > 100 || body.length > 500) return json({ error: "Title or message is too long." }, 400);

    let query = admin.from("push_subscriptions").select("*").eq("is_active", true);
    if (business_id) query = query.eq("business_id", business_id); // specific business, or omit for "all"

    const { data: subs, error: subsErr } = await query;
    if (subsErr) return json({ error: subsErr.message }, 500);

    let sent = 0, failed = 0;
    for (const sub of subs || []) {
      const result = await sendPushToSubscription(sub as any, { title, body, url: "/app.html" });
      if (result.success) sent++;
      else {
        failed++;
        if (result.shouldDeactivate) await admin.from("push_subscriptions").update({ is_active: false }).eq("id", (sub as any).id);
      }
    }

    // Same audit trail as every other privileged action in the admin panel
    // (grant_plan, suspend/reactivate) — a platform-wide notification
    // capability should leave a record of who used it and when.
    await admin.from("audit_log_platform").insert({
      actor_auth_user_id: callerData.user.id,
      action: "send_broadcast",
      target_business_id: business_id || null,
      detail: `"${title}" — sent to ${sent}${business_id ? '' : ' (all businesses)'}, ${failed} failed`,
    }).then((r) => { if (r.error) console.log("audit_log_platform insert skipped:", r.error.message); });

    return json({ sent, failed, totalTargeted: (subs || []).length }, 200);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "Unexpected error" }, 500);
  }
});

function json(body: Record<string, unknown>, status: number) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
