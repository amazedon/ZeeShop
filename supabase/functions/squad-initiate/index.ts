// supabase/functions/squad-initiate/index.ts
//
// Wallet funding through Squad checkout. Called from app.html by a signed-in
// business user (same login as bigisub-proxy). Three actions:
//   fee_preview  { amount }              → what the person will pay / get, using the live admin fee rules
//   initiate     { amount }              → creates the payment record + Squad checkout, returns checkout_url
//   verify       { reference }           → "I paid but my balance hasn't moved": asks Squad directly and
//                                           credits through the same atomic function the webhook uses
//
// Two more actions open and show a business's Squad DEDICATED ACCOUNT (a permanent account number):
//   va_status               → the account (if any), a legacy account (if any), and live fee wording for the card
//   create_virtual_account  → owner only: { bvn, dob (YYYY-MM-DD), first_name, last_name, phone, email, consent }
// Settlement is whatever is set as default on the Squad dashboard — nothing about it is hard-coded here.
// If (and only if) Squad rejects creation for lack of a beneficiary account, set SQUAD_BENEFICIARY_ACCOUNT.
// Needs squad-virtual-account.sql. The BVN and date of birth are forwarded to Squad and never stored or logged.
//
// Secrets (Supabase → Edge Functions → Secrets):
//   SQUAD_SECRET_KEY    sandbox_sk_… or sq_sk_… (never put this in app.html)
//   SQUAD_PUBLIC_KEY    sandbox_pk_… or sq_pk_… (not needed for the hosted checkout used here; kept for config completeness)
//   SQUAD_BASE_URL      https://sandbox-api-d.squadco.com (default)  |  https://api-d.squadco.com (live)
//   SQUAD_CALLBACK_URL  where Squad sends the person back, e.g. https://yourapp.com/  (?squad_ref=… is added)
//   MIN_DEPOSIT / MAX_DEPOSIT  optional, ₦ (defaults 100 / 1,000,000)
// Run squad-setup.sql first.

import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SQUAD_SECRET_KEY = Deno.env.get("SQUAD_SECRET_KEY") || "";
const SQUAD_PUBLIC_KEY = Deno.env.get("SQUAD_PUBLIC_KEY") || ""; // eslint-disable-line @typescript-eslint/no-unused-vars
const SQUAD_BASE_URL = (Deno.env.get("SQUAD_BASE_URL") || "https://sandbox-api-d.squadco.com").replace(/\/+$/, "");
const SQUAD_CALLBACK_URL = Deno.env.get("SQUAD_CALLBACK_URL") || "";
const SQUAD_BENEFICIARY_ACCOUNT = Deno.env.get("SQUAD_BENEFICIARY_ACCOUNT") || ""; // optional fallback, see header
const MIN_DEPOSIT = Number(Deno.env.get("MIN_DEPOSIT")) || 100;
const MAX_DEPOSIT = Number(Deno.env.get("MAX_DEPOSIT")) || 1_000_000;

// ---------------------------------------------------------------------------
// calculateDepositFee — the ONE place deposit fees are computed.
// Works in whole KOBO so there is never a floating-point cent error.
//
//   pass_charge_to_user = true  → the payer pays  amount + fee,  wallet gets  amount
//   pass_charge_to_user = false → the payer pays  amount,        wallet gets  amount − fee
//   deposit_fee_type "none"     → fee 0 either way
// ---------------------------------------------------------------------------
type FeeRules = { type: "percentage" | "flat" | "none"; value: number; cap: number; passToUser: boolean };
type FeeResult = { grossAmount: number; fee: number; netWalletCredit: number; grossKobo: number; rules: FeeRules };

async function loadFeeRules(admin: ReturnType<typeof createClient>): Promise<FeeRules> {
  const { data } = await admin.from("platform_settings")
    .select("deposit_fee_type, deposit_fee_value, deposit_fee_cap, pass_charge_to_user").eq("id", 1).maybeSingle();
  const t = String(data?.deposit_fee_type || "none");
  return {
    type: t === "percentage" || t === "flat" ? t : "none",
    value: Math.max(0, Number(data?.deposit_fee_value) || 0),
    cap: Math.max(0, Number(data?.deposit_fee_cap) || 0),
    passToUser: !!data?.pass_charge_to_user,
  };
}

