// supabase/functions/manage-name-change-request/index.ts
//
// Same class of bug as reset-staff-pin and update-staff-permissions:
// name_change_request writes went through the offline sync queue
// (enqueueSync → client-authenticated PATCH, subject to RLS). A staff
// member's request to be renamed could silently never reach the server —
// meaning the Owner, almost always on a DIFFERENT device than the staff
// member, would never see it at all. This bypasses that with the service
// role key.
//
// Actions:
//   request — a staff member proposes a new first/last name for themself
//   approve — the business's master applies the pending request
//   deny    — the business's master clears the pending request without applying it
//   cancel  — the staff member withdraws their own pending request

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

    const { action, target_user_id, first_name, last_name } = await req.json();
    if (!["request", "approve", "deny", "cancel"].includes(action)) {
      return json({ error: "Invalid action." }, 400);
    }
    if (!target_user_id) return json({ error: "Missing target_user_id." }, 400);

    let { data: callerRow } = await admin
      .from("app_users")
      .select("id, business_id, role, auth_user_id, first_name, last_name")
      .eq("auth_user_id", callerData.user.id)
      .maybeSingle();

    // Same identity-split fallback used throughout this app.
    if (!callerRow && callerData.user.email) {
      const { data: emailMatch } = await admin
        .from("app_users")
        .select("id, business_id, role, auth_user_id, first_name, last_name")
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

    if (action === "request" || action === "cancel") {
      if (callerRow.id !== targetRow.id) return json({ error: "You can only manage your own request." }, 403);

      const payload = action === "request"
        ? { name_change_request: { firstName: first_name, lastName: last_name, requestedAt: new Date().toISOString() } }
        : { name_change_request: null };

      if (action === "request" && !first_name) return json({ error: "First name is required." }, 400);

      const { error: updErr } = await admin.from("app_users").update(payload).eq("id", target_user_id);
      if (updErr) return json({ error: updErr.message }, 500);
      return json({ ok: true }, 200);
    }

    // approve / deny — only the business's own master may act on someone else's request
    const isOwnerOfSameBusiness = callerRow.role === "master" && callerRow.business_id === targetRow.business_id;
    if (!isOwnerOfSameBusiness) return json({ error: "Only this business's Owner can approve or deny name changes." }, 403);

    if (action === "deny") {
      const { error: updErr } = await admin.from("app_users").update({ name_change_request: null }).eq("id", target_user_id);
      if (updErr) return json({ error: updErr.message }, 500);
      return json({ ok: true }, 200);
    }

    // approve — read the pending request off the target row itself, so the
    // client can't smuggle in a name that was never actually requested
    const { data: freshTarget } = await admin
      .from("app_users")
      .select("name_change_request")
      .eq("id", target_user_id)
      .maybeSingle();
    const pending = freshTarget?.name_change_request;
    if (!pending) return json({ error: "No pending request to approve." }, 404);

    const { error: updErr } = await admin
      .from("app_users")
      .update({ first_name: pending.firstName, last_name: pending.lastName, name_change_request: null })
      .eq("id", target_user_id);
    if (updErr) return json({ error: updErr.message }, 500);

    return json({ ok: true, first_name: pending.firstName, last_name: pending.lastName }, 200);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "Unexpected error" }, 500);
  }
});
