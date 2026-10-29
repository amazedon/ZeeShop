// supabase/functions/flutterwave-reconcile/index.ts
//
// Reconciles every business's Flutterwave payout subaccount against the wallet balance in our database, and (optionally)
// sweeps the SPENT portion into your main Flutterwave balance.
//
// The rule it enforces (your rule): money customers have funded but not yet spent STAYS in their subaccount; once they spend
// it on bills, it is moved to your main balance.   sweepable = subaccount balance − customer wallet balance.
//
// Two ways to call it:
//   1. A signed-in super admin (the Authorization: Bearer <session token> header), e.g. from the Super Admin panel.
//   2. A scheduler (Supabase cron) sending header  x-cron-secret: <RECONCILE_CRON_SECRET>   (for the daily run).
// Deploy with "Verify JWT" OFF (the function checks the caller itself).
//
// Body:  { "action": "reconcile" }                              read-only report for all businesses with a Flutterwave account
//        { "action": "reconcile", "business_id": "<id>" }       one business
//        { "action": "sweep" }                                  DRY RUN: shows what would be moved, moves nothing
//        { "action": "sweep", "confirm": true }                 really moves money — ONLY if secret FLW_SWEEP_ENABLED = "true"
//
// Secrets used:  FLW_SECRET_KEY (live), FLW_MERCHANT_ID (your merchant id from the Flutterwave dashboard, needed to sweep),
//                FLW_SWEEP_ENABLED ("true" to allow real transfers), FLW_SWEEP_MIN (smallest amount worth moving, default 1000),
//                RECONCILE_CRON_SECRET (for scheduled calls).
// Needs flutterwave-reconcile.sql (the flw_sweeps log table).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const FLW = "https://api.flutterwave.com/v3";
const round2 = (n: number) => Math.round(n * 100) / 100;

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

// Flutterwave's balance response shape isn't guaranteed, so look for the usual field names, in NGN.
function pickBalance(data: any): number | null {
  const rows = Array.isArray(data) ? data : data ? [data] : [];
  for (const r of rows) {
    const cur = String(r?.currency ?? "NGN").toUpperCase();
    if (cur !== "NGN") continue;
    for (const k of ["available_balance", "balance", "ledger_balance"]) {
      const v = Number(r?.[k]);
      if (r?.[k] !== undefined && r?.[k] !== null && Number.isFinite(v)) return round2(v);
    }
  }
  return null;
}

