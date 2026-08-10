// supabase/functions/join-business/index.ts
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Updated limits — free: 2 staff, 2 shops
const STAFF_LIMITS: Record<string, number> = { free: 2, pro: 5, boss: Infinity };
const SHOP_LIMITS: Record<string, number> = { free: 2, pro: 10, boss: Infinity };

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const { code, first_name, last_name, phone } = await req.json();
    if (!code ||!first_name) return json({ error: "Missing code or first name" }, 400);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const admin = createClient(supabaseUrl, serviceKey);

    // Validate code
    const { data: codeRow } = await admin.from("join_codes").select("*").eq("code", String(code)).order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (!codeRow) return json({ error: "Incorrect code." }, 400);
    if (codeRow.expires_at && new Date(codeRow.expires_at) < new Date()) return json({ error: "This code has expired — ask the owner for a new one." }, 400);

    const businessId = codeRow.business_id;

    // Check business + plan
    const { data: biz } = await admin.from("businesses").select("name, country, currency, subscription_plan, subscription_expires_at").eq("id", businessId).single();
    if (!biz) return json({ error: "Business not found." }, 404);

    const planExpired = biz.subscription_expires_at && new Date(biz.subscription_expires_at) <= new Date();
    const effectivePlan = (!biz.subscription_plan || biz.subscription_plan === "free" || planExpired)? "free" : biz.subscription_plan;
    const staffLimit = STAFF_LIMITS[effectivePlan]?? 2;
    const shopLimit = SHOP_LIMITS[effectivePlan]?? 2;

    // Staff limit check — only count staff
    const { count: staffCount } = await admin.from("app_users").select("id", { count: "exact", head: true }).eq("business_id", businessId).eq("role", "staff");
    if ((staffCount?? 0) >= staffLimit) {
      return json({ error: `This business's plan allows up to ${staffLimit} staff. Ask the owner to upgrade.` }, 400);
    }

    // Shop limit info (for boss dashboard enforcement, not blocking staff join)
    const { count: shopCount } = await admin.from("shops").select("id", { count: "exact", head: true }).eq("business_id", businessId);

    // Create auth account
    const syntheticEmail = `staff-${crypto.randomUUID().slice(0, 12)}@zed-internal.local`;
    const syntheticPassword = crypto.randomUUID() + crypto.randomUUID();

    const { data: authUser, error: authErr } = await admin.auth.admin.createUser({ email: syntheticEmail, password: syntheticPassword, email_confirm: true });
    if (authErr ||!authUser?.user) return json({ error: "Could not create account: " + (authErr?.message || "unknown") }, 500);

    const username = (first_name + (last_name || "")).toLowerCase().replace(/[^a-z0-9]/g, "") + Math.floor(Math.random() * 1000);

    // Create app_users row — FIXED
    const { error: userInsertErr } = await admin.from("app_users").insert({
      id: authUser.user.id,
      business_id: businessId,
      auth_user_id: authUser.user.id,
      username,
      phone: phone || null,
      first_name,
      last_name: last_name || "",
      email: syntheticEmail,
      role: "staff",
      is_active: true,
      can_add_goods: true,
    });
    if (userInsertErr) {
      await admin.auth.admin.deleteUser(authUser.user.id);
      return json({ error: "Staff record failed: " + userInsertErr.message }, 500);
    }

    // FIX — Create employment_records so boss Staff List works
    const { error: empErr } = await admin.from("employment_records").insert({
      business_id: businessId,
      user_id: authUser.user.id,
      employment_type: "full_time",
      resumption_date: new Date().toISOString().split('T')[0],
      salary_amount: 0,
    });
    if (empErr) console.log("employment_records insert warning:", empErr.message);

    // FIX — Auto-assign staff to ALL shops of business so goods/sales show up
    // This fixes your "goods/sales never showed up on boss's dashboard"
    const { data: allShops } = await admin.from("shops").select("id").eq("business_id", businessId);
    if (allShops && allShops.length > 0) {
      // Try shop_staff table if you have it
      for (const shop of allShops) {
        await admin.from("shop_members").insert({ shop_id: shop.id, user_id: authUser.user.id, business_id: businessId }).then(r => {
          if (r.error) console.log("shop_members not exists, trying shop_staff");
        });
        await admin.from("shop_staff").insert({ shop_id: shop.id, user_id: authUser.user.id, business_id: businessId }).then(r => {
          if (r.error) console.log("shop_staff insert skipped:", r.error.message);
        });
      }
    }

    const { data: shops } = await admin.from("shops").select("*").eq("business_id", businessId);

    return json({
      joined: true,
      auth_email: syntheticEmail,
      auth_password: syntheticPassword,
      user: { id: authUser.user.id, businessId, username, firstName: first_name, lastName: last_name || "", phone: phone || "", role: "staff", isActive: true, canAddGoods: true },
      business: { id: businessId, name: biz.name, country: biz.country, currency: biz.currency, subscriptionPlan: biz.subscription_plan, subscriptionExpiresAt: biz.subscription_expires_at, shopLimit, staffLimit, shopCount: shopCount?? 0, staffCount: (staffCount?? 0) + 1 },
      shops: shops || [],
    }, 200);
  } catch (e) {
    return json({ error: e instanceof Error? e.message : "Unexpected error" }, 500);
  }
});

function json(body: Record<string, unknown>, status: number) {
  return new Response(JSON.stringify(body), { status, headers: {...corsHeaders, "Content-Type": "application/json" } });
}
