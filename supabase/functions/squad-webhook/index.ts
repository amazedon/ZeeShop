// supabase/functions/squad-webhook/index.ts
//
// Squad → us, when a checkout payment succeeds.
// Webhook URL to paste in Squad dashboard (Profile → API & Webhooks):
//     https://<project-ref>.supabase.co/functions/v1/squad-webhook
//
// MUST be deployed without Supabase's JWT check (Squad doesn't send one — the
// HMAC signature below is the authentication):
//     supabase functions deploy squad-webhook --no-verify-jwt
//
// Two kinds of event arrive here (Squad allows one webhook URL):
//   A. Checkout payments (Pay now)            → { Event: "charge_successful", Body: {...} }
//   B. Transfers into a DEDICATED ACCOUNT     → flat JSON with virtual_account_number / customer_identifier /
//      transaction_reference / principal_amount (naira) — matched to a business, fee deducted, credited once.
//      Anything we can't place on exactly one business goes to unmatched_payments for Super Admin to resolve.
//
// Rules this file follows:
//   1. Nothing is trusted until the HMAC-SHA512 signature (keyed with SQUAD_SECRET_KEY) matches.
//   2. The amount credited comes from OUR squad_payments row (created at initiation),
//      never from anything in the webhook body or metadata.
//   3. The signed amount must cover what we asked Squad to collect.
//   4. Squad is asked to confirm the transaction (verify endpoint) before any money moves.
//   5. Crediting happens in ONE database function (squad_apply_success): idempotent,
//      row-locked, atomic. A retried or duplicated webhook credits once.
//   6. The email is fire-and-forget; it can never fail the credit.

import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const SQUAD_SECRET_KEY = Deno.env.get("SQUAD_SECRET_KEY") || "";
const SQUAD_BASE_URL = (Deno.env.get("SQUAD_BASE_URL") || "https://sandbox-api-d.squadco.com").replace(/\/+$/, "");

const ok = (body: Record<string, unknown> = { ok: true }) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
const fail = (status: number, msg: string) =>
  new Response(JSON.stringify({ error: msg }), { status, headers: { "Content-Type": "application/json" } });

async function hmacSha512Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-512" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function fireEmail(payload: Record<string, unknown>) {
  const p = fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/notify-email`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}` },
    body: JSON.stringify(payload),
  }).catch((e) => console.warn("notify-email call failed:", e instanceof Error ? e.message : e));
  // deno-lint-ignore no-explicit-any
  const rt = (globalThis as any).EdgeRuntime;
  if (rt && typeof rt.waitUntil === "function") rt.waitUntil(p);
}

// ---------------------------------------------------------------------------
// Dedicated-account transfers
// ---------------------------------------------------------------------------
type FeeRules = { type: "percentage" | "flat" | "none"; value: number; cap: number };

async function loadAdminFeeRules(admin: ReturnType<typeof createClient>): Promise<FeeRules> {
  const { data } = await admin.from("platform_settings").select("deposit_fee_type, deposit_fee_value, deposit_fee_cap").eq("id", 1).maybeSingle();
  const t = String(data?.deposit_fee_type || "none");
  return { type: t === "percentage" || t === "flat" ? t : "none", value: Math.max(0, Number(data?.deposit_fee_value) || 0), cap: Math.max(0, Number(data?.deposit_fee_cap) || 0) };
}
// Same maths as squad-initiate: whole kobo; the fee is deducted from what arrives; a fee that would swallow it all is dropped.
function feeOnTransfer(rules: FeeRules, amountNaira: number): number {
  const k = Math.round(amountNaira * 100);
  let f = 0;
  if (rules.type === "percentage") { f = Math.round((k * rules.value) / 100); if (rules.cap > 0) f = Math.min(f, Math.round(rules.cap * 100)); }
  else if (rules.type === "flat") { f = Math.round(rules.value * 100); }
  return f >= k ? 0 : f / 100;
}
const num = (v: unknown) => { const n = Number(String(v ?? "").replace(/,/g, "")); return Number.isFinite(n) ? n : NaN; };
const safeToken = (v: unknown) => { const t = String(v ?? "").trim(); return /^[A-Za-z0-9_-]{1,80}$/.test(t) ? t : ""; };

// Squad expects this exact acknowledgement for account-transfer notifications.
const vaAck = (ref: string, extra: Record<string, unknown> = {}) =>
  new Response(JSON.stringify({ response_code: 200, transaction_reference: ref, response_description: "Success", ...extra }),
    { status: 200, headers: { "Content-Type": "application/json" } });

