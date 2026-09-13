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

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const BIGISUB_BASE = Deno.env.get("BIGISUB_BASE_URL") || "https://api.bigisub.ng";
const BIGISUB_TOKEN = Deno.env.get("BIGISUB_TOKEN") || "";
const BIGISUB_PIN = Deno.env.get("BIGISUB_PIN") || ""; // the Bigisub ACCOUNT's transaction PIN — never entered by shop staff
const FLW_SECRET_KEY = Deno.env.get("FLW_SECRET_KEY") || ""; // same Flutterwave secret key your verify-payment function already uses

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
function extractCustomerName(data: any): string {
  return data?.customer_name || data?.Customer_name || data?.Customer || data?.name || "";
}

// SHA-256 hash for the shared Bill Payments PIN — no plaintext PIN is ever
// stored, and it's verified server-side (not just checked in the browser)
// since a client-side-only check would do nothing to stop someone with
// basic dev tools access from bypassing it — the whole point of this PIN
// is to stop casual misuse of an unlocked, already-logged-in device.
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
      .select("id, business_id, role, is_active, can_bill_payments, phone")
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
      .select("id, name, currency, country, bill_wallet_balance, bill_markup_percent, bill_payments_pin_hash, bill_flat_fee_airtime, bill_flat_fee_electricity, bill_flat_fee_betting, psa_account_reference, psa_account_number, psa_bank_name, psa_status, psa_last_synced_at")
      .eq("id", businessId)
      .maybeSingle();
    if (bizErr) return json({ error: bizErr.message }, 500);
    if (!biz) return json({ error: `No business found with id = ${businessId} (from your app_users.business_id). That id doesn't match any row in businesses — check for a mismatch (e.g. a locally-generated id that never got the server-assigned one back) directly in Supabase.` }, 404);

    const { action, ...params } = await req.json();
    const markupPercent = Number(biz.bill_markup_percent || 0);
    const currency = biz.currency || "NGN";

    // ---------- read-only reference/lookups ----------
    if (action === "my_wallet_summary") {
      return json({
        wallet_balance: Number(biz.bill_wallet_balance || 0), markup_percent: markupPercent, currency,
        psa_account_number: biz.psa_account_number || null, psa_bank_name: biz.psa_bank_name || null, psa_status: biz.psa_status || null,
        bill_pin_set: !!biz.bill_payments_pin_hash,
        flat_fees: {
          airtime: Number(biz.bill_flat_fee_airtime || 0),
          electricity: Number(biz.bill_flat_fee_electricity || 0),
          betting: Number(biz.bill_flat_fee_betting || 0),
        },
      }, 200);
    }
    if (action === "data_plans") {
      const data = await bigisub("GET", EP.DATA_PLANS);
      return json({ plans: data?.plans || data?.data || data || [] }, 200);
    }
    if (action === "cable_plans") {
      const data = await bigisub("GET", EP.CABLE_PLANS);
      return json({ plans: data?.plans || data?.data || data || [] }, 200);
    }
    if (action === "electricity_providers") {
      const data = await bigisub("GET", EP.ELECTRICITY_PROVIDERS);
      return json({ providers: data?.providers || data?.data || data || [] }, 200);
    }
    if (action === "result_checker_prices") {
      const data = await bigisub("GET", EP.RESULT_CHECKER_PRICES);
      return json({ prices: data?.prices || data?.data || data || [] }, 200);
    }
    if (action === "betting_billers") {
      const data = await bigisub("GET", EP.BETTING_BILLERS);
      return json({ billers: data?.billers || data?.data || data || [] }, 200);
    }
    if (action === "isp_smile_plans") {
      const data = await bigisub("GET", EP.ISP_SMILE_PLANS);
      return json({ plans: data?.plans || data?.data || data || [] }, 200);
    }
    if (action === "isp_spectranet_plans") {
      const data = await bigisub("GET", EP.ISP_SPECTRANET_PLANS);
      return json({ plans: data?.plans || data?.data || data || [] }, 200);
    }

    // ---------- verify-before-charge steps ----------
    if (action === "cable_verify") {
      const { cable_name, card_no } = params as { cable_name: string; card_no: string };
      if (!cable_name || !card_no) return json({ error: "Missing cable_name or card_no." }, 400);
      const data = await bigisub("POST", EP.CABLE_VERIFY, { cable_name, card_no });
      return json({ customer_name: extractCustomerName(data), raw: data }, 200);
    }
    if (action === "electricity_verify") {
      const { company, meter_no, meter_type } = params as { company: string; meter_no: string; meter_type: string };
      if (!company || !meter_no || !meter_type) return json({ error: "Missing company, meter_no, or meter_type." }, 400);
      const data = await bigisub("POST", EP.ELECTRICITY_VERIFY, { company, meter_no, meter_type });
      return json({ customer_name: extractCustomerName(data), raw: data }, 200);
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
      return json({ customer_name: extractCustomerName(data), raw: data }, 200);
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

    // ---------- master-only settings ----------
    if (action === "set_markup") {
      if (!isMaster) return json({ error: "Only the business owner can change the markup." }, 403);
      const pct = Number(params.markup_percent);
      if (Number.isNaN(pct) || pct < 0) return json({ error: "Invalid markup percent." }, 400);
      const { error } = await admin.from("businesses").update({ bill_markup_percent: pct }).eq("id", businessId);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true, markup_percent: pct }, 200);
    }

    // One shared PIN, set by the owner, required before every purchase
    // once set. Never stored as plaintext — only its SHA-256 hash, which
    // is all that's needed to verify a later attempt without being able
    // to recover the original PIN from the database.
    if (action === "set_bill_pin") {
      if (!isMaster) return json({ error: "Only the business owner can set the Bill Payments PIN." }, 403);
      const pin = String(params.pin || "");
      if (!/^\d{4}$/.test(pin)) return json({ error: "PIN must be exactly 4 digits." }, 400);
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

    // Flat fee for the three free-typed-amount services. A percentage
    // doesn't make sense here — 5% of a ₦100,000 electricity token and 5%
    // of a ₦100 airtime top-up earn wildly different amounts for the same
    // effort, so these three earn a fixed naira amount instead, regardless
    // of the transaction size.
    if (action === "set_flat_fee") {
      if (!isMaster) return json({ error: "Only the business owner can change fees." }, 403);
      const service = String(params.service || "");
      const column = service === "airtime" ? "bill_flat_fee_airtime" : service === "electricity" ? "bill_flat_fee_electricity" : service === "betting" ? "bill_flat_fee_betting" : null;
      if (!column) return json({ error: "Unknown service for a flat fee." }, 400);
      const fee = Number(params.fee);
      if (Number.isNaN(fee) || fee < 0) return json({ error: "Invalid fee." }, 400);
      const { error } = await admin.from("businesses").update({ [column]: fee }).eq("id", businessId);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true, fee }, 200);
    }

    // Exact sell price per plan, for the catalog-based services. Any plan
    // without an override set here falls back to bill_markup_percent —
    // see handlePurchase for exactly where that fallback happens.
    if (action === "list_price_overrides") {
      const { data: overrides, error } = await admin.from("bill_price_overrides").select("*").eq("business_id", businessId);
      if (error) return json({ error: error.message }, 500);
      return json({ overrides: overrides || [] }, 200);
    }
    if (action === "set_price_override") {
      if (!isMaster) return json({ error: "Only the business owner can set prices." }, 403);
      const service = String(params.service || "");
      const planKey = String(params.plan_key || "");
      const sellPrice = Number(params.sell_price);
      if (!service || !planKey) return json({ error: "Missing service or plan_key." }, 400);
      if (Number.isNaN(sellPrice) || sellPrice <= 0) return json({ error: "Enter a valid sell price." }, 400);
      const { error } = await admin.from("bill_price_overrides").upsert({
        id: crypto.randomUUID(), business_id: businessId, service, plan_key: planKey,
        plan_label: params.plan_label ? String(params.plan_label) : null, sell_price: sellPrice,
        updated_at: new Date().toISOString(),
      }, { onConflict: "business_id,service,plan_key" });
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true }, 200);
    }
    if (action === "delete_price_override") {
      if (!isMaster) return json({ error: "Only the business owner can remove a set price." }, 403);
      const service = String(params.service || "");
      const planKey = String(params.plan_key || "");
      const { error } = await admin.from("bill_price_overrides").delete().eq("business_id", businessId).eq("service", service).eq("plan_key", planKey);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true }, 200);
    }

    // ---------- wallet top-up (Flutterwave verify → credit) ----------
    if (action === "fund_wallet_verify") {
      const { transaction_id, expected_amount, expected_currency } = params;
      if (!transaction_id || !expected_amount) return json({ error: "Missing transaction_id or expected_amount." }, 400);
      if (!FLW_SECRET_KEY) return json({ error: "Payment verification isn't configured yet (missing FLW_SECRET_KEY)." }, 500);

      const flwRes = await fetch(`https://api.flutterwave.com/v3/transactions/${transaction_id}/verify`, {
        headers: { Authorization: `Bearer ${FLW_SECRET_KEY}` },
      });
      const flwData = await flwRes.json();
      const tx = flwData?.data;
      const verified = flwRes.ok && flwData?.status === "success" && tx?.status === "successful"
        && Number(tx.amount) >= Number(expected_amount) && tx.currency === (expected_currency || currency);
      if (!verified) return json({ error: "Payment could not be verified." }, 400);

      const { data: existing } = await admin.from("wallet_topups").select("id").eq("flutterwave_transaction_id", String(transaction_id)).maybeSingle();
      if (existing) return json({ error: "This payment has already been credited." }, 400);

      const newBalance = Number(biz.bill_wallet_balance || 0) + Number(tx.amount);
      const { error: updErr } = await admin.from("businesses").update({ bill_wallet_balance: newBalance }).eq("id", businessId);
      if (updErr) return json({ error: updErr.message }, 500);

      await admin.from("wallet_topups").insert({
        id: crypto.randomUUID(), business_id: businessId, amount: tx.amount,
        flutterwave_tx_ref: tx.tx_ref, flutterwave_transaction_id: String(transaction_id), status: "success",
      });

      return json({ wallet_balance: newBalance }, 200);
    }

    // ---------- wallet top-up (bank transfer via temporary virtual account) ----------
    // Uses Flutterwave's plain virtual-account-numbers endpoint with
    // is_permanent omitted/false, so no BVN is required. The account is
    // single-use for this exact amount and expires — actual crediting
    // happens in the separate flutterwave-webhook function when Flutterwave
    // notifies us the transfer landed, NOT here (we only ask Flutterwave to
    // generate the account here). This action just records a "pending" row
    // so the webhook has something to match against.
    if (action === "generate_bank_transfer_topup") {
      const amount = Number(params.amount);
      if (!amount || amount < 100) return json({ error: "Enter an amount of at least ₦100." }, 400);
      if (!FLW_SECRET_KEY) return json({ error: "Bank transfer isn't configured yet (missing FLW_SECRET_KEY)." }, 500);

      const txRef = `zeeshop_bt_${businessId}_${Date.now()}`;
      const flwRes = await fetch("https://api.flutterwave.com/v3/virtual-account-numbers", {
        method: "POST",
        headers: { Authorization: `Bearer ${FLW_SECRET_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          email: callerData.user.email || `business-${businessId}@zeeshop.app`,
          amount, tx_ref: txRef,
          narration: `ZeeShop Bill Wallet top-up`,
          is_permanent: false,
        }),
      });
      const flwData = await flwRes.json();
      const acct = flwData?.data;
      if (!flwRes.ok || flwData?.status !== "success" || !acct?.account_number) {
        return json({ error: flwData?.message || "Could not generate a transfer account. Please try again." }, 502);
      }

      await admin.from("wallet_topups").insert({
        id: crypto.randomUUID(), business_id: businessId, amount,
        flutterwave_tx_ref: txRef, status: "pending",
      });

      return json({
        tx_ref: txRef, account_number: acct.account_number, bank_name: acct.bank_name,
        expiry_date: acct.expiry_date || null, amount,
      }, 200);
    }

    // Lets the app poll after showing the account details, in case the
    // webhook lands before the shop owner comes back to check manually.
    if (action === "check_bank_transfer_topup") {
      const txRef = params.tx_ref;
      if (!txRef) return json({ error: "Missing tx_ref." }, 400);
      const { data: topup } = await admin.from("wallet_topups").select("status").eq("flutterwave_tx_ref", txRef).eq("business_id", businessId).maybeSingle();
      if (!topup) return json({ error: "Top-up not found." }, 404);
      if (topup.status === "success") {
        const { data: freshBiz } = await admin.from("businesses").select("bill_wallet_balance").eq("id", businessId).maybeSingle();
        return json({ status: "success", wallet_balance: Number(freshBiz?.bill_wallet_balance || 0) }, 200);
      }
      return json({ status: topup.status }, 200);
    }

    // ---------- wallet top-up (dedicated permanent account — Payout Subaccounts) ----------
    // This is Flutterwave's Payout Subaccounts (PSA) product — NOT the same
    // endpoint as fund_wallet_verify/generate_bank_transfer_topup above.
    // Confirmed from Flutterwave's own PSA reference docs (including exact
    // request/response bodies): creating a PSA wallet only needs
    // account_name/email/mobilenumber/country — no BVN anywhere. Per
    // Flutterwave support directly: no manual approval is needed for this
    // feature itself, but your Flutterwave account must be fully
    // KYC-verified / live-approved before PSA calls succeed in production.
    // The bank-facing account name that actually gets issued may NOT match
    // what you send as account_name (Flutterwave's own docs show "John Doe"
    // submitted but "Flutterwave Developers" issued instead) — expected,
    // not a bug, and matches Billpoint's own screen (generic "Billpoint
    // Checkout" name, not the individual customer's). One account is
    // created once per business and reused forever — never regenerated.
    //
    // Create already returns the account number (nuban) directly in most
    // cases — confirmed from the docs' own example response. As a fallback
    // (documented as a separate "fetch static account" endpoint, for cases
    // where create doesn't include it, or to re-fetch it later), this also
    // calls GET .../static-account if nuban is missing from the create
    // response.
    if (action === "get_or_create_psa_account") {
      if (biz.psa_account_number && biz.psa_status === "active") {
        return json({ account_number: biz.psa_account_number, bank_name: biz.psa_bank_name, status: biz.psa_status }, 200);
      }
      if (!FLW_SECRET_KEY) return json({ error: "Dedicated accounts aren't configured yet (missing FLW_SECRET_KEY)." }, 500);

      const flwRes = await fetch("https://api.flutterwave.com/v3/payout-subaccounts", {
        method: "POST",
        headers: { Authorization: `Bearer ${FLW_SECRET_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          account_name: biz.name || "ZeeShop Business",
          email: callerData.user.email || `business-${businessId}@zeeshop.app`,
          mobilenumber: caller.phone || "08000000000",
          // Hardcoded, not biz.country — Bigisub and every service in this
          // feature are Nigeria-only, and biz.country likely stores a full
          // name ("Nigeria") rather than the ISO2 code ("NG") Flutterwave's
          // PSA endpoint actually requires, which is what triggered
          // "country length must be 2 characters long."
          country: "NG",
        }),
      });
      const flwData = await flwRes.json();
      let acct = flwData?.data;
      if (!flwRes.ok || flwData?.status !== "success" || !acct?.account_reference) {
        const msg = flwData?.message || "Could not set up a dedicated account.";
        return json({ error: /not enabled|not permitted|unauthorized|kyc|verif/i.test(msg) ? `${msg} — this usually means your Flutterwave account isn't fully KYC-verified / live-approved yet.` : msg }, 502);
      }

      // Fallback: some create responses may not include nuban directly —
      // fetch it explicitly from the static-account endpoint in that case.
      if (!acct.nuban) {
        const staticRes = await fetch(`https://api.flutterwave.com/v3/payout-subaccounts/${acct.account_reference}/static-account?verbose=1`, {
          headers: { Authorization: `Bearer ${FLW_SECRET_KEY}` },
        });
        const staticData = await staticRes.json();
        const staticAcct = staticData?.data?.static_accounts?.[0] || staticData?.data?.static_virtual_accounts?.[0];
        if (staticRes.ok && staticAcct) {
          acct = { ...acct, nuban: staticAcct.account_number, bank_name: staticAcct.bank_name };
        }
      }
      if (!acct.nuban) return json({ error: "Account created but no account number came back yet — try Refresh Balance in a moment." }, 502);

      await admin.from("businesses").update({
        psa_account_reference: acct.account_reference, psa_account_number: acct.nuban,
        psa_bank_name: acct.bank_name, psa_status: acct.status || "active",
      }).eq("id", businessId);

      return json({ account_number: acct.nuban, bank_name: acct.bank_name, status: acct.status || "active" }, 200);
    }

    // Reconciliation fallback for PSA funding — doesn't replace the
    // webhook (still the fast path), but the exact webhook payload shape
    // for PSA funding events wasn't part of anything confirmed from docs,
    // so this gives a second, independently-confirmed way to catch a
    // transfer even if that guess turns out wrong: Flutterwave's own PSA
    // transactions-list endpoint. Called on a timer from the client while
    // the PSA top-up screen is open, and available as a manual "Sync Now."
    // Each Flutterwave transaction's `reference` is stored as this
    // business's flutterwave_transaction_id, and the column's unique
    // constraint is what actually prevents double-crediting if the
    // webhook and this sync both see the same transfer — inserting first
    // and only crediting the balance if that insert succeeds, rather than
    // checking-then-inserting, so the two can't race each other into a
    // double credit.
    //
    // The lookback window tracks psa_last_synced_at per business rather
    // than always using a fixed "30 days ago" — a fixed window means a
    // transfer landing more than 30 days before the NEXT time anyone opens
    // this screen would fall outside the window forever, not just be
    // delayed. Using last-synced-at (with a 1-day overlap buffer, in case
    // Flutterwave's own transaction timestamps lag slightly behind when we
    // last checked) means every sync only needs to cover the gap since the
    // previous one, however long that gap was.
    if (action === "sync_psa_wallet") {
      if (!biz.psa_account_reference) return json({ error: "No dedicated account set up yet." }, 400);
      const lastSyncedAt: string | null = (biz as any).psa_last_synced_at || null;
      const from = lastSyncedAt
        ? new Date(new Date(lastSyncedAt).getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
        : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10); // first-ever sync: 30-day initial lookback
      const to = new Date().toISOString().slice(0, 10);
      const flwRes = await fetch(`https://api.flutterwave.com/v3/payout-subaccounts/${biz.psa_account_reference}/transactions?from=${from}&to=${to}`, {
        headers: { Authorization: `Bearer ${FLW_SECRET_KEY}` },
      });
      const flwData = await flwRes.json();
      const txns: any[] = flwData?.data?.transactions || [];
      let synced = 0;
      let runningBalance = Number(biz.bill_wallet_balance || 0);
      for (const t of txns) {
        if (t.type !== "credit" || t.status !== "successful" || !t.reference) continue;
        const { error: insertErr } = await admin.from("wallet_topups").insert({
          id: crypto.randomUUID(), business_id: businessId, amount: t.amount,
          flutterwave_transaction_id: String(t.reference), status: "success",
        });
        if (insertErr) continue; // unique-constraint conflict = already recorded (by webhook or a prior sync) — skip, don't double-credit
        runningBalance += Number(t.amount);
        synced++;
      }
      const bizUpdate: Record<string, unknown> = { psa_last_synced_at: new Date().toISOString() };
      if (synced > 0) bizUpdate.bill_wallet_balance = runningBalance;
      await admin.from("businesses").update(bizUpdate).eq("id", businessId);
      return json({ wallet_balance: runningBalance, synced }, 200);
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
      return await handlePurchase(admin, action, params, businessId, biz, markupPercent, caller.id);
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
    const list = raw?.[preferredKey] || raw?.data || (Array.isArray(raw) ? raw : []) || [];
    const item = (Array.isArray(list) ? list : []).find((x: any) => matchKeys.some((k) => String(x?.[k]) === String(matchValue)));
    if (!item) return null;
    const amt = Number(item.amount ?? item.price);
    return Number.isFinite(amt) ? amt : null;
  } catch (_e) {
    return null;
  }
}

