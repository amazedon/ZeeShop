// supabase/functions/super-admin/index.ts
//
// Every privileged super-admin action goes through here — never through a
// direct client-side `sb.from(...).update()` call. Two reasons:
//   1. Reliability: whether a client-side write succeeds depends entirely on
//      RLS policies on `businesses` being configured exactly right for this
//      one signed-in user. If they aren't, the "Set" button in the panel
//      silently does nothing.
//   2. Security: super-admin.html signs in through the SAME Supabase Auth
//      pool as every ordinary business owner and staff account. Without a
//      server-side check, ANY person with ANY valid Zed login (their own
//      shop's owner account is enough) could open this page, sign in with
//      their own credentials, and see or edit every business on the
//      platform. This function is what actually enforces "only real super
//      admins may do this" — the page itself cannot enforce it alone.
//
// Setup required once, in your Supabase project:
//   create table super_admins (
//     auth_user_id uuid primary key references auth.users(id),
//     created_at timestamptz default now()
//   );
// Then insert the row(s) for whichever Supabase Auth account(s) should be
// allowed to use this panel, e.g.:
//   insert into super_admins (auth_user_id) values ('<your-auth-user-id>');
//
// If you want to be able to suspend a business, also run:
//   alter table businesses add column if not exists is_active boolean default true;
// The panel works fine without it — the suspend/reactivate button just
// won't appear until the column exists.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const VALID_PLANS = ["free", "pro", "boss"];

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const admin = createClient(supabaseUrl, serviceKey);

    // Verify the caller is signed in AND is a listed super admin — every
    // action below runs only after this passes.
    const authHeader = req.headers.get("Authorization") || "";
    const token = authHeader.replace(/^Bearer\s+/i, "");
    if (!token) return json({ error: "Not authenticated." }, 401);

    const { data: callerData, error: callerErr } = await admin.auth.getUser(token);
    if (callerErr || !callerData?.user) return json({ error: "Not authenticated." }, 401);

    const { data: adminRow } = await admin
      .from("super_admins")
      .select("auth_user_id")
      .eq("auth_user_id", callerData.user.id)
      .maybeSingle();
    if (!adminRow) return json({ error: "This account is not authorized for super admin access." }, 403);

    const { action, ...params } = await req.json();

    if (action === "list_businesses") {
      const { data: businesses, error: bizErr } = await admin
        .from("businesses")
        .select("*")
        .order("created_at", { ascending: false });
      if (bizErr) return json({ error: bizErr.message }, 500);

      const { data: staff } = await admin.from("app_users").select("business_id, role");
      const staffCounts: Record<string, number> = {};
      (staff || []).forEach((u: { business_id: string; role: string }) => {
        if (u.role === "staff") staffCounts[u.business_id] = (staffCounts[u.business_id] || 0) + 1;
      });

      return json({ businesses: businesses || [], staffCounts }, 200);
    }

    if (action === "business_detail") {
      const businessId = params.business_id;
      if (!businessId) return json({ error: "Missing business_id" }, 400);
      const [{ data: staff }, { data: shops }] = await Promise.all([
        admin.from("app_users").select("id, first_name, last_name, role, is_active, email, phone, created_at").eq("business_id", businessId),
        admin.from("shops").select("id, name").eq("business_id", businessId),
      ]);
      return json({ staff: staff || [], shops: shops || [] }, 200);
    }

    if (action === "grant_plan") {
      const { business_id, plan, expires_at } = params;
      if (!business_id || !VALID_PLANS.includes(plan)) {
        return json({ error: "Missing or invalid business_id/plan." }, 400);
      }
      const { error: updErr } = await admin
        .from("businesses")
        .update({ subscription_plan: plan, subscription_expires_at: expires_at || null })
        .eq("id", business_id);
      if (updErr) return json({ error: updErr.message }, 500);

      await admin.from("audit_log_platform").insert({
        actor_auth_user_id: callerData.user.id,
        action: "grant_plan",
        target_business_id: business_id,
        detail: `Set plan to ${plan}${expires_at ? ` (expires ${expires_at})` : " (no expiry)"}`,
      }).then((r) => { if (r.error) console.log("audit_log_platform insert skipped:", r.error.message); });

      return json({ ok: true }, 200);
    }

    if (action === "set_business_active") {
      const { business_id, is_active } = params;
      if (!business_id || typeof is_active !== "boolean") {
        return json({ error: "Missing or invalid business_id/is_active." }, 400);
      }
      const { error: updErr } = await admin.from("businesses").update({ is_active }).eq("id", business_id);
      if (updErr) {
        // Most likely cause: the is_active column hasn't been added yet (see file header).
        return json({ error: "Could not update — has the `is_active` column been added to `businesses`? " + updErr.message }, 500);
      }
      await admin.from("audit_log_platform").insert({
        actor_auth_user_id: callerData.user.id,
        action: is_active ? "reactivate_business" : "suspend_business",
        target_business_id: business_id,
        detail: null,
      }).then((r) => { if (r.error) console.log("audit_log_platform insert skipped:", r.error.message); });
      return json({ ok: true }, 200);
    }

    return json({ error: "Unknown action." }, 400);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "Unexpected error" }, 500);
  }
});

function json(body: Record<string, unknown>, status: number) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
