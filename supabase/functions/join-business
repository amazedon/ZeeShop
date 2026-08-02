// supabase/functions/join-business/index.ts
//
// Called from a STAFF MEMBER's fresh device — no Supabase session exists
// yet, since they've never logged in anywhere before. This is why it's a
// public endpoint: the join CODE itself is the proof they're allowed in,
// not a pre-existing login.
//
// What it does:
//   1. Validates the code (exists, not expired, matches a real business)
//   2. Checks the business's staff limit for its current plan
//   3. Creates a real (but invisible-to-them) Supabase Auth account —
//      staff never see or type this email/password; the app uses it
//      silently in the background for syncing.
//   4. Creates their app_users row, linked to that new auth account
//   5. Returns the synthetic credentials + a snapshot of the business,
//      so the app can sign them in and bootstrap local data immediately.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Mirrors planLimits() in app.html — kept in sync manually since this
// runs in a different environment (Deno, not the browser).
const STAFF_LIMITS: Record<string, number> = { free: 1, pro: 5, boss: Infinity };

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { code, first_name, last_name, phone } = await req.json();
    if (!code || !first_name) return json({ error: "Missing code or first name" }, 400);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const admin = createClient(supabaseUrl, serviceKey);

    // ---- Validate the code ----
    const { data: codeRow } = await admin
      .from("join_codes")
      .select("*")
      .eq("code", String(code))
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!codeRow) return json({ error: "Incorrect code." }, 400);
    if (new Date(codeRow.expires_at) < new Date()) return json({ error: "This code has expired — ask the owner for a new one." }, 400);

    const businessId = codeRow.business_id;

    // ---- Check the staff limit for this business's current plan ----
    const { data: biz } = await admin
      .from("businesses")
      .select("name, country, currency, subscription_plan, subscription_expires_at")
      .eq("id", businessId)
      .single();
    if (!biz) return json({ error: "Business not found." }, 404);

    const planExpired = biz.subscription_expires_at && new Date(biz.subscription_expires_at) <= new Date();
    const effectivePlan = (!biz.subscription_plan || biz.subscription_plan === "free" || planExpired) ? "free" : biz.subscription_plan;
    const limit = STAFF_LIMITS[effectivePlan] ?? 1;

    const { count } = await admin
      .from("app_users")
      .select("id", { count: "exact", head: true })
      .eq("business_id", businessId);

    if ((count ?? 0) >= limit) {
      return json({ error: `This business's plan allows up to ${limit} staff. Ask the owner to upgrade.` }, 400);
    }

    // ---- Create the invisible Supabase Auth account for this staff member ----
    const syntheticEmail = `staff-${crypto.randomUUID().slice(0, 12)}@zed-internal.local`;
    const syntheticPassword = crypto.randomUUID() + crypto.randomUUID(); // long random, never seen by anyone

    const { data: authUser, error: authErr } = await admin.auth.admin.createUser({
      email: syntheticEmail,
      password: syntheticPassword,
      email_confirm: true, // skip email confirmation — it's not a real inbox
    });
    if (authErr || !authUser?.user) return json({ error: "Could not create account: " + (authErr?.message || "unknown error") }, 500);

    // ---- Create their app_users row ----
    const username = (first_name + (last_name || "")).toLowerCase().replace(/[^a-z0-9]/g, "") + Math.floor(Math.random() * 1000);
    const userId = crypto.randomUUID();

    const { error: userInsertErr } = await admin.from("app_users").insert({
      id: userId,
      business_id: businessId,
      auth_user_id: authUser.user.id,
      username,
      phone: phone || null,
      first_name,
      last_name: last_name || "",
      role: "staff",
      is_active: true,
      can_add_goods: false,
    });
    if (userInsertErr) return json({ error: "Account created but staff record failed: " + userInsertErr.message }, 500);

    // ---- Return everything the app needs to sign in and bootstrap locally ----
    const { data: shops } = await admin.from("shops").select("*").eq("business_id", businessId);

    return json({
      joined: true,
      auth_email: syntheticEmail,
      auth_password: syntheticPassword,
      user: { id: userId, businessId, username, firstName: first_name, lastName: last_name || "", phone: phone || "", role: "staff", isActive: true, canAddGoods: false },
      business: { id: businessId, name: biz.name, country: biz.country, currency: biz.currency, subscriptionPlan: biz.subscription_plan, subscriptionExpiresAt: biz.subscription_expires_at },
      shops: shops || [],
    }, 200);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "Unexpected error" }, 500);
  }
});

function json(body: Record<string, unknown>, status: number) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