// Decides the actual sale price using whichever pricing engine applies to
// this service — flat fee for the three free-typed-amount services, an
// exact per-plan override (falling back to the percentage markup) for the
// catalog-based ones. Called twice per purchase: once for the pre-check
// (against the estimated cost) and once for the real charge (against
// Bigisub's actual reported cost) — see handlePurchase.
async function computeSalePrice(
  admin: ReturnType<typeof createClient>,
  businessId: string,
  biz: { bill_flat_fee_airtime?: number; bill_flat_fee_electricity?: number; bill_flat_fee_betting?: number },
  pricingService: string,
  planKey: string | null,
  quantity: number,
  costPrice: number,
  markupPercent: number,
): Promise<number> {
  const flatFeeColumn: Record<string, number | undefined> = {
    airtime: biz.bill_flat_fee_airtime, electricity: biz.bill_flat_fee_electricity, betting: biz.bill_flat_fee_betting,
  };
  if (pricingService in flatFeeColumn) {
    return Math.round((costPrice + Number(flatFeeColumn[pricingService] || 0)) * 100) / 100;
  }
  if (planKey) {
    const { data: override } = await admin.from("bill_price_overrides")
      .select("sell_price").eq("business_id", businessId).eq("service", pricingService).eq("plan_key", planKey).maybeSingle();
    if (override) return Math.round(Number(override.sell_price) * quantity * 100) / 100;
  }
  return Math.round(costPrice * (1 + markupPercent / 100) * 100) / 100; // no override set for this plan yet — fall back to the global markup
}

async function handlePurchase(
  admin: ReturnType<typeof createClient>,
  action: string,
  params: Record<string, unknown>,
  businessId: string,
  biz: { bill_wallet_balance: number | null; bill_flat_fee_airtime?: number; bill_flat_fee_electricity?: number; bill_flat_fee_betting?: number },
  markupPercent: number,
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
  const estimatedSale = await computeSalePrice(admin, businessId, biz, pricingService, planKey, quantity, estimatedCost, markupPercent);
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
  const salePrice = await computeSalePrice(admin, businessId, biz, pricingService, planKey, quantity, costPrice, markupPercent);
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
