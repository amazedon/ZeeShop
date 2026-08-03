// supabase/functions/process-auto-renewals/index.ts
//
// Runs on a schedule (see cron setup instructions below) — NOT called
// directly by the app. Finds every business that:
//   - has auto_renew_enabled = true
//   - has a saved, active, consented card token
//   - is due (expires within the next 24h, or already expired)
// ...and attempts to charge their saved card via Flutterwave's tokenized
// charge API, using the CURRENT admin-set price (never a stale one).
//
// Deploy with:
//   supabase functions deploy process-auto-renewals --no-verify-jwt
// (no-verify-jwt because this is called by pg_cron/pg_net, not a logged-in user)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

Deno.serve(async (req: Request) => {
  // Simple shared-secret check so this can't be triggered by just anyone
  // who finds the URL — pg_cron sends this header (set up below).
  const secret = req.headers.get("x-cron-secret");
  if (secret !== Deno.env.get("CRON_SECRET")) {
    return new Response("Unauthorized", { status: 401 });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const flwSecret = Deno.env.get("FLW_SECRET_KEY")!;
  const admin = createClient(supabaseUrl, serviceKey);

  const now = new Date();
  const in24h = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();

  // Businesses due for renewal: auto-renew on, expiring within 24h or already expired.
  const { data: dueBusinesses, error: dueErr } = await admin
    .from("businesses")
    .select("id, currency, auto_renew_plan, auto_renew_interval, subscription_expires_at")
    .eq("auto_renew_enabled", true)
    .lte("subscription_expires_at", in24h);

  if (dueErr) {
    return new Response(JSON.stringify({ error: dueErr.message }), { status: 500 });
  }

  const results: Record<string, unknown>[] = [];

  for (const biz of dueBusinesses || []) {
    const result = await renewOne(admin, flwSecret, biz);
    results.push(result);
  }

  return new Response(JSON.stringify({ processed: results.length, results }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});

async function renewOne(
  admin: ReturnType<typeof createClient>,
  flwSecret: string,
  biz: { id: string; currency: string; auto_renew_plan: string; auto_renew_interval: string; subscription_expires_at: string }
) {
  const businessId = biz.id;
  const plan = biz.auto_renew_plan;
  const interval = biz.auto_renew_interval;

  // Mark that we attempted this, regardless of outcome — used to avoid
  // hammering the same business every time this function runs before
  // its expiry date actually moves.
  await admin.from("businesses").update({ last_auto_renew_attempt_at: new Date().toISOString() }).eq("id", businessId);

  // Get the saved card
  const { data: card } = await admin
    .from("saved_payment_methods")
    .select("*")
    .eq("business_id", businessId)
    .eq("is_active", true)
    .eq("consent_given", true)
    .maybeSingle();

  if (!card) {
    return await logAndReturn(admin, businessId, plan, interval, null, null, false, "No active consented card on file");
  }

  // Get the current admin-set price for this business's currency
  const currency = ["NGN", "GHS", "GBP", "EUR"].includes(biz.currency) ? biz.currency : "USD";
  const { data: priceRow } = await admin
    .from("pricing")
    .select("amount")
    .eq("plan", plan)
    .eq("interval", interval)
    .eq("currency", currency)
    .single();

  if (!priceRow || Number(priceRow.amount) <= 0) {
    return await logAndReturn(admin, businessId, plan, interval, null, currency, false, "No valid price configured");
  }

  const amount = Number(priceRow.amount);
  const txRef = "zed_autorenew_" + businessId + "_" + Date.now();

  try {
    const chargeRes = await fetch("https://api.flutterwave.com/v3/tokenized-charges", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${flwSecret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        token: card.flw_token,
        currency,
        amount,
        email: "billing@ememart.com", // Flutterwave requires an email; not the customer's, since we don't store it here
        tx_ref: txRef,
      }),
    });
    const chargeData = await chargeRes.json();

    const success = chargeData?.status === "success" && chargeData?.data?.status === "successful";

    if (success) {
      const periodDays = interval === "yearly" ? 365 : 30;
      const expiresAt = new Date(Date.now() + periodDays * 24 * 60 * 60 * 1000).toISOString();
      await admin.from("businesses").update({ subscription_plan: plan, subscription_expires_at: expiresAt }).eq("id", businessId);
      return await logAndReturn(admin, businessId, plan, interval, amount, currency, true, null, String(chargeData?.data?.id || ""));
    } else {
      // Charge failed (declined, expired card, etc.) — turn off auto-renew so
      // it doesn't keep retrying a dead card indefinitely; the business will
      // see the normal expiry reminder banner and can renew manually or
      // re-enable auto-renewal with a fresh card.
      await admin.from("businesses").update({ auto_renew_enabled: false }).eq("id", businessId);
      await admin.from("saved_payment_methods").update({ is_active: false }).eq("business_id", businessId);
      return await logAndReturn(admin, businessId, plan, interval, amount, currency, false, chargeData?.message || "Charge declined");
    }
  } catch (e) {
    return await logAndReturn(admin, businessId, plan, interval, amount, currency, false, e instanceof Error ? e.message : "Unexpected error");
  }
}

async function logAndReturn(
  admin: ReturnType<typeof createClient>,
  businessId: string,
  plan: string,
  interval: string,
  amount: number | null,
  currency: string | null,
  success: boolean,
  errorMessage: string | null,
  flwTransactionId?: string
) {
  await admin.from("auto_renewal_log").insert({
    business_id: businessId,
    plan,
    interval,
    amount,
    currency,
    success,
    error_message: errorMessage,
    flw_transaction_id: flwTransactionId || null,
  });
  return { businessId, success, errorMessage };
}
