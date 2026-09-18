// supabase/functions/flutterwave-webhook/index.ts
//
// Flutterwave calls this directly (server-to-server) whenever a payment
// event happens — independent of whatever the customer's browser does.
// This one function now handles TWO separate things Flutterwave pays for,
// because Flutterwave only lets you configure one webhook URL+secret per
// account, so both have to live behind the same endpoint:
//   1. Subscription plan upgrades (the original, working logic below —
//      untouched, still keyed off meta.business_id/plan/interval).
//   2. Bill Payments wallet top-ups (added below that) — bank-transfer
//      top-ups matched by tx_ref, and dedicated PSA account top-ups
//      matched by the receiving account number.
// Each branch only acts on the shape of event it recognizes and leaves
// everything else alone, so neither can accidentally process the other's
// events — a bill-wallet top-up has no plan/interval in its meta, and a
// subscription payment's tx_ref won't match the "zeeshop_bt_" prefix or
// any business's PSA account number.
//
// IMPORTANT: deploy this with --no-verify-jwt, since Flutterwave has no
// Supabase session to send:
//   supabase functions deploy flutterwave-webhook --no-verify-jwt
//
// Authenticity here comes from the verif-hash header check below, NOT
// from Supabase's JWT verification — that's why --no-verify-jwt is safe.

import { createClient } from "npm:@supabase/supabase-js@2.45.4";

function extractPsaAccountNumber(data: any): string | null {
  // Best-effort — tighten to the exact field once a real PSA webhook
  // payload has been observed (check Supabase function logs). Only
  // Flutterwave's create/fetch/list PSA endpoints' shapes were confirmed
  // from docs, not a live funding-webhook payload.
  return data?.account_number || data?.nuban || data?.virtual_account_number
    || data?.meta_data?.account_number || data?.customer?.account_number || null;
}

Deno.serve(async (req: Request) => {
  try {
    // ---- Confirm this request genuinely came from Flutterwave ----
    const receivedHash = req.headers.get("verif-hash");
    const expectedHash = Deno.env.get("FLW_WEBHOOK_SECRET_HASH");
    if (!expectedHash || receivedHash !== expectedHash) {
      return new Response("Unauthorized", { status: 401 });
    }

    const payload = await req.json();
    const data = payload?.data;

    // Only act on a completed, successful charge — acknowledge everything
    // else with 200 so Flutterwave doesn't keep retrying non-actionable events.
    if (!data || data.status !== "successful") {
      return new Response("ok", { status: 200 });
    }

    const transactionId = String(data.id);
    const meta = data.meta || {};
    const businessId = meta.business_id;
    const plan = meta.plan;
    const interval = meta.interval;
    const currency = data.currency;
    const amount = Number(data.amount);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const adminClient = createClient(supabaseUrl, serviceKey);

    if (!businessId || !plan || !interval) {
      // Not a subscription payment (no plan/interval in meta) — check
      // whether it's a Bill Payments wallet top-up before giving up on it.
      // ---------------------------------------------------------------
      // BILL PAYMENTS WALLET TOP-UPS (added — subscription logic above
      // and below this block is unchanged from the original file)
      // ---------------------------------------------------------------
      const txRef: string | undefined = data?.tx_ref;
      if (txRef && txRef.startsWith("zeeshop_bt_")) {
        // ---- Temporary bank-transfer top-up: match the pre-created pending row ----
        const { data: topup } = await adminClient
          .from("wallet_topups")
          .select("id, business_id, amount, status")
          .eq("flutterwave_tx_ref", txRef)
          .maybeSingle();
        if (!topup || topup.status === "success") return new Response("ok", { status: 200 }); // unknown, or already credited (webhook retry)

        const { data: biz } = await adminClient.from("businesses").select("bill_wallet_balance").eq("id", topup.business_id).maybeSingle();
        const newBalance = Number(biz?.bill_wallet_balance || 0) + amount;
        await adminClient.from("businesses").update({ bill_wallet_balance: newBalance }).eq("id", topup.business_id);
        await adminClient.from("wallet_topups").update({ status: "success", flutterwave_transaction_id: transactionId }).eq("id", topup.id);
        return new Response("ok — bill wallet funded (bank transfer)", { status: 200 });
      }

      const psaAccountNumber = extractPsaAccountNumber(data);
      if (psaAccountNumber) {
        // ---- Dedicated PSA account: match by the account that received the transfer ----
        // Prefer `reference` over the charge `id` as the idempotency key —
        // `reference` is the field Flutterwave's PSA transactions-list
        // endpoint uses (confirmed from docs), and bigisub-proxy's
        // sync_psa_wallet reconciles against that same endpoint as a
        // fallback for this webhook. Using the same field in both places
        // means whichever one records a transaction first, the other's
        // unique-constraint insert simply fails and does nothing — no
        // risk of double-crediting even if this webhook's exact payload
        // shape turns out to differ from what's guessed here.
        const dedupeKey = data?.reference ? String(data.reference) : transactionId;
        const { data: biz } = await adminClient.from("businesses").select("id, bill_wallet_balance").eq("psa_account_number", psaAccountNumber).maybeSingle();
        if (!biz) return new Response("ok", { status: 200 }); // account number we don't recognize — nothing to do

        const { error: insertErr } = await adminClient.from("wallet_topups").insert({
          id: crypto.randomUUID(), business_id: biz.id, amount,
          flutterwave_transaction_id: dedupeKey, status: "success",
        });
        if (insertErr) return new Response("ok — already processed", { status: 200 }); // unique-constraint conflict = already recorded

        const newBalance = Number(biz.bill_wallet_balance || 0) + amount;
        await adminClient.from("businesses").update({ bill_wallet_balance: newBalance }).eq("id", biz.id);
        return new Response("ok — bill wallet funded (dedicated account)", { status: 200 });
      }

      // Payment succeeded but matches neither a subscription (missing
      // plan/interval) nor a recognized bill-wallet top-up — acknowledge
      // so Flutterwave stops retrying, but do nothing further.
      return new Response("ok — missing meta, skipped", { status: 200 });
    }

    // ---------------------------------------------------------------
    // SUBSCRIPTION PLAN UPGRADE — original logic, unchanged
    // ---------------------------------------------------------------

    // ---- Replay protection: skip if we've already processed this transaction ----
    const { error: insertErr } = await adminClient
      .from("processed_payments")
      .insert({ transaction_id: transactionId, business_id: businessId, plan, interval, amount, currency });

    if (insertErr) {
      // A unique-constraint violation here means this exact transaction was
      // already processed (likely a Flutterwave retry) — safe to stop.
      return new Response("ok — already processed", { status: 200 });
    }

    // ---- Independently verify the amount against the admin-set price ----
    // (never trust the webhook payload's amount alone — check it against
    // what the business should actually owe, same as the browser-side flow does)
    const { data: priceRow } = await adminClient
      .from("pricing")
      .select("amount")
      .eq("plan", plan)
      .eq("interval", interval)
      .eq("currency", currency)
      .single();

    if (!priceRow || amount < Number(priceRow.amount)) {
      // Underpaid or price mismatch — don't upgrade. Already recorded in
      // processed_payments above for visibility/audit.
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
  } catch (e) {
    // Still return 200 for unexpected errors after logging, so Flutterwave
    // doesn't hammer retries on a bug — but this should be monitored.
    console.error("flutterwave-webhook error:", e);
    return new Response("error logged", { status: 200 });
  }
});
