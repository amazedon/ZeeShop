// supabase/functions/flutterwave-webhook/index.ts
//
// Flutterwave calls this directly (server-to-server) whenever a payment
// event happens — independent of whatever the customer's browser does.
// This one function handles TWO things:
//   1. SUBSCRIPTION plan upgrades (meta.business_id / plan / interval) — unchanged.
//   2. Bill Payments wallet funding by transfer to a business's permanent
//      account (a Flutterwave "payout subaccount") — event "transfer.completed".
//
// IMPORTANT: deploy this with --no-verify-jwt, since Flutterwave has no
// Supabase session to send:
//   supabase functions deploy flutterwave-webhook --no-verify-jwt
//
// Authenticity comes from the verif-hash header check below, NOT from
// Supabase's JWT verification — that's why --no-verify-jwt is safe.
//
// ALSO REQUIRED in the Flutterwave dashboard, or wallet funding notices are
// never sent at all: Settings → Webhooks → choose V3 webhooks → tick
// "Enable payout subaccounts wallet funding hook".
//
// Wallet funding is safe against double credits: each payment's reference is
// stored in wallet_topups.provider_reference (UNIQUE) BEFORE the balance
// moves, and the balance is changed by one atomic SQL function.

import { createClient } from "npm:@supabase/supabase-js@2.45.4";

// "1,400.50" -> 1400.5
function toNumber(v: unknown): number {
  return Number(String(v ?? "").replace(/,/g, ""));
}

// Flutterwave's wallet-funding reference sometimes carries a "PSA_" prefix and
// sometimes not (webhook vs. transactions list). Normalise so the webhook and
// the sync fallback can never credit the same payment twice.
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function normaliseRef(ref: unknown): string {
  return String(ref ?? "").replace(/^PSA_/i, "");
}

