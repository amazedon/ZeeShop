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
//
// PLATFORM PRICING — this is what actually earns the platform money from
// VTU/bill payments, independent of whatever markup (including 0%) any
// individual business sets for itself. There is no business-side markup
// at all in this app (removed) — this is the ONLY margin the platform
// earns, applied to Bigisub's raw cost before the charge is made (see
// computeSalePrice in bigisub-proxy/index.ts).
//
// It's per-service rather than one blanket percentage, because a flat %
// doesn't make sense everywhere — funding a ₦50,000 betting wallet at 2%
// would add ₦1,000 to what should be a fixed small fee. So: a percentage
// for the services with genuinely variable cost (data, airtime, cable,
// result checker, ISP), and a flat ₦ fee for the two pass-through
// services where the exact amount matters (betting funding, electricity
// tokens) — plus one "default" percentage as a fallback for any
// percentage-based service left blank. One-time setup:
//   create table platform_settings (
//     id int primary key default 1,
//     default_markup_percent numeric not null default 0,
//     data_markup_percent numeric not null default 0,
//     airtime_markup_percent numeric not null default 0,
//     cable_markup_percent numeric not null default 0,
//     result_checker_markup_percent numeric not null default 0,
//     isp_markup_percent numeric not null default 0,
//     betting_flat_fee numeric not null default 0,
//     electricity_flat_fee numeric not null default 0,
//     updated_at timestamptz default now(),
//     constraint platform_settings_singleton check (id = 1)
//   );
//   insert into platform_settings (id) values (1);
// If you already created the OLD single-column version of this table
// (platform_markup_percent only), just add the new columns instead:
//   alter table platform_settings
//     add column if not exists default_markup_percent numeric not null default 0,
//     add column if not exists data_markup_percent numeric not null default 0,
//     add column if not exists airtime_markup_percent numeric not null default 0,
//     add column if not exists cable_markup_percent numeric not null default 0,
//     add column if not exists result_checker_markup_percent numeric not null default 0,
//     add column if not exists isp_markup_percent numeric not null default 0,
//     add column if not exists betting_flat_fee numeric not null default 0,
//     add column if not exists electricity_flat_fee numeric not null default 0;
//   update platform_settings set default_markup_percent = platform_markup_percent where id = 1;
//   alter table platform_settings drop column if exists platform_markup_percent;
// Missing/empty table just means 0% platform markup — nothing breaks if
// you haven't run this yet, it just means you aren't earning anything
// extra on top of what businesses charge themselves yet.

import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const VALID_PLANS = ["free", "pro", "boss"];

// Same Bigisub credentials bigisub-proxy/index.ts uses — Supabase secrets
// are shared project-wide across every edge function, so nothing extra
// needs to be set here. This function only ever reads Bigisub data
// (platform wallet balance, transaction requery) for monitoring — it
// never makes a purchase, so it doesn't need BIGISUB_PIN.
const BIGISUB_BASE = Deno.env.get("BIGISUB_BASE_URL") || "https://api.bigisub.ng";
const BIGISUB_TOKEN = Deno.env.get("BIGISUB_TOKEN") || "";