async function handleVirtualAccountTransfer(p: any): Promise<Response> {
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  const indicator = String(p.transaction_indicator ?? "C").toUpperCase();
  if (indicator !== "C") return vaAck(String(p.transaction_reference ?? ""), { ignored: "not a credit" });

  const ref = safeToken(p.transaction_reference);
  if (!ref) return fail(400, "No transaction reference");
  const gross = num(p.principal_amount ?? p.amount ?? p.transaction_amount);
  if (!(gross > 0)) return fail(400, "Bad amount");
  const settled = num(p.settled_amount);
  const squadFeeRaw = num(p.fee_charged);
  const squadFee = Number.isFinite(squadFeeRaw) ? squadFeeRaw : (Number.isFinite(settled) && settled <= gross ? Math.round((gross - settled) * 100) / 100 : null);
  const account = safeToken(p.virtual_account_number);
  const identifier = safeToken(p.customer_identifier);

  const rules = await loadAdminFeeRules(admin);
  const fee = feeOnTransfer(rules, gross);

  // ---- who does this belong to? exactly ONE business, by identifier and/or account number ----
  const ids = new Set<string>();
  if (identifier) {
    const { data } = await admin.from("businesses").select("id").eq("squad_customer_identifier", identifier).limit(2);
    (data || []).forEach((r: any) => ids.add(String(r.id)));
  }
  if (account) {
    const { data } = await admin.from("businesses").select("id").eq("squad_account_number", account).limit(2);
    (data || []).forEach((r: any) => ids.add(String(r.id)));
  }

  if (ids.size !== 1) {
    const reason = ids.size === 0 ? "No business matches this dedicated account" : "More than one business matches this dedicated account";
    const { data: existing } = await admin.from("unmatched_payments").select("id").eq("provider", "squad").eq("reference", ref).maybeSingle();
    if (!existing) {
      const { error } = await admin.from("unmatched_payments").insert({
        provider: "squad", reference: ref, account_number: account || null,
        amount: Math.round((gross - fee) * 100) / 100, gross_amount: gross, fee, reason, status: "open", credit_key: `squadva:${ref}`,
      });
      if (error) { console.error("unmatched insert failed:", error.message); return fail(500, "Retry"); }   // 500 → Squad retries; money is never dropped
    }
    await admin.from("squad_va_events").upsert({ tx_ref: ref, business_id: null, account_number: account || null, gross_amount: gross, app_fee: fee, net_credited: 0, squad_fee: squadFee, status: "unmatched", raw: p }, { onConflict: "tx_ref", ignoreDuplicates: true });
    console.warn("squad-webhook VA unmatched:", ref, reason);
    return vaAck(ref, { flagged: "unmatched" });
  }

  const businessId = [...ids][0];
  const { data: applied, error } = await admin.rpc("squad_apply_va_credit", {
    p_business_id: businessId, p_ref: ref, p_gross: gross, p_fee: fee, p_squad_fee: squadFee, p_account: account || null, p_raw: p,
  });
  if (error) { console.error("squad_apply_va_credit error:", error.message); return fail(500, "Could not credit, retry"); }

  if (applied?.result === "applied") {
    // Receipt to the business owner — never blocks, never fails the credit.
    try {
      const { data: b } = await admin.from("businesses").select("owner_auth_user_id").eq("id", businessId).maybeSingle();
      let email: string | null = null;
      if (b?.owner_auth_user_id) { const { data: u } = await admin.auth.admin.getUserById(String(b.owner_auth_user_id)); email = u?.user?.email || null; }
      const { data: m } = await admin.from("app_users").select("email, first_name").eq("business_id", businessId).eq("role", "master").limit(1).maybeSingle();
      fireEmail({
        type: "wallet_funding", to: email || m?.email || null, name: m?.first_name || "",
        data: { amount: applied.net_credited, fee: applied.app_fee, previous_balance: applied.previous_balance, new_balance: applied.new_balance, reference: ref, method: "Bank transfer (dedicated account)" },
      });
    } catch (e) { console.warn("VA receipt email skipped:", e instanceof Error ? e.message : e); }
    return vaAck(ref, { credited: true });
  }
  if (applied?.result === "already") return vaAck(ref, { already: true });
  console.error("squad-webhook VA unexpected result:", ref, JSON.stringify(applied));
  return fail(500, "Unexpected result, retry");
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return fail(405, "POST only");
  if (!SQUAD_SECRET_KEY) { console.error("SQUAD_SECRET_KEY is not set"); return fail(500, "Not configured"); }

  // ---- 1. signature ----
  const raw = await req.text();
  const received = (req.headers.get("x-squad-encrypted-body") || req.headers.get("x-squad-signature") || "").trim().toLowerCase();
  if (!received) return fail(401, "Missing signature");

  // Squad's docs sign the JSON body; depending on how it is serialised, the exact bytes can differ
  // from what arrived, so accept a match on the raw text OR on the re-serialised JSON.
  let valid = safeEqual((await hmacSha512Hex(SQUAD_SECRET_KEY, raw)).toLowerCase(), received);
  let payload: any = null;
  try { payload = JSON.parse(raw); } catch (_e) { return fail(400, "Bad JSON"); }
  if (!valid) valid = safeEqual((await hmacSha512Hex(SQUAD_SECRET_KEY, JSON.stringify(payload))).toLowerCase(), received);
  if (!valid && payload && typeof payload === "object" && "encrypted_body" in payload) {
    const { encrypted_body: _drop, ...rest } = payload;
    valid = safeEqual((await hmacSha512Hex(SQUAD_SECRET_KEY, JSON.stringify(rest))).toLowerCase(), received);
  }
  if (!valid) { console.warn("squad-webhook: signature mismatch"); return fail(401, "Invalid signature"); }

  // ---- dedicated-account transfer? ----
  const looksLikeVa = payload && typeof payload === "object" && !payload.Event && !payload.event &&
    (payload.virtual_account_number || payload.customer_identifier || String(payload.channel || "").toLowerCase() === "virtual-account");
  if (looksLikeVa) return await handleVirtualAccountTransfer(payload);

  // ---- 2. only successful charges matter ----
  const event = String(payload?.Event ?? payload?.event ?? "").toLowerCase();
  if (!["charge_successful", "charge.success", "charge_success"].includes(event)) return ok({ ok: true, ignored: event || "no event" });

  const data = payload?.Body ?? payload?.data ?? payload;
  const reference = String(data?.transaction_ref ?? payload?.TransactionRef ?? "").trim();
  if (!reference) return fail(400, "No transaction reference");

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // A reference we didn't create (e.g. another Squad product on the same account) → acknowledge and ignore.
  const { data: row } = await admin.from("squad_payments").select("reference, status, gross_kobo").eq("reference", reference).maybeSingle();
  if (!row) { console.log("squad-webhook: unknown reference, ignored:", reference); return ok({ ok: true, ignored: "unknown reference" }); }
  if (row.status === "success") return ok({ ok: true, already: true });

  // ---- 3. ask Squad to confirm (a transient failure → 500 so Squad retries later) ----
  let verified: any = null;
  try {
    const vRes = await fetch(`${SQUAD_BASE_URL}/transaction/verify/${encodeURIComponent(reference)}`, {
      headers: { Authorization: `Bearer ${SQUAD_SECRET_KEY}` },
    });
    verified = await vRes.json().catch(() => null);
    if (!vRes.ok && vRes.status >= 500) return fail(500, "Verification unavailable, retry");
  } catch (_e) { return fail(500, "Verification unavailable, retry"); }
  if (String(verified?.data?.transaction_status || "").toLowerCase() !== "success") {
    console.warn("squad-webhook: Squad says not successful for", reference, verified?.data?.transaction_status);
    return ok({ ok: true, ignored: "not successful at Squad" });
  }

  // ---- 4. Squad's own charge, when the payload reports it (amount − merchant_amount) ----
  const amountKobo = Number(data?.amount ?? data?.transaction_amount);
  const merchantKobo = Number(data?.merchant_amount);
  const squadFee = Number.isFinite(amountKobo) && Number.isFinite(merchantKobo) && amountKobo >= merchantKobo
    ? Math.round(amountKobo - merchantKobo) / 100 : null;

  // ---- 5. atomic, idempotent credit ----
  const { data: applied, error } = await admin.rpc("squad_apply_success", {
    p_ref: reference,
    p_received_kobo: Number.isFinite(amountKobo) ? Math.round(amountKobo) : null,
    p_squad_fee: squadFee,
    p_gateway_ref: data?.gateway_ref ?? data?.gateway_transaction_ref ?? null,
    p_raw: payload,
  });
  if (error) { console.error("squad_apply_success error:", error.message); return fail(500, "Could not credit, retry"); }

  switch (applied?.result) {
    case "applied": {
      // ---- 6. email, never blocking ----
      fireEmail({
        type: "wallet_funding", to: applied.user_email,
        data: {
          amount: applied.net_credited, fee: applied.app_fee,
          previous_balance: applied.previous_balance, new_balance: applied.new_balance,
          reference: applied.reference, method: "Card / bank (Squad)",
        },
      });
      return ok({ ok: true, credited: true });
    }
    case "already": return ok({ ok: true, already: true });
    case "amount_mismatch":
      console.error("SQUAD AMOUNT MISMATCH — NOT credited:", reference, JSON.stringify(applied));
      return ok({ ok: true, flagged: "amount_mismatch" });           // 200 so Squad stops retrying; row is flagged for review
    default:
      console.error("squad-webhook unexpected result:", reference, JSON.stringify(applied));
      return ok({ ok: true, flagged: applied?.result || "unknown" });
  }
});