Deno.serve(async (req: Request) => {
  try {
    // ---- Confirm this request genuinely came from Flutterwave ----
    // Two ways Flutterwave proves itself, depending on the webhook version chosen in its dashboard:
    //   V3:  header  verif-hash            = your secret hash, as is
    //   V4:  header  flutterwave-signature = base64( HMAC-SHA256( raw body, secret hash ) )
    // Both sides are trimmed: a stray space or newline in the pasted secret is the classic cause of a permanent 401.
    const rawBody = await req.text();
    const expectedHash = (Deno.env.get("FLW_WEBHOOK_SECRET_HASH") || "").trim();
    const receivedHash = (req.headers.get("verif-hash") || "").trim();
    const receivedSig = (req.headers.get("flutterwave-signature") || "").trim();
    let authentic = false;
    if (expectedHash) {
      if (receivedHash && safeEqual(receivedHash, expectedHash)) authentic = true;
      if (!authentic && receivedSig) {
        const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(expectedHash), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
        const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
        let bin = ""; new Uint8Array(mac).forEach((b) => (bin += String.fromCharCode(b)));
        if (safeEqual(btoa(bin), receivedSig)) authentic = true;
      }
    }
    if (!authentic) {
      // Safe diagnostics: lengths and presence only, never the secret itself.
      console.error("flutterwave-webhook 401 | secret configured:", !!expectedHash, "(length", expectedHash.length + ")",
        "| verif-hash header:", receivedHash ? "present (length " + receivedHash.length + ")" : "absent",
        "| flutterwave-signature header:", receivedSig ? "present" : "absent");
      return new Response("Unauthorized", { status: 401 });
    }

    const payload = JSON.parse(rawBody);
    const data = payload?.data;

    // Only act on a completed, successful payment — acknowledge everything
    // else with 200 so Flutterwave doesn't keep retrying non-actionable events.
    // (Case-insensitive: wallet-funding events say "SUCCESSFUL" in capitals,
    // card/transfer charges say "successful". The old strict check silently
    // skipped every wallet-funding notice.)
    if (!data || String(data.status ?? "").toLowerCase() !== "successful") {
      return new Response("ok", { status: 200 });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const adminClient = createClient(supabaseUrl, serviceKey);

    const meta = data.meta || {};
    const businessId = meta.business_id;
    const plan = meta.plan;
    const interval = meta.interval;

    // =====================================================================
    // 1. SUBSCRIPTION PLAN UPGRADE (original logic, unchanged)
    // =====================================================================
    if (businessId && plan && interval) {
      const transactionId = String(data.id);
      const currency = data.currency;
      const amount = Number(data.amount);

      // ---- Replay protection: skip if we've already processed this transaction ----
      const { error: insertErr } = await adminClient
        .from("processed_payments")
        .insert({ transaction_id: transactionId, business_id: businessId, plan, interval, amount, currency });

      if (insertErr) {
        return new Response("ok — already processed", { status: 200 });
      }

      // ---- Independently verify the amount against the admin-set price ----
      const { data: priceRow } = await adminClient
        .from("pricing")
        .select("amount")
        .eq("plan", plan)
        .eq("interval", interval)
        .eq("currency", currency)
        .single();

      if (!priceRow || amount < Number(priceRow.amount)) {
        return new Response("ok — amount mismatch, not upgraded", { status: 200 });
      }

      // ---- Apply the upgrade ----
      const periodDays = interval === "yearly" ? 365 : 30;
      const expiresAt = new Date(Date.now() + periodDays * 24 * 60 * 60 * 1000).toISOString();

      await adminClient
        .from("businesses")
        .update({ subscription_plan: plan, subscription_expires_at: expiresAt })
        .eq("id", businessId);

      return new Response("ok — upgraded", { status: 200 });
    }

    // =====================================================================
    // 2. WALLET FUNDING — transfer into a business's permanent account
    // =====================================================================
    // TEMPORARY: log the full payload so the exact field holding the
    // RECEIVING account number can be confirmed from the first real transfer.
    // (Flutterwave's sample shows data.account_number; this also tries the
    // other likely fields.) Remove this log once confirmed.
    console.log("flutterwave-webhook wallet payload:", JSON.stringify(payload));

    const candidates = [
      data.account_number, data.nuban, data.virtual_account_number,
      meta.account_number, data.customer?.account_number,
    ].filter((x) => x !== undefined && x !== null && String(x).trim() !== "").map((x) => String(x).trim());

    let bizId: string | null = null;
    for (const acct of candidates) {
      const { data: biz } = await adminClient.from("businesses").select("id").eq("psa_account_number", acct).maybeSingle();
      if (biz) { bizId = String(biz.id); break; }
    }
    if (!bizId) {
      // Not one of ours (or the field wasn't recognised). The app's own
      // "sync" check against Flutterwave's transactions list will still
      // catch a real transfer, so just acknowledge.
      return new Response("ok — no matching business account", { status: 200 });
    }

    const ref = normaliseRef(data.reference || data.id);
    if (!ref) return new Response("ok — no reference, skipped", { status: 200 });

    // What the wallet is credited with: the amount received minus
    // Flutterwave's fee for it. If the fee is missing we credit the amount.
    const gross = toNumber(data.amount);
    // Flutterwave's wallet-funding notice often carries no fee. The app's Refresh Balance path applies an ESTIMATED
    // percentage in that case, so do the same here — otherwise the same payment is credited differently depending on
    // which path happens to run first.
    const estimatedPercent = Number(Deno.env.get("FLW_ESTIMATED_FEE_PERCENT")) || 2.0;
    const reportedFee = toNumber(data.fee);
    const fee = Number.isFinite(reportedFee) && reportedFee > 0
      ? reportedFee
      : Math.round(gross * (estimatedPercent / 100) * 100) / 100;
    if (!Number.isFinite(gross) || gross <= 0) return new Response("ok — no valid amount", { status: 200 });
    const net = Math.round((gross - fee) * 100) / 100;

    // Record FIRST — the unique provider_reference blocks a double credit.
    const topupId = crypto.randomUUID();
    const { error: recErr } = await adminClient.from("wallet_topups").insert({
      id: topupId, business_id: bizId, amount: net > 0 ? net : 0, gross_amount: gross, fee,
      provider_reference: `flw:${ref}`, status: net > 0 ? "success" : "ignored",
    });
    if (recErr) return new Response("ok — already processed", { status: 200 });
    if (net <= 0) return new Response("ok — nothing left after the fee", { status: 200 });

    const { error: creditErr } = await adminClient.rpc("increment_bill_wallet", { p_business_id: bizId, p_amount: net });
    if (creditErr) {
      // Undo the record so a retry (or the app's sync) can credit it properly.
      await adminClient.from("wallet_topups").delete().eq("id", topupId);
      console.error("flutterwave-webhook: wallet credit failed:", creditErr.message);
      return new Response("Credit failed, please retry", { status: 500 });
    }

    return new Response("ok — bill wallet funded", { status: 200 });
  } catch (e) {
    // Return 200 for unexpected errors after logging, so Flutterwave doesn't
    // hammer retries on a bug — but this should be monitored.
    console.error("flutterwave-webhook error:", e);
    return new Response("error logged", { status: 200 });
  }
});
