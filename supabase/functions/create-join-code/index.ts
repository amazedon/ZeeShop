// supabase/functions/create-join-code/index.ts
//
// Called by the OWNER (needs a real Supabase session — this requires
// internet, same as any other owner action that touches the server).
// Creates a server-side join code so a staff member's completely fresh
// device can validate it later via join-business, with zero local data.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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
    if (userErr || !userData?.user) return json({ error: "Invalid session" }, 401);

    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const admin = createClient(supabaseUrl, serviceKey);

    const { data: bizRows, error: bizErr } = await admin
      .from("businesses")
      .select("id")
      .eq("owner_auth_user_id", userData.user.id)
      .limit(1);
    if (bizErr || !bizRows?.length) return json({ error: "No business found for this account" }, 404);

    const businessId = bizRows[0].id;
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 minutes, same as the local version

    const { error: insertErr } = await admin
      .from("join_codes")
      .insert({ business_id: businessId, code, expires_at: expiresAt });
    if (insertErr) return json({ error: insertErr.message }, 500);

    return json({ code, expires_at: expiresAt }, 200);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "Unexpected error" }, 500);
  }
});

function json(body: Record<string, unknown>, status: number) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
