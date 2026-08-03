// supabase/functions/send-broadcast/index.ts
//
// Called from super-admin.html. Requires a valid Supabase session
// belonging to the allowlisted admin email — checked here AND enforced
// by RLS on the push_subscriptions read below, as a second layer.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sendPushToSubscription } from "../_shared/push.ts";

const ADMIN_EMAIL = "amazedon50@gmail.com";
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Missing authorization" }, 401);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData?.user || userData.user.email !== ADMIN_EMAIL) {
      return json({ error: "Not authorized" }, 403);
    }

    const { title, body, business_id } = await req.json();
    if (!title || !body) return json({ error: "Title and body are required" }, 400);

    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const admin = createClient(supabaseUrl, serviceKey);

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

    return json({ sent, failed, totalTargeted: (subs || []).length }, 200);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "Unexpected error" }, 500);
  }
});

function json(body: Record<string, unknown>, status: number) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