async function bigisub(method: "GET" | "POST", path: string) {
  const res = await fetch(`${BIGISUB_BASE}${path}`, {
    method,
    headers: { Authorization: `Token ${BIGISUB_TOKEN}`, "Content-Type": "application/json" },
  });
  let data: any = null;
  try { data = await res.json(); } catch (_e) { /* non-JSON response */ }
  if (!res.ok) throw new Error((data && (data.message || data.detail)) || `Bigisub request failed (${res.status})`);
  return data;
}

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

    // PLATFORM PRICING — read/write the per-service pricing rules (see the
    // file header for the table this needs and why it's per-service, not
    // one blanket percentage). No isMaster/business check here since this
    // whole function is already gated to super admins only, at the top.
    const PRICING_FIELDS = [
      "default_markup_percent", "data_markup_percent", "airtime_markup_percent",
      "cable_markup_percent", "result_checker_markup_percent", "isp_markup_percent",
      "betting_flat_fee", "electricity_flat_fee",
    ];
    if (action === "get_platform_pricing") {
      const { data, error } = await admin.from("platform_settings").select(PRICING_FIELDS.join(",")).eq("id", 1).maybeSingle();
      if (error) return json({ error: "Could not load platform pricing — has the platform_settings table been created with the new per-service columns? (see file header) " + error.message }, 500);
      const out: Record<string, number> = {};
      for (const f of PRICING_FIELDS) out[f] = Number((data as Record<string, unknown> | null)?.[f] || 0);
      return json(out, 200);
    }
    if (action === "set_platform_pricing") {
      const update: Record<string, number> = {};
      for (const f of PRICING_FIELDS) {
        const val = Number(params[f]);
        if (Number.isNaN(val) || val < 0) return json({ error: `Invalid value for ${f}.` }, 400);
        update[f] = val;
      }
      const { error } = await admin.from("platform_settings")
        .upsert({ id: 1, ...update, updated_at: new Date().toISOString() }, { onConflict: "id" });
      if (error) return json({ error: "Could not save — has the platform_settings table been created with the new per-service columns? (see file header) " + error.message }, 500);

      await admin.from("audit_log_platform").insert({
        actor_auth_user_id: callerData.user.id,
        action: "set_platform_pricing",
        target_business_id: null,
        detail: `Set platform pricing: ${PRICING_FIELDS.map((f) => `${f}=${update[f]}`).join(", ")}.`,
      }).then((r) => { if (r.error) console.log("audit_log_platform insert skipped:", r.error.message); });

      return json({ ok: true, ...update }, 200);
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

    // BILL PAYMENTS OVERVIEW — platform-wide monitoring for the Bigisub/
    // Flutterwave bill-payments feature. Three things a platform owner
    // actually needs eyes on, none of which are visible from inside any
    // single business's own app:
    //   1. Bigisub's own wallet balance — the ONE shared balance that
    //      funds every business's purchases. If this runs dry, purchases
    //      fail for everyone regardless of individual Bill Wallet
    //      balances, so it's the single most operationally important
    //      number here.
    //   2. Aggregate Bill Wallet liability — the sum of what every
    //      business has prepaid and is still owed as spendable credit.
    //   3. Revenue/profit from markups, and recent activity to spot
    //      stuck transactions needing manual intervention.
    // The transaction query below is capped at the last 2000 rows for
    // aggregation — an honest approximation, not a true unlimited total.
    // At real scale this should become a database-side aggregate (a SQL
    // view or RPC) instead of pulling rows into JS to sum them.
    if (action === "bill_payments_overview") {
      let bigisubWalletBalance: number | null = null;
      let bigisubError: string | null = null;
      if (!BIGISUB_TOKEN) {
        bigisubError = "BIGISUB_TOKEN isn't set on this function yet.";
      } else {
        try {
          const w = await bigisub("GET", "/api/v2/financial/wallet/balance/");
          bigisubWalletBalance = w?.balance ?? w?.data?.balance ?? w?.wallet_balance ?? null;
        } catch (e) {
          bigisubError = e instanceof Error ? e.message : "Could not reach Bigisub.";
        }
      }

      const { data: businesses, error: bizErr } = await admin
        .from("businesses")
        .select("id, name, bill_wallet_balance, bill_markup_percent, psa_account_number, psa_bank_name");
      if (bizErr) return json({ error: bizErr.message }, 500);

      const bizNameById: Record<string, string> = {};
      let totalBillWallet = 0;
      let businessesWithWallet = 0;
      (businesses || []).forEach((b: any) => {
        bizNameById[b.id] = b.name || "(unnamed)";
        const bal = Number(b.bill_wallet_balance || 0);
        totalBillWallet += bal;
        if (bal > 0 || b.psa_account_number) businessesWithWallet++;
      });

      const { data: txns, error: txErr } = await admin
        .from("bill_transactions")
        .select("business_id, service, status, cost_price, sale_price")
        .order("created_at", { ascending: false })
        .limit(2000);
      if (txErr) return json({ error: txErr.message }, 500);

      let totalRevenue = 0, totalCost = 0;
      const byStatus: Record<string, number> = {};
      const byService: Record<string, { count: number; revenue: number }> = {};
      (txns || []).forEach((t: any) => {
        byStatus[t.status] = (byStatus[t.status] || 0) + 1;
        if (!byService[t.service]) byService[t.service] = { count: 0, revenue: 0 };
        byService[t.service].count++;
        if (t.status === "success") {
          totalRevenue += Number(t.sale_price || 0);
          totalCost += Number(t.cost_price || 0);
          byService[t.service].revenue += Number(t.sale_price || 0);
        }
      });

      const { data: recent, error: recentErr } = await admin
        .from("bill_transactions")
        .select("id, business_id, service_label, recipient, sale_price, status, created_at, bigisub_tranx_id")
        .order("created_at", { ascending: false })
        .limit(30);
      if (recentErr) return json({ error: recentErr.message }, 500);
      const recentWithNames = (recent || []).map((t: any) => ({ ...t, business_name: bizNameById[t.business_id] || "(deleted business)" }));

      return json({
        bigisub_wallet_balance: bigisubWalletBalance, bigisub_error: bigisubError,
        total_bill_wallet_balance: totalBillWallet, businesses_with_wallet: businessesWithWallet,
        businesses: businesses || [],
        total_transactions: (txns || []).length, transactions_capped_at: 2000,
        total_revenue: totalRevenue, total_cost: totalCost, total_profit: totalRevenue - totalCost,
        by_status: byStatus, by_service: byService,
        recent_transactions: recentWithNames,
      }, 200);
    }

    // Platform-wide visibility into what Bigisub is actually charging
    // right now — pulled live, same endpoints bigisub-proxy uses for the
    // per-business "Manage Prices" screen, just surfaced here too so you
    // don't need to open a specific business's account to see current
    // costs. Read-only — this never sets or changes anything, since
    // pricing decisions belong to each business individually via their
    // own markup/flat-fee/override settings.
    if (action === "bigisub_service_prices") {
      if (!BIGISUB_TOKEN) return json({ error: "BIGISUB_TOKEN isn't set on this function yet." }, 500);
      // Some of Bigisub's list endpoints come back grouped into an object
      // (e.g. keyed by network name) rather than one flat array — this
      // guarantees a flat array either way instead of ever handing the
      // client something list.map() would crash on.
      const normalizeList = (data: any, key: string): any[] => {
        const candidate = data?.[key] ?? data?.data ?? data;
        if (Array.isArray(candidate)) return candidate;
        if (candidate && typeof candidate === "object") {
          const flattened: any[] = [];
          for (const [groupKey, v] of Object.entries(candidate)) {
            if (Array.isArray(v)) {
              // Preserve which group (commonly a network name, e.g. "MTN")
              // each item came from, in case it isn't already a field on
              // the item itself — the client uses this for a Network
              // column and doesn't overwrite an existing field of the
              // same name.
              flattened.push(...v.map((item: any) => (item && typeof item === "object" && !("network_name" in item)) ? { ...item, network_name: groupKey } : item));
            }
          }
          if (flattened.length > 0) return flattened;
        }
        return [];
      };
      const fetchList = async (path: string, key: string) => {
        try {
          const data = await bigisub("GET", path);
          return normalizeList(data, key);
        } catch (e) {
          return { error: e instanceof Error ? e.message : "Could not fetch." };
        }
      };
      const [dataPlans, cablePlans, resultCheckerPrices, ispSmilePlans, ispSpectranetPlans] = await Promise.all([
        fetchList("/api/v2/vtu/data/plans/", "plans"),
        fetchList("/api/v2/vtu/cable/plans/", "plans"),
        fetchList("/api/v2/bills/result-checker/prices/", "prices"),
        fetchList("/api/v2/isp/smile/plans/", "plans"),
        fetchList("/api/v2/isp/spectranet/plans/", "plans"),
      ]);
      return json({ data_plans: dataPlans, cable_plans: cablePlans, result_checker_prices: resultCheckerPrices, isp_smile_plans: ispSmilePlans, isp_spectranet_plans: ispSpectranetPlans }, 200);
    }

    // Force a status re-check on ANY business's bill-payment transaction
    // (not just your own, unlike the equivalent action in bigisub-proxy) —
    // for manually unsticking a pending/failed transaction a business
    // reports as stuck, without needing to go into their account.
    if (action === "retry_bill_transaction") {
      const transactionId = params.transaction_id;
      if (!transactionId) return json({ error: "Missing transaction_id" }, 400);
      const { data: tx, error: txErr } = await admin.from("bill_transactions").select("*").eq("id", transactionId).maybeSingle();
      if (txErr) return json({ error: txErr.message }, 500);
      if (!tx) return json({ error: "Transaction not found." }, 404);
      if (!tx.bigisub_tranx_id) return json({ error: "This transaction has no Bigisub reference to check." }, 400);

      // Betting uses its own dedicated requery endpoint (GET, query param);
      // everything else uses the generic anubis requery (POST, path param).
      // Same caveat as in bigisub-proxy: the betting query param name is a
      // best guess, not confirmed from docs.
      const data = tx.service === "betting"
        ? await bigisub("GET", `/api/v2/betting/requery/?reference=${encodeURIComponent(tx.bigisub_tranx_id)}`)
        : await bigisub("POST", `/api/v2/anubis/transactions/${tx.bigisub_tranx_id}/requery/`);
      const statusStr = (data?.Status || data?.status || "").toString().toLowerCase();
      const newStatus = statusStr.includes("success") ? "success" : statusStr.includes("fail") ? "failed" : tx.status;
      await admin.from("bill_transactions").update({ status: newStatus, bigisub_response: data }).eq("id", transactionId);

      await admin.from("audit_log_platform").insert({
        actor_auth_user_id: callerData.user.id,
        action: "retry_bill_transaction",
        target_business_id: tx.business_id,
        detail: `Re-checked transaction ${transactionId} — status: ${newStatus}.`,
      }).then((r) => { if (r.error) console.log("audit_log_platform insert skipped:", r.error.message); });

      return json({ status: newStatus }, 200);
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
      const { section, ...fields } = params;
      if (!section) return json({ error: "Missing section" }, 400);

      // Generic pass-through — accepts heading/body (about_us, contact_us,
      // privacy_policy) or email/phone/address (contact_us) without this
      // function needing to change every time a new field is added.
      const { error: upsertErr } = await admin
        .from("site_content")
        .upsert({ section, ...fields }, { onConflict: "section" });
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
