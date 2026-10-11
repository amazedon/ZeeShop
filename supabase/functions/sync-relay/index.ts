// supabase/functions/sync-relay/index.ts
//
// THE central fix for "everything disappears on another device" reports
// that trace back to writes silently never reaching the server. Every
// write in the app — adding goods, recording a sale, updating settings,
// resetting a PIN, everything — eventually goes through one function on
// the client: pushSyncItem() in sync-engine.js. Previously, that function
// hit PostgREST directly using the CLIENT's own session token, which
// means every single write was subject to Row Level Security — and RLS
// gaps on this project have now been independently confirmed real and
// repeatable (PIN resets, staff permissions, name-change requests all
// silently failed this way before being fixed one at a time).
//
// Rather than keep finding and patching these one table at a time, this
// relay replaces the ONE chokepoint every write already passes through.
// It runs with the service role key — RLS cannot silently block it — and
// does its OWN authorization check per request instead, using the same
// "does this row belong to your business" logic that RLS was supposed to
// be enforcing. A failure here is a real, visible error returned to the
// client, never a silent no-op.
//
// Authorization strategy, per table:
//   - If the payload already includes business_id (most top-level
//     tables), verify it matches the caller's own business.
//   - If the payload includes shop_id instead (goods, sales, and other
//     shop-scoped tables), verify that shop belongs to the caller's
//     business.
//   - If neither is present (a partial UPDATE/DELETE that only sends
//     changed fields, e.g. {id, someField}), fetch the EXISTING row and
//     resolve its business/shop from there.
//   - For child tables with no scope column of their own (good_variants,
//     good_batches, sale_items, employment_record_history), resolve
//     through their parent row (goods/sales/employment_records) instead.
//
// HARDENING (added): RLS is bypassed here, so the checks below ARE the security boundary:
//   - Deactivated and read-only (viewer) accounts can't write at all.
//   - For update/delete/insert-over-existing, the EXISTING row's owner is always checked — a caller can no
//     longer claim a victim's row by putting their own business_id/shop_id in the payload.
//   - businesses and app_users only accept the columns the app legitimately syncs (COLUMN_ALLOWLIST). Wallet
//     balance, subscription, payment-account, role and permission columns can only be changed server-side
//     (bigisub-proxy, verify-payment, update-staff-permissions, super-admin, ...). Anything else is ignored.
//   - Only the owner (master) may write the businesses row; staff may edit only their own app_users row;
//     users are never created or deleted through this relay.
//
// NOTE ON SCHEMA ASSUMPTIONS: table-to-parent relationships below
// (PARENT_TABLE_MAP) are inferred from how the client constructs each
// payload throughout app.html, not confirmed against your live schema
// directly. If a specific table's write starts failing after deploying
// this, check that table's entry below against your actual columns.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: Record<string, unknown>, status: number) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

// Tables allowed through this relay — anything not listed here is
// rejected outright, so this can never become a generic "write anything
// anywhere" endpoint even if the client were compromised.
const ALLOWED_TABLES = new Set([
  "app_users", "audit_log", "businesses", "communication_log", "customers",
  "employment_record_history", "employment_records", "expenses",
  "good_batches", "good_variants", "goods", "lodging_bookings",
  "record_only_staff", "rooms", "salary_payments", "sale_items", "sales",
  "shop_notes", "shops", "stock_adjustments", "supplier_purchases", "suppliers",
]);

// Columns the app is allowed to write on these two sensitive tables (taken from what app.html actually sends).
// Everything else is dropped, not rejected, so an old client that includes extra fields keeps working.
const COLUMN_ALLOWLIST: Record<string, Set<string>> = {
  businesses: new Set(["id", "name", "business_type", "registration_number", "country", "currency", "timezone", "language",
    "tax_name", "tax_percent", "logo_data_url", "setup_complete"]),
  app_users: new Set(["id", "username", "first_name", "last_name", "phone", "email", "password_hash", "is_active"]),
};

