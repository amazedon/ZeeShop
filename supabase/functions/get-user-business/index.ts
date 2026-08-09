import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Every field the front end needs to build a working local user record
// (see loginOwnerToSupabase in app.html) — must include id/email/the
// password & pin hashes, or the device can't actually log this person in.
const USER_COLUMNS =
  "id, business_id, role, is_active, username, email, first_name, last_name, phone, can_add_goods, password_hash, pin_hash, pin_length";

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return json({ error: "Missing Authorization header" }, 401);
    }
    const supabaseClient = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_ANON_KEY") ?? "",
      { global: { headers: { Authorization: authHeader } } }
    );
    const { data: { user }, error: userError } = await supabaseClient.auth.getUser();
    if (userError || !user) {
      return json({ error: "Unauthorized user: " + (userError?.message || "No user found") }, 401);
    }
    const authUserId = user.id;

    const admin = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    let businessId: string | null = null;
    let userData: any = null;

    // 1. The normal path — this device's account is directly linked via auth_user_id.
    const { data: appUser } = await admin
      .from("app_users")
      .select(USER_COLUMNS)
      .eq("auth_user_id", authUserId)
      .maybeSingle();

    if (appUser) {
      businessId = appUser.business_id;
      userData = appUser;
    } else {
      // 2. Not linked directly — but they might still be the business owner
      // (e.g. an account created before auth_user_id was being saved).
      // Find the business, then look up the REAL app_users row for it —
      // never fabricate a partial user object; every field above is real
      // data or this whole login attempt should fail cleanly instead.
      const { data: bizOwner } = await admin
        .from("businesses")
        .select("id")
        .eq("owner_auth_user_id", authUserId)
        .maybeSingle();
      if (bizOwner) {
        businessId = bizOwner.id;
        const { data: ownerRow } = await admin
          .from("app_users")
          .select(USER_COLUMNS)
          .eq("business_id", businessId)
          .eq("role", "master")
          .maybeSingle();
        userData = ownerRow || null;
      }
    }

    if (!businessId) {
      return json({ error: "We couldn't find a business linked to this account." }, 404);
    }
    if (!userData) {
      return json({ error: "This business has no matching owner record. Contact support." }, 404);
    }

    // 3. Fetch the business details.
    const { data: business, error: bizErr } = await admin
      .from("businesses")
      .select("*")
      .eq("id", businessId)
      .single();
    if (bizErr || !business) {
      return json({ error: "Business record not found." }, 404);
    }

    // 4. Fetch the shops associated with this business.
    const { data: shops } = await admin
      .from("shops")
      .select("*")
      .eq("business_id", businessId);

    return json({
      success: true,
      user: userData,
      business: business,
      shops: shops || [],
    }, 200);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "Unexpected error" }, 500);
  }
});

function json(body: Record<string, unknown>, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
