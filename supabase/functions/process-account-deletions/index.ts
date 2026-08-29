// supabase/functions/process-account-deletions/index.ts
//
// Run on a daily schedule (see setup SQL below) — NOT called from the
// app itself. This is the piece that actually finishes what
// request-account-deletion starts: that function only locks a business
// out and records WHEN deletion was requested. Nothing was actually
// purging the data 30 days later — this closes that gap.
//
// Finds every business where deletion_requested_at is more than 30 days
// in the past, and permanently deletes it and everything in it — the
// exact same cascade already proven in super-admin's force_delete_business
// action, reused here rather than reimplemented.
//
// If an Owner changes their mind before the 30 days are up, cancelling
// is currently a manual process (a super admin clearing
// deletion_requested_at and setting is_active back to true) — there's no
// self-service "undo" in the app yet. That's a deliberate, documented
// choice for now (see privacy.html), not an oversight.
//
// One-time setup required in Supabase — schedule this to run daily:
//
//   select cron.schedule(
//     'process-account-deletions-daily',
//     '0 4 * * *',  -- 4am UTC daily — adjust to your preference
//     $$
//     select net.http_post(
//       url := 'https://<your-project-ref>.supabase.co/functions/v1/process-account-deletions',
//       headers := jsonb_build_object('x-cron-secret', '<the same CRON_SECRET used by process-auto-renewals>', 'Content-Type', 'application/json')
//     );
//     $$
//   );
//
// Requires pg_cron and pg_net enabled (Database → Extensions).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

Deno.serve(async (req: Request) => {
  // Same shared-secret pattern as process-auto-renewals — this should
  // only ever be triggered by your own pg_cron job, never by the app.
  const secret = req.headers.get("x-cron-secret");
  if (secret !== Deno.env.get("CRON_SECRET")) {
    return new Response("Unauthorized", { status: 401 });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(supabaseUrl, serviceKey);

  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const { data: dueBusinesses, error: dueErr } = await admin
    .from("businesses")
    .select("id, name")
    .not("deletion_requested_at", "is", null)
    .lte("deletion_requested_at", cutoff);

  if (dueErr) {
    return new Response(JSON.stringify({ error: dueErr.message }), { status: 500 });
  }

  const results: Record<string, unknown>[] = [];

  for (const biz of dueBusinesses || []) {
    const result = await permanentlyDeleteBusiness(admin, biz.id, biz.name);
    results.push(result);
  }

  return new Response(JSON.stringify({ processed: results.length, results }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});

async function permanentlyDeleteBusiness(admin: ReturnType<typeof createClient>, businessId: string, bizName: string) {
  const { data: shopRows } = await admin.from("shops").select("id").eq("business_id", businessId);
  const shopIds = (shopRows || []).map((s: { id: string }) => s.id);

  const { data: userRows } = await admin.from("app_users").select("id, auth_user_id").eq("business_id", businessId);
  const authUserIds = (userRows || []).map((u: { auth_user_id: string | null }) => u.auth_user_id).filter(Boolean) as string[];

  const skipped: string[] = [];
  const tryDelete = async (table: string, column: string, value: unknown) => {
    const { error } = await admin.from(table).delete().eq(column, value);
    if (error) skipped.push(`${table}: ${error.message}`);
  };

  await admin.from("audit_log_platform").insert({
    actor_auth_user_id: null,
    action: "account_deletion_completed",
    target_business_id: businessId,
    detail: `Permanently deleted "${bizName}" — 30-day grace period expired after the Owner's deletion request.`,
  }).then((r) => { if (r.error) console.log("audit_log_platform insert skipped:", r.error.message); });

  for (const shopId of shopIds) {
    for (const table of ["sale_items", "sales", "stock_adjustments", "good_variants", "good_batches", "goods",
                          "lodging_bookings", "rooms", "shop_notes", "audit_log"]) {
      await tryDelete(table, "shop_id", shopId);
    }
  }
  for (const table of ["customers", "expenses", "supplier_purchases", "suppliers", "salary_payments",
                        "employment_record_history", "employment_records", "record_only_staff",
                        "communication_log", "app_users"]) {
    await tryDelete(table, "business_id", businessId);
  }
  await tryDelete("shops", "business_id", businessId);

  for (const authId of authUserIds) {
    const { error } = await admin.auth.admin.deleteUser(authId);
    if (error) skipped.push(`auth user ${authId}: ${error.message}`);
  }

  const { error: bizDelErr } = await admin.from("businesses").delete().eq("id", businessId);
  if (bizDelErr) {
    return { business_id: businessId, status: "failed", reason: bizDelErr.message, skipped };
  }

  return { business_id: businessId, status: "deleted", skipped };
}
