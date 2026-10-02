// supabase/functions/fonpayedge-webhook/index.ts
//
// FonPayEdge calls this (server-to-server) when a transfer lands in a
// business's dedicated virtual account. It credits that business's Bill
// Payments wallet with what FonPayEdge says actually reached us (amount
// minus their fee). Subscriptions are separate — flutterwave-webhook.
//
// Deploy with --no-verify-jwt (FonPayEdge has no Supabase session):
//   supabase functions deploy fonpayedge-webhook --no-verify-jwt
// Then enter this function's URL in the FonPayEdge dashboard under
// "API keys and webhook".
//
// Secret: FONPAYEDGE_SECRET_KEY = your LIVE secret key (starts "sck_").
// Payment webhooks and collections only exist for live keys.
//
// How a webhook is trusted (per FonPayEdge's docs):
//  1. The `token` header must equal our live secret key, else 401.
//  2. We never trust the webhook body for money. We fetch the payment
//     from FonPayEdge (GET /collections/{reference}) and use ITS
//     account number, status and settled amount.
//  3. Each payment is processed once: its reference is stored in
//     wallet_topups.provider_reference (UNIQUE) BEFORE crediting.
//
// If the lookup fails we answer 5xx WITHOUT crediting, so FonPayEdge
// retries later — a payment is never credited on unverified data.

import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const FONPAYEDGE_BASE = "https://dashboard.fonpayedge.ng/api/v1";
const WALLET_EMAIL_DOMAIN = "@wallet.zeeshop.app";

// Constant-time string comparison.
function safeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a), y = enc.encode(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

function ok(msg: string) { return new Response(msg, { status: 200 }); }
function retryLater(msg: string) { return new Response(msg, { status: 503 }); }

Deno.serve(async (req: Request) => {
  try {
    if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

    const secret = Deno.env.get("FONPAYEDGE_SECRET_KEY") || "";
    if (!secret) {
      console.error("fonpayedge-webhook: FONPAYEDGE_SECRET_KEY is not set");
      return new Response("Not configured", { status: 500 });
    }

    // ---- 1. Authenticity: token header must equal our secret key ----
    const receivedToken = req.headers.get("token") || "";
    if (!safeEqual(receivedToken, secret)) {
      console.warn("fonpayedge-webhook: rejected (bad or missing token)");
      return new Response("Unauthorized", { status: 401 });
    }

    let payload: any;
    try { payload = await req.json(); } catch (_e) { return ok("ok — not JSON, skipped"); }

    // `reference` in the webhook is the collection's providerReference.
    const webhookRef = payload?.reference ? String(payload.reference) : "";
    if (!webhookRef) return ok("ok — no reference, skipped");

    // ---- 2. Confirm the payment with FonPayEdge before giving value ----
    let collection: any = null;
    try {
      const r = await fetch(`${FONPAYEDGE_BASE}/collections/${encodeURIComponent(webhookRef)}`, {
        headers: { Authorization: `Bearer ${secret}`, Accept: "application/json" },
      });
      const body = await r.json().catch(() => null);
      if (r.ok && body?.success === true && body?.data) {
        collection = body.data;
      } else {
        // Not found yet / FonPayEdge hiccup: don't credit, ask them to retry.
        console.warn("fonpayedge-webhook: collection lookup failed", r.status, body?.code, body?.requestId);
        return retryLater("Could not confirm payment yet, please retry");
      }
    } catch (e) {
      console.warn("fonpayedge-webhook: collection lookup error:", e);
      return retryLater("Could not confirm payment yet, please retry");
    }

    if (collection.status === "pending") return retryLater("Payment still pending, please retry");
    if (collection.status !== "successful") return ok(`ok — payment ${collection.status}, nothing credited`);

    const gross = Number(collection.amount);
    const fee = Number(collection.fee) || 0;
    const settled = Number(collection.settled);
    // What actually reached our FonPayEdge wallet, from FonPayEdge's record.
    const netAmount = Math.round((Number.isFinite(settled) ? settled : gross - fee) * 100) / 100;
    if (!Number.isFinite(gross) || gross <= 0) return ok("ok — no valid amount, skipped");

    // Our unique key for this payment (same on every retry).
    const reference = String(collection.providerReference || webhookRef);

    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    // ---- Find the business: account number first, placeholder email as backup ----
    let businessId: string | null = null;
    const acctNo = collection.accountNumber ? String(collection.accountNumber) : "";
    if (acctNo) {
      const { data: biz } = await admin.from("businesses").select("id").eq("psa_account_number", acctNo).maybeSingle();
      if (biz) businessId = String(biz.id);
    }
    if (!businessId) {
      const email = String(payload?.customerEmail || "").trim().toLowerCase();
      if (email.endsWith(WALLET_EMAIL_DOMAIN)) {
        const candidate = email.slice(0, -WALLET_EMAIL_DOMAIN.length);
        const { data: biz } = await admin.from("businesses").select("id").eq("id", candidate).maybeSingle();
        if (biz) businessId = String(biz.id);
      }
    }
    if (!businessId) {
      console.warn("fonpayedge-webhook: no matching business for account", acctNo || "(none)", "ref", reference);
      return ok("ok — no matching business");
    }

    // ---- 3. Record FIRST — the unique provider_reference blocks double credit ----
    const topupId = crypto.randomUUID();
    const { error: insertErr } = await admin.from("wallet_topups").insert({
      id: topupId,
      business_id: businessId,
      amount: netAmount > 0 ? netAmount : 0,
      gross_amount: gross,
      fee,
      provider_reference: reference,
      status: netAmount > 0 ? "success" : "ignored",
    });
    if (insertErr) return ok("ok — already processed");

    if (netAmount <= 0) return ok("ok — nothing left after the fee, nothing credited");

    // Atomic add to the balance (SQL function — see fonpayedge-setup.sql).
    const { error: creditErr } = await admin.rpc("increment_bill_wallet", {
      p_business_id: businessId,
      p_amount: netAmount,
    });
    if (creditErr) {
      // Undo the record so FonPayEdge's retry can credit it properly.
      await admin.from("wallet_topups").delete().eq("id", topupId);
      console.error("fonpayedge-webhook: credit failed:", creditErr.message);
      return new Response("Credit failed, please retry", { status: 500 });
    }

    return ok("ok — bill wallet funded");
  } catch (e) {
    console.error("fonpayedge-webhook error:", e);
    return new Response("Error", { status: 500 });
  }
});
