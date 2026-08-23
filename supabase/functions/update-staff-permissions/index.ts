// supabase/functions/update-staff-permissions/index.ts
//
// Permission changes went through the same offline sync queue as most
// other app_users fields (enqueueSync → a client-authenticated PATCH,
// subject to Row Level Security) — the exact same class of bug as the
// PIN reset issue fixed in reset-staff-pin. A revoked or granted
// permission would show "Permissions saved ✅" locally, but silently
// never reach the server, so a second device would keep showing the
// OLD permission set indefinitely, no matter how many times it was
// "saved" again.
//
// This bypasses that whole class of problem with the service role key,
// exactly like reset-staff-pin: it cannot be silently blocked by an RLS
// policy the way a client-authenticated write can. If this fails, it
// fails LOUDLY with a real error, instead of quietly doing nothing.
//
// Only the business's master/owner can call this, for staff within
// their own business — never across businesses, and never for another
// master account.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: Record<string, unknown>, status: number) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

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

    const {
      target_user_id, can_sell, can_sell_credit, can_record_cash,
      can_add_goods, can_void_return, is_super_admin, manages_shop_ids,
    } = await req.json();
    if (!target_user_id) return json({ error: "Missing target_user_id." }, 400);

    let { data: callerRow } = await admin
      .from("app_users")
      .select("id, business_id, role, auth_user_id")
      .eq("auth_user_id", callerData.user.id)
      .maybeSingle();

    // Same identity-split fallback used throughout this app: heal a caller
    // whose auth_user_id is stale (signed up one way, signed in a
    // different way on this device) by matching on email instead.
    if (!callerRow && callerData.user.email) {
      const { data: emailMatch } = await admin
        .from("app_users")
        .select("id, business_id, role, auth_user_id")
        .ilike("email", callerData.user.email)
        .maybeSingle();
      if (emailMatch) {
        await admin.from("app_users").update({ auth_user_id: callerData.user.id }).eq("id", emailMatch.id);
        callerRow = emailMatch;
      }
    }
    if (!callerRow) return json({ error: "No matching account found for this session." }, 404);

    const { data: targetRow } = await admin
      .from("app_users")
      .select("id, business_id, role")
      .eq("id", target_user_id)
      .maybeSingle();
    if (!targetRow) return json({ error: "Target account not found." }, 404);

    const isOwnerOfSameBusiness = callerRow.role === "master" && callerRow.business_id === targetRow.business_id;
    if (!isOwnerOfSameBusiness) {
      return json({ error: "Only this business's Owner can change staff permissions." }, 403);
    }
    if (targetRow.role === "master") {
      return json({ error: "Cannot change permissions on a master/owner account." }, 400);
    }

    const updatePayload: Record<string, unknown> = {};
    if (can_sell !== undefined) updatePayload.can_sell = !!can_sell;
    if (can_sell_credit !== undefined) updatePayload.can_sell_credit = !!can_sell_credit;
    if (can_record_cash !== undefined) updatePayload.can_record_cash = !!can_record_cash;
    if (can_add_goods !== undefined) updatePayload.can_add_goods = !!can_add_goods;
    if (can_void_return !== undefined) updatePayload.can_void_return = !!can_void_return;
    if (is_super_admin !== undefined) updatePayload.is_super_admin = !!is_super_admin;
    if (manages_shop_ids !== undefined) updatePayload.manages_shop_ids = manages_shop_ids || [];

    const { error: updErr } = await admin.from("app_users").update(updatePayload).eq("id", target_user_id);
    if (updErr) return json({ error: "Could not update permissions: " + updErr.message }, 500);

    return json({ ok: true, updated: updatePayload }, 200);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "Unexpected error" }, 500);
  }
});