async function calculateDepositFee(admin: ReturnType<typeof createClient>, amountInNaira: number): Promise<FeeResult> {
  const rules = await loadFeeRules(admin);
  const amountKobo = Math.round(amountInNaira * 100);
  let feeKobo = 0;
  if (rules.type === "percentage") {
    feeKobo = Math.round((amountKobo * rules.value) / 100);
    if (rules.cap > 0) feeKobo = Math.min(feeKobo, Math.round(rules.cap * 100));
  } else if (rules.type === "flat") {
    feeKobo = Math.round(rules.value * 100);
  }
  const grossKobo = rules.passToUser ? amountKobo + feeKobo : amountKobo;
  const netKobo = rules.passToUser ? amountKobo : amountKobo - feeKobo;
  return { grossAmount: grossKobo / 100, fee: feeKobo / 100, netWalletCredit: netKobo / 100, grossKobo, rules };
}

// ---------------------------------------------------------------------------
// Email — fire and forget. Never throws, never delays the response.
// ---------------------------------------------------------------------------
function fireEmail(payload: Record<string, unknown>) {
  const url = `${Deno.env.get("SUPABASE_URL")}/functions/v1/notify-email`;
  const p = fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}` },
    body: JSON.stringify(payload),
  }).catch((e) => console.warn("notify-email call failed:", e instanceof Error ? e.message : e));
  // deno-lint-ignore no-explicit-any
  const rt = (globalThis as any).EdgeRuntime;
  if (rt && typeof rt.waitUntil === "function") rt.waitUntil(p);
}

// ---------------------------------------------------------------------------
// Dedicated-account helpers
// ---------------------------------------------------------------------------
// Transfers into a dedicated account can't "add the fee on top" (the sender just sends money), so the
// admin fee is ALWAYS deducted from what arrives. If the fee would swallow the whole amount, nothing is deducted.
function adminFeeOnTransfer(rules: FeeRules, amountNaira: number): { fee: number; net: number } {
  const amountKobo = Math.round(amountNaira * 100);
  let feeKobo = 0;
  if (rules.type === "percentage") {
    feeKobo = Math.round((amountKobo * rules.value) / 100);
    if (rules.cap > 0) feeKobo = Math.min(feeKobo, Math.round(rules.cap * 100));
  } else if (rules.type === "flat") {
    feeKobo = Math.round(rules.value * 100);
  }
  if (feeKobo >= amountKobo) feeKobo = 0;
  return { fee: feeKobo / 100, net: (amountKobo - feeKobo) / 100 };
}

// Wording for the card, built from the LIVE admin fee — "below 1%" only appears while it is true.
function feeWording(rules: FeeRules) {
  const sample = 5000;
  const { fee } = adminFeeOnTransfer(rules, sample);
  const pct = (fee / sample) * 100;
  if (rules.type === "none" || fee === 0) return { badge: "Save Money • No Deposit Fee", short: "no deposit fee", below_one_percent: true, sample_amount: sample, sample_fee: 0 };
  if (pct < 1) return { badge: "Save Money • Below 1% Deposit Fee", short: "below 1%", below_one_percent: true, sample_amount: sample, sample_fee: fee };
  return { badge: "Save Money • Low Deposit Fee", short: "low", below_one_percent: false, sample_amount: sample, sample_fee: fee };
}

// Never let a BVN-looking number reach a log line.
const redact = (v: unknown) => String(v ?? "").replace(/\b\d{10,11}\b/g, "***").slice(0, 200);

const BANK_NAMES: Record<string, string> = { "058": "GTBank", "737": "GTBank" };
const IDENTITY_RE = /bvn|dob|date of birth|birth|name|match|verif|not found|invalid/i;
const EXISTS_RE = /already|exist|duplicate/i;
const VA_DAILY_REJECTIONS = 3;

// "2000-01-31" → "31/01/2000"; null if it isn't a real date, is in the future, or the person is under 18 / over 110.
function dobToSquad(iso: string): { ok: true; value: string } | { ok: false; why: string } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return { ok: false, why: "Enter your date of birth." };
  const y = +m[1], mo = +m[2], d = +m[3];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return { ok: false, why: "That date of birth isn't a real date." };
  const now = new Date();
  if (dt.getTime() > now.getTime()) return { ok: false, why: "Date of birth can't be in the future." };
  let age = now.getUTCFullYear() - y;
  if (now.getUTCMonth() < mo - 1 || (now.getUTCMonth() === mo - 1 && now.getUTCDate() < d)) age--;
  if (age < 18) return { ok: false, why: "You must be 18 or older to open a dedicated account." };
  if (age > 110) return { ok: false, why: "Please check the year of your date of birth." };
  return { ok: true, value: `${m[3]}/${m[2]}/${m[1]}` };
}

function normalizePhone(raw: string): string | null {
  let p = String(raw || "").replace(/[\s()-]/g, "");
  if (p.startsWith("+")) p = p.slice(1);
  if (p.startsWith("234") && p.length === 13) p = "0" + p.slice(3);
  if (/^\d{10}$/.test(p) && !p.startsWith("0")) p = "0" + p;
  return /^0\d{10}$/.test(p) ? p : null;
}

function json(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    // ---- who is calling (same pattern as bigisub-proxy) ----
    const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    if (!token) return json({ error: "Not authenticated." }, 401);
    const { data: callerData, error: callerErr } = await admin.auth.getUser(token);
    if (callerErr || !callerData?.user) return json({ error: "Not authenticated." }, 401);

    const { data: caller, error: callerRowErr } = await admin.from("app_users")
      .select("id, business_id, role, is_active, can_bill_payments, phone, email, first_name, last_name")
      .eq("auth_user_id", callerData.user.id).maybeSingle();
    if (callerRowErr) return json({ error: callerRowErr.message }, 500);
    if (!caller) return json({ error: "Account not found." }, 404);
    if (caller.is_active === false) return json({ error: "This account has been deactivated." }, 403);
    const canTransact = caller.role === "master" || (caller.role === "staff" && !!caller.can_bill_payments);
    if (!canTransact) return json({ error: "You don't have permission to fund the wallet." }, 403);
    if (!caller.business_id) return json({ error: "Your account isn't linked to a business yet." }, 400);
    const businessId = String(caller.business_id);

    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "");

    // ======================= fee_preview =======================
    if (action === "fee_preview" || action === "initiate") {
      const amount = Math.round(Number(body.amount) * 100) / 100;
      if (!Number.isFinite(amount) || amount < MIN_DEPOSIT || amount > MAX_DEPOSIT) {
        return json({ error: `Enter an amount between ₦${MIN_DEPOSIT.toLocaleString()} and ₦${MAX_DEPOSIT.toLocaleString()}.` }, 400);
      }
      const calc = await calculateDepositFee(admin, amount);
      if (calc.netWalletCredit <= 0) return json({ error: "That amount is too small to cover the funding fee. Try a larger amount." }, 400);

      if (action === "fee_preview") {
        return json({
          amount, fee: calc.fee, pay_amount: calc.grossAmount, wallet_credit: calc.netWalletCredit,
          fee_type: calc.rules.type, fee_paid_by: calc.rules.passToUser ? "customer" : "deducted_from_credit",
        });
      }

      // ======================= initiate =======================
      if (!SQUAD_SECRET_KEY) return json({ error: "Card/bank funding isn't available right now." }, 500);

      // Simple throttle: at most 8 new checkouts per business per 10 minutes.
      const since = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      const { count: recent } = await admin.from("squad_payments").select("id", { count: "exact", head: true })
        .eq("business_id", businessId).gte("created_at", since);
      if ((recent || 0) >= 8) return json({ error: "Too many funding attempts. Please wait a few minutes and try again." }, 429);

      const email = String(caller.email || callerData.user.email || "").trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: "Add an email address to your profile before funding your wallet." }, 400);

      const reference = `EMEMART_${Date.now()}_${crypto.randomUUID().replace(/-/g, "").slice(0, 6)}`;
      const callback = SQUAD_CALLBACK_URL
        ? `${SQUAD_CALLBACK_URL}${SQUAD_CALLBACK_URL.includes("?") ? "&" : "?"}squad_ref=${encodeURIComponent(reference)}`
        : undefined;

      // The record (with the fee rules in force RIGHT NOW) exists BEFORE the customer pays.
      const { error: insErr } = await admin.from("squad_payments").insert({
        reference, business_id: businessId, user_id: String(caller.id), user_email: email,
        requested_amount: amount, gross_amount: calc.grossAmount, gross_kobo: calc.grossKobo,
        app_fee: calc.fee, net_credited: calc.netWalletCredit,
        fee_type: calc.rules.type, fee_value: calc.rules.value, fee_cap: calc.rules.cap, pass_charge: calc.rules.passToUser,
        status: "pending",
      });
      if (insErr) { console.error("squad_payments insert failed:", insErr.message); return json({ error: "Could not start the payment. Please try again." }, 500); }

      const payload: Record<string, unknown> = {
        amount: calc.grossKobo,                       // Squad wants KOBO
        email,
        currency: "NGN",
        initiate_type: "inline",
        transaction_ref: reference,
        payment_channels: ["card", "bank", "ussd", "transfer"],
        pass_charge: calc.rules.passToUser,           // true → Squad's own charge is added on top for the payer
        customer_name: `${caller.first_name || ""} ${caller.last_name || ""}`.trim() || undefined,
        metadata: { user_id: String(caller.id), business_id: businessId, target_wallet_credit: calc.netWalletCredit, service_type: "vtu_wallet_funding" },
      };
      if (callback) payload.callback_url = callback;

      let sqRes: Response; let sq: any = null;
      try {
        sqRes = await fetch(`${SQUAD_BASE_URL}/transaction/initiate`, {
          method: "POST",
          headers: { Authorization: `Bearer ${SQUAD_SECRET_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        sq = await sqRes.json().catch(() => null);
      } catch (e) {
        await admin.from("squad_payments").update({ status: "failed" }).eq("reference", reference);
        console.error("Squad initiate network error:", e instanceof Error ? e.message : e);
        return json({ error: "Couldn't reach the payment provider. Please try again." }, 502);
      }
      const checkoutUrl = sq?.data?.checkout_url || sq?.data?.auth_url || null;
      if (!sqRes.ok || !checkoutUrl) {
        await admin.from("squad_payments").update({ status: "failed" }).eq("reference", reference);
        console.error("Squad initiate rejected:", sqRes.status, JSON.stringify(sq)?.slice(0, 400));
        return json({ error: "The payment provider didn't accept the request. Please try again." }, 502);
      }
      await admin.from("squad_payments").update({ checkout_url: checkoutUrl }).eq("reference", reference);

      return json({
        checkout_url: checkoutUrl, reference,
        amount, fee: calc.fee, pay_amount: calc.grossAmount, wallet_credit: calc.netWalletCredit,
      });
    }

    // ======================= va_status =======================
    if (action === "va_status") {
      const { data: b } = await admin.from("businesses")
        .select("squad_account_number, squad_bank_name, squad_account_name, fpe_account_number, fpe_bank_name")
        .eq("id", businessId).maybeSingle();
      const rules = await loadFeeRules(admin);
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const { count: rejected } = await admin.from("squad_va_attempts").select("id", { count: "exact", head: true })
        .eq("business_id", businessId).eq("outcome", "rejected").gte("created_at", since);
      return json({
        account: b?.squad_account_number ? { number: b.squad_account_number, bank_name: b.squad_bank_name || "", name: b.squad_account_name || "" } : null,
        // An older dedicated account that still receives money (read-only; its own webhook keeps crediting it).
        legacy: b?.fpe_account_number ? { number: b.fpe_account_number, bank_name: b.fpe_bank_name || "" } : null,
        fee: feeWording(rules),
        attempts_left: Math.max(0, VA_DAILY_REJECTIONS - (rejected || 0)),
        is_owner: caller.role === "master",
      });
    }

    // ======================= create_virtual_account =======================
    if (action === "create_virtual_account") {
      if (caller.role !== "master") return json({ error: "Only the business owner can open the dedicated account." }, 403);
      if (!SQUAD_SECRET_KEY) return json({ error: "Dedicated accounts aren't available right now. Please try again later." }, 500);

      const { data: biz } = await admin.from("businesses").select("squad_account_number, squad_bank_name, squad_account_name").eq("id", businessId).maybeSingle();
      const asAccount = (n: string, bank: string, name: string) => ({ number: n, bank_name: bank, name });
      if (biz?.squad_account_number) return json({ account: asAccount(biz.squad_account_number, biz.squad_bank_name || "", biz.squad_account_name || ""), already: true });

      // ---- validate (none of these count against the daily limit) ----
      if (body.consent !== true) return json({ error: "Please tick the box to agree before continuing." }, 400);
      const bvn = String(body.bvn || "").replace(/\s/g, "");
      if (!/^\d{11}$/.test(bvn)) return json({ error: "Your BVN must be exactly 11 digits." }, 400);
      const dob = dobToSquad(String(body.dob || ""));
      if ("why" in dob) return json({ error: dob.why }, 400);
      const nameRe = /^[\p{L}][\p{L} '.-]{0,59}$/u;
      const firstName = String(body.first_name || "").trim(); const lastName = String(body.last_name || "").trim();
      if (!nameRe.test(firstName) || !nameRe.test(lastName)) return json({ error: "Enter your first and last name as they appear on your BVN." }, 400);
      const phone = normalizePhone(String(body.phone || ""));
      if (!phone) return json({ error: "Enter a valid Nigerian phone number." }, 400);
      const email = String(body.email || caller.email || callerData.user.email || "").trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: "Enter a valid email address." }, 400);

      // ---- recovery 1: Squad already opened it earlier but our save failed ----
      const { data: prior } = await admin.from("squad_va_attempts").select("account_number, bank_name, account_name")
        .eq("business_id", businessId).eq("outcome", "created").not("account_number", "is", null)
        .order("created_at", { ascending: false }).limit(1).maybeSingle();
      const identifier = `EMEMARTVA_${businessId}`;
      const saveAccount = async (num: string, bank: string, name: string) => {
        const { error } = await admin.from("businesses").update({
          squad_account_number: num, squad_bank_name: bank, squad_account_name: name,
          squad_customer_identifier: identifier, squad_va_created_at: new Date().toISOString(),
        }).eq("id", businessId);
        return error;
      };
      if (prior?.account_number) {
        const e = await saveAccount(prior.account_number, prior.bank_name || "", prior.account_name || "");
        if (!e) return json({ account: asAccount(prior.account_number, prior.bank_name || "", prior.account_name || ""), recovered: true });
        console.error("va recovery save failed:", e.message);
      }

      // ---- daily limit: only bank/identity rejections count ----
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const { count: rejected } = await admin.from("squad_va_attempts").select("id", { count: "exact", head: true })
        .eq("business_id", businessId).eq("outcome", "rejected").gte("created_at", since);
      if ((rejected || 0) >= VA_DAILY_REJECTIONS) {
        return json({ error: "Too many unsuccessful verification attempts today. Please check your details and try again tomorrow, or contact support.", attempts_left: 0 }, 429);
      }
      const note = async (outcome: "rejected" | "error" | "created", detail: string, acct?: { n: string; b: string; a: string }) => {
        await admin.from("squad_va_attempts").insert({
          business_id: businessId, outcome, detail: redact(detail),
          account_number: acct?.n ?? null, bank_name: acct?.b ?? null, account_name: acct?.a ?? null,
        });
      };

      // ---- call Squad (the BVN/DOB go only into this request body) ----
      const payload: Record<string, unknown> = {
        customer_identifier: identifier, first_name: firstName, last_name: lastName,
        mobile_num: phone, email, bvn, dob: (dob as { value: string }).value,
      };
      if (SQUAD_BENEFICIARY_ACCOUNT) payload.beneficiary_account = SQUAD_BENEFICIARY_ACCOUNT;

      const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), 45000);
      let res: Response; let sq: any = null;
      try {
        res = await fetch(`${SQUAD_BASE_URL}/virtual-account`, {
          method: "POST", signal: ctrl.signal,
          headers: { Authorization: `Bearer ${SQUAD_SECRET_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        sq = await res.json().catch(() => null);
      } catch (e) {
        clearTimeout(timer);
        await note("error", e instanceof Error ? e.name : "network");
        return json({ error: "This is taking longer than expected. Please wait a minute, then tap Verify again — you won't be charged anything." }, 502);
      }
      clearTimeout(timer);

      const msg = String(sq?.message || sq?.error || "");
      const d = sq?.data || {};
      const accountNumber = String(d.virtual_account_number || d.account_number || "").trim();

      if (res.ok && accountNumber) {
        const bankName = String(d.bank_name || BANK_NAMES[String(d.bank_code || "")] || "Nigerian bank");
        const accountName = String(d.account_name || d.customer_name || `${d.first_name || firstName} ${d.last_name || lastName}`).trim().toUpperCase();
        await note("created", "ok", { n: accountNumber, b: bankName, a: accountName });   // BEFORE saving, so a failed save is recoverable
        const saveErr = await saveAccount(accountNumber, bankName, accountName);
        if (saveErr) {
          console.error("va created at Squad but save failed:", businessId, accountNumber, saveErr.message);
          return json({ error: "Your account was opened but we couldn't save it. Please tap Verify again — you won't be charged twice." }, 500);
        }
        return json({ account: asAccount(accountNumber, bankName, accountName) });
      }

      // ---- recovery 2: Squad says it already exists and we hold no record of it ----
      if (EXISTS_RE.test(msg)) {
        await note("error", "exists: " + msg);
        console.error("va already exists at Squad, no local record. business:", businessId);
        return json({ error: "An account was already opened for this business. Please contact support so we can link it for you." }, 409);
      }

      console.error("Squad virtual-account rejected:", res.status, redact(msg));
      if (res.status >= 500) {
        await note("error", `${res.status} ${msg}`);
        return json({ error: "Our payment partner is having trouble right now. Nothing was saved. Please try again in a few minutes." }, 502);
      }
      if (IDENTITY_RE.test(msg)) {
        await note("rejected", `${res.status} ${msg}`);
        const left = Math.max(0, VA_DAILY_REJECTIONS - ((rejected || 0) + 1));
        return json({
          error: `We couldn't verify those details with the bank. Check that your BVN, date of birth and names match your bank records.${left > 0 ? ` You have ${left} attempt${left === 1 ? "" : "s"} left today.` : " You've used all your attempts for today."}`,
          attempts_left: left,
        }, 422);
      }
      await note("error", `${res.status} ${msg}`);
      return json({ error: "We couldn't open the account because the request was incomplete. Please contact support." }, 502);
    }

    // ======================= verify =======================
    if (action === "verify") {
      const reference = String(body.reference || "").trim();
      if (!reference) return json({ error: "Missing reference." }, 400);
      const { data: row } = await admin.from("squad_payments").select("reference, business_id, status, net_credited, new_balance")
        .eq("reference", reference).eq("business_id", businessId).maybeSingle();
      if (!row) return json({ error: "Payment not found." }, 404);

      const balanceNow = async () => {
        const { data: b } = await admin.from("businesses").select("bill_wallet_balance").eq("id", businessId).maybeSingle();
        return Number(b?.bill_wallet_balance ?? 0);
      };
      if (row.status === "success") return json({ status: "success", wallet_balance: await balanceNow() });
      if (row.status !== "pending") return json({ status: row.status, wallet_balance: await balanceNow() });

      if (!SQUAD_SECRET_KEY) return json({ error: "Verification isn't available right now." }, 500);
      let v: any = null; let vRes: Response;
      try {
        vRes = await fetch(`${SQUAD_BASE_URL}/transaction/verify/${encodeURIComponent(reference)}`, {
          headers: { Authorization: `Bearer ${SQUAD_SECRET_KEY}` },
        });
        v = await vRes.json().catch(() => null);
      } catch (_e) { return json({ error: "Couldn't reach the payment provider. Try again in a moment." }, 502); }

      const sqStatus = String(v?.data?.transaction_status || "").toLowerCase();
      if (!vRes.ok || sqStatus !== "success") {
        return json({ status: sqStatus || "pending", wallet_balance: await balanceNow() });
      }
      // The amount was fixed by US when the checkout was created, so a payer can't change it; the
      // webhook path additionally checks the signed amount. Here: status + reference match is enough.
      const { data: applied, error: rpcErr } = await admin.rpc("squad_apply_success", {
        p_ref: reference, p_received_kobo: null, p_squad_fee: null, p_gateway_ref: v?.data?.gateway_transaction_ref || null, p_raw: v,
      });
      if (rpcErr) { console.error("squad_apply_success failed:", rpcErr.message); return json({ error: "Could not credit your wallet yet. Please contact support with your reference." }, 500); }
      if (applied?.result === "applied") {
        fireEmail({
          type: "wallet_funding", to: applied.user_email, name: `${caller.first_name || ""}`.trim(),
          data: { amount: applied.net_credited, fee: applied.app_fee, previous_balance: applied.previous_balance, new_balance: applied.new_balance, reference: applied.reference, method: "Card / bank (Squad)" },
        });
      }
      return json({ status: "success", wallet_balance: await balanceNow() });
    }

    return json({ error: "Unknown action." }, 400);
  } catch (e) {
    console.error("squad-initiate error:", e);
    return json({ error: e instanceof Error ? e.message : "Unexpected error" }, 500);
  }
});
