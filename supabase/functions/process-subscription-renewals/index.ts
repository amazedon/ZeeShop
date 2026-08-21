// supabase/functions/process-subscription-renewals/index.ts
//
// Run on a daily schedule (see setup SQL below) — NOT called from the
// app itself. This is the piece that actually makes "auto-renewal" real:
// launchCheckout() + saveAutoRenewCard() in app.html already let a
// business save a card token when they upgrade, but nothing was actually
// re-charging that token when the subscription came due. This does.
//
// For each business with auto_renew_enabled = true and
// subscription_expires_at due or overdue:
//   1. Look up the saved card token and the price for their plan/interval
//      /currency (from the same `pricing` table the checkout screen reads).
//   2. Charge that token via Flutterwave's tokenized-charge API.
//   3. On success: extend subscription_expires_at, log it, email a receipt.
//   4. On failure: log it. After 3 consecutive failed attempts (roughly
//      3 days, if run daily), give up — disable auto_renew_enabled and
//      let the existing client-side logic naturally treat the now-expired
//      plan as free (screenSettings already does this; no separate
//      "cancel" action is needed here).
//
// One-time setup required in Supabase:
//
//   alter table businesses add column if not exists last_renewal_attempt_at timestamptz;
//
//   -- Then schedule this function to run once a day, e.g. via pg_cron:
//   select cron.schedule(
//     'process-subscription-renewals-daily',
//     '0 6 * * *',  -- 6am UTC daily — adjust to your preference
//     $$
//     select net.http_post(
//       url := 'https://<your-project-ref>.supabase.co/functions/v1/process-subscription-renewals',
//       headers := jsonb_build_object('Authorization', 'Bearer <service-role-key>', 'Content-Type', 'application/json')
//     );
//     $$
//   );
//   -- Requires the pg_cron and pg_net extensions enabled on your project
//   -- (Database → Extensions in the Supabase dashboard).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const MAX_RETRY_DAYS = 3; // give up after this many consecutive failed daily attempts
const RETRY_COOLDOWN_HOURS = 20; // don't reprocess the same business twice in one run/day

