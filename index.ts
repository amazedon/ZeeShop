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
      .select("id")
      .eq("owner_auth_user_id", userData.user.id)
      .limit(1);

    if (bizErr || !bizRows || bizRows.length === 0) {
      return json({ error: "No business found for this account" }, 404);
    }

    const businessId = bizRows[0].id;
    const periodDays = interval === "yearly" ? 365 : 30;
    const expiresAt = new Date(Date.now() + periodDays * 24 * 60 * 60 * 1000).toISOString();

    const { error: updateErr } = await adminClient
      .from("businesses")
      .update({ subscription_plan: plan, subscription_expires_at: expiresAt })
      .eq("id", businessId);

    if (updateErr) {
      return json({ error: "Payment verified but plan update failed: " + updateErr.message }, 500);
    }

    return json({ verified: true, plan, expires_at: expiresAt }, 200);
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
