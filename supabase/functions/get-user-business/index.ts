import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

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

    // 1. Check if the user is a staff member in app_users
    const { data: appUser } = await admin
      .from("app_users")
      .select("business_id, role, is_active, username, first_name, last_name, phone, can_add_goods")
      .eq("auth_user_id", authUserId)
      .maybeSingle();

    if (appUser) {
      businessId = appUser.business_id;
      userData = appUser;
    } else {
      // 2. If not found in app_users, check if they are the business owner in businesses
      // (Adjust column name if your owner column is named differently, e.g., owner_auth_user_id or user_id)
      const { data: bizOwner } = await admin
        .from("businesses")
        .select("*")
        .eq("owner_auth_user_id", authUserId) // Change to match your actual owner column if different
        .maybeSingle();

      if (bizOwner) {
        businessId = bizOwner.id;
        userData = {
          role: "owner",
          is_active: true,
          can_add_goods: true,
          username: bizOwner.name,
        };
      }
    }

    if (!businessId) {
      return json({ error: "We couldn't find a business linked to this account." }, 404);
    }

    // 3. Fetch the business details
    const { data: business, error: bizErr } = await admin
      .from("businesses")
      .select("*")
      .eq("id", businessId)
      .single();

    if (bizErr || !business) {
      return json({ error: "Business record not found." }, 404);
    }

    // 4. Fetch the shops associated with this business
    const { data: shops } = await admin
      .from("shops")
      .select("*")
      .eq("business_id", businessId);

    return json({
      success: true,
      user: userData,
      business: business,
      shops: shops || []
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
