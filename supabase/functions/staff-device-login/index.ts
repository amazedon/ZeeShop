// supabase/functions/staff-device-login/index.ts
//
// Lets an EXISTING staff member re-authenticate on a new/second device using
// their business's permanent Connect Code + their own phone number + PIN —
// without creating a duplicate account (which is what happens today if they
// go through join-business again).
//
// Setup required once, in your Supabase project (no change needed to
// app_users — it already stores each staff member's synthetic login
// email in its existing `email` column, the same one join-business writes
// to today):
//
//   alter table businesses add column if not exists connect_code text unique;
//
//   create table login_attempts (
//     id uuid primary key default gen_random_uuid(),
//     bucket_key text not null,        -- what we're rate-limiting: an IP for
//                                       -- code guesses, a phone for PIN guesses
//     attempt_count int not null default 1,
//     window_start timestamptz not null default now()
//   );
//   create index if not exists login_attempts_bucket_idx on login_attempts(bucket_key);
//
// Deploy this function, then use the companion `regenerate-connect-code`
// function to issue the first code for each business (Settings screen in
// the app calls it automatically the first time it needs one).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const MAX_ATTEMPTS = 8;
const WINDOW_MINUTES = 15;

// Same non-cryptographic hash the client uses for local PIN storage
// (app.html's `hash()`). Replicated exactly so a PIN submitted here
// verifies against the same pin_hash value stored on the app_users row.
// This is intentionally simple, not a security-grade hash — the actual
// protection against guessing is the rate limiter below, not this.
function hashPin(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; }
  return "h" + h;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const admin = createClient(supabaseUrl, serviceKey);

    const { connect_code, phone, pin } = await req.json();
    if (!connect_code || !phone || !pin) {
      return json({ error: "Missing connect code, phone, or PIN." }, 400);
    }

    // Stage 1 rate limit: guessing the connect code itself. Keyed by
    // requesting IP, since at this point we don't know which business
    // (or which staff account) is even being targeted yet.
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
    const ipBlocked = await checkAndBumpRateLimit(admin, `code:${ip}`);
    if (ipBlocked) return json({ error: "Too many attempts. Please wait 15 minutes and try again." }, 429);

    const { data: biz } = await admin
      .from("businesses")
      .select("id")
      .eq("connect_code", String(connect_code).trim())
      .maybeSingle();
    if (!biz) return json({ error: "Incorrect connect code." }, 400);

    // Stage 2 rate limit: guessing a specific staff member's PIN. Keyed by
    // phone number within this business, separate from the code-guessing
    // bucket — someone with a valid code shouldn't get unlimited PIN tries.
    const phoneBlocked = await checkAndBumpRateLimit(admin, `pin:${biz.id}:${phone}`);
    if (phoneBlocked) return json({ error: "Too many attempts for this phone number. Please wait 15 minutes and try again." }, 429);

    const { data: staffUser } = await admin
      .from("app_users")
      .select("*")
      .eq("business_id", biz.id)
      .eq("phone", phone)
      .eq("role", "staff")
      .maybeSingle();
    if (!staffUser) return json({ error: "No staff account found with that phone number on this business." }, 400);

    if (staffUser.pin_hash !== hashPin(String(pin))) {
      return json({ error: "Incorrect PIN." }, 400);
    }
    if (staffUser.is_active === false) {
      return json({ error: "This staff account has been deactivated. Ask the owner." }, 403);
    }

    // Correct code + correct phone + correct PIN — reset both rate-limit
    // buckets and re-authenticate the EXISTING account by rotating its
    // synthetic password, exactly like join-business does for a brand new
    // one. This never creates a new app_users row.
    await clearRateLimit(admin, `code:${ip}`);
    await clearRateLimit(admin, `pin:${biz.id}:${phone}`);

    const newPassword = crypto.randomUUID() + crypto.randomUUID();
    const { error: pwErr } = await admin.auth.admin.updateUserById(staffUser.auth_user_id, { password: newPassword });
    if (pwErr) return json({ error: "Could not start a session: " + pwErr.message }, 500);

    const { data: shops } = await admin.from("shops").select("*").eq("business_id", biz.id);
    const { data: bizFull } = await admin.from("businesses").select("*").eq("id", biz.id).maybeSingle();

    return json({
      auth_email: staffUser.email,
      auth_password: newPassword,
      user: {
        id: staffUser.id, businessId: staffUser.business_id, username: staffUser.username,
        email: staffUser.email, phone: staffUser.phone, firstName: staffUser.first_name, lastName: staffUser.last_name,
        role: staffUser.role, isActive: staffUser.is_active, canAddGoods: staffUser.can_add_goods,
        // These were missing even though staffUser already has them from the
        // select("*") above — omitting them here isn't "no value yet" like it
        // is for a brand-new join, it's discarding REAL permissions the owner
        // already configured, leaving the reconnected staff member looking
        // like they can do nothing until the next background sync catches up.
        canSell: staffUser.can_sell, canSellCredit: staffUser.can_sell_credit, canRecordCash: staffUser.can_record_cash,
        canVoidReturn: staffUser.can_void_return, isSuperAdmin: staffUser.is_super_admin || false,
        managesShopIds: staffUser.manages_shop_ids || [],
        pinHash: staffUser.pin_hash, pinLength: staffUser.pin_length
      },
      business: bizFull ? {
        id: bizFull.id, name: bizFull.name, country: bizFull.country, currency: bizFull.currency,
        subscriptionPlan: bizFull.subscription_plan, subscriptionExpiresAt: bizFull.subscription_expires_at
      } : null,
      shops: shops || []
    }, 200);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "Unexpected error" }, 500);
  }
});

async function checkAndBumpRateLimit(admin: ReturnType<typeof createClient>, bucketKey: string): Promise<boolean> {
  const windowCutoff = new Date(Date.now() - WINDOW_MINUTES * 60_000).toISOString();
  const { data: row } = await admin.from("login_attempts").select("*").eq("bucket_key", bucketKey).maybeSingle();
  if (!row || row.window_start < windowCutoff) {
    await admin.from("login_attempts").upsert({ bucket_key: bucketKey, attempt_count: 1, window_start: new Date().toISOString() }, { onConflict: "bucket_key" });
    return false;
  }
  if (row.attempt_count >= MAX_ATTEMPTS) return true; // blocked
  await admin.from("login_attempts").update({ attempt_count: row.attempt_count + 1 }).eq("bucket_key", bucketKey);
  return false;
}
async function clearRateLimit(admin: ReturnType<typeof createClient>, bucketKey: string) {
  await admin.from("login_attempts").delete().eq("bucket_key", bucketKey);
}

function json(body: Record<string, unknown>, status: number) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
