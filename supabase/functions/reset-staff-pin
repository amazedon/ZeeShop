// supabase/functions/reset-staff-pin/index.ts
//
// PIN resets used to go through the same offline sync queue as everything
// else (enqueueSync → a client-authenticated PATCH, subject to RLS). For
// months this silently failed for reasons never fully diagnosed (almost
// certainly an RLS policy gap) — the app showed "PIN reset ✅" every time,
// but the server's pin_hash never actually changed, so reconnecting on any
// OTHER device kept accepting the OLD pin and rejecting the new one no
// matter how many times it was "reset."
//
// This bypasses that whole class of problem: it runs with the service
// role key, so it cannot be silently blocked by an RLS policy the way a
// client-authenticated write can. If this fails, it fails LOUDLY with a
// real error the person can see, instead of quietly doing nothing.
//
// Who can reset whose PIN:
//   - Anyone can reset their OWN PIN.
//   - A business's master/owner can reset any staff member's PIN within
//     that SAME business — never across businesses.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Mirrors the client's hash() function in app.html exactly — same 32-bit
// signed overflow behavior — so a server-set PIN hash matches what the
// app's own local comparison logic expects.
function simpleHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return "h" + h;
}

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

    const { target_user_id, new_pin } = await req.json();
    if (!target_user_id || !new_pin) return json({ error: "Missing target_user_id or new_pin." }, 400);
    if (!/^\d{4,6}$/.test(String(new_pin))) return json({ error: "PIN must be 4-6 digits." }, 400);

    let { data: callerRow } = await admin
      .from("app_users")
      .select("id, business_id, role, auth_user_id, is_super_admin")
      .eq("auth_user_id", callerData.user.id)
      .maybeSingle();

    // Same identity-split fallback as the other fixes in this app: heal a
    // caller whose auth_user_id is stale (signed up one way, signed in a
    // different way on this device) by matching on email instead, rather
    // than let that also block PIN resets.
    if (!callerRow && callerData.user.email) {
      const { data: emailMatch } = await admin
        .from("app_users")
        .select("id, business_id, role, auth_user_id, is_super_admin")
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
      .select("id, business_id, first_name, role, is_super_admin")
      .eq("id", target_user_id)
      .maybeSingle();
    if (!targetRow) return json({ error: "Target account not found." }, 404);

    const isSelf = callerRow.id === targetRow.id;
    const sameBusiness = callerRow.business_id === targetRow.business_id;
    // Mirrors canManageThisUser() in app.html exactly: the Owner can reset
    // anyone except another Owner account; a designated in-app Super Admin
    // can reset regular staff, but not the Owner and not another Super
    // Admin — matching what the client already allows the Reset PIN
    // button to be clicked for, so this never rejects an action the UI
    // itself already said was allowed.
    const isOwnerManaging = callerRow.role === "master" && sameBusiness && targetRow.role !== "master";
    const isSuperAdminManaging = callerRow.is_super_admin && sameBusiness && targetRow.role !== "master" && !targetRow.is_super_admin;

    if (!isSelf && !isOwnerManaging && !isSuperAdminManaging) {
      return json({ error: "You don't have permission to reset this PIN." }, 403);
    }

    const pinHash = simpleHash(String(new_pin));
    const { error: updErr } = await admin
      .from("app_users")
      .update({ pin_hash: pinHash, pin_length: String(new_pin).length })
      .eq("id", target_user_id);

    if (updErr) return json({ error: "Could not update PIN: " + updErr.message }, 500);

    return json({ ok: true, pin_hash: pinHash, pin_length: String(new_pin).length }, 200);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "Unexpected error" }, 500);
  }
});
