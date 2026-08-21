// supabase/functions/verify-payment/index.ts
//
// Called by app.html right after a Flutterwave checkout popup reports
// success. This function is the ONLY thing that actually trusts a payment —
// it re-checks the transaction directly with Flutterwave using the secret
// key (never exposed to the browser), then upgrades the calling business's
// plan. A client claiming "I paid" is never enough on its own.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ---- Inlined receipt-sending (was a shared import, but Supabase's
// dashboard single-function deploy can't resolve relative imports to a
// sibling _shared/ folder — see the "Module not found ... _shared/
// send-receipt.ts" deploy error). Duplicated into every function that
// needs it instead, so each one deploys standalone from the dashboard.
// If you switch to CLI-based deploys of the whole supabase/functions/
// directory later, this can be de-duplicated back into a real _shared
// import if you prefer. ----
const TERMII_API_KEY = Deno.env.get("TERMII_API_KEY")!;
const TERMII_BASE_URL = Deno.env.get("TERMII_BASE_URL")!;
const TERMII_EMAIL_CONFIG_ID = Deno.env.get("TERMII_EMAIL_CONFIG_ID")!;

const CURRENCY_SYMBOLS: Record<string, string> = {
  NGN: "₦", GHS: "GH₵", GBP: "£", EUR: "€", USD: "$",
};

export interface ReceiptInput {
  toEmail: string;
  businessName: string;
  plan: "pro" | "boss";
  interval: "monthly" | "yearly";
  amount: number;
  currency: string;
  txRef: string;
  paidAt: string;      // ISO date
  expiresAt: string;   // ISO date
  isAutoRenewal: boolean;
}

