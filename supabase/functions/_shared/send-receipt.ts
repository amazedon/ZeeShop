// supabase/functions/_shared/send-receipt.ts
//
// Shared by verify-payment (first-time/manual payments) and
// process-subscription-renewals (auto-renewal charges) — one place for
// subscription receipt formatting and sending, so both stay consistent
// and a future change to the email only needs to happen once.
//
// Uses the same Termii email call shape as send-reset-otp/send-signup-otp.
// NOTE: those two confirmed endpoints are Termii's *OTP* email API
// (/api/email/otp/send). A receipt isn't a one-time code, so this uses
// what should be Termii's plain transactional email endpoint instead —
// I haven't seen that endpoint confirmed anywhere in your existing code,
// so treat /api/email/send below as a best guess until you've tested it.
// If it 404s or errors, check Termii's dashboard/docs for the actual
// plain-email endpoint name and swap it in here (one place, not two).

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
