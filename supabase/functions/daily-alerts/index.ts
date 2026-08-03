// supabase/functions/daily-alerts/index.ts
//
// Runs on a schedule (see cron setup) — checks every business for:
//   1. Low stock goods (qty remaining <= reorder level) — sent to
//      everyone at that business who's enabled notifications
//   2. Batches expiring within 7 days — same audience as low stock
//   3. Subscription expiring within 3 days, or just expired — sent
//      ONLY to the owner (master), never staff, and skipped entirely
//      if auto-renewal is on (since that's silent by design)
//
// Deploy with:
//   supabase functions deploy daily-alerts --no-verify-jwt

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sendPushToSubscription } from "../_shared/push.ts";

Deno.serve(async (req: Request) => {
  const secret = req.headers.get("x-cron-secret");
  if (secret !== Deno.env.get("CRON_SECRET")) {
    return new Response("Unauthorized", { status: 401 });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(supabaseUrl, serviceKey);

  const results = { lowStock: 0, expiring: 0, subscriptionReminders: 0, pushesSent: 0, pushesFailed: 0 };

  // ---- 1. Low stock goods, grouped by shop → business ----
  const { data: lowStockGoods } = await admin.rpc("get_low_stock_goods");

  const businessesToNotifyWide = new Set<string>(); // stock/expiry — whole-business audience
  const businessAlertText: Record<string, string[]> = {};

  if (lowStockGoods) {
    for (const g of lowStockGoods as { business_id: string; name: string; qty: number }[]) {
      businessesToNotifyWide.add(g.business_id);
      (businessAlertText[g.business_id] ||= []).push(`${g.name} is low (${g.qty} left)`);
      results.lowStock++;
    }
  }

  // ---- 2. Batches expiring within 7 days ----
  const in7days = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const { data: expiringBatches } = await admin
    .from("good_batches")
    .select("expiry_date, qty_remaining, goods!inner(name, shop_id, shops!inner(business_id))")
    .gt("qty_remaining", 0)
    .lte("expiry_date", in7days)
    .gte("expiry_date", new Date().toISOString().slice(0, 10));

  if (expiringBatches) {
    for (const b of expiringBatches as any[]) {
      const bizId = b.goods?.shops?.business_id;
      if (!bizId) continue;
      businessesToNotifyWide.add(bizId);
      (businessAlertText[bizId] ||= []).push(`${b.goods.name} expires ${b.expiry_date}`);
      results.expiring++;
    }
  }

  // ---- Send wide (whole-business) alerts ----
  for (const bizId of businessesToNotifyWide) {
    const messages = businessAlertText[bizId].slice(0, 3); // keep it short
    const extra = businessAlertText[bizId].length - messages.length;
    const body = messages.join(" · ") + (extra > 0 ? ` · +${extra} more` : "");
    await sendToBusiness(admin, bizId, "Stock Alert", body, results);
  }

  // ---- 3. Subscription reminders — owner only, skip if auto-renew is on ----
  const in3days = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
  const { data: dueBusinesses } = await admin
    .from("businesses")
    .select("id, name, subscription_plan, subscription_expires_at, auto_renew_enabled")
    .neq("subscription_plan", "free")
    .eq("auto_renew_enabled", false)
    .lte("subscription_expires_at", in3days);

  for (const biz of dueBusinesses || []) {
    const expired = new Date(biz.subscription_expires_at) <= new Date();
    const body = expired
      ? `Your ${biz.subscription_plan} plan has expired — renew to restore full access.`
      : `Your ${biz.subscription_plan} plan expires soon — renew to avoid losing access.`;
    results.subscriptionReminders++;
    await sendToOwnerOnly(admin, biz.id, "Subscription Reminder", body, results);
  }

  return new Response(JSON.stringify(results), { status: 200, headers: { "Content-Type": "application/json" } });
});

async function sendToBusiness(admin: ReturnType<typeof createClient>, businessId: string, title: string, body: string, results: any) {
  const { data: subs } = await admin.from("push_subscriptions").select("*").eq("business_id", businessId).eq("is_active", true);
  for (const sub of subs || []) {
    const result = await sendPushToSubscription(sub as any, { title, body, url: "/app.html" });
    if (result.success) results.pushesSent++;
    else {
      results.pushesFailed++;
      if (result.shouldDeactivate) await admin.from("push_subscriptions").update({ is_active: false }).eq("id", (sub as any).id);
    }
  }
}

async function sendToOwnerOnly(admin: ReturnType<typeof createClient>, businessId: string, title: string, body: string, results: any) {
  const { data: master } = await admin.from("app_users").select("id").eq("business_id", businessId).eq("role", "master").maybeSingle();
  if (!master) return;
  const { data: subs } = await admin.from("push_subscriptions").select("*").eq("business_id", businessId).eq("user_id", master.id).eq("is_active", true);
  for (const sub of subs || []) {
    const result = await sendPushToSubscription(sub as any, { title, body, url: "/app.html" });
    if (result.success) results.pushesSent++;
    else {
      results.pushesFailed++;
      if (result.shouldDeactivate) await admin.from("push_subscriptions").update({ is_active: false }).eq("id", (sub as any).id);
    }
  }
}