export async function sendSubscriptionReceipt(input: ReceiptInput): Promise<{ sent: boolean; error?: string }> {
  if (!input.toEmail) return { sent: false, error: "No email on file to send to." };

  const symbol = CURRENCY_SYMBOLS[input.currency] || input.currency + " ";
  const planLabel = input.plan === "boss" ? "Boss" : "Pro";
  const paidDate = new Date(input.paidAt).toLocaleDateString("en-GB", { year: "numeric", month: "long", day: "numeric" });
  const expiresDate = new Date(input.expiresAt).toLocaleDateString("en-GB", { year: "numeric", month: "long", day: "numeric" });

  const subject = `Your ZeeShop receipt — ${planLabel} plan (${symbol}${input.amount})`;
  const bodyHtml = `
    <div style="font-family:sans-serif;max-width:480px;margin:0 auto;">
      <h2 style="color:#12213B;">Payment Receipt</h2>
      <p>${input.isAutoRenewal ? "Your ZeeShop subscription auto-renewed." : "Thank you for upgrading your ZeeShop subscription."}</p>
      <table style="width:100%;border-collapse:collapse;margin:16px 0;">
        <tr><td style="padding:6px 0;color:#6B7280;">Business</td><td style="padding:6px 0;text-align:right;font-weight:700;">${input.businessName}</td></tr>
        <tr><td style="padding:6px 0;color:#6B7280;">Plan</td><td style="padding:6px 0;text-align:right;font-weight:700;">${planLabel} (${input.interval})</td></tr>
        <tr><td style="padding:6px 0;color:#6B7280;">Amount</td><td style="padding:6px 0;text-align:right;font-weight:700;">${symbol}${input.amount}</td></tr>
        <tr><td style="padding:6px 0;color:#6B7280;">Date Paid</td><td style="padding:6px 0;text-align:right;">${paidDate}</td></tr>
        <tr><td style="padding:6px 0;color:#6B7280;">Transaction Ref</td><td style="padding:6px 0;text-align:right;font-size:12px;">${input.txRef}</td></tr>
        <tr><td style="padding:6px 0;color:#6B7280;">Renews / Expires</td><td style="padding:6px 0;text-align:right;">${expiresDate}</td></tr>
      </table>
      <p style="font-size:12px;color:#6B7280;">Keep this email as your receipt. Questions? Reply to this email or reach us from within the app under More → Contact Us.</p>
    </div>
  `;

  try {
    const res = await fetch(`${TERMII_BASE_URL}/api/email/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: TERMII_API_KEY,
        email_address: input.toEmail,
        subject,
        content: bodyHtml,
        emailConfigurationId: TERMII_EMAIL_CONFIG_ID,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.log("Receipt email send failed:", JSON.stringify(data));
      return { sent: false, error: JSON.stringify(data) };
    }
    return { sent: true };
  } catch (e) {
    console.log("Receipt email send threw:", e);
    return { sent: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { transaction_id, plan, interval, expected_amount, expected_currency } = await req.json();

    if (!transaction_id || !plan || !interval || !expected_amount || !expected_currency) {
      return json({ error: "Missing required fields" }, 400);
    }
    if (!["pro", "boss"].includes(plan)) {
      return json({ error: "Invalid plan" }, 400);
    }
    if (!["monthly", "yearly"].includes(interval)) {
      return json({ error: "Invalid interval" }, 400);
    }

    // ---- Identify the calling business owner from their Supabase session ----
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Missing authorization" }, 401);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData?.user) return json({ error: "Invalid session" }, 401);

    // ---- Verify the transaction directly with Flutterwave ----
    const flwSecret = Deno.env.get("FLW_SECRET_KEY")!;
    const flwRes = await fetch(
      `https://api.flutterwave.com/v3/transactions/${transaction_id}/verify`,
      { headers: { Authorization: `Bearer ${flwSecret}` } }
    );
    const flwData = await flwRes.json();

    const paymentOk =
      flwData?.status === "success" &&
      flwData?.data?.status === "successful" &&
      flwData?.data?.currency === expected_currency &&
      Number(flwData?.data?.amount) >= Number(expected_amount);

    if (!paymentOk) {
      return json({ error: "Payment could not be verified", verified: false }, 400);
    }

    // ---- Payment is genuine — upgrade the plan using the service role ----
    // (bypasses RLS deliberately: we've already independently verified both
    // the payment with Flutterwave and the caller's identity above)
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const adminClient = createClient(supabaseUrl, serviceKey);

    const { data: bizRows, error: bizErr } = await adminClient
      .from("businesses")
      .select("id, name")
      .eq("owner_auth_user_id", userData.user.id)
      .limit(1);

    if (bizErr || !bizRows || bizRows.length === 0) {
      return json({ error: "No business found for this account" }, 404);
    }

    const businessId = bizRows[0].id;
    const businessName = bizRows[0].name || "your business";
    const periodDays = interval === "yearly" ? 365 : 30;
    const paidAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + periodDays * 24 * 60 * 60 * 1000).toISOString();

    const { error: updateErr } = await adminClient
      .from("businesses")
      .update({ subscription_plan: plan, subscription_expires_at: expiresAt })
      .eq("id", businessId);

    if (updateErr) {
      return json({ error: "Payment verified but plan update failed: " + updateErr.message }, 500);
    }

    // Best-effort — a receipt email failing should never undo a payment
    // that's already been verified and applied above.
    if (userData.user.email) {
      sendSubscriptionReceipt({
        toEmail: userData.user.email,
        businessName,
        plan,
        interval,
        amount: Number(expected_amount),
        currency: expected_currency,
        txRef: String(transaction_id),
        paidAt,
        expiresAt,
        isAutoRenewal: false,
      }).catch((e) => console.log("Receipt send threw:", e));
    }

    return json({
      verified: true,
      plan,
      expires_at: expiresAt,
      // If the customer's card was tokenized by Flutterwave during checkout,
      // this lets the app offer "enable auto-renewal?" right after payment.
      // The actual token is only ever sent to Supabase directly by the
      // client afterward (if they opt in) — never logged or exposed beyond this response.
      card_token: flwData?.data?.card?.token || null,
      card_last4: flwData?.data?.card?.last_4digits || null,
      card_type: flwData?.data?.card?.type || null,
      card_expiry: flwData?.data?.card?.expiry || null
    }, 200);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "Unexpected error" }, 500);
  }
});

function json(body: Record<string, unknown>, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
