// supabase/functions/regenerate-connect-code/index.ts
//
// Generates (or resets) a business's permanent 8-digit Connect Code, used
// by staff-device-login so an existing staff member can reconnect on a new
// device without creating a duplicate account. Only the signed-in owner of
// a business may call this for their own business — verified server-side
// via businesses.owner_auth_user_id, not trusted from the client.
//
// Regenerating immediately invalidates the old code. It does NOT sign
// anyone out or affect any device already connected — the code is only
// ever checked at the moment of a new reconnect attempt.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const admin = createClient(supabaseUrl, serviceKey);

    const authHeader = req.headers.get("Authorization") || "";
    const token = authHeader.replace(/^Bearer\s+/i, "");
    if (!token) return json({ error: "Not authenticated." }, 401);

    const { data: callerData, error: callerErr } = await admin.auth.getUser(token);
    if (callerErr || !callerData?.user) return json({ error: "Not authenticated." }, 401);

    const { business_id } = await req.json();
    if (!business_id) return json({ error: "Missing business_id." }, 400);

    const { data: biz } = await admin.from("businesses").select("id, owner_auth_user_id").eq("id", business_id).maybeSingle();
    if (!biz) return json({ error: "Business not found." }, 404);
    if (biz.owner_auth_user_id !== callerData.user.id) {
      return json({ error: "Only the business owner can reset the connect code." }, 403);
    }

    // Each press creates a NEW single-use code (valid 10 minutes). Old expired ones are cleaned up here.
    await admin.from("staff_connect_codes").delete().lt("expires_at", new Date().toISOString());

    let code = "";
    for (let attempt = 0; attempt < 8; attempt++) {
      const c = String(Math.floor(10_000_000 + Math.random() * 90_000_000));
      const { data: clash } = await admin.from("staff_connect_codes").select("code").eq("code", c).maybeSingle();
      if (!clash) { code = c; break; }
    }
    if (!code) return json({ error: "Could not generate a unique code — please try again." }, 500);

    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const { error: insErr } = await admin.from("staff_connect_codes").insert({ code, business_id, expires_at: expiresAt });
    if (insErr) return json({ error: insErr.message }, 500);

    // The old permanent business-wide code is retired so it can never be reused.
    await admin.from("businesses").update({ connect_code: null }).eq("id", business_id);

    return json({ connect_code: code, expires_at: expiresAt }, 200);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "Unexpected error" }, 500);
  }
});

function json(body: Record<string, unknown>, status: number) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