async function flwBalance(key: string, ref: string): Promise<{ balance: number | null; raw: unknown; error: string | null }> {
  try {
    const r = await fetch(`${FLW}/payout-subaccounts/${encodeURIComponent(ref)}/balances`, { headers: { Authorization: `Bearer ${key}` } });
    const body = await r.json().catch(() => null);
    if (!r.ok) return { balance: null, raw: body, error: `Flutterwave ${r.status}: ${String(body?.message || "").slice(0, 200)}` };
    const b = pickBalance(body?.data);
    return { balance: b, raw: body?.data ?? null, error: b === null ? "Balance field not recognised — see raw." : null };
  } catch (e) { return { balance: null, raw: null, error: "Could not reach Flutterwave: " + String((e as Error).message || e) }; }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    // ---- who is calling? scheduler secret, or a super admin ----
    const cronSecret = (Deno.env.get("RECONCILE_CRON_SECRET") || "").trim();
    const gotCron = (req.headers.get("x-cron-secret") || "").trim();
    let actor = "cron";
    if (!(cronSecret && gotCron && safeEqual(cronSecret, gotCron))) {
      const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
      if (!token) return json({ error: "Not authenticated." }, 401);
      const { data: u, error: uErr } = await admin.auth.getUser(token);
      if (uErr || !u?.user) return json({ error: "Not authenticated." }, 401);
      const { data: sa } = await admin.from("super_admins").select("auth_user_id").eq("auth_user_id", u.user.id).maybeSingle();
      if (!sa) return json({ error: "This account is not authorized for super admin access." }, 403);
      actor = u.user.id;
    }

    const body = await req.json().catch(() => ({}));
    const action = String(body?.action || "reconcile");
    if (action !== "reconcile" && action !== "sweep") return json({ error: "Unknown action." }, 400);

    const key = Deno.env.get("FLW_SECRET_KEY") || "";
    if (!key) return json({ error: "FLW_SECRET_KEY is not set on this function." }, 500);
    if (key.startsWith("FLWSECK_TEST")) return json({ error: "FLW_SECRET_KEY is a TEST key (FLWSECK_TEST-…). Use the live key." }, 500);

    let q = admin.from("businesses").select("id, name, bill_wallet_balance, psa_account_reference, psa_account_number").not("psa_account_reference", "is", null);
    if (body?.business_id) q = q.eq("id", String(body.business_id));
    const { data: biz, error: bErr } = await q;
    if (bErr) return json({ error: bErr.message }, 500);

    const sweepEnabled = (Deno.env.get("FLW_SWEEP_ENABLED") || "").toLowerCase() === "true";
    const merchantId = (Deno.env.get("FLW_MERCHANT_ID") || "").trim();
    const minSweep = Number(Deno.env.get("FLW_SWEEP_MIN")) || 1000;
    const live = action === "sweep" && body?.confirm === true;
    if (live && !sweepEnabled) return json({ error: "Real sweeps are switched off. Set the secret FLW_SWEEP_ENABLED = true first (or call without confirm for a dry run)." }, 403);
    if (action === "sweep" && live && !merchantId) return json({ error: "FLW_MERCHANT_ID is not set — it is the destination of the sweep." }, 500);

    const day = new Date().toISOString().slice(0, 10);
    const rows: any[] = [];
    let totalFlw = 0, totalWallets = 0, totalSweepable = 0, moved = 0;

    for (const b of biz || []) {
      const wallet = round2(Number(b.bill_wallet_balance || 0));
      const f = await flwBalance(key, String(b.psa_account_reference));
      const row: any = { business_id: b.id, name: b.name, account: b.psa_account_number, wallet_balance: wallet, flutterwave_balance: f.balance, status: "", sweepable: 0 };
      if (f.balance === null) { row.status = "unknown"; row.error = f.error; row.raw = f.raw; rows.push(row); continue; }
      totalFlw += f.balance; totalWallets += wallet;
      const diff = round2(f.balance - wallet);          // >0: spent/fees, free to move.  <0: Flutterwave holds LESS than we owe customers.
      row.difference = diff;
      if (diff < -0.009) { row.status = "SHORTFALL"; rows.push(row); continue; }
      row.status = diff > 0.009 ? "surplus" : "balanced";
      row.sweepable = diff >= minSweep ? diff : 0;
      totalSweepable += row.sweepable;

      if (action === "sweep" && row.sweepable > 0) {
        if (!live) { row.sweep = "dry-run: would move " + row.sweepable; rows.push(row); continue; }
        // One sweep per business per day: the unique reference makes a repeated run harmless.
        const reference = `zs-sweep-${String(b.id).replace(/[^a-z0-9]/gi, "").slice(0, 16)}-${day}`;
        const { error: claim } = await admin.from("flw_sweeps").insert({ business_id: b.id, reference, amount: row.sweepable, status: "pending", requested_by: actor });
        if (claim) { row.sweep = "skipped: already attempted today (" + claim.message + ")"; rows.push(row); continue; }
        try {
          const r = await fetch(`${FLW}/transfers`, {
            method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
            body: JSON.stringify({ account_bank: "flutterwave", account_number: merchantId, amount: row.sweepable, currency: "NGN",
              narration: "ZeeShop settlement", reference, debit_subaccount: String(b.psa_account_reference) }),
          });
          const d = await r.json().catch(() => null);
          const ok = r.ok && d?.status === "success";
          await admin.from("flw_sweeps").update({ status: ok ? "submitted" : "failed", flutterwave_response: d }).eq("reference", reference);
          row.sweep = ok ? "submitted " + row.sweepable : "FAILED: " + String(d?.message || r.status).slice(0, 200);
          if (ok) moved += row.sweepable;
        } catch (e) {
          await admin.from("flw_sweeps").update({ status: "failed", flutterwave_response: { error: String((e as Error).message || e) } }).eq("reference", reference);
          row.sweep = "FAILED: " + String((e as Error).message || e);
        }
      }
      rows.push(row);
    }

    const shortfalls = rows.filter((r) => r.status === "SHORTFALL");
    console.log("FLW-RECONCILE " + JSON.stringify({ action, live, businesses: rows.length, totalFlw: round2(totalFlw), totalWallets: round2(totalWallets),
      shortfalls: shortfalls.map((s) => ({ id: s.business_id, wallet: s.wallet_balance, flw: s.flutterwave_balance })), moved: round2(moved) }));

    return json({
      action, live, sweep_enabled: sweepEnabled, min_sweep: minSweep,
      totals: { flutterwave_subaccounts: round2(totalFlw), customer_wallets: round2(totalWallets), sweepable: round2(totalSweepable), moved_now: round2(moved) },
      shortfalls: shortfalls.length, businesses: rows,
    }, 200);
  } catch (e) {
    console.error("flutterwave-reconcile error:", e);
    return json({ error: String((e as Error).message || e) }, 500);
  }
});
