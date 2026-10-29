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
//  2. Pay now by card / bank / USSD / transfer through Squad checkout. This
//     lives in its own function: squad-initiate (start + verify) and
//     squad-webhook (credit). Nothing about Squad is handled in this file.
const FLW_SECRET_KEY = Deno.env.get("FLW_SECRET_KEY") || "";
// Only used by the sync fallback below, whose Flutterwave endpoint doesn't
// report fees; the webhook uses Flutterwave's own fee figure.
const FLW_ESTIMATED_FEE_PERCENT = Number(Deno.env.get("FLW_ESTIMATED_FEE_PERCENT")) || 2.0;

// The account name shown to people who send money = the business name, cleaned so Flutterwave never rejects it
// (odd characters / emoji), max 60 characters.
function cleanPsaName(name: unknown): string {
  return String(name || "").normalize("NFKD").replace(/[^\p{L}\p{N} &.'-]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 60) || "ZeeShop Business";
}

// ---- Flutterwave account fee: admin-editable (Super Admin -> Platform Pricing), never hard-coded ----
type FlwFeeRule = { type: string; value: number; cap: number };
async function loadFlwFeeRule(admin: any): Promise<FlwFeeRule | null> {
  try {
    const { data, error } = await admin.from("platform_settings").select("flw_fee_type, flw_fee_value, flw_fee_cap").eq("id", 1).maybeSingle();
    if (error || !data || !data.flw_fee_type) return null;      // not configured yet -> caller falls back to the old estimate
    return { type: String(data.flw_fee_type), value: Number(data.flw_fee_value || 0), cap: Number(data.flw_fee_cap || 0) };
  } catch (_e) { return null; }
}
function computeFlwFee(gross: number, rule: FlwFeeRule): number {
  let fee = 0;
  if (rule.type === "percentage") { fee = (gross * rule.value) / 100; if (rule.cap > 0) fee = Math.min(fee, rule.cap); }
  else if (rule.type === "flat") fee = rule.value;
  fee = Math.round(fee * 100) / 100;
  return Math.min(Math.max(fee, 0), gross);
}


// ---- Email receipts ------------------------------------------------------
// Sent through the notify-email function. Fire-and-forget: a failed or slow
// email can NEVER block, delay or roll back a purchase or a wallet credit.
function fireEmail(payload: Record<string, unknown>) {
  try {
    const p = fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/notify-email`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}` },
      body: JSON.stringify(payload),
    }).catch((e) => console.warn("notify-email call failed:", e instanceof Error ? e.message : e));
    // deno-lint-ignore no-explicit-any
    const rt = (globalThis as any).EdgeRuntime;
    if (rt && typeof rt.waitUntil === "function") rt.waitUntil(p);
  } catch (e) { console.warn("fireEmail error:", e instanceof Error ? e.message : e); }
}
const NETWORK_NAMES: Record<string, string> = { "1": "MTN", "2": "GLO", "3": "AIRTEL", "4": "9MOBILE" };
const RECIPIENT_LABEL: Record<string, string> = {
  cable: "Smartcard / IUC number", isp_smile: "Smile account ID", isp_spectranet: "Spectranet number",
  betting: "Betting account ID", result_checker: "Exam × quantity",
};
// A human plan name for the receipt ("2GB - 30 days"), never "0GB".
function describePlan(item: any): string {
  if (!item || typeof item !== "object") return "";
  const sizeRe = /(\d+(?:[.,]\d+)?)\s*(TB|GB|MB|KB)(?![A-Za-z])/i;
  const validity = String(item.validity ?? item.plan_validity ?? item.duration ?? "").trim();
  const withValidity = (s: string) => (validity && !s.toLowerCase().includes(validity.toLowerCase()) ? `${s} - ${validity}` : s);
  for (const k of ["plan_name", "name", "product_name", "title", "plan", "size", "plan_size", "data_size", "label", "description"]) {
    const v = item[k];
    if (typeof v === "string" && v.trim()) {
      const m = v.match(sizeRe);
      if (m && parseFloat(m[1].replace(",", ".")) > 0) return withValidity(v.trim().length <= 70 ? v.trim() : `${m[1]}${m[2].toUpperCase()}`);
    }
  }
  const vol = Number(item.plan_volume ?? item.volume ?? item.data_volume);
  const unit = String(item.unit ?? item.data_unit ?? item.size_unit ?? "").toUpperCase();
  if (Number.isFinite(vol) && vol > 0 && /^(KB|MB|GB|TB)$/.test(unit)) return withValidity(`${vol}${unit}`);
  for (const k of ["plan_name", "name", "product_name", "title", "label", "description"]) {
    const v = item[k];
    if (typeof v === "string" && v.trim() && !/^\d+$/.test(v.trim())) return withValidity(v.trim().slice(0, 70));
  }
  return "";
}
function deepFindAny(obj: any, keys: string[], depth = 0): string {
  if (!obj || typeof obj !== "object" || depth > 6) return "";
  const byNorm: Record<string, unknown> = {};
  for (const k of Object.keys(obj)) byNorm[k.toLowerCase().replace(/[^a-z0-9]/g, "")] = obj[k];
  for (const want of keys) {
    const v = byNorm[want.toLowerCase().replace(/[^a-z0-9]/g, "")];
    if ((typeof v === "string" && v.trim()) || (typeof v === "number" && Number.isFinite(v))) return String(v).trim();
  }
  for (const v of Object.values(obj)) {
    if (v && typeof v === "object") { const f = deepFindAny(v, keys, depth + 1); if (f) return f; }
  }
  return "";
}
function pinsToText(pins: any): string {
  if (!pins) return "";
  const arr = Array.isArray(pins) ? pins : [pins];
  return arr.map((p) => (typeof p === "string" || typeof p === "number" ? String(p) : Object.values(p || {}).join(" / "))).join("; ");
}
type ReceiptCtx = {
  to?: string | null; name?: string; serviceLabel: string; recipient: string; amount: number; reference: string; newBalance: number;
  provider?: string; planName?: string; token?: string; units?: string; meterType?: string; customerName?: string; customerPhone?: string; customerAddress?: string; txId?: string; createdAt?: string; extra?: { label: string; value: string; mono?: boolean }[];
};
function receiptPayload(service: string, c: ReceiptCtx): Record<string, unknown> {
  const base = { to: c.to, name: c.name };
  if (service === "electricity") {
    return { type: "electricity_token", ...base, data: {
      provider: c.provider, meter_number: c.recipient, meter_type: c.meterType, customer_name: c.customerName,
      customer_phone: c.customerPhone, customer_address: c.customerAddress, tx_id: c.txId, created_at: c.createdAt,
      token: c.token, units: c.units, amount: c.amount, reference: c.reference, new_balance: c.newBalance } };
  }
  if (service === "airtime" || service === "data") {
    return { type: "vtu_purchase", ...base, data: {
      service: c.serviceLabel, phone: c.recipient, network: c.provider, plan: c.planName,
      amount: c.amount, reference: c.reference, new_balance: c.newBalance } };
  }
  return { type: "bill_payment", ...base, data: {
    service: c.serviceLabel, provider: c.provider, recipient: c.recipient, recipient_label: RECIPIENT_LABEL[service],
    plan: c.planName, extra: c.extra, amount: c.amount, reference: c.reference, new_balance: c.newBalance } };
}

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