function json(body: Record<string, unknown>, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const flwSecret = Deno.env.get("FLW_SECRET_KEY")!;
    const admin = createClient(supabaseUrl, serviceKey);

    const nowIso = new Date().toISOString();
    const cooldownCutoff = new Date(Date.now() - RETRY_COOLDOWN_HOURS * 60 * 60_000).toISOString();

    const { data: dueBusinesses, error: dueErr } = await admin
      .from("businesses")
      .select("id, name, currency, subscription_plan, subscription_expires_at, auto_renew_plan, auto_renew_interval, owner_auth_user_id")
      .eq("auto_renew_enabled", true)
      .lte("subscription_expires_at", nowIso)
      .or(`last_renewal_attempt_at.is.null,last_renewal_attempt_at.lt.${cooldownCutoff}`);

    if (dueErr) return json({ error: dueErr.message }, 500);

    const results: Array<Record<string, unknown>> = [];

    for (const biz of dueBusinesses || []) {
      // Claim this business for this run before doing any network calls,
      // so an overlapping/duplicate trigger of this same function can't
      // also pick it up and double-charge.
      await admin.from("businesses").update({ last_renewal_attempt_at: nowIso }).eq("id", biz.id);

      const plan = biz.auto_renew_plan || biz.subscription_plan;
      const interval = biz.auto_renew_interval || "monthly";

      try {
        const { data: cardRow } = await admin
          .from("saved_payment_methods")
          .select("flw_token")
          .eq("business_id", biz.id)
          .eq("is_active", true)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        if (!cardRow?.flw_token) {
          await logRenewal(admin, biz.id, "failed", "No active saved card on file.");
          await maybeGiveUp(admin, biz.id);
          results.push({ business_id: biz.id, status: "failed", reason: "no_card" });
          continue;
        }

        const { data: priceRow } = await admin
          .from("pricing")
          .select("amount")
          .eq("currency", biz.currency || "USD")
          .eq("plan", plan)
          .eq("interval", interval)
          .maybeSingle();

        if (!priceRow?.amount) {
          await logRenewal(admin, biz.id, "failed", `No price found for ${plan}/${interval}/${biz.currency}.`);
          await maybeGiveUp(admin, biz.id);
          results.push({ business_id: biz.id, status: "failed", reason: "no_price" });
          continue;
        }

        const { data: ownerRow } = await admin
          .from("app_users")
          .select("email")
          .eq("business_id", biz.id)
          .eq("role", "master")
          .maybeSingle();

        const txRef = "zeeshop_renew_" + crypto.randomUUID();

        const chargeRes = await fetch("https://api.flutterwave.com/v3/tokenized-charges", {
          method: "POST",
          headers: { Authorization: `Bearer ${flwSecret}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            token: cardRow.flw_token,
            currency: biz.currency || "USD",
            amount: priceRow.amount,
            email: ownerRow?.email || "billing@zeeshop.app",
            tx_ref: txRef,
            narration: `ZeeShop ${plan} plan renewal (${interval})`,
          }),
        });
        const chargeData = await chargeRes.json().catch(() => ({}));
        const success = chargeRes.ok && chargeData?.status === "success" && chargeData?.data?.status === "successful";

        if (!success) {
          const errMsg = chargeData?.message || `Charge failed (HTTP ${chargeRes.status})`;
          await logRenewal(admin, biz.id, "failed", errMsg);
          await maybeGiveUp(admin, biz.id);
          results.push({ business_id: biz.id, status: "failed", reason: errMsg });
          continue;
        }

        // Extend from the current expiry if it's still recent (protects
        // against losing paid days if this ran a little early), otherwise
        // from now (protects against stacking up a huge extension if the
        // job was broken for a while and is only now catching up).
        const currentExpiry = new Date(biz.subscription_expires_at).getTime();
        const baseline = currentExpiry > Date.now() - 24 * 60 * 60_000 ? currentExpiry : Date.now();
        const periodDays = interval === "yearly" ? 365 : 30;
        const newExpiresAt = new Date(baseline + periodDays * 24 * 60 * 60_000).toISOString();

        await admin.from("businesses").update({
          subscription_plan: plan,
          subscription_expires_at: newExpiresAt,
        }).eq("id", biz.id);

        await logRenewal(admin, biz.id, "success", `Charged ${biz.currency} ${priceRow.amount} via saved card.`);

        if (ownerRow?.email) {
          sendSubscriptionReceipt({
            toEmail: ownerRow.email,
            businessName: biz.name || "your business",
            plan,
            interval,
            amount: priceRow.amount,
            currency: biz.currency || "USD",
            txRef,
            paidAt: nowIso,
            expiresAt: newExpiresAt,
            isAutoRenewal: true,
          }).catch((e) => console.log("Renewal receipt send threw:", e));
        }

        results.push({ business_id: biz.id, status: "success" });
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Unexpected error";
        await logRenewal(admin, biz.id, "failed", msg);
        await maybeGiveUp(admin, biz.id);
        results.push({ business_id: biz.id, status: "failed", reason: msg });
      }
    }

    return json({ processed: results.length, results }, 200);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "Unexpected error" }, 500);
  }
});

async function logRenewal(admin: ReturnType<typeof createClient>, businessId: string, status: "success" | "failed", detail: string) {
  await admin.from("auto_renewal_log").insert({
    business_id: businessId,
    status,
    detail,
  }).then((r: { error: { message: string } | null }) => {
    if (r.error) console.log("auto_renewal_log insert skipped:", r.error.message);
  });
}

// After MAX_RETRY_DAYS consecutive failures, stop trying and let the
// business fall back to free (the app already treats an expired paid
// plan as free automatically — no extra "downgrade" step needed here).
async function maybeGiveUp(admin: ReturnType<typeof createClient>, businessId: string) {
  const { data: recentLogs } = await admin
    .from("auto_renewal_log")
    .select("status")
    .eq("business_id", businessId)
    .order("created_at", { ascending: false })
    .limit(MAX_RETRY_DAYS);

  const allRecentFailed =
    (recentLogs || []).length >= MAX_RETRY_DAYS &&
    (recentLogs || []).every((r: { status: string }) => r.status === "failed");

  if (allRecentFailed) {
    await admin.from("businesses").update({ auto_renew_enabled: false }).eq("id", businessId);
  }
}