// For child tables with no business_id/shop_id of their own — how to
// find their parent row and which column on THAT row to resolve scope
// from. Every parent here has already been confirmed (via app.html) to
// carry either shop_id or business_id directly, or is itself resolvable
// through one more hop (rooms -> shop_id).
const PARENT_TABLE_MAP: Record<string, { parentTable: string; parentKeyOnChild: string }> = {
  good_batches: { parentTable: "goods", parentKeyOnChild: "good_id" },
  good_variants: { parentTable: "goods", parentKeyOnChild: "good_id" },
  sale_items: { parentTable: "sales", parentKeyOnChild: "sale_id" },
  employment_record_history: { parentTable: "employment_records", parentKeyOnChild: "employment_record_id" },
  lodging_bookings: { parentTable: "rooms", parentKeyOnChild: "room_id" },
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization") || "";
    const token = authHeader.replace(/^Bearer\s+/i, "");
    if (!token) return json({ error: "Not authenticated." }, 401);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const admin = createClient(supabaseUrl, serviceKey);

    const { data: callerData, error: callerErr } = await admin.auth.getUser(token);
    if (callerErr || !callerData?.user) return json({ error: "Not authenticated." }, 401);

    const { table, op, payload: rawPayload } = await req.json();
    let payload = rawPayload;
    if (!table || !op || !payload) return json({ error: "Missing table, op, or payload." }, 400);
    if (!ALLOWED_TABLES.has(table)) return json({ error: `Table '${table}' is not permitted through this relay.` }, 403);
    if (!["insert", "update", "delete"].includes(op)) return json({ error: "Invalid op." }, 400);

    // Resolve the caller's own business — same identity-split fallback
    // used throughout this app (heal a stale auth_user_id via email match).
    let { data: callerRow } = await admin
      .from("app_users")
      .select("id, business_id, role, auth_user_id, is_active")
      .eq("auth_user_id", callerData.user.id)
      .maybeSingle();

    if (!callerRow && callerData.user.email) {
      const { data: emailMatch } = await admin
        .from("app_users")
        .select("id, business_id, role, auth_user_id, is_active")
        .ilike("email", callerData.user.email)
        .maybeSingle();
      if (emailMatch) {
        await admin.from("app_users").update({ auth_user_id: callerData.user.id }).eq("id", emailMatch.id);
        callerRow = emailMatch;
      }
    }
    if (!callerRow) return json({ error: "No matching account found for this session." }, 404);

    const callerBusinessId = callerRow.business_id;
    if (callerRow.is_active === false) return json({ error: "This account has been deactivated." }, 403);
    if (callerRow.role === "viewer") return json({ error: "Read-only accounts can't make changes." }, 403);
    const isOwner = callerRow.role === "master";

    // Resolve which business this write actually belongs to.
    const resolvedBusinessId = await resolveBusinessId(admin, table, op, payload, callerBusinessId);
    if (resolvedBusinessId === null) {
      return json({ error: `Could not determine which business this ${table} record belongs to.` }, 400);
    }
    if (resolvedBusinessId !== callerBusinessId) {
      return json({ error: "This record does not belong to your business." }, 403);
    }

    // The row that ALREADY exists (if any) must belong to the caller's business too. The payload's own
    // business_id/shop_id is attacker-controlled, so it can never be the only thing we check.
    if (payload.id && table !== "businesses") {
      const existingOwner = await rowToBusinessId(admin, table, String(payload.id));
      if (existingOwner !== null && existingOwner !== callerBusinessId) {
        return json({ error: "This record does not belong to your business." }, 403);
      }
    }

    // Per-table rules for the two sensitive tables.
    if (table === "businesses") {
      if (!isOwner) return json({ error: "Only the owner can change business details." }, 403);
      if (op === "delete") return json({ error: "Not permitted." }, 403);
    }
    if (table === "app_users") {
      if (op !== "update") return json({ error: "Users can't be created or deleted this way." }, 403);
      if (payload.id !== callerRow.id && !isOwner) return json({ error: "You can only edit your own profile." }, 403);
    }
    const allow = COLUMN_ALLOWLIST[table];
    if (allow) {
      const kept: Record<string, unknown> = {};
      const dropped: string[] = [];
      for (const [k, v] of Object.entries(payload)) (allow.has(k) ? (kept[k] = v) : dropped.push(k));
      if (table === "app_users" && !isOwner && "is_active" in kept) { delete kept.is_active; dropped.push("is_active"); }
      if (dropped.length) console.warn(`sync-relay: ignored protected column(s) on ${table}: ${dropped.join(", ")}`);
      if (Object.keys(kept).filter((k) => k !== "id").length === 0) return json({ ok: true, ignored: dropped }, 200);
      payload = kept;
    }

    // Authorized — perform the write with the service role client.
    if (op === "insert") {
      const { error } = await admin.from(table).upsert(payload);
      if (error) return json({ error: error.message }, 500);
    } else if (op === "update") {
      if (!payload.id) return json({ error: "Missing id for update." }, 400);
      const { id, ...fields } = payload;
      const { error } = await admin.from(table).update(fields).eq("id", id);
      if (error) return json({ error: error.message }, 500);
    } else if (op === "delete") {
      if (!payload.id) return json({ error: "Missing id for delete." }, 400);
      const { error } = await admin.from(table).delete().eq("id", payload.id);
      if (error) return json({ error: error.message }, 500);
    }

    return json({ ok: true }, 200);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "Unexpected error" }, 500);
  }
});

