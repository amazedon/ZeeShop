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
//
// CHANGES FROM THE ORIGINAL VERSION:
//   - Looks up the real business owner's email (app_users, role='master')
//     instead of a hardcoded placeholder, and uses it for the Flutterwave
//     charge itself.
//   - Emails that owner a receipt on a successful renewal, and a plain
//     notice on a failed one (previously, either outcome was only ever
//     visible in auto_renewal_log — nobody was actually told).
//   - Email sending is best-effort and never blocks or reverses the
//     underlying charge/db update logic above it, which is unchanged.
//   - Email-sending code is inlined rather than imported from a shared
//     file — Supabase's dashboard single-function deploy can't resolve
//     relative imports to a sibling _shared/ folder, so this needs to
//     stay self-contained to deploy cleanly from there.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const TERMII_API_KEY = Deno.env.get("TERMII_API_KEY")!;
const TERMII_BASE_URL = Deno.env.get("TERMII_BASE_URL")!;
const TERMII_EMAIL_CONFIG_ID = Deno.env.get("TERMII_EMAIL_CONFIG_ID")!;

const CURRENCY_SYMBOLS: Record<string, string> = {
  NGN: "₦", GHS: "GH₵", GBP: "£", EUR: "€", USD: "$",
};

// Best-guess Termii endpoint for a plain transactional email (as opposed
// to their confirmed OTP endpoint used elsewhere in this app). If this
// 404s or errors, check Termii's dashboard/docs for the real endpoint
// name and swap it in here.
async function sendEmail(toEmail: string, subject: string, bodyHtml: string): Promise<void> {
  if (!toEmail) return;
  try {
    const res = await fetch(`${TERMII_BASE_URL}/api/email/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: TERMII_API_KEY,
        email_address: toEmail,
        subject,
        content: bodyHtml,
        emailConfigurationId: TERMII_EMAIL_CONFIG_ID,
      }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      console.log("Email send failed:", JSON.stringify(data));
    }
  } catch (e) {
    console.log("Email send threw:", e);
  }
}

function sendReceiptEmail(toEmail: string, businessName: string, plan: string, interval: string, amount: number, currency: string, txRef: string, expiresAt: string): Promise<void> {
  const symbol = CURRENCY_SYMBOLS[currency] || currency + " ";
  const planLabel = plan === "boss" ? "Boss" : "Pro";
  const expiresDate = new Date(expiresAt).toLocaleDateString("en-GB", { year: "numeric", month: "long", day: "numeric" });
  const paidDate = new Date().toLocaleDateString("en-GB", { year: "numeric", month: "long", day: "numeric" });

  const subject = `Your ZeeShop receipt — ${planLabel} plan (${symbol}${amount})`;
  const bodyHtml = `
    <div style="font-family:sans-serif;max-width:480px;margin:0 auto;">
      <h2 style="color:#12213B;">Payment Receipt</h2>
      <p>Your ZeeShop subscription auto-renewed.</p>
      <table style="width:100%;border-collapse:collapse;margin:16px 0;">
        <tr><td style="padding:6px 0;color:#6B7280;">Business</td><td style="padding:6px 0;text-align:right;font-weight:700;">${businessName}</td></tr>
        <tr><td style="padding:6px 0;color:#6B7280;">Plan</td><td style="padding:6px 0;text-align:right;font-weight:700;">${planLabel} (${interval})</td></tr>
        <tr><td style="padding:6px 0;color:#6B7280;">Amount</td><td style="padding:6px 0;text-align:right;font-weight:700;">${symbol}${amount}</td></tr>
        <tr><td style="padding:6px 0;color:#6B7280;">Date Paid</td><td style="padding:6px 0;text-align:right;">${paidDate}</td></tr>
        <tr><td style="padding:6px 0;color:#6B7280;">Transaction Ref</td><td style="padding:6px 0;text-align:right;font-size:12px;">${txRef}</td></tr>
        <tr><td style="padding:6px 0;color:#6B7280;">Renews / Expires</td><td style="padding:6px 0;text-align:right;">${expiresDate}</td></tr>
      </table>
      <p style="font-size:12px;color:#6B7280;">Keep this email as your receipt. Questions? Reply to this email or reach us from within the app under More → Contact Us.</p>
    </div>
  `;
  return sendEmail(toEmail, subject, bodyHtml);
}

function sendRenewalFailedEmail(toEmail: string, businessName: string, reason: string): Promise<void> {
  const subject = `ZeeShop: your card was declined — auto-renewal turned off`;
  const bodyHtml = `
    <div style="font-family:sans-serif;max-width:480px;margin:0 auto;">
      <h2 style="color:#12213B;">Auto-Renewal Failed</h2>
      <p>We tried to renew <b>${businessName}</b>'s ZeeShop subscription using your saved card, but the charge didn't go through.</p>
      <p style="color:#6B7280;font-size:13px;">Reason: ${reason}</p>
      <p>Auto-renewal has been turned off for now so we don't keep retrying a card that isn't working. You can renew manually or add a fresh card any time from More → Settings → Subscription.</p>
    </div>
  `;
  return sendEmail(toEmail, subject, bodyHtml);
}

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
    .select("id, name, currency, auto_renew_plan, auto_renew_interval, subscription_expires_at")
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
  biz: { id: string; name: string; currency: string; auto_renew_plan: string; auto_renew_interval: string; subscription_expires_at: string }
) {
  const businessId = biz.id;
  const businessName = biz.name || "your business";
  const plan = biz.auto_renew_plan;
  const interval = biz.auto_renew_interval;

  // Mark that we attempted this, regardless of outcome — used to avoid
  // hammering the same business every time this function runs before
  // its expiry date actually moves.
  await admin.from("businesses").update({ last_auto_renew_attempt_at: new Date().toISOString() }).eq("id", businessId);

  // The real owner's email — used both as the Flutterwave charge email
  // and as where receipt/failure notices actually get sent. Previously
  // this was a hardcoded placeholder that never reached the customer.
  const { data: ownerRow } = await admin
    .from("app_users")
    .select("email")
    .eq("business_id", businessId)
    .eq("role", "master")
    .maybeSingle();
  const ownerEmail = ownerRow?.email || "billing@ememart.com";

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
        email: ownerEmail,
        tx_ref: txRef,
      }),
    });
    const chargeData = await chargeRes.json();

    const success = chargeData?.status === "success" && chargeData?.data?.status === "successful";

    if (success) {
      const periodDays = interval === "yearly" ? 365 : 30;
      const expiresAt = new Date(Date.now() + periodDays * 24 * 60 * 60 * 1000).toISOString();
      await admin.from("businesses").update({ subscription_plan: plan, subscription_expires_at: expiresAt }).eq("id", businessId);
      sendReceiptEmail(ownerEmail, businessName, plan, interval, amount, currency, txRef, expiresAt)
        .catch((e) => console.log("Receipt email threw:", e));
      return await logAndReturn(admin, businessId, plan, interval, amount, currency, true, null, String(chargeData?.data?.id || ""));
    } else {
      // Charge failed (declined, expired card, etc.) — turn off auto-renew so
      // it doesn't keep retrying a dead card indefinitely; the business will
      // see the normal expiry reminder banner and can renew manually or
      // re-enable auto-renewal with a fresh card.
      const errorMessage = chargeData?.message || "Charge declined";
      await admin.from("businesses").update({ auto_renew_enabled: false }).eq("id", businessId);
      await admin.from("saved_payment_methods").update({ is_active: false }).eq("business_id", businessId);
      sendRenewalFailedEmail(ownerEmail, businessName, errorMessage)
        .catch((e) => console.log("Failure notice email threw:", e));
      return await logAndReturn(admin, businessId, plan, interval, amount, currency, false, errorMessage);
    }
  } catch (e) {
    const errorMessage = e instanceof Error ? e.message : "Unexpected error";
    sendRenewalFailedEmail(ownerEmail, businessName, errorMessage)
      .catch((err) => console.log("Failure notice email threw:", err));
    return await logAndReturn(admin, businessId, plan, interval, amount, currency, false, errorMessage);
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
