// supabase/functions/flutterwave-webhook/index.ts
//
// Flutterwave calls this directly (server-to-server) whenever a payment
// event happens — independent of whatever the customer's browser does.
// This is what makes upgrades reliable even if their connection drops,
// they close the tab, or the app crashes right after paying.
//
// IMPORTANT: deploy this with --no-verify-jwt, since Flutterwave has no
// Supabase session to send:
//   supabase functions deploy flutterwave-webhook --no-verify-jwt
//
// Authenticity here comes from the verif-hash header check below, NOT
// from Supabase's JWT verification — that's why --no-verify-jwt is safe.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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

    if (!businessId || !plan || !interval) {
      // Payment succeeded but we can't tell which business/plan it was
      // for (shouldn't happen if checkout always sets meta correctly) —
      // acknowledge so Flutterwave stops retrying, but do nothing further.
      return new Response("ok — missing meta, skipped", { status: 200 });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const adminClient = createClient(supabaseUrl, serviceKey);

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
