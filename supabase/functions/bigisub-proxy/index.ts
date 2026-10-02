// supabase/functions/bigisub-proxy/index.ts
//
// Every Bigisub call (VTU/bills) goes through here — never from app.html.
// Two reasons, same as super-admin/index.ts:
//   1. Security: the Bigisub partner token and transaction PIN are ONE
//      shared secret for your whole platform — there's no per-business
//      token. If they lived in app.html, anyone could open dev tools,
//      steal them, and drain your Bigisub balance. They live only in
//      this function's environment variables, which the browser never
//      sees.
//   2. Correctness: every business has its own Bill Wallet balance and
//      markup %, stored in Postgres. Debiting that balance has to happen
//      server-side with the service role key.
//
// EVERY endpoint below was confirmed live against Bigisub's own docs
// (rif.africa/technotronics/api/bigisub) — none of this is guessed.
//
// Four services are verify-then-charge flows: you confirm the customer's
// name/details in one call, then pass that confirmation into the charge
// call. Betting's validation_reference looked time-encoded when we saw
// it — treat it as single-use, call validate immediately before fund,
// never cache it across a page reload.
//
// Field names are NOT consistent across services — this is Bigisub's API
// design, not a bug in this file. Don't try to generalize these into one
// shared shape:
//   PIN field:         airtime/data/cable/electricity/isp use "pin",
//                       betting/result-checker use "pin_code"
//   Verified name:      cable purchase wants "Customer",
//                       electricity pay wants "Customer_name",
//                       betting fund wants "customer_name"
//   Cable identifier:   verify uses "cable_name", purchase uses
//                       "cable_type" — same value (e.g. "dstv")
//   ISP:                Smile and Spectranet are entirely separate paths
//                       (isp/smile/..., isp/spectranet/...), not one
//                       generic ISP endpoint with a provider param —
//                       and only Smile has a verify step; Spectranet's
//                       topup wants "spectranet_number" + "quantity"
//                       instead of a verified account.
//
// Two list endpoints exist per category where we originally expected
// one (e.g. cable has both /plans/ and /pricing/; result-checker
// pricing lives at /bills/result-checker/prices/ while /bills/education/
// services/ is a broader list). This file picks the one that's the
// clearest fit for each UI dropdown — see comments at each action.
//
// Setup required once in your Supabase project — see SETUP.md.
//
// Also requires the platform_settings table (see the header comment in
// super-admin/index.ts for the exact SQL) — this is where YOUR platform-
// wide markup lives, applied on top of Bigisub's cost before a business's
// own markup ever runs. Missing/empty table just means 0% platform
// markup, so this degrades safely if it hasn't been created yet.

import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const BIGISUB_BASE = Deno.env.get("BIGISUB_BASE_URL") || "https://api.bigisub.ng";
const BIGISUB_TOKEN = Deno.env.get("BIGISUB_TOKEN") || "";
const BIGISUB_PIN = Deno.env.get("BIGISUB_PIN") || ""; // the Bigisub ACCOUNT's transaction PIN — never entered by shop staff
// ---- Wallet funding ----------------------------------------------------
// Two ways for a business to fund its Bill Wallet (each is its own card on
// the Add Money screen):
//  1. A permanent account for every business, no BVN/NIN (Flutterwave
//     "payout subaccount"). Secret: FLW_SECRET_KEY (the same one your
//     Flutterwave functions already use). Credited by flutterwave-webhook.
//  2. An optional upgrade to a dedicated account opened with the owner's
//     BVN or NIN (FonPayEdge). Secret: FONPAYEDGE_SECRET_KEY = your LIVE key
//     (starts "sck_"). Credited by fonpayedge-webhook.
const FLW_SECRET_KEY = Deno.env.get("FLW_SECRET_KEY") || "";
// Only used by the sync fallback below, whose Flutterwave endpoint doesn't
// report fees; the webhook uses Flutterwave's own fee figure.
const FLW_ESTIMATED_FEE_PERCENT = Number(Deno.env.get("FLW_ESTIMATED_FEE_PERCENT")) || 2.0;
const FONPAYEDGE_SECRET_KEY = Deno.env.get("FONPAYEDGE_SECRET_KEY") || "";
const FONPAYEDGE_BASE = "https://dashboard.fonpayedge.ng/api/v1";
// One-time fee the BUSINESS pays from its Bill Wallet to upgrade (refunded if
// the upgrade fails). Optional Supabase secret PSA_UPGRADE_FEE, default 100.
const PSA_UPGRADE_FEE = Number(Deno.env.get("PSA_UPGRADE_FEE")) || 100;
// Each upgraded account is registered under this unique email — the
// fonpayedge-webhook uses it as a backup way to match a payment.
const walletEmailFor = (businessId: string) => `${businessId}@wallet.zeeshop.app`;

const EP = {
  WALLET_BALANCE: "/api/v2/financial/wallet/balance/",

  AIRTIME_PURCHASE: "/api/v2/vtu/airtime/purchase/",

  DATA_PLANS: "/api/v2/vtu/data/plans/",
  DATA_PURCHASE: "/api/v2/vtu/data/purchase/",

  CABLE_PLANS: "/api/v2/vtu/cable/plans/",       // used for the provider+plan dropdown
  CABLE_PRICING: "/api/v2/vtu/cable/pricing/",   // also real, kept available but unused for now
  CABLE_VERIFY: "/api/v2/vtu/cable/verify/",
  CABLE_PURCHASE: "/api/v2/vtu/cable/purchase/",

  ELECTRICITY_PROVIDERS: "/api/v2/bills/electricity/providers/",
  ELECTRICITY_VERIFY: "/api/v2/bills/electricity/verify/",
  ELECTRICITY_PAY: "/api/v2/bills/electricity/pay/",

  EDUCATION_SERVICES: "/api/v2/bills/education/services/", // broader list; not used directly, kept for reference
  RESULT_CHECKER_PRICES: "/api/v2/bills/result-checker/prices/", // used for the exam+price dropdown
  RESULT_CHECKER_PURCHASE: "/api/v2/bills/result-checker/purchase/",

  BETTING_BILLERS: "/api/v2/betting/billers/",   // used for the platform dropdown
  BETTING_PRODUCTS: "/api/v2/betting/products/", // also real, kept available but unused for now
  BETTING_VALIDATE: "/api/v2/betting/validate/",
  BETTING_FUND: "/api/v2/betting/fund/",
  BETTING_REQUERY: "/api/v2/betting/requery/",
  BETTING_HISTORY: "/api/v2/betting/history/",

  ISP_SMILE_PLANS: "/api/v2/isp/smile/plans/",
  ISP_SMILE_VERIFY: "/api/v2/isp/smile/verify/",
  ISP_SMILE_TOPUP: "/api/v2/isp/smile/topup/",
  ISP_SPECTRANET_PLANS: "/api/v2/isp/spectranet/plans/",
  ISP_SPECTRANET_TOPUP: "/api/v2/isp/spectranet/topup/",

  TRANSACTION_DETAIL: (id: string) => `/api/v2/anubis/transactions/${id}/`, // lightweight fetch, no active re-check
  REQUERY: (id: string) => `/api/v2/anubis/transactions/${id}/requery/`,    // asks Bigisub to actively re-check with the provider
};

