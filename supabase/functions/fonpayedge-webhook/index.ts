// supabase/functions/fonpayedge-webhook/index.ts
//
// FonPayEdge calls this (server-to-server) when a transfer lands in a
// business's dedicated virtual account. It credits that business's Bill
// Payments wallet with the amount MINUS FonPayEdge's flat fee.
// (Subscriptions are separate — they still use flutterwave-webhook.)
//
// Deploy with --no-verify-jwt (FonPayEdge has no Supabase session):
//   supabase functions deploy fonpayedge-webhook --no-verify-jwt
// Then put this function's URL in your FonPayEdge dashboard as the webhook URL.
//
// Secrets (Supabase → Edge Functions → Secrets):
//   FONPAYEDGE_SECRET_KEY   — your FonPayEdge SECRET key
//   FONPAYEDGE_FLAT_FEE     — optional, defaults to 50 (₦ per transfer)
//
// Authenticity: FonPayEdge signs the raw body with HMAC-SHA512 using the
// secret key and sends it in the `signature` header (plus `token`).
// A request that fails either check is rejected with 401.
//
// How a payment is matched to a business: the virtual account was created
// with the unique email <business_id>@wallet.zeeshop.app (see
// get_or_create_psa_account in bigisub-proxy). The webhook's customerEmail
// is that email. If it doesn't match, we fall back to an account number
// in the payload (if one is present) against businesses.psa_account_number.
//
// Double-credit protection: the payment's `reference` is stored in
// wallet_topups.provider_reference, which has a UNIQUE index. We insert
// that row FIRST; if it already exists, this is a retry and we stop.

import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const WALLET_EMAIL_DOMAIN = "@wallet.zeeshop.app";

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Constant-time string comparison.
function safeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a), y = enc.encode(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

async function hmacSha512Hex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-512" }, false, ["sign"],
  );
  return toHex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
}

function ok(msg: string) { return new Response(msg, { status: 200 }); }

Deno.serve(async (req: Request) => {
  try {
    if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

    const secret = Deno.env.get("FONPAYEDGE_SECRET_KEY") || "";
    if (!secret) {
      console.error("fonpayedge-webhook: FONPAYEDGE_SECRET_KEY is not set");
      return new Response("Not configured", { status: 500 });
    }
    const flatFee = Number(Deno.env.get("FONPAYEDGE_FLAT_FEE")) || 50;

    // ---- Authenticity: token header + HMAC-SHA512 of the raw body ----
    const rawBody = await req.text();
    const receivedToken = req.headers.get("token") || "";
    const receivedSig = (req.headers.get("signature") || "").toLowerCase();
    const expectedSig = await hmacSha512Hex(secret, rawBody);
    const tokenOk = safeEqual(receivedToken, secret);
    const sigOk = receivedSig.length > 0 && safeEqual(receivedSig, expectedSig);
    if (!tokenOk || !sigOk) {
      console.warn(`fonpayedge-webhook: rejected (token ${tokenOk ? "ok" : "bad"}, signature ${sigOk ? "ok" : receivedSig ? "bad" : "missing"})`);
      return new Response("Unauthorized", { status: 401 });
    }

    let payload: any;
    try { payload = JSON.parse(rawBody); } catch (_e) { return ok("ok — not JSON, skipped"); }

    // TEMPORARY: log what FonPayEdge really sends, so the field names and
    // whether `amount` already has their fee taken out can be confirmed
    // from the first real test transfer. Remove once confirmed.
    console.log("fonpayedge-webhook payload:", rawBody);

    const email = String(payload?.customerEmail || "").trim().toLowerCase();
    const grossAmount = Number(payload?.amount);
    if (!Number.isFinite(grossAmount) || grossAmount <= 0) return ok("ok — no valid amount, skipped");

    const reference = payload?.reference
      ? String(payload.reference)
      : `${email}|${grossAmount}|${payload?.dateTime || ""}`;

    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    // ---- Find the business ----
    let businessId: string | null = null;
    if (email.endsWith(WALLET_EMAIL_DOMAIN)) {
      const candidate = email.slice(0, -WALLET_EMAIL_DOMAIN.length);
      const { data: biz } = await admin.from("businesses").select("id").eq("id", candidate).maybeSingle();
      if (biz) businessId = String(biz.id);
    }
    if (!businessId) {
      const acctNo = payload?.accountNumber || payload?.account_number || payload?.bankAccountNumber || payload?.nuban;
      if (acctNo) {
        const { data: biz } = await admin.from("businesses").select("id").eq("psa_account_number", String(acctNo)).maybeSingle();
        if (biz) businessId = String(biz.id);
      }
    }
    if (!businessId) {
      console.warn("fonpayedge-webhook: no matching business for", email || "(no email)");
      return ok("ok — no matching business");
    }

    // ---- Fee: credit amount minus the flat fee ----
    const netAmount = Math.round((grossAmount - flatFee) * 100) / 100;

    // Insert the record FIRST — the unique provider_reference blocks a
    // retried webhook from crediting twice.
    const topupId = crypto.randomUUID();
    const { error: insertErr } = await admin.from("wallet_topups").insert({
      id: topupId,
      business_id: businessId,
      amount: netAmount > 0 ? netAmount : 0,
      gross_amount: grossAmount,
      fee: flatFee,
      provider_reference: reference,
      status: netAmount > 0 ? "success" : "ignored",
    });
    if (insertErr) return ok("ok — already processed");

    if (netAmount <= 0) return ok("ok — amount not above the fee, nothing credited");

    // Atomic add to the balance (SQL function — see the SQL file).
    const { error: creditErr } = await admin.rpc("increment_bill_wallet", {
      p_business_id: businessId,
      p_amount: netAmount,
    });
    if (creditErr) {
      // Undo the record so FonPayEdge's retry can credit it properly,
      // and answer with an error so they DO retry.
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