// Returns the business_id this write should belong to, or null if it
// can't be determined at all (missing row, broken reference, etc.).
async function resolveBusinessId(
  admin: ReturnType<typeof createClient>,
  table: string,
  op: string,
  payload: Record<string, unknown>,
  callerBusinessId: string
): Promise<string | null> {
  // businesses itself — the row's own id IS the business.
  if (table === "businesses") {
    const id = (payload.id as string) || null;
    return id || null;
  }

  // Directly on the payload — the common, simple case.
  if (payload.business_id) return payload.business_id as string;

  if (payload.shop_id) {
    return await shopIdToBusinessId(admin, payload.shop_id as string);
  }

  // A child table (no scope column of its own) — resolve via its parent.
  const parentInfo = PARENT_TABLE_MAP[table];
  if (parentInfo) {
    const parentKeyValue = payload[parentInfo.parentKeyOnChild] as string | undefined;
    if (parentKeyValue) {
      return await rowToBusinessId(admin, parentInfo.parentTable, parentKeyValue);
    }
  }

  // Nothing in the payload itself (a partial update/delete that only sent
  // changed fields) — fetch the EXISTING row and resolve from there.
  if ((op === "update" || op === "delete") && payload.id) {
    return await rowToBusinessId(admin, table, payload.id as string);
  }

  // Last resort for a genuinely scope-less insert — trust the caller's
  // own business rather than reject a legitimate write outright. This
  // only applies to inserts with no business_id/shop_id/parent reference
  // at all, which shouldn't happen for any currently-known table, but
  // fails safe (scoped to the caller) rather than failing closed.
  if (op === "insert") return callerBusinessId;

  return null;
}

async function shopIdToBusinessId(admin: ReturnType<typeof createClient>, shopId: string): Promise<string | null> {
  const { data } = await admin.from("shops").select("business_id").eq("id", shopId).maybeSingle();
  return data?.business_id || null;
}

// Resolves a row in ANY table (goods, sales, rooms, employment_records,
// or a table with business_id/shop_id directly) down to a business_id.
async function rowToBusinessId(admin: ReturnType<typeof createClient>, table: string, id: string): Promise<string | null> {
  const { data } = await admin.from(table).select("*").eq("id", id).maybeSingle();
  if (!data) return null;
  if (data.business_id) return data.business_id as string;
  if (data.shop_id) return await shopIdToBusinessId(admin, data.shop_id as string);
  // One more hop for tables whose OWN parent is itself a child table
  // (e.g. rooms -> shop_id already covered above; this covers any
  // currently-unlisted case defensively rather than silently failing).
  const parentInfo = PARENT_TABLE_MAP[table];
  if (parentInfo) {
    const parentKeyValue = data[parentInfo.parentKeyOnChild] as string | undefined;
    if (parentKeyValue) return await rowToBusinessId(admin, parentInfo.parentTable, parentKeyValue);
  }
  return null;
}