async function bigisub(method: "GET" | "POST", path: string, body?: Record<string, unknown>) {
  const res = await fetch(`${BIGISUB_BASE}${path}`, {
    method,
    headers: {
      "Authorization": `Token ${BIGISUB_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data: any = null;
  try { data = await res.json(); } catch (_e) { /* non-JSON response */ }
  if (!res.ok) {
    const msg = (data && (data.message || data.detail || data.error)) || `Bigisub request failed (${res.status})`;
    throw new Error(msg);
  }
  return data;
}

// Bigisub's exact purchase-response shape wasn't part of what was shared
// (only request shapes were confirmed), so cost/id extraction checks
// several plausible field names rather than assuming one. Tighten this
// once you've inspected a real response in your Supabase function logs.
function extractCost(data: any, fallback: number): number {
  if (!data) return fallback;
  if (typeof data.amount_charged === "number") return data.amount_charged;
  if (typeof data.plan_amount === "number") return data.plan_amount;
  if (typeof data.amount === "number") return data.amount;
  if (data.balance_before != null && data.balance_after != null) {
    const diff = Number(data.balance_before) - Number(data.balance_after);
    if (!Number.isNaN(diff) && diff > 0) return diff;
  }
  return fallback;
}
function extractTranxId(data: any): string | null {
  if (!data) return null;
  return data.tran_id || data.tranx_id || data.transaction_id || data.id?.toString?.() || null;
}
function extractStatus(data: any): string {
  const s = (data?.Status || data?.status || "successful").toString().toLowerCase();
  return s.includes("success") ? "success" : (s.includes("fail") ? "failed" : "pending");
}
// Bigisub's verify responses aren't consistent about key casing or
// nesting (e.g. {customer_name} vs {data:{Customer_Name}} vs {details:{name}}),
// and the old flat-only lookup returned "" for anything nested — which the
// app then reported as a failed verification even though Bigisub had
// verified fine. This searches case/punctuation-insensitively at any depth.
const NAME_KEYS = ["customer_name", "customername", "customer", "account_name", "accountname", "subscriber_name", "subscriber", "card_holder", "cardholder", "owner", "full_name", "fullname", "client_name", "name"];
function normKey(k: string): string { return k.toLowerCase().replace(/[^a-z0-9]/g, ""); }
function deepFindString(obj: any, keys: string[], depth = 0): string {
  if (!obj || typeof obj !== "object" || depth > 6) return "";
  const byNorm: Record<string, unknown> = {};
  for (const k of Object.keys(obj)) byNorm[normKey(k)] = obj[k];
  for (const want of keys) {
    const v = byNorm[normKey(want)];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  for (const v of Object.values(obj)) {
    if (v && typeof v === "object") {
      const found = deepFindString(v, keys, depth + 1);
      if (found) return found;
    }
  }
  return "";
}
function extractCustomerName(data: any): string {
  return deepFindString(data, NAME_KEYS);
}
function extractUpstreamMessage(data: any): string {
  return deepFindString(data, ["message", "msg", "error", "detail", "description"]);
}

// SHA-256 hash for the shared Bill Payments PIN — no plaintext PIN is ever
// stored, and it's verified server-side (not just checked in the browser)
// since a client-side-only check would do nothing to stop someone with
// basic dev tools access from bypassing it — the whole point of this PIN
// is to stop casual misuse of an unlocked, already-logged-in device.
// Bigisub's list endpoints were assumed to always return a flat array —
// they don't always. Some come back grouped into an object (e.g. keyed by
// network or provider name) rather than one flat list, and calling
// .map() on that from the client crashed with "list.map is not a
// function" instead of ever showing a plan. This guarantees a flat array
// either way: passes a real array straight through, flattens a grouped
// object's array values into one list, and only falls back to empty if
// neither shape is found — never crashes the caller either way.
function normalizeList(data: any, key: string): any[] {
  const candidate = data?.[key] ?? data?.data ?? data;
  if (Array.isArray(candidate)) return candidate;
  if (candidate && typeof candidate === "object") {
    const flattened: any[] = [];
    for (const v of Object.values(candidate)) {
      if (Array.isArray(v)) flattened.push(...v);
    }
    if (flattened.length > 0) return flattened;
  }
  return [];
}

async function hashPin(pin: string): Promise<string> {
  const data = new TextEncoder().encode(pin);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

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

    // Every regular ZeeShop user (owner or staff) has an app_users row
    // keyed by auth_user_id — same lookup pattern as super-admin/index.ts.
    const { data: caller, error: callerRowErr } = await admin
      .from("app_users")
      .select("id, business_id, role, is_active, can_bill_payments, phone, email, first_name, last_name")
      .eq("auth_user_id", callerData.user.id)
      .maybeSingle();
    if (callerRowErr) return json({ error: callerRowErr.message }, 500);
    if (!caller) return json({ error: `Account not found. No app_users row has auth_user_id = ${callerData.user.id}. If this is a staff device-PIN login, that row's auth_user_id may never have been set — check that column for this user in Supabase.` }, 403);
    if (caller.is_active === false) return json({ error: "This account has been deactivated." }, 403);

    const isMaster = caller.role === "master";
    const canTransact = isMaster || (caller.role === "staff" && !!caller.can_bill_payments);
    if (!canTransact) return json({ error: "You don't have permission for bill payments." }, 403);

    const businessId = caller.business_id;
    if (!businessId) return json({ error: `Your account (app_users.id = ${caller.id}) has no business_id set — it isn't linked to a business on the server yet. This can happen if this account was created/updated locally and hasn't finished syncing. Try again once the device shows fully synced (check the sync status dot), or check that row's business_id directly in Supabase.` }, 404);
    const { data: biz, error: bizErr } = await admin
      .from("businesses")
      .select("id, name, currency, country, bill_wallet_balance, bill_payments_pin_hash, psa_account_reference, psa_account_number, psa_bank_name, psa_status, psa_last_synced_at, fpe_account_number, fpe_bank_name, fpe_status")
      .eq("id", businessId)
      .maybeSingle();
    if (bizErr) return json({ error: bizErr.message }, 500);
    if (!biz) return json({ error: `No business found with id = ${businessId} (from your app_users.business_id). That id doesn't match any row in businesses — check for a mismatch (e.g. a locally-generated id that never got the server-assigned one back) directly in Supabase.` }, 404);

    const { action, ...params } = await req.json();
    const currency = biz.currency || "NGN";

    // ---------- read-only reference/lookups ----------
    if (action === "my_wallet_summary") {
      return json({
        wallet_balance: Number(biz.bill_wallet_balance || 0), currency,
        psa_account_number: biz.psa_account_number || null, psa_bank_name: biz.psa_bank_name || null, psa_status: biz.psa_status || null,
        fpe_account_number: biz.fpe_account_number || null, fpe_bank_name: biz.fpe_bank_name || null, fpe_status: biz.fpe_status || null,
        upgrade_fee: PSA_UPGRADE_FEE,
        bill_pin_set: !!biz.bill_payments_pin_hash,
      }, 200);
    }
    // Shared by every simple list-fetch action below — if Bigisub itself
    // rejects the request (rate-limit throttling being the one we've
    // actually hit), this surfaces THAT real message with a proper 502,
    // instead of the request falling through uncaught to the top-level
    // catch-all's generic 500. The message is unchanged either way (the
    // client already reads and displays it correctly regardless of status
    // code) — this is about correct HTTP semantics, not new behavior.
    const fetchListAction = async (path: string, key: string, responseKey: string) => {
      try {
        const data = await bigisub("GET", path);
        return json({ [responseKey]: normalizeList(data, key) }, 200);
      } catch (e) {
        return json({ error: e instanceof Error ? e.message : "Could not reach Bigisub." }, 502);
      }
    };
    if (action === "data_plans") return await fetchListAction(EP.DATA_PLANS, "plans", "plans");
    if (action === "cable_plans") return await fetchListAction(EP.CABLE_PLANS, "plans", "plans");
    if (action === "electricity_providers") return await fetchListAction(EP.ELECTRICITY_PROVIDERS, "providers", "providers");
    if (action === "result_checker_prices") return await fetchListAction(EP.RESULT_CHECKER_PRICES, "prices", "prices");
    if (action === "betting_billers") return await fetchListAction(EP.BETTING_BILLERS, "billers", "billers");
    if (action === "isp_smile_plans") return await fetchListAction(EP.ISP_SMILE_PLANS, "plans", "plans");
    if (action === "isp_spectranet_plans") return await fetchListAction(EP.ISP_SPECTRANET_PLANS, "plans", "plans");

    // ---------- verify-before-charge steps ----------
    if (action === "cable_verify") {
      const { cable_name, card_no } = params as { cable_name: string; card_no: string };
      if (!cable_name || !card_no) return json({ error: "Missing cable_name or card_no." }, 400);
      const data = await bigisub("POST", EP.CABLE_VERIFY, { cable_name, card_no });
      return json({ customer_name: extractCustomerName(data), upstream_message: extractUpstreamMessage(data), raw: data }, 200);
    }
    if (action === "electricity_verify") {
      const { company, meter_no, meter_type } = params as { company: string; meter_no: string; meter_type: string };
      if (!company || !meter_no || !meter_type) return json({ error: "Missing company, meter_no, or meter_type." }, 400);
      const data = await bigisub("POST", EP.ELECTRICITY_VERIFY, { company, meter_no, meter_type });
      return json({ customer_name: extractCustomerName(data), upstream_message: extractUpstreamMessage(data), raw: data }, 200);
    }
    if (action === "betting_validate") {
      const { biller_code, customer_id } = params as { biller_code: string; customer_id: string };
      if (!biller_code || !customer_id) return json({ error: "Missing biller_code or customer_id." }, 400);
      const data = await bigisub("POST", EP.BETTING_VALIDATE, { biller_code, customer_id });
      const validationReference = data?.validation_reference || data?.reference || null;
      if (!validationReference) return json({ error: "Betting validation didn't return a reference — cannot proceed to fund." }, 502);
      return json({ customer_name: extractCustomerName(data), validation_reference: validationReference, raw: data }, 200);
    }
    if (action === "isp_smile_verify") {
      const { account_id } = params as { account_id: string };
      if (!account_id) return json({ error: "Missing account_id." }, 400);
      const data = await bigisub("POST", EP.ISP_SMILE_VERIFY, { account_id });
      return json({ customer_name: extractCustomerName(data), upstream_message: extractUpstreamMessage(data), raw: data }, 200);
    }

    if (action === "list_transactions") {
      const { data: txs, error } = await admin
        .from("bill_transactions")
        .select("*")
        .eq("business_id", businessId)
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) return json({ error: error.message }, 500);
      return json({ transactions: txs || [] }, 200);
    }

    if (action === "requery" || action === "betting_requery") {
      const txId = params.transaction_id;
      if (!txId) return json({ error: "Missing transaction_id" }, 400);
      const { data: txRow } = await admin.from("bill_transactions").select("*").eq("id", txId).eq("business_id", businessId).maybeSingle();
      if (!txRow) return json({ error: "Transaction not found." }, 404);
      const bigisubId = txRow.bigisub_tranx_id;
      if (!bigisubId) return json({ error: "This transaction has no Bigisub reference to check." }, 400);
      const path = txRow.service === "betting" ? EP.BETTING_REQUERY : EP.REQUERY(bigisubId);
      // NOTE: the betting requery endpoint was given as a bare GET with no
      // params shown, so the query param name below ("reference") is a
      // guess based on what validate/fund call it — confirm the real
      // param name if this 400s, and adjust just this one line.
      const data = txRow.service === "betting"
        ? await bigisub("GET", `${EP.BETTING_REQUERY}?reference=${encodeURIComponent(bigisubId)}`)
        : await bigisub("POST", path as string);
      const newStatus = extractStatus(data);
      await admin.from("bill_transactions").update({ status: newStatus, bigisub_response: data }).eq("id", txId);
      return json({ status: newStatus, raw: data }, 200);
    }

    // This app doesn't support per-business reseller pricing (markup, flat
    // fees, or per-plan price overrides) — every business is charged
    // exactly what Bigisub costs, plus the platform's own invisible cut
    // (see the per-service PlatformPricing type / computeSalePrice below). The
    // set_markup / set_flat_fee / list_price_overrides / set_price_override
    // / delete_price_override actions that used to live here have been
    // removed along with the "Your markup" and "Manage Prices" screens on
    // the client — this app is built for end users, not resellers.

    // One shared PIN, set by the owner, required before every purchase
    // once set. Never stored as plaintext — only its SHA-256 hash, which
    // is all that's needed to verify a later attempt without being able
    // to recover the original PIN from the database.
    if (action === "set_bill_pin") {
      if (!isMaster) return json({ error: "Only the business owner can set the Bill Payments PIN." }, 403);
      const pin = String(params.pin || "");
      if (!/^\d{4}$/.test(pin)) return json({ error: "PIN must be exactly 4 digits." }, 400);
      // A PIN already exists — require a valid, unused, unexpired OTP code
      // (sent via send-bill-pin-otp, using your existing Termii setup)
      // before overwriting it. Real OTP, not just re-entering the old PIN —
      // this is also what makes recovering a genuinely forgotten PIN
      // possible, which a "must know the current PIN" check never could.
      if (biz.bill_payments_pin_hash) {
        const otp = String(params.otp || "");
        if (!/^\d{6}$/.test(otp)) return json({ error: "Enter the 6-digit code sent to your email." }, 400);
        const otpHash = await hashPin(otp); // same SHA-256 helper works for any numeric code, not just 4-digit PINs
        const { data: otpRow, error: otpErr } = await admin.from("bill_pin_reset_otp_codes")
          .select("id, expires_at, consumed_at").eq("business_id", businessId).eq("code_hash", otpHash)
          .order("created_at", { ascending: false }).limit(1).maybeSingle();
        if (otpErr) return json({ error: otpErr.message }, 500);
        if (!otpRow || otpRow.consumed_at || new Date(otpRow.expires_at).getTime() < Date.now()) {
          return json({ error: "That code is invalid or has expired. Request a new one." }, 403);
        }
        await admin.from("bill_pin_reset_otp_codes").update({ consumed_at: new Date().toISOString() }).eq("id", otpRow.id);
      }
      const hash = await hashPin(pin);
      const { error } = await admin.from("businesses").update({ bill_payments_pin_hash: hash }).eq("id", businessId);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true }, 200);
    }
    if (action === "clear_bill_pin") {
      if (!isMaster) return json({ error: "Only the business owner can remove the Bill Payments PIN." }, 403);
      const { error } = await admin.from("businesses").update({ bill_payments_pin_hash: null }).eq("id", businessId);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true }, 200);
    }

    // ---------- wallet funding card 1: permanent account for every business ----------
    // A Flutterwave "payout subaccount": one permanent account number per
    // business, no BVN/NIN needed. Created once and reused forever.
    // Money sent to it is credited by flutterwave-webhook (and caught by
    // sync_psa_wallet below if a notice is ever missed) — NOT here.
    if (action === "get_or_create_psa_account") {
      if (biz.psa_account_number && biz.psa_status === "active") {
        return json({ account_number: biz.psa_account_number, bank_name: biz.psa_bank_name, status: biz.psa_status }, 200);
      }
      if (!FLW_SECRET_KEY) return json({ error: "Account setup isn't configured yet." }, 500);

      const flwRes = await fetch("https://api.flutterwave.com/v3/payout-subaccounts", {
        method: "POST",
        headers: { Authorization: `Bearer ${FLW_SECRET_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          account_name: biz.name || "ZeeShop Business",
          email: callerData.user.email || `business-${businessId}@zeeshop.app`,
          mobilenumber: caller.phone || "08000000000",
          // Hardcoded: Flutterwave needs the 2-letter code and every service
          // here is Nigeria-only (biz.country may hold the full name).
          country: "NG",
        }),
      });
      const flwData = await flwRes.json();
      let acct = flwData?.data;
      if (!flwRes.ok || flwData?.status !== "success" || !acct?.account_reference) {
        console.error("Flutterwave payout-subaccount create failed:", flwData?.message);
        return json({ error: "Account setup is temporarily unavailable. Please try again later." }, 502);
      }

      // The account number to fund. The create response may carry `nuban`;
      // Flutterwave's docs also describe a separate "fetch static account"
      // call that returns `static_account` — try that when it's missing.
      let accountNumber: string | null = acct.nuban ? String(acct.nuban) : null;
      let bankName: string | null = acct.bank_name || null;
      const staticRes = await fetch(`https://api.flutterwave.com/v3/payout-subaccounts/${acct.account_reference}/static-account`, {
        headers: { Authorization: `Bearer ${FLW_SECRET_KEY}` },
      });
      const staticData = await staticRes.json().catch(() => null);
      const sd = staticData?.data;
      const staticAcct = sd?.static_account ? sd : (sd?.static_accounts?.[0] || sd?.static_virtual_accounts?.[0] || null);
      if (staticRes.ok && staticAcct) {
        // Prefer the account Flutterwave documents for FUNDING the wallet.
        accountNumber = String(staticAcct.static_account || staticAcct.account_number || accountNumber || "");
        bankName = staticAcct.bank_name || bankName;
      }
      if (!accountNumber) return json({ error: "Your account was created but the number isn't ready yet — tap Refresh in a moment." }, 502);

      await admin.from("businesses").update({
        psa_account_reference: acct.account_reference, psa_account_number: accountNumber,
        psa_bank_name: bankName || "Bank", psa_status: "active",
      }).eq("id", businessId);

      return json({ account_number: accountNumber, bank_name: bankName || "Bank", status: "active" }, 200);
    }

    // Catch-up check for the permanent account. The webhook is the fast path,
    // but if its notice is ever missed (or the field it reads isn't right),
    // this independently asks Flutterwave for the account's recent transfers
    // and credits any not seen yet. It runs on a timer while the Add Money
    // screen is open. Returns the CURRENT wallet balance either way, so it
    // also shows credits from the FonPayEdge account.
    // Each payment is recorded FIRST under a unique reference (the same
    // "flw:<reference>" key the webhook uses), so the webhook and this sync
    // can never credit the same transfer twice.
    if (action === "sync_psa_wallet") {
      if (biz.psa_account_reference && FLW_SECRET_KEY) {
        const lastSyncedAt: string | null = (biz as any).psa_last_synced_at || null;
        const from = lastSyncedAt
          ? new Date(new Date(lastSyncedAt).getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
          : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
        const to = new Date().toISOString().slice(0, 10);
        try {
          const flwRes = await fetch(`https://api.flutterwave.com/v3/payout-subaccounts/${biz.psa_account_reference}/transactions?from=${from}&to=${to}`, {
            headers: { Authorization: `Bearer ${FLW_SECRET_KEY}` },
          });
          const flwData = await flwRes.json();
          if (flwRes.ok) {
            const txns: any[] = flwData?.data?.transactions || [];
            for (const t of txns) {
              if (String(t.type).toLowerCase() !== "credit" || String(t.status).toLowerCase() !== "successful" || !t.reference) continue;
              const ref = String(t.reference).replace(/^PSA_/i, "");
              const gross = Number(String(t.amount).replace(/,/g, ""));
              if (!Number.isFinite(gross) || gross <= 0) continue;
              // This endpoint reports no fee figure, so apply the estimated
              // percentage (the webhook path uses Flutterwave's real fee).
              const net = Math.round(gross * (1 - FLW_ESTIMATED_FEE_PERCENT / 100) * 100) / 100;
              const topupId = crypto.randomUUID();
              const { error: recErr } = await admin.from("wallet_topups").insert({
                id: topupId, business_id: businessId, amount: net, gross_amount: gross,
                provider_reference: `flw:${ref}`, status: "success",
              });
              if (recErr) continue; // already recorded by the webhook or an earlier sync
              const { error: creditErr } = await admin.rpc("increment_bill_wallet", { p_business_id: String(businessId), p_amount: net });
              if (creditErr) await admin.from("wallet_topups").delete().eq("id", topupId);
            }
            await admin.from("businesses").update({ psa_last_synced_at: new Date().toISOString() }).eq("id", businessId);
          }
        } catch (e) {
          console.error("sync_psa_wallet lookup failed:", e);
        }
      }
      const { data: fresh } = await admin.from("businesses").select("bill_wallet_balance").eq("id", businessId).maybeSingle();
      return json({ wallet_balance: Number(fresh?.bill_wallet_balance ?? biz.bill_wallet_balance ?? 0) }, 200);
    }

    // ---------- wallet funding card 2: upgrade to a dedicated account (FonPayEdge) ----------
    // Opened with the OWNER's BVN or NIN (exactly one), plus first name, last
    // name and phone. The ID number is passed straight through to FonPayEdge
    // and is NEVER stored or logged here.
    // The business pays a one-time PSA_UPGRADE_FEE from its Bill Wallet:
    //  1. the fee is taken first, in one atomic step (refused if the balance
    //     is too low),
    //  2. then the account is opened,
    //  3. and the fee is REFUNDED automatically if anything fails.
    // FonPayEdge's own charge for opening the account goes to our FonPayEdge
    // wallet (and is refunded to us when the bank declines).
    // Payments into it are credited by fonpayedge-webhook.
    if (action === "upgrade_to_dedicated_account") {
      if (!isMaster) return json({ error: "Only the business owner can upgrade the account." }, 403);
      if (biz.fpe_account_number && biz.fpe_status === "active") {
        return json({ account_number: biz.fpe_account_number, bank_name: biz.fpe_bank_name, status: biz.fpe_status, fee_charged: 0 }, 200);
      }
      if (!FONPAYEDGE_SECRET_KEY) return json({ error: "The upgrade isn't available right now. Please try again later." }, 500);

      // ---- validate what the person typed on the form ----
      const firstName = String(params.first_name ?? "").trim();
      const lastName = String(params.last_name ?? "").trim();
      const phone = String(params.phone ?? "").replace(/[\s-]/g, "");
      const idType = String(params.id_type ?? "").toLowerCase();
      const idNumber = String(params.id_number ?? "").replace(/\s/g, "");
      if (!firstName || !lastName || firstName.length > 100 || lastName.length > 100) {
        return json({ error: "Please enter your first name and last name." }, 400);
      }
      if (!/^\+?\d{7,15}$/.test(phone)) return json({ error: "Please enter a valid phone number." }, 400);
      if (idType !== "bvn" && idType !== "nin") return json({ error: "Please choose BVN or NIN." }, 400);
      if (!/^\d{11}$/.test(idNumber)) return json({ error: `Your ${idType.toUpperCase()} must be exactly 11 digits.` }, 400);

      // ---- 1. take the upgrade fee from the wallet (atomic; refuses if short) ----
      const { error: debitErr } = await admin.rpc("debit_bill_wallet", { p_business_id: String(businessId), p_amount: PSA_UPGRADE_FEE });
      if (debitErr) {
        if (/INSUFFICIENT/i.test(debitErr.message)) {
          return json({ error: `Add at least ₦${PSA_UPGRADE_FEE} to your wallet first.` }, 402);
        }
        console.error("upgrade fee debit failed:", debitErr.message);
        return json({ error: "Could not take the setup fee. Please try again." }, 500);
      }
      const feeLogId = crypto.randomUUID();
      await admin.from("wallet_fee_log").insert({
        id: feeLogId, business_id: String(businessId), amount: PSA_UPGRADE_FEE, kind: "dedicated_account_setup", status: "charged",
      });
      // Gives the fee back (and records why). Used on every failure path.
      const refundFee = async (reason: string) => {
        const { error: refundErr } = await admin.rpc("increment_bill_wallet", { p_business_id: String(businessId), p_amount: PSA_UPGRADE_FEE });
        if (refundErr) console.error("UPGRADE FEE REFUND FAILED for business", businessId, refundErr.message);
        else await admin.from("wallet_fee_log").update({ status: "refunded", note: reason }).eq("id", feeLogId);
      };

      try {
        const fpHeaders = {
          Authorization: `Bearer ${FONPAYEDGE_SECRET_KEY}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        };

        // Turns FonPayEdge's error codes into messages a shop owner can act on.
        const friendlyError = (fp: any): string => {
          const code = fp?.code;
          if (code === "identity_rejected") return "The bank couldn't verify these details. Check your names and your BVN/NIN, then try again.";
          if (code === "validation_failed") {
            const firstMsg = fp?.errors ? (Object.values(fp.errors as Record<string, string[]>)[0] || [])[0] : null;
            return firstMsg || "Some of your details look wrong. Please check them and try again.";
          }
          if (code === "provider_unavailable") return "The bank couldn't be reached right now. Please try again shortly.";
          if (code === "rate_limited") return "Too many tries. Please wait a minute and try again.";
          // insufficient_funds, invalid/rolled key, business_not_approved, server_error…
          // are OUR problem, not the customer's — log for us, keep the message neutral.
          console.error("FonPayEdge createVirtualAccount problem:", code, fp?.message, fp?.requestId);
          return "The upgrade is temporarily unavailable. Please try again later.";
        };

        const reference = String(businessId);
        let fpRes: Response;
        let fpData: any = null;
        try {
          fpRes = await fetch(`${FONPAYEDGE_BASE}/virtual-accounts`, {
            method: "POST",
            headers: fpHeaders,
            body: JSON.stringify({
              reference, firstName, lastName, phone,
              email: walletEmailFor(reference),
              [idType]: idNumber, // sends exactly one of bvn / nin
            }),
          });
          try { fpData = await fpRes.json(); } catch (_e) { /* non-JSON response */ }
        } catch (_e) {
          await refundFee("network error");
          return json({ error: "Could not reach the bank. Your fee was returned — please try again." }, 502);
        }

        let acct = fpData?.data;
        let alreadyExisted = false;

        // The account already exists on FonPayEdge's side (e.g. a save failed
        // last time): they answer 409 duplicate_reference. Find it instead.
        if (fpRes.status === 409 || fpData?.code === "duplicate_reference") {
          alreadyExisted = true;
          acct = null;
          for (let page = 1; page <= 10 && !acct; page++) {
            try {
              const lr = await fetch(`${FONPAYEDGE_BASE}/virtual-accounts?perPage=100&page=${page}`, { headers: fpHeaders });
              const ld = await lr.json();
              if (!lr.ok || !Array.isArray(ld?.data)) break;
              acct = ld.data.find((a: any) => a?.reference === reference) || null;
              if (page >= (ld?.meta?.lastPage || 1)) break;
            } catch (_e) { break; }
          }
          if (!acct) {
            await refundFee("existing account not found");
            return json({ error: "The upgrade is temporarily unavailable. Your fee was returned — please try again later." }, 502);
          }
        } else if (!fpRes.ok || fpData?.success !== true || !acct?.accountNumber) {
          const reason = fpData?.code || `http_${fpRes.status}`;
          await refundFee(reason);
          return json({ error: `${friendlyError(fpData)} Your fee was returned.` }, fpRes.status >= 400 && fpRes.status < 500 ? 422 : 502);
        }

        const accountNumber = String(acct.accountNumber);
        const bankName = acct.bankName || "Bank";
        const { error: saveErr } = await admin.from("businesses").update({
          fpe_account_number: accountNumber, fpe_bank_name: bankName, fpe_status: "active",
        }).eq("id", businessId);
        if (saveErr) {
          // The account IS open on their side but we couldn't store it. Keep
          // the fee (FonPayEdge charged us); trying again finds the account
          // via the 409 path above and returns the fee then.
          console.error("upgrade: account opened but save failed:", saveErr.message);
          return json({ error: "Your account was opened but couldn't be saved. Please tap Upgrade again — you won't be charged twice." }, 500);
        }

        // An account that already existed means FonPayEdge did not charge us
        // again, so give the business its fee back as well.
        if (alreadyExisted) await refundFee("account already existed");

        const { data: fresh } = await admin.from("businesses").select("bill_wallet_balance").eq("id", businessId).maybeSingle();
        return json({
          account_number: accountNumber,
          bank_name: bankName,
          status: "active",
          fee_charged: alreadyExisted ? 0 : PSA_UPGRADE_FEE,
          wallet_balance: Number(fresh?.bill_wallet_balance ?? 0),
          // The name the bank has on record — the app uses it to correct the
          // owner's profile if they typed it differently.
          verified_first_name: acct?.customer?.firstName ?? null,
          verified_last_name: acct?.customer?.lastName ?? null,
        }, 200);
      } catch (e) {
        // Anything unexpected before the account was saved: give the fee back.
        console.error("upgrade_to_dedicated_account error:", e);
        await refundFee("unexpected error");
        return json({ error: "Something went wrong. Your fee was returned — please try again." }, 500);
      }
    }

    // ---------- purchases (debit wallet, call Bigisub, log) ----------
    const PURCHASE_ACTIONS = [
      "airtime_purchase", "data_purchase", "cable_purchase", "electricity_pay",
      "betting_fund", "result_checker_purchase", "isp_smile_topup", "isp_spectranet_topup",
    ];
    if (PURCHASE_ACTIONS.includes(action)) {
      // Enforced once here, centrally, rather than duplicated inside each
      // of the 8 branches in handlePurchase — every purchase goes through
      // this one gate. If no PIN has ever been set for this business,
      // purchases proceed exactly as before (this is opt-in, not forced
      // on existing installs); once a PIN exists, it's required every time.
      if (biz.bill_payments_pin_hash) {
        const suppliedPin = String(params.bill_pin || "");
        const suppliedHash = suppliedPin ? await hashPin(suppliedPin) : null;
        if (!suppliedPin || suppliedHash !== biz.bill_payments_pin_hash) {
          return json({ error: "Incorrect Bill Payments PIN." }, 403);
        }
      }
      const { data: platformSettings } = await admin.from("platform_settings")
        .select("default_markup_percent, data_markup_percent, airtime_markup_percent, cable_markup_percent, result_checker_markup_percent, isp_markup_percent, betting_flat_fee, electricity_flat_fee")
        .eq("id", 1).maybeSingle();
      const pricing: PlatformPricing = {
        default_markup_percent: Number(platformSettings?.default_markup_percent || 0),
        data_markup_percent: Number(platformSettings?.data_markup_percent || 0),
        airtime_markup_percent: Number(platformSettings?.airtime_markup_percent || 0),
        cable_markup_percent: Number(platformSettings?.cable_markup_percent || 0),
        result_checker_markup_percent: Number(platformSettings?.result_checker_markup_percent || 0),
        isp_markup_percent: Number(platformSettings?.isp_markup_percent || 0),
        betting_flat_fee: Number(platformSettings?.betting_flat_fee || 0),
        electricity_flat_fee: Number(platformSettings?.electricity_flat_fee || 0),
      };
      return await handlePurchase(admin, action, params, businessId, biz, pricing, caller.id);
    }

    return json({ error: "Unknown action." }, 400);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "Unexpected error" }, 500);
  }
});

// Looks up a plan/exam's real price from Bigisub's own list endpoint
// before purchasing — used for the services that only receive a plan ID
// (not a naira amount) from the client, so their balance pre-check is a
// real check against what will actually be charged, not just "is the
// balance above zero." Returns null if the plan can't be found or the
// list call fails — callers treat that as "can't verify, don't proceed"
// rather than silently allowing an unchecked purchase.
async function lookupPlanAmount(path: string, preferredKey: string, matchValue: unknown, matchKeys: string[]): Promise<number | null> {
  try {
    const raw = await bigisub("GET", path);
    const list = normalizeList(raw, preferredKey);
    const item = list.find((x: any) => matchKeys.some((k) => String(x?.[k]) === String(matchValue)));
    if (!item) return null;
    const amt = Number(
      item.amount ?? item.price ?? item.plan_amount ?? item.plan_price ?? item.selling_price ??
      item.cost ?? item.cost_price ?? item.api_price ?? item.user_price ?? item.reseller_price
    );
    return Number.isFinite(amt) ? amt : null;
  } catch (_e) {
    return null;
  }
}

// Per-service pricing rules, loaded once per request from the
// platform_settings table (see the header comment for the SQL). This is
// the only margin the platform earns anywhere in this system — there is
// no business-side markup, flat fee, or price override at all.
type PlatformPricing = {
  default_markup_percent: number;
  data_markup_percent: number;
  airtime_markup_percent: number;
  cable_markup_percent: number;
  result_checker_markup_percent: number;
  isp_markup_percent: number;
  betting_flat_fee: number;
  electricity_flat_fee: number;
};

// Decides the actual sale price for a given service. A single blanket
// percentage doesn't work for every service — funding a ₦50,000 betting
// wallet at 2% would add ₦1,000, which isn't how a betting funding fee
// should work — so each service uses whichever unit actually fits it:
//   - percentage, for services with genuinely variable cost (data,
//     airtime, cable, result checker, ISP) — falls back to
//     default_markup_percent if that service's own field is 0/unset.
//   - flat ₦ fee, for the two pass-through services where the exact
//     amount matters (betting funding, electricity tokens).
// Called twice per purchase: once for the pre-check (against the
// estimated cost) and once for the real charge (against Bigisub's actual
// reported cost) — see handlePurchase.
function computeSalePrice(pricingService: string, costPrice: number, pricing: PlatformPricing): number {
  if (pricingService === "betting") {
    return Math.round((costPrice + (pricing.betting_flat_fee || 0)) * 100) / 100;
  }
  if (pricingService === "electricity") {
    return Math.round((costPrice + (pricing.electricity_flat_fee || 0)) * 100) / 100;
  }
  const pctByService: Record<string, number | undefined> = {
    data: pricing.data_markup_percent,
    airtime: pricing.airtime_markup_percent,
    cable: pricing.cable_markup_percent,
    result_checker: pricing.result_checker_markup_percent,
    isp_smile: pricing.isp_markup_percent,
    isp_spectranet: pricing.isp_markup_percent,
  };
  const pct = pctByService[pricingService] || pricing.default_markup_percent || 0;
  return Math.round(costPrice * (1 + pct / 100) * 100) / 100;
}

async function handlePurchase(
  admin: ReturnType<typeof createClient>,
  action: string,
  params: Record<string, unknown>,
  businessId: string,
  biz: { bill_wallet_balance: number | null },
  pricing: PlatformPricing,
  userId: string,
) {
  let serviceLabel = "";
  let recipient = "";
  let estimatedCost = 0; // always resolved to a real, verified amount below before any Bigisub call — see per-branch comments
  let pricingService = ""; // which pricing engine applies — see computeSalePrice
  let planKey: string | null = null; // for catalog-based services, the plan/exam identifier — null for flat-fee services
  let quantity = 1; // only meaningfully >1 for result_checker and ISP-Spectranet
  let bigisubCall: () => Promise<any>;

  if (action === "airtime_purchase") {
    const { network, phone_number, amount } = params as { network: number; phone_number: string; amount: number };
    if (!network || !phone_number || !amount) return json({ error: "Missing network, phone_number, or amount." }, 400);
    serviceLabel = "Airtime"; recipient = String(phone_number); estimatedCost = Number(amount); pricingService = "airtime";
    bigisubCall = () => bigisub("POST", EP.AIRTIME_PURCHASE, { network, phone_number, amount: String(amount), airtime_type: "vtu", pin: BIGISUB_PIN });

  } else if (action === "data_purchase") {
    const { network, phone_number, plan, ported_number } = params as { network: number; phone_number: string; plan: number; ported_number?: boolean };
    if (!network || !phone_number || !plan) return json({ error: "Missing network, phone_number, or plan." }, 400);
    serviceLabel = "Data"; recipient = String(phone_number); pricingService = "data"; planKey = String(plan);
    // Only a plan ID comes from the client — verify its real price against
    // Bigisub's own plan list rather than trusting whatever the client
    // displayed (client-side prices are for UI only, never authoritative).
    const price = await lookupPlanAmount(EP.DATA_PLANS, "plans", plan, ["id"]);
    if (price === null) return json({ error: "Could not verify this plan's price right now — please try again in a moment." }, 502);
    estimatedCost = price;
    bigisubCall = () => bigisub("POST", EP.DATA_PURCHASE, { network, phone_number, plan, pin: BIGISUB_PIN, ported_number: !!ported_number });

  } else if (action === "cable_purchase") {
    const { cable_type, card_no, phone_number, amount, customer_name, plan_id } = params as { cable_type: string; card_no: string; phone_number: string; amount: number; customer_name: string; plan_id?: string | number };
    if (!cable_type || !card_no || !phone_number || !amount || !customer_name) return json({ error: "Missing cable_type, card_no, phone_number, amount, or customer_name (verify the card first)." }, 400);
    serviceLabel = "Cable TV"; recipient = String(card_no); estimatedCost = Number(amount); pricingService = "cable";
    planKey = plan_id != null ? String(plan_id) : null; // older clients without plan_id just fall back to the markup — no override lookup possible without it
    bigisubCall = () => bigisub("POST", EP.CABLE_PURCHASE, { cable_type, card_no, phone_number, amount: Number(amount), Customer: customer_name, pin: BIGISUB_PIN });

  } else if (action === "electricity_pay") {
    const { company, meter_no, meter_type, phone_number, amount, customer_name } = params as { company: string; meter_no: string; meter_type: string; phone_number: string; amount: number; customer_name: string };
    if (!company || !meter_no || !meter_type || !phone_number || !amount || !customer_name) return json({ error: "Missing company, meter_no, meter_type, phone_number, amount, or customer_name (verify the meter first)." }, 400);
    serviceLabel = "Electricity"; recipient = String(meter_no); estimatedCost = Number(amount); pricingService = "electricity";
    bigisubCall = () => bigisub("POST", EP.ELECTRICITY_PAY, { company, meter_no, meter_type, phone_number, amount: Number(amount), Customer_name: customer_name, pin: BIGISUB_PIN });

  } else if (action === "betting_fund") {
    const { biller_code, customer_id, customer_name, amount, validation_reference } = params as { biller_code: string; customer_id: string; customer_name: string; amount: number; validation_reference: string };
    if (!biller_code || !customer_id || !customer_name || !amount || !validation_reference) return json({ error: "Missing biller_code, customer_id, customer_name, amount, or validation_reference (validate first — and don't delay before funding, the reference is short-lived)." }, 400);
    serviceLabel = "Betting Wallet"; recipient = String(customer_id); estimatedCost = Number(amount); pricingService = "betting";
    bigisubCall = () => bigisub("POST", EP.BETTING_FUND, { biller_code, customer_id, customer_name, amount: Number(amount), validation_reference, pin_code: BIGISUB_PIN });

  } else if (action === "result_checker_purchase") {
    const { exam, quantity: qty } = params as { exam: string; quantity: number };
    if (!exam || !qty) return json({ error: "Missing exam or quantity." }, 400);
    serviceLabel = "Result Checker"; recipient = `${exam} × ${qty}`; pricingService = "result_checker"; planKey = String(exam); quantity = Number(qty);
    const unitPrice = await lookupPlanAmount(EP.RESULT_CHECKER_PRICES, "prices", exam, ["exam", "exam_type", "name"]);
    if (unitPrice === null) return json({ error: "Could not verify this exam's price right now — please try again in a moment." }, 502);
    estimatedCost = unitPrice * quantity;
    bigisubCall = () => bigisub("POST", EP.RESULT_CHECKER_PURCHASE, { exam, quantity, pin_code: BIGISUB_PIN });

  } else if (action === "isp_smile_topup") {
    const { plan, phone_number, email, account_id } = params as { plan: number; phone_number: string; email: string; account_id: string };
    if (!plan || !phone_number || !email || !account_id) return json({ error: "Missing plan, phone_number, email, or account_id (verify the account first)." }, 400);
    serviceLabel = "ISP — Smile"; recipient = String(account_id); pricingService = "isp_smile"; planKey = String(plan);
    const price = await lookupPlanAmount(EP.ISP_SMILE_PLANS, "plans", plan, ["id"]);
    if (price === null) return json({ error: "Could not verify this plan's price right now — please try again in a moment." }, 502);
    estimatedCost = price;
    bigisubCall = () => bigisub("POST", EP.ISP_SMILE_TOPUP, { plan, phone_number, email, account_id, pin: BIGISUB_PIN });

  } else { // isp_spectranet_topup
    const { plan, phone_number, spectranet_number, quantity: qty } = params as { plan: number; phone_number: string; spectranet_number: string; quantity: number };
    if (!plan || !phone_number || !spectranet_number || !qty) return json({ error: "Missing plan, phone_number, spectranet_number, or quantity." }, 400);
    serviceLabel = "ISP — Spectranet"; recipient = String(spectranet_number); pricingService = "isp_spectranet"; planKey = String(plan); quantity = Number(qty);
    const unitPrice = await lookupPlanAmount(EP.ISP_SPECTRANET_PLANS, "plans", plan, ["id"]);
    if (unitPrice === null) return json({ error: "Could not verify this plan's price right now — please try again in a moment." }, 502);
    estimatedCost = unitPrice * quantity;
    bigisubCall = () => bigisub("POST", EP.ISP_SPECTRANET_TOPUP, { plan, phone_number, spectranet_number, quantity, pin: BIGISUB_PIN });
  }

  const preCheckBalance = Number(biz.bill_wallet_balance || 0);
  const estimatedSale = computeSalePrice(pricingService, estimatedCost, pricing);
  if (preCheckBalance < estimatedSale) return json({ error: "Insufficient Bill Wallet balance. Please top up." }, 400);

  // ---- Idempotency: reserve a row BEFORE calling Bigisub, keyed on the
  // client's per-attempt reference, so a retry after a timeout — or an
  // accidental double-tap — can't result in two real purchases. The
  // client is expected to reuse the same client_ref across retries of the
  // same attempt (see app.html) and only generate a new one for a genuinely
  // new purchase. A unique index on (business_id, client_ref) is what
  // actually enforces this — if two requests for the same client_ref
  // somehow race each other, only one wins the insert below; the other
  // gets redirected to read that same row's result instead of calling
  // Bigisub a second time.
  const clientRef = (params.client_ref as string | undefined) || null;
  const serviceKey = action.replace("_purchase", "").replace("_pay", "").replace("_fund", "").replace("_topup", "");
  let txId = crypto.randomUUID();

  if (clientRef) {
    const { error: reserveErr } = await admin.from("bill_transactions").insert({
      id: txId, business_id: businessId, user_id: userId, service: serviceKey,
      service_label: serviceLabel, recipient, cost_price: estimatedCost, sale_price: 0,
      status: "pending", client_ref: clientRef,
    });
    if (reserveErr) {
      // Unique-constraint conflict = this exact attempt was already made —
      // replay its stored result instead of purchasing again.
      const { data: existing } = await admin.from("bill_transactions").select("*").eq("business_id", businessId).eq("client_ref", clientRef).maybeSingle();
      if (existing) {
        const { data: freshBiz } = await admin.from("businesses").select("bill_wallet_balance").eq("id", businessId).maybeSingle();
        return json({
          ok: existing.status !== "failed", wallet_balance: Number(freshBiz?.bill_wallet_balance || preCheckBalance),
          status: existing.status, token: existing.bigisub_response?.token || null,
          pins: existing.bigisub_response?.pins || null, bigisub_response: existing.bigisub_response, replayed: true,
        }, 200);
      }
      // Conflict happened but the row vanished somehow (shouldn't occur) —
      // fall through and proceed with a fresh id rather than getting stuck.
      txId = crypto.randomUUID();
    }
  }

  let bigisubResponse: any;
  try {
    bigisubResponse = await bigisubCall();
  } catch (e) {
    const failedUpdate = { status: "failed", cost_price: estimatedCost, sale_price: 0, bigisub_response: { error: e instanceof Error ? e.message : String(e) } };
    if (clientRef) await admin.from("bill_transactions").update(failedUpdate).eq("id", txId);
    else await admin.from("bill_transactions").insert({ id: txId, business_id: businessId, user_id: userId, service: serviceKey, service_label: serviceLabel, recipient, ...failedUpdate });
    return json({ error: e instanceof Error ? e.message : "Purchase failed." }, 502);
  }

  const costPrice = extractCost(bigisubResponse, estimatedCost);
  // Recomputed against Bigisub's ACTUAL reported cost, not just the
  // pre-check estimate — for flat-fee services this can differ slightly
  // if Bigisub's real charge isn't exactly what was estimated; for
  // override-priced plans it's identical to estimatedSale either way,
  // since a fixed sell price doesn't depend on the underlying cost at all.
  const salePrice = computeSalePrice(pricingService, costPrice, pricing);
  const bigisubTranxId = extractTranxId(bigisubResponse);
  const status = extractStatus(bigisubResponse);

  // Best-effort balance debit: a business with two staff transacting in
  // the same split-second could theoretically race this read-then-write.
  // Acceptable for low-volume single-shop usage; revisit with a Postgres
  // RPC (atomic decrement) if you scale to high concurrency.
  const newBalance = Math.max(0, preCheckBalance - salePrice);
  await admin.from("businesses").update({ bill_wallet_balance: newBalance }).eq("id", businessId);

  const finalFields = { cost_price: costPrice, sale_price: salePrice, status, bigisub_tranx_id: bigisubTranxId, bigisub_response: bigisubResponse };
  if (clientRef) await admin.from("bill_transactions").update(finalFields).eq("id", txId);
  else await admin.from("bill_transactions").insert({ id: txId, business_id: businessId, user_id: userId, service: serviceKey, service_label: serviceLabel, recipient, ...finalFields });

  return json({
    ok: true, wallet_balance: newBalance, status, token: bigisubResponse?.token || null,
    pins: bigisubResponse?.pins || null, bigisub_response: bigisubResponse,
  }, 200);
}

function json(body: Record<string, unknown>, status: number) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
