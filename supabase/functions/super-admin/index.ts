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

      const { data: staff } = await admin.from("app_users").select("business_id, role, first_name, last_name, username, phone, email");
      const staffCounts: Record<string, number> = {};
      const owners: Record<string, { name: string; username: string; phone: string | null; email: string | null }> = {};
      (staff || []).forEach((u: { business_id: string; role: string; first_name: string; last_name: string; username: string; phone: string | null; email: string | null }) => {
        if (u.role === "staff") staffCounts[u.business_id] = (staffCounts[u.business_id] || 0) + 1;
        if (u.role === "master" && !owners[u.business_id]) {
          owners[u.business_id] = { name: `${u.first_name || ""} ${u.last_name || ""}`.trim(), username: u.username, phone: u.phone, email: u.email };
        }
      });

      return json({ businesses: businesses || [], staffCounts, owners }, 200);
    }

    if (action === "business_detail") {
      const businessId = params.business_id;
      if (!businessId) return json({ error: "Missing business_id" }, 400);
      const [{ data: staff }, { data: shops }] = await Promise.all([
        admin.from("app_users").select("id, first_name, last_name, username, role, is_active, email, phone, created_at").eq("business_id", businessId),
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

    // FORCE DELETE — permanent, immediate, skips the normal 30-day GDPR
    // grace period that the in-app Settings → Delete Business flow gives
    // real customers. Meant for wiping test/junk accounts created during
    // development. Best-effort across every table this app writes to
    // (see the enqueueSync table list in app.html/admin.html) — a missing
    // or renamed table is logged and skipped rather than aborting the
    // whole cleanup, since partial cleanup is still better than none.
    if (action === "force_delete_business") {
      const businessId = params.business_id;
      if (!businessId) return json({ error: "Missing business_id" }, 400);

      const { data: bizRow } = await admin.from("businesses").select("name").eq("id", businessId).maybeSingle();
      const bizName = bizRow?.name || "(unknown)";

      const { data: shopRows } = await admin.from("shops").select("id").eq("business_id", businessId);
      const shopIds = (shopRows || []).map((s: { id: string }) => s.id);

      const { data: userRows } = await admin.from("app_users").select("id, auth_user_id").eq("business_id", businessId);
      const authUserIds = (userRows || []).map((u: { auth_user_id: string | null }) => u.auth_user_id).filter(Boolean) as string[];

      const skipped: string[] = [];
      const tryDelete = async (table: string, column: string, value: unknown) => {
        const { error } = await admin.from(table).delete().eq(column, value);
        if (error) skipped.push(`${table}: ${error.message}`);
      };

      // Log BEFORE deleting, while target_business_id still points to a
      // real row (avoids a dangling-reference audit entry afterward).
      await admin.from("audit_log_platform").insert({
        actor_auth_user_id: callerData.user.id,
        action: "force_delete_business",
        target_business_id: businessId,
        detail: `Permanently deleted "${bizName}" and all its data (test-account cleanup, no grace period).`,
      }).then((r) => { if (r.error) console.log("audit_log_platform insert skipped:", r.error.message); });

      // Shop-scoped tables first.
      for (const shopId of shopIds) {
        for (const table of ["sale_items", "sales", "stock_adjustments", "good_variants", "good_batches", "goods",
                              "lodging_bookings", "rooms", "shop_notes", "audit_log"]) {
          await tryDelete(table, "shop_id", shopId);
        }
      }
      // Business-scoped tables.
      for (const table of ["customers", "expenses", "supplier_purchases", "suppliers", "salary_payments",
                            "employment_record_history", "employment_records", "record_only_staff",
                            "communication_log", "app_users"]) {
        await tryDelete(table, "business_id", businessId);
      }
      await tryDelete("shops", "business_id", businessId);

      // Auth users — must happen via the admin API, not a table delete.
      for (const authId of authUserIds) {
        const { error } = await admin.auth.admin.deleteUser(authId);
        if (error) skipped.push(`auth user ${authId}: ${error.message}`);
      }

      const { error: bizDelErr } = await admin.from("businesses").delete().eq("id", businessId);
      if (bizDelErr) return json({ error: "Deleted related data, but could not delete the business row itself: " + bizDelErr.message, skipped }, 500);

      return json({ ok: true, skipped }, 200);
    }

    // RECOVER ACCOUNT — the human escalation path for when a real owner
    // is genuinely locked out (email/phone changed by an attacker, or
    // simply lost). This is intentionally powerful and only reachable by
    // someone already verified as a super admin above; the actual safety
    // check — confirming the person on the other end really is the
    // rightful owner (via ID, business registration, original signup
    // details, a phone call, etc.) — has to happen procedurally, outside
    // this function, before a super admin ever clicks the button that
    // calls this.
    if (action === "override_owner_contact") {
      const { business_id, new_email, new_phone, new_password } = params;
      if (!business_id || (!new_email && !new_phone && !new_password)) {
        return json({ error: "Provide business_id and at least one of new_email/new_phone/new_password." }, 400);
      }

      const { data: ownerRow, error: ownerErr } = await admin
        .from("app_users")
        .select("id, auth_user_id, email, phone")
        .eq("business_id", business_id)
        .eq("role", "master")
        .maybeSingle();
      if (ownerErr) return json({ error: ownerErr.message }, 500);
      if (!ownerRow) return json({ error: "No owner account found for that business." }, 404);

      const changes: string[] = [];
      const updatePayload: Record<string, unknown> = {};

      if (new_password) {
        if (ownerRow.auth_user_id) {
          const { error: authErr } = await admin.auth.admin.updateUserById(ownerRow.auth_user_id, { password: new_password });
          if (authErr) return json({ error: "Could not update login password: " + authErr.message }, 500);
        }
        updatePayload.password_hash = simpleHash(new_password);
        changes.push("password");
      }
      if (new_email && new_email !== ownerRow.email) {
        if (ownerRow.auth_user_id) {
          const { error: authErr } = await admin.auth.admin.updateUserById(ownerRow.auth_user_id, { email: new_email });
          if (authErr) return json({ error: "Could not update login email: " + authErr.message }, 500);
        }
        updatePayload.email = new_email;
        changes.push(`email (${ownerRow.email || "none"} → ${new_email})`);
      }
      if (new_phone && new_phone !== ownerRow.phone) {
        updatePayload.phone = new_phone;
        changes.push(`phone (${ownerRow.phone || "none"} → ${new_phone})`);
      }

      if (Object.keys(updatePayload).length) {
        const { error: updErr } = await admin.from("app_users").update(updatePayload).eq("id", ownerRow.id);
        if (updErr) return json({ error: updErr.message }, 500);
      }

      await admin.from("audit_log_platform").insert({
        actor_auth_user_id: callerData.user.id,
        action: "override_owner_contact",
        target_business_id: business_id,
        detail: `Manual account recovery — changed: ${changes.join(", ") || "(nothing changed)"}.`,
      }).then((r) => { if (r.error) console.log("audit_log_platform insert skipped:", r.error.message); });

      return json({ ok: true, changed: changes }, 200);
    }

    // SITE CONTENT — the public landing page and in-app About/Contact
    // screens all read from this one shared table. Editing it here (not
    // in the regular business admin.html) is deliberate: this table has
    // no business_id — it's one shared row per section for the whole
    // platform, not per-shop content. Any regular shop owner being able
    // to write to it would mean any of them could deface the company's
    // own marketing page.
    if (action === "get_site_content") {
      const { data, error } = await admin.from("site_content").select("*");
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true, sections: data }, 200);
    }

    if (action === "update_site_content") {
      const { section, heading, body } = params;
      if (!section) return json({ error: "Missing section" }, 400);

      const { error: upsertErr } = await admin
        .from("site_content")
        .upsert({ section, heading, body }, { onConflict: "section" });
      if (upsertErr) return json({ error: upsertErr.message }, 500);

      await admin.from("audit_log_platform").insert({
        actor_auth_user_id: callerData.user.id,
        action: "update_site_content",
        target_business_id: null,
        detail: `Updated landing page section "${section}".`,
      }).then((r) => { if (r.error) console.log("audit_log_platform insert skipped:", r.error.message); });

      return json({ ok: true }, 200);
    }

    return json({ error: "Unknown action." }, 400);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "Unexpected error" }, 500);
  }
});

// Mirrors the client's hash() function in app.html/admin.html exactly —
// same 32-bit signed overflow behavior — so a server-set password stays
// consistent with what the app's own local comparison logic expects.
function simpleHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return "h" + h;
}

function json(body: Record<string, unknown>, status: number) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