// Bigisub wraps every reply as { success, data: {...}, message }. The real
// fields (status, amount, transaction_id, token, pins …) live INSIDE `data`.
// These helpers read that inner object; they used to read the top level,
// where none of those fields exist — so every purchase looked "successful"
// and the real cost and Bigisub reference were never recorded.
function inner(body: any): any {
  return body && typeof body.data === "object" && body.data !== null && !Array.isArray(body.data) ? body.data : (body || {});
}
// What Bigisub actually took from our Bigisub wallet for this purchase.
// total_amount / pay_amount include any provider charge; plain `amount`
// is the fallback. Never plan_amount first — that's the retail list price.
function extractCost(body: any, fallback: number): number {
  const d = inner(body);
  for (const k of ["total_amount", "pay_amount", "amount_charged", "amount"]) {
    const n = Number(d?.[k]);
    if (d?.[k] !== undefined && d?.[k] !== null && Number.isFinite(n) && n > 0) return n;
  }
  if (d.balance_before != null && d.balance_after != null) {
    const diff = Number(d.balance_before) - Number(d.balance_after);
    if (!Number.isNaN(diff) && diff > 0) return diff;
  }
  return fallback;
}
function extractTranxId(body: any): string | null {
  const d = inner(body);
  return d.transaction_id || d.tranx_id || d.tran_id || d.reference || body?.transaction_id || null;
}
// Bigisub's documented status values:
//   success: successful, completed
//   pending: processing, submitted, pending, in_progress
//   failed:  failed, cancelled, refunded, partial
function extractStatus(body: any): string {
  if (body && body.success === false) return "failed";
  const d = inner(body);
  const raw = (d?.status ?? d?.Status ?? body?.status ?? "").toString().toLowerCase().trim();
  if (!raw) return "pending"; // no status given: never assume it worked
  if (raw === "successful" || raw === "completed" || raw === "success") return "success";
  if (["failed", "cancelled", "canceled", "refunded", "partial", "error"].includes(raw)) return "failed";
  return "pending"; // processing, submitted, pending, in_progress, anything unknown
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
// Bigisub's plan lists can arrive as a plain array, as { plans: [...] }, grouped
// into several arrays ({ "Data": [...], "Voice": [...] }) or nested a level deeper.
// Collect EVERY plan from all of them — nothing is dropped.
function collectArrays(node: any, depth = 0): any[] {
  if (Array.isArray(node)) return node;
  if (!node || typeof node !== "object" || depth > 3) return [];
  const out: any[] = [];
  for (const v of Object.values(node)) {
    if (Array.isArray(v)) out.push(...v);
    else if (v && typeof v === "object") out.push(...collectArrays(v, depth + 1));
  }
  return out;
}
function normalizeList(data: any, key: string): any[] {
  const candidate = data?.[key] ?? data?.data?.[key] ?? data?.data ?? data;
  if (Array.isArray(candidate)) return candidate;
  return collectArrays(candidate).filter((x) => x && typeof x === "object");
}
// If the list is paginated, the reply carries a link to the next page.
function nextPagePath(body: any): string | null {
  const raw = body?.next ?? body?.data?.next ?? body?.meta?.next ?? body?.pagination?.next ?? null;
  if (!raw || typeof raw !== "string") return null;
  try {
    const u = new URL(raw, BIGISUB_BASE);
    if (u.host !== new URL(BIGISUB_BASE).host) return null;     // only ever follow links on Bigisub's own host
    return u.pathname + u.search;
  } catch (_e) { return null; }
}
// Fetches a list and follows its "next page" links (up to 15 pages), de-duplicating by id.
async function fetchAllPlans(path: string, key: string): Promise<any[]> {
  const seen = new Set<string>(); const all: any[] = []; let next: string | null = path;
  for (let page = 0; next && page < 15; page++) {
    const body = await bigisub("GET", next);
    for (const item of normalizeList(body, key)) {
      const id = item?.id !== undefined && item?.id !== null ? String(item.id) : null;
      if (id !== null) { if (seen.has(id)) continue; seen.add(id); }
      all.push(item);
    }
    const np = nextPagePath(body);
    next = np && np !== next ? np : null;
  }
  return all;
}

async function hashPin(pin: string): Promise<string> {
  const data = new TextEncoder().encode(pin);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---- Bill Payments PIN protection ----------------------------------------------------------------------------------
// A 4-digit PIN has only 10,000 possibilities, so two things protect it:
//  1) Stored with a per-business salt AND a server-side secret ("v2:" hash). A plain SHA-256 of a 4-digit number can be
//     reversed in an instant by anyone who ever sees the database; this cannot be without the server secret.
//     Older plain hashes still work and are upgraded to v2 the first time the right PIN is entered.
//  2) Lockout: 5 wrong tries lock bill payments for 15 minutes (needs bill-pin-lockout.sql).
const PIN_MAX_ATTEMPTS = 5;
const PIN_LOCK_MINUTES = 15;

async function hashPinStrong(pin: string, businessId: string): Promise<string> {
  const secret = (Deno.env.get("BILL_PIN_PEPPER") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "zeeshop") + "|" + businessId;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(pin));
  return "v2:" + Array.from(new Uint8Array(mac)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function safeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
async function verifyBillPin(admin: any, businessId: string, stored: string, pin: string): Promise<boolean> {
  if (!pin || !stored) return false;
  if (stored.startsWith("v2:")) return safeEq(await hashPinStrong(pin, businessId), stored);
  if (!safeEq(await hashPin(pin), stored)) return false;                       // old plain SHA-256 hash
  await admin.from("businesses").update({ bill_payments_pin_hash: await hashPinStrong(pin, businessId) }).eq("id", businessId);   // upgrade in place
  return true;
}
type PinLock = { attempts: number; lockedUntil: number } | null;
async function getPinLock(admin: any, businessId: string): Promise<PinLock> {
  try {
    const { data, error } = await admin.from("businesses").select("bill_pin_failed_attempts, bill_pin_locked_until").eq("id", businessId).maybeSingle();
    if (error || !data) return null;                    // columns not added yet: lockout stays off
    return { attempts: Number(data.bill_pin_failed_attempts || 0), lockedUntil: data.bill_pin_locked_until ? Date.parse(data.bill_pin_locked_until) : 0 };
  } catch (_e) { return null; }
}
function pinLockedResponse(lock: PinLock): Response | null {
  if (lock && lock.lockedUntil > Date.now()) {
    const mins = Math.ceil((lock.lockedUntil - Date.now()) / 60000);
    return json({ error: `Too many wrong PIN attempts. Bill payments are locked for ${mins} more minute${mins === 1 ? "" : "s"}. The owner can reset the PIN with the emailed code.` }, 429);
  }
  return null;
}
// Count one wrong try; returns how many tries are left (0 = now locked).
async function registerPinFailure(admin: any, businessId: string, lock: PinLock): Promise<number> {
  if (!lock) return PIN_MAX_ATTEMPTS;                     // lockout not available: behave as before
  const attempts = lock.attempts + 1;
  if (attempts >= PIN_MAX_ATTEMPTS) {
    await admin.from("businesses").update({ bill_pin_failed_attempts: 0, bill_pin_locked_until: new Date(Date.now() + PIN_LOCK_MINUTES * 60000).toISOString() }).eq("id", businessId);
    return 0;
  }
  await admin.from("businesses").update({ bill_pin_failed_attempts: attempts }).eq("id", businessId);
  return PIN_MAX_ATTEMPTS - attempts;
}
async function clearPinFailures(admin: any, businessId: string, lock: PinLock) {
  if (lock && (lock.attempts > 0 || lock.lockedUntil)) {
    await admin.from("businesses").update({ bill_pin_failed_attempts: 0, bill_pin_locked_until: null }).eq("id", businessId);
  }
}
// The emailed 6-digit code that proves the owner is really them (used to set a new PIN and to remove the PIN).
async function consumeResetOtp(admin: any, businessId: string, otp: string): Promise<{ ok: true } | { ok: false; status: number; message: string }> {
  if (!/^\d{6}$/.test(otp)) return { ok: false, status: 400, message: "Enter the 6-digit code sent to your email." };
  const otpHash = await hashPin(otp);
  const { data: otpRow, error: otpErr } = await admin.from("bill_pin_reset_otp_codes")
    .select("id, expires_at, consumed_at").eq("business_id", businessId).eq("code_hash", otpHash)
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (otpErr) return { ok: false, status: 500, message: otpErr.message };
  if (!otpRow || otpRow.consumed_at || new Date(otpRow.expires_at).getTime() < Date.now()) {
    return { ok: false, status: 403, message: "That code is invalid or has expired. Request a new one." };
  }
  await admin.from("bill_pin_reset_otp_codes").update({ consumed_at: new Date().toISOString() }).eq("id", otpRow.id);
  return { ok: true };
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
      .select("id, name, currency, country, bill_wallet_balance, bill_payments_pin_hash, psa_account_reference, psa_account_number, psa_bank_name, psa_account_name, psa_status, psa_last_synced_at")
      .eq("id", businessId)
      .maybeSingle();
    if (bizErr) return json({ error: bizErr.message }, 500);
    if (!biz) return json({ error: `No business found with id = ${businessId} (from your app_users.business_id). That id doesn't match any row in businesses — check for a mismatch (e.g. a locally-generated id that never got the server-assigned one back) directly in Supabase.` }, 404);

    const { action, ...params } = await req.json();
    const currency = biz.currency || "NGN";

    // ---------- read-only reference/lookups ----------
    if (action === "my_wallet_summary") {
      // Older accounts were created before we saved the account name: ask Flutterwave for it ONCE, then keep it.
      let psaName: string | null = (biz as any).psa_account_name || null;
      if (!psaName && biz.psa_account_reference && FLW_SECRET_KEY) {
        try {
          const nr = await fetch(`https://api.flutterwave.com/v3/payout-subaccounts/${biz.psa_account_reference}`, { headers: { Authorization: `Bearer ${FLW_SECRET_KEY}` } });
          const nd = await nr.json().catch(() => null);
          const nm = nd?.data?.account_name ? String(nd.data.account_name) : "";
          if (nr.ok && nm) { psaName = nm; await admin.from("businesses").update({ psa_account_name: nm }).eq("id", businessId); }
        } catch (_e) { /* show no name rather than fail the screen */ }
      }
      // The shop name IS the account name. If the owner renamed the business, update the name on the Flutterwave account too.
      // (Flutterwave's update call needs the account's email and mobile number as well, so read them first and send them back.)
      const wantName = cleanPsaName(biz.name);
      if (biz.psa_account_reference && FLW_SECRET_KEY && psaName && psaName.trim().toLowerCase() !== wantName.toLowerCase()) {
        try {
          const ref = String(biz.psa_account_reference);
          const gr = await fetch(`https://api.flutterwave.com/v3/payout-subaccounts/${ref}`, { headers: { Authorization: `Bearer ${FLW_SECRET_KEY}` } });
          const gd = await gr.json().catch(() => null);
          const cur = gd?.data;
          if (gr.ok && cur?.email) {
            const body: Record<string, unknown> = { account_name: wantName, email: cur.email, country: "NG" };
            if (cur.mobilenumber) body.mobilenumber = cur.mobilenumber;
            const pr = await fetch(`https://api.flutterwave.com/v3/payout-subaccounts/${ref}`, {
              method: "PUT", headers: { Authorization: `Bearer ${FLW_SECRET_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
            });
            const pd = await pr.json().catch(() => null);
            if (pr.ok) {
              psaName = wantName;
              await admin.from("businesses").update({ psa_account_name: wantName }).eq("id", businessId);
              console.log("my_wallet_summary: account name updated to match the shop name:", wantName);
            } else {
              console.error("my_wallet_summary: Flutterwave refused the name update:", pr.status, JSON.stringify(pd)?.slice(0, 300));
            }
          } else {
            console.error("my_wallet_summary: could not read the account before renaming:", gr.status, JSON.stringify(gd)?.slice(0, 300));
          }
        } catch (e) { console.error("my_wallet_summary: account rename error:", (e as Error).message); }
      }
      return json({
        wallet_balance: Number(biz.bill_wallet_balance || 0), currency,
        psa_account_number: biz.psa_account_number || null, psa_bank_name: biz.psa_bank_name || null, psa_status: biz.psa_status || null,
        psa_account_name: psaName,
        // Added to electricity amounts so the screen can show ONE final total (never labelled as a fee).
        bill_fees: (await loadPricing(admin)).fees,
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
    const fetchListAction = async (path: string, key: string, responseKey: string, pricingService?: string) => {
      try {
        let list = await fetchAllPlans(path, key);
        if (pricingService) list = withDisplayPrice(list, pricingService, await loadPricing(admin));
        return json({ [responseKey]: list }, 200);
      } catch (e) {
        return json({ error: e instanceof Error ? e.message : "Could not reach Bigisub." }, 502);
      }
    };
    if (action === "data_plans") return await fetchListAction(EP.DATA_PLANS, "plans", "plans", "data");
    if (action === "cable_plans") return await fetchListAction(EP.CABLE_PLANS, "plans", "plans", "cable");
    if (action === "electricity_providers") {
      try {
        const data = await bigisub("GET", EP.ELECTRICITY_PROVIDERS);
        const list = normalizeList(data, "providers");
        // Safety net: Aba, Yola and Benin must always be offered. Added only if
        // Bigisub's own list doesn't already contain one (matched by name/code).
        // The codes follow Bigisub's pattern ("ikeja-electric"); a wrong one fails
        // safely at the meter-verification step, before any money moves.
        const hay = list.map((p: any) => `${p?.name} ${p?.code} ${p?.id} ${p?.company}`.toLowerCase());
        const extras = [
          { test: /\baba\b|aba-electric/, code: "aba-electric", name: "Aba Electricity - AED" },
          { test: /yola|yedc/, code: "yola-electric", name: "Yola Electricity - YEDC" },
          { test: /benin|bedc/, code: "benin-electric", name: "Benin Electricity - BEDC" },
        ];
        for (const e of extras) {
          if (!hay.some((h: string) => e.test.test(h))) list.push({ code: e.code, name: e.name, min_amount: MIN_AMOUNT.electricity, service_charge: 0, service_charge_type: "fixed" });
        }
        return json({ providers: list }, 200);
      } catch (e) {
        return json({ error: e instanceof Error ? e.message : "Could not reach Bigisub." }, 502);
      }
    }
    if (action === "result_checker_prices") return await fetchListAction(EP.RESULT_CHECKER_PRICES, "prices", "prices", "result_checker");
    if (action === "betting_billers") {
      try {
        const data = await bigisub("GET", EP.BETTING_BILLERS);
        const list = normalizeList(data, "billers");
        // Logos: ones uploaded in Super Admin win; otherwise any https image
        // link Bigisub itself includes with the platform.
        const { data: logoRows } = await admin.from("betting_logos").select("biller_code, image_url");
        const managed: Record<string, string> = {};
        for (const r of (logoRows || []) as any[]) managed[String(r.biller_code).toLowerCase()] = r.image_url;
        const apiLogo = (b: any) => {
          for (const k of ["logo_url", "logo", "image_url", "image", "icon_url", "icon", "thumbnail", "avatar"]) {
            const v = b?.[k]; if (typeof v === "string" && /^https:\/\//i.test(v)) return v;
          }
          return null;
        };
        const withLogos = list.map((b: any) => ({ ...b, logo_url: managed[String(b?.code ?? b?.biller_code ?? b?.id ?? "").toLowerCase()] || apiLogo(b) }));
        return json({ billers: withLogos }, 200);
      } catch (e) {
        return json({ error: e instanceof Error ? e.message : "Could not reach Bigisub." }, 502);
      }
    }
    if (action === "isp_smile_plans") return await fetchListAction(EP.ISP_SMILE_PLANS, "plans", "plans", "isp_smile");
    if (action === "isp_spectranet_plans") return await fetchListAction(EP.ISP_SPECTRANET_PLANS, "plans", "plans", "isp_spectranet");

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
      return json({
        customer_name: extractCustomerName(data), upstream_message: extractUpstreamMessage(data), raw: data,
        customer_address: deepFindString(data, ["address", "customer_address", "customeraddress", "meter_address", "service_address"]) || null,
      }, 200);
    }
    if (action === "betting_validate") {
      const { biller_code, customer_id } = params as { biller_code: string; customer_id: string };
      if (!biller_code || !customer_id) return json({ error: "Missing biller_code or customer_id." }, 400);
      const data = await bigisub("POST", EP.BETTING_VALIDATE, { biller_code, customer_id });
      // Bigisub wraps the reply as { success, data: {...} }: the validation
      // reference and the customer's details are INSIDE `data`. (This used to
      // read the top level, found nothing, and rejected every validation.)
      const d = inner(data);
      if (d?.valid === false) return json({ error: "That customer ID wasn't found on this platform. Check it and try again." }, 404);
      const validationReference = d?.validation_reference || data?.validation_reference || d?.reference || null;
      if (!validationReference) return json({ error: extractUpstreamMessage(data) || "Couldn't validate this customer ID. Check it and try again." }, 502);
      return json({
        customer_name: extractCustomerName(data) || d?.customer_name || null,
        validation_reference: validationReference,
        min_amount: d?.min_amount ?? null, max_amount: d?.max_amount ?? null,
        raw: data,
      }, 200);
    }
    if (action === "isp_smile_verify") {
      const { account_id } = params as { account_id: string };
      if (!account_id) return json({ error: "Missing account_id." }, 400);
      const data = await bigisub("POST", EP.ISP_SMILE_VERIFY, { account_id });
      return json({ customer_name: extractCustomerName(data), upstream_message: extractUpstreamMessage(data), raw: data }, 200);
    }

    // ---- Saved numbers / codes (beneficiaries): kept per business on the server so they survive logout and follow the person to any phone.
    if (action === "ben_list") {
      const { data, error } = await admin.from("bill_beneficiaries").select("type, value, label, last_used")
        .eq("business_id", businessId).order("last_used", { ascending: false }).limit(300);
      if (error) return json({ error: error.message }, 500);
      return json({ items: data || [] }, 200);
    }
    if (action === "ben_save" || action === "ben_remove") {
      const type = String(params.type || "").trim();
      const value = String(params.value || "").trim();
      if (!["phone", "card", "meter", "bet", "smile", "spectranet"].includes(type) || !value || value.length > 64) {
        return json({ error: "Invalid saved number." }, 400);
      }
      if (action === "ben_remove") {
        const { error } = await admin.from("bill_beneficiaries").delete().eq("business_id", businessId).eq("type", type).eq("value", value);
        if (error) return json({ error: error.message }, 500);
        return json({ ok: true }, 200);
      }
      const label = String(params.label || "").trim().slice(0, 120);
      const { error } = await admin.from("bill_beneficiaries").upsert(
        { business_id: businessId, type, value, label, last_used: new Date().toISOString() },
        { onConflict: "business_id,type,value" },
      );
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true }, 200);
    }

    if (action === "list_transactions") {
      const { data: txs, error } = await admin
        .from("bill_transactions")
        .select("*")
        .eq("business_id", businessId)
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) return json({ error: error.message }, 500);
      // Wallet funding credits, so "History" shows money coming in as well as going out. If this lookup fails for
      // any reason the purchases still load — it never breaks the list.
      let topups: unknown[] = [];
      const topSelect = (cols: string) => admin.from("wallet_topups").select(cols)
        .eq("business_id", businessId).order("created_at", { ascending: false }).limit(50);
      let { data: tops, error: topErr } = await topSelect("id, amount, gross_amount, fee, provider_reference, status, created_at, sender_name, sender_bank, sender_account, narration");
      if (topErr) {   // sender columns not added yet — fall back so funding rows never disappear from History
        ({ data: tops, error: topErr } = await topSelect("id, amount, gross_amount, fee, provider_reference, status, created_at"));
      }
      if (!topErr) topups = tops || [];
      else console.warn("list_transactions: wallet_topups lookup skipped:", topErr.message);
      return json({ transactions: txs || [], topups }, 200);
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
      if (newStatus === "failed" && txRow.status === "pending") {
        // Bigisub refunded itself; give the business its money back — once.
        // The status guard means a double-tap can't refund twice.
        const { data: flipped } = await admin.from("bill_transactions")
          .update({ status: "failed", bigisub_response: data }).eq("id", txId).eq("status", "pending").select("id, sale_price");
        if (flipped && flipped.length > 0 && Number(flipped[0].sale_price) > 0) {
          const { error: refundErr } = await admin.rpc("increment_bill_wallet", { p_business_id: String(businessId), p_amount: Number(flipped[0].sale_price) });
          if (refundErr) console.error("REFUND FAILED for transaction", txId, refundErr.message);
        }
      } else if (newStatus !== "pending") {
        await admin.from("bill_transactions").update({ status: newStatus, bigisub_response: data }).eq("id", txId);
        if (newStatus === "success" && txRow.status !== "success") {
          const d = inner(data);
          const { data: bRow } = await admin.from("businesses").select("bill_wallet_balance").eq("id", businessId).maybeSingle();
          fireEmail(receiptPayload(txRow.service, {
            to: caller.email || callerData.user.email, name: caller.first_name || "", serviceLabel: txRow.service_label || txRow.service,
            recipient: String(txRow.recipient || ""), amount: Number(txRow.sale_price || 0), reference: String(txRow.bigisub_tranx_id || txRow.id),
            newBalance: Number(bRow?.bill_wallet_balance ?? 0), txId: String(txRow.id), createdAt: txRow.created_at || undefined, token: d?.token || "",
            extra: pinsToText(d?.pins) ? [{ label: "PIN(s)", value: pinsToText(d?.pins), mono: true }] : undefined, units: deepFindAny(data, ["units", "unit", "kwh", "token_units", "total_units"]),
          }));
        }
      }
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
      // A PIN already exists — require the emailed code before overwriting it (also what makes a forgotten PIN recoverable).
      // Wrong codes count toward the same lockout as wrong PINs, so the 6-digit code cannot be guessed either.
      const lock = await getPinLock(admin, businessId);
      if (biz.bill_payments_pin_hash) {
        const locked = pinLockedResponse(lock); if (locked) return locked;
        const check = await consumeResetOtp(admin, businessId, String(params.otp || ""));
        if (!check.ok) {
          if (check.status === 403) await registerPinFailure(admin, businessId, lock);
          return json({ error: check.message }, check.status);
        }
      }
      const hash = await hashPinStrong(pin, businessId);
      const { error } = await admin.from("businesses").update({ bill_payments_pin_hash: hash }).eq("id", businessId);
      if (error) return json({ error: error.message }, 500);
      await clearPinFailures(admin, businessId, lock);
      return json({ ok: true }, 200);
    }
    if (action === "clear_bill_pin") {
      if (!isMaster) return json({ error: "Only the business owner can remove the Bill Payments PIN." }, 403);
      // Removing the PIN is as sensitive as changing it, so it needs the same emailed code.
      if (biz.bill_payments_pin_hash) {
        const lock = await getPinLock(admin, businessId);
        const locked = pinLockedResponse(lock); if (locked) return locked;
        const check = await consumeResetOtp(admin, businessId, String(params.otp || ""));
        if (!check.ok) {
          if (check.status === 403) await registerPinFailure(admin, businessId, lock);
          return json({ error: check.message }, check.status);
        }
      }
      const { error } = await admin.from("businesses").update({ bill_payments_pin_hash: null }).eq("id", businessId);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true }, 200);
    }

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
        const lock = await getPinLock(admin, businessId);
        const locked = pinLockedResponse(lock); if (locked) return locked;
        const suppliedPin = String(params.bill_pin || "");
        if (!(await verifyBillPin(admin, businessId, biz.bill_payments_pin_hash, suppliedPin))) {
          const left = await registerPinFailure(admin, businessId, lock);
          return json({ error: left === 0 && lock
            ? `Too many wrong PIN attempts. Bill payments are locked for ${PIN_LOCK_MINUTES} minutes.`
            : (lock ? `Incorrect Bill Payments PIN. ${left} attempt${left === 1 ? "" : "s"} left.` : "Incorrect Bill Payments PIN.") }, left === 0 && lock ? 429 : 403);
        }
        await clearPinFailures(admin, businessId, lock);
      }
      const pricing = await loadPricing(admin);
      return await handlePurchase(admin, action, params, businessId, biz, pricing, caller.id, { email: caller.email || callerData.user.email || null, name: caller.first_name || "" });
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
async function lookupPlanAmount(path: string, preferredKey: string, matchValue: unknown, matchKeys: string[], addCharges = false): Promise<number | null> {
  const r = await lookupPlan(path, preferredKey, matchValue, matchKeys, addCharges);
  return r ? r.amount : null;
}
// Same lookup, but also hands back the plan itself so the receipt can name it.
async function lookupPlan(path: string, preferredKey: string, matchValue: unknown, matchKeys: string[], addCharges = false): Promise<{ amount: number; item: any } | null> {
  try {
    const raw = await bigisub("GET", path);
    const list = normalizeList(raw, preferredKey);
    const item = list.find((x: any) => matchKeys.some((k) => String(x?.[k]) === String(matchValue)));
    if (!item) return null;
    const amt = Number(
      item.amount ?? item.price ?? item.plan_amount ?? item.plan_price ?? item.selling_price ??
      item.cost ?? item.cost_price ?? item.api_price ?? item.user_price ?? item.reseller_price
    );
    if (!Number.isFinite(amt)) return null;
    // Spectranet plans carry their own `charges`, part of what Bigisub takes.
    return { amount: addCharges ? amt + (Number(item.charges) || 0) : amt, item };
  } catch (_e) {
    return null;
  }
}

// Platform pricing — the ONLY margin the platform earns. Each VTU service has
// its own switch, managed from Super Admin → Platform Pricing (table
// vtu_service_fees): fee ON/OFF, a flat ₦ amount or a percentage, and the value.
// The person only ever sees ONE final price — never a fee line.
type FeeRule = { enabled: boolean; fee_type: "flat" | "percent"; fee_value: number };
type PlatformPricing = { fees: Record<string, FeeRule> };
const VTU_SERVICES = ["airtime", "data", "cable", "electricity", "betting", "result_checker", "isp_smile", "isp_spectranet"];

async function loadPricing(admin: ReturnType<typeof createClient>): Promise<PlatformPricing> {
  const fees: Record<string, FeeRule> = {};
  const { data: rows, error } = await admin.from("vtu_service_fees").select("service, enabled, fee_type, fee_value");
  if (!error && Array.isArray(rows) && rows.length > 0) {
    for (const r of rows as any[]) fees[r.service] = { enabled: !!r.enabled, fee_type: r.fee_type === "percent" ? "percent" : "flat", fee_value: Number(r.fee_value) || 0 };
  } else {
    // Table not created yet: fall back to the earlier two settings so nothing breaks.
    const { data } = await admin.from("platform_settings").select("data_markup_percent, utility_flat_fee").eq("id", 1).maybeSingle();
    const flat = data?.utility_flat_fee === undefined || data?.utility_flat_fee === null ? 50 : Number(data.utility_flat_fee);
    const pct = Number(data?.data_markup_percent || 0);
    fees.data = { enabled: pct > 0, fee_type: "percent", fee_value: pct };
    for (const sv of ["cable", "electricity", "result_checker", "isp_smile", "isp_spectranet"]) fees[sv] = { enabled: flat > 0, fee_type: "flat", fee_value: flat };
  }
  return { fees };
}

// Every price the person sees or pays is a WHOLE naira, rounded UP (never
// ₦26.75). The same function builds the shown price and the charged price,
// so they can never differ.
const wholeNaira = (n: number) => Math.ceil(Math.round(n * 100) / 100);
// `quantity` matters for Result Checker and Spectranet, where a flat amount is
// per unit (so the per-unit display_price × quantity always equals the real charge).
function computeSalePrice(pricingService: string, costPrice: number, pricing: PlatformPricing, quantity = 1): number {
  const f = pricing.fees[pricingService];
  if (!f || !f.enabled || !(f.fee_value > 0)) return wholeNaira(costPrice);
  if (f.fee_type === "percent") return wholeNaira(costPrice * (1 + f.fee_value / 100));
  const units = (pricingService === "result_checker" || pricingService === "isp_spectranet") ? Math.max(1, quantity) : 1;
  return wholeNaira(costPrice + f.fee_value * units);
}

// Adds `display_price` (the single final total the person pays) to each item
// of a plan list, so the app never shows Bigisub's raw cost while the wallet
// is charged more. Spectranet's own `charges` are part of its cost.
function withDisplayPrice(items: any[], pricingService: string, pricing: PlatformPricing): any[] {
  return items.map((it) => {
    const base = Number(it?.amount ?? it?.price ?? it?.plan_price ?? it?.plan_amount);
    if (!Number.isFinite(base)) return it;
    const charges = pricingService === "isp_spectranet" ? (Number(it?.charges) || 0) : 0;
    return { ...it, display_price: computeSalePrice(pricingService, base + charges, pricing) };
  });
}

// Smallest amount each service accepts (Bigisub's documented minimums).
const MIN_AMOUNT: Record<string, number> = { airtime: 50, electricity: 500, betting: 1 };

async function handlePurchase(
  admin: ReturnType<typeof createClient>,
  action: string,
  params: Record<string, unknown>,
  businessId: string,
  biz: { bill_wallet_balance: number | null },
  pricing: PlatformPricing,
  userId: string,
  buyer: { email: string | null; name: string } = { email: null, name: "" },
) {
  let planName = "";       // for the email receipt only
  let providerName = "";   // network / cable provider / disco / betting platform — receipt only
  let meterType = "";
  let customerNameForReceipt = "";
  let customerPhoneForReceipt = "";
  let customerAddressForReceipt = "";
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
    if (Number(amount) < MIN_AMOUNT.airtime) return json({ error: `The minimum airtime purchase is ₦${MIN_AMOUNT.airtime}.` }, 400);
    serviceLabel = "Airtime"; recipient = String(phone_number); estimatedCost = Number(amount); pricingService = "airtime";
    providerName = NETWORK_NAMES[String(network)] || ""; planName = `₦${Number(amount).toLocaleString()} airtime`;
    bigisubCall = () => bigisub("POST", EP.AIRTIME_PURCHASE, { network, phone_number, amount: String(amount), airtime_type: "vtu", pin: BIGISUB_PIN });

  } else if (action === "data_purchase") {
    const { network, phone_number, plan, ported_number } = params as { network: number; phone_number: string; plan: number; ported_number?: boolean };
    if (!network || !phone_number || !plan) return json({ error: "Missing network, phone_number, or plan." }, 400);
    serviceLabel = "Data"; recipient = String(phone_number); pricingService = "data"; planKey = String(plan);
    // Only a plan ID comes from the client — verify its real price against
    // Bigisub's own plan list rather than trusting whatever the client
    // displayed (client-side prices are for UI only, never authoritative).
    const found = await lookupPlan(EP.DATA_PLANS, "plans", plan, ["id"]);
    const price = found ? found.amount : null;
    if (price === null) return json({ error: "Could not verify this plan's price right now — please try again in a moment." }, 502);
    estimatedCost = price;
    providerName = NETWORK_NAMES[String(network)] || String((found?.item as any)?.network_name || ""); planName = describePlan(found?.item);
    bigisubCall = () => bigisub("POST", EP.DATA_PURCHASE, { network, phone_number, plan, pin: BIGISUB_PIN, ported_number: !!ported_number });

  } else if (action === "cable_purchase") {
    const { cable_type, card_no, phone_number, amount, customer_name, plan_id } = params as { cable_type: string; card_no: string; phone_number: string; amount: number; customer_name: string; plan_id?: string | number };
    if (!cable_type || !card_no || !phone_number || !amount || !customer_name) return json({ error: "Missing cable_type, card_no, phone_number, amount, or customer_name (verify the card first)." }, 400);
    serviceLabel = "Cable TV"; recipient = String(card_no); estimatedCost = Number(amount); pricingService = "cable";
    providerName = String(cable_type).toUpperCase(); customerNameForReceipt = String(customer_name);
    planKey = plan_id != null ? String(plan_id) : null;
    // With a plan id, the price comes from Bigisub's own list — never from the client.
    let cableAmount = Number(amount);
    if (plan_id != null) {
      const catalog = await lookupPlan(EP.CABLE_PLANS, "plans", plan_id, ["id"]);
      if (catalog === null) return json({ error: "Could not verify this plan's price right now — please try again in a moment." }, 502);
      cableAmount = catalog.amount; planName = describePlan(catalog.item);
    }
    estimatedCost = cableAmount;
    bigisubCall = () => bigisub("POST", EP.CABLE_PURCHASE, { cable_type: String(cable_type).toLowerCase(), card_no, phone_number, amount: cableAmount, Customer: customer_name, pin: BIGISUB_PIN });

  } else if (action === "electricity_pay") {
    const { company, meter_no, meter_type, phone_number, amount, customer_name, customer_address } = params as { company: string; meter_no: string; meter_type: string; phone_number: string; amount: number; customer_name: string; customer_address?: string };
    if (!company || !meter_no || !meter_type || !phone_number || !amount || !customer_name) return json({ error: "Missing company, meter_no, meter_type, phone_number, amount, or customer_name (verify the meter first)." }, 400);
    if (Number(amount) < MIN_AMOUNT.electricity) return json({ error: `The minimum electricity purchase is ₦${MIN_AMOUNT.electricity.toLocaleString()}.` }, 400);
    serviceLabel = "Electricity"; recipient = String(meter_no); estimatedCost = Number(amount); pricingService = "electricity";
    providerName = String(company); meterType = String(meter_type); customerNameForReceipt = String(customer_name);
    customerPhoneForReceipt = String(phone_number); customerAddressForReceipt = String(customer_address || "").slice(0, 200);
    bigisubCall = () => bigisub("POST", EP.ELECTRICITY_PAY, { company, meter_no, meter_type, phone_number, amount: Number(amount), Customer_name: customer_name, pin: BIGISUB_PIN });

  } else if (action === "betting_fund") {
    const { biller_code, customer_id, customer_name, amount, validation_reference } = params as { biller_code: string; customer_id: string; customer_name: string; amount: number; validation_reference: string };
    if (!biller_code || !customer_id || !customer_name || !amount || !validation_reference) return json({ error: "Missing biller_code, customer_id, customer_name, amount, or validation_reference (validate first — and don't delay before funding, the reference is short-lived)." }, 400);
    if (Number(amount) < MIN_AMOUNT.betting) return json({ error: `The minimum betting funding is ₦${MIN_AMOUNT.betting}.` }, 400);
    serviceLabel = "Betting Wallet"; recipient = String(customer_id); estimatedCost = Number(amount); pricingService = "betting";
    providerName = String(biller_code); customerNameForReceipt = String(customer_name);
    bigisubCall = () => bigisub("POST", EP.BETTING_FUND, { biller_code, customer_id, customer_name, amount: Number(amount), validation_reference, pin_code: BIGISUB_PIN });

  } else if (action === "result_checker_purchase") {
    const { exam, quantity: qty } = params as { exam: string; quantity: number };
    if (!exam || !qty) return json({ error: "Missing exam or quantity." }, 400);
    serviceLabel = "Result Checker"; recipient = `${exam} × ${qty}`; pricingService = "result_checker"; planKey = String(exam); quantity = Number(qty);
    providerName = String(exam); planName = `${exam} × ${qty}`;
    const unitPrice = await lookupPlanAmount(EP.RESULT_CHECKER_PRICES, "prices", exam, ["exam", "exam_type", "name"]);
    if (unitPrice === null) return json({ error: "Could not verify this exam's price right now — please try again in a moment." }, 502);
    estimatedCost = unitPrice * quantity;
    bigisubCall = () => bigisub("POST", EP.RESULT_CHECKER_PURCHASE, { exam, quantity, pin_code: BIGISUB_PIN });

  } else if (action === "isp_smile_topup") {
    const { plan, phone_number, email, account_id } = params as { plan: number; phone_number: string; email: string; account_id: string };
    if (!plan || !phone_number || !email || !account_id) return json({ error: "Missing plan, phone_number, email, or account_id (verify the account first)." }, 400);
    serviceLabel = "ISP — Smile"; recipient = String(account_id); pricingService = "isp_smile"; planKey = String(plan);
    const smilePlan = await lookupPlan(EP.ISP_SMILE_PLANS, "plans", plan, ["id"]);
    const price = smilePlan ? smilePlan.amount : null;
    providerName = "Smile"; planName = describePlan(smilePlan?.item);
    if (price === null) return json({ error: "Could not verify this plan's price right now — please try again in a moment." }, 502);
    estimatedCost = price;
    bigisubCall = () => bigisub("POST", EP.ISP_SMILE_TOPUP, { plan, phone_number, email, account_id, pin: BIGISUB_PIN });

  } else { // isp_spectranet_topup
    const { plan, phone_number, spectranet_number, quantity: qty } = params as { plan: number; phone_number: string; spectranet_number: string; quantity: number };
    if (!plan || !phone_number || !spectranet_number || !qty) return json({ error: "Missing plan, phone_number, spectranet_number, or quantity." }, 400);
    serviceLabel = "ISP — Spectranet"; recipient = String(spectranet_number); pricingService = "isp_spectranet"; planKey = String(plan); quantity = Number(qty);
    const spPlan = await lookupPlan(EP.ISP_SPECTRANET_PLANS, "plans", plan, ["id"], true); // price + Spectranet's own charges
    const unitPrice = spPlan ? spPlan.amount : null;
    providerName = "Spectranet"; planName = describePlan(spPlan?.item);
    if (unitPrice === null) return json({ error: "Could not verify this plan's price right now — please try again in a moment." }, 502);
    estimatedCost = unitPrice * quantity;
    bigisubCall = () => bigisub("POST", EP.ISP_SPECTRANET_TOPUP, { plan, phone_number, spectranet_number, quantity, pin: BIGISUB_PIN });
  }

  const preCheckBalance = Number(biz.bill_wallet_balance || 0);
  const estimatedSale = computeSalePrice(pricingService, estimatedCost, pricing, quantity);
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
  const bigisubTranxId = extractTranxId(bigisubResponse);
  const status = extractStatus(bigisubResponse);
  const payload = inner(bigisubResponse);

  // Bigisub refunds its own wallet when a purchase fails, so the business
  // is NOT charged either — record the failure and say why.
  if (status === "failed") {
    const failFields = { cost_price: 0, sale_price: 0, status: "failed", bigisub_tranx_id: bigisubTranxId, bigisub_response: bigisubResponse };
    if (clientRef) await admin.from("bill_transactions").update(failFields).eq("id", txId);
    else await admin.from("bill_transactions").insert({ id: txId, business_id: businessId, user_id: userId, service: serviceKey, service_label: serviceLabel, recipient, ...failFields });
    const why = (bigisubResponse?.message || payload?.message || payload?.status_detail || "The purchase didn't go through.").toString();
    return json({ error: `${why} You were not charged.`, status: "failed" }, 502);
  }

  // The person is charged exactly the single total they were shown (the
  // pre-check price); the real cost is recorded separately for the admin.
  const salePrice = estimatedSale;

  // Atomic debit (never overwrites a wallet credit that landed meanwhile).
  // The purchase already happened, so this must never refuse: it floors at 0.
  let newBalance = Math.max(0, preCheckBalance - salePrice);
  const { data: debited, error: debitErr } = await admin.rpc("debit_bill_wallet_floor", { p_business_id: String(businessId), p_amount: salePrice });
  if (!debitErr && debited !== null && debited !== undefined) {
    newBalance = Number(debited);
  } else {
    console.warn("debit_bill_wallet_floor unavailable, using fallback:", debitErr?.message);
    await admin.from("businesses").update({ bill_wallet_balance: newBalance }).eq("id", businessId);
  }

  const finalFields = { cost_price: costPrice, sale_price: salePrice, status, bigisub_tranx_id: bigisubTranxId, bigisub_response: bigisubResponse };
  if (clientRef) await admin.from("bill_transactions").update(finalFields).eq("id", txId);
  else await admin.from("bill_transactions").insert({ id: txId, business_id: businessId, user_id: userId, service: serviceKey, service_label: serviceLabel, recipient, ...finalFields });

  // Receipt email — only for a purchase that actually succeeded. A "pending" one is emailed later,
  // from the requery action, if and when it turns successful. Never blocks the response.
  if (status === "success") {
    const pinsText = pinsToText(payload?.pins);
    fireEmail(receiptPayload(serviceKey, {
      to: buyer.email, name: buyer.name, serviceLabel, recipient, amount: salePrice, reference: String(bigisubTranxId || txId), newBalance,
      provider: providerName, planName, meterType, customerName: customerNameForReceipt,
      customerPhone: customerPhoneForReceipt, customerAddress: customerAddressForReceipt, txId: String(txId),
      token: payload?.token || "", units: deepFindAny(bigisubResponse, ["units", "unit", "kwh", "token_units", "total_units"]),
      extra: pinsText ? [{ label: "PIN(s)", value: pinsText, mono: true }] : undefined,
    }));
  }

  return json({
    ok: true, wallet_balance: newBalance, status, charged: salePrice, token: payload?.token || null,
    pins: payload?.pins || null, bigisub_response: bigisubResponse,
  }, 200);
}

function json(body: Record<string, unknown>, status: number) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
