// supabase/functions/request-account-deletion/index.ts
//
// Called when the Owner taps "Delete Business" in Settings. This does
// NOT delete anything immediately — it locks the business out right away
// (is_active = false, everyone signed out) and records WHEN deletion was
// requested. The actual permanent deletion happens 30 days later, via
// the separate process-account-deletions scheduled function — giving the
// Owner a real window to change their mind (by contacting support) before
// anything is unrecoverable.
//
// Only the business's own master/owner can request this — never staff,
// and never for a different business.

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

    // Same identity-split fallback used throughout this app: heal a
    // caller whose auth_user_id is stale (signed up one way, signed in a
    // different way on this device) by matching on email instead.
    let { data: callerRow } = await admin
      .from("app_users")
      .select("id, business_id, role, auth_user_id")
      .eq("auth_user_id", callerData.user.id)
      .maybeSingle();

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
    if (callerRow.role !== "master") {
      return json({ error: "Only the business Owner can request account deletion." }, 403);
    }

    const { data: bizRow } = await admin
      .from("businesses")
      .select("id, deletion_requested_at")
      .eq("id", callerRow.business_id)
      .maybeSingle();
    if (!bizRow) return json({ error: "Business not found." }, 404);
    if (bizRow.deletion_requested_at) {
      return json({ error: "Deletion has already been requested for this business.", deletion_requested_at: bizRow.deletion_requested_at }, 200);
    }

    const deletionRequestedAt = new Date().toISOString();
    const { error: updErr } = await admin
      .from("businesses")
      .update({ deletion_requested_at: deletionRequestedAt, is_active: false })
      .eq("id", callerRow.business_id);
    if (updErr) return json({ error: updErr.message }, 500);

    await admin.from("audit_log_platform").insert({
      actor_auth_user_id: callerData.user.id,
      action: "account_deletion_requested",
      target_business_id: callerRow.business_id,
      detail: "Owner requested account deletion — locked immediately, permanent deletion scheduled in 30 days.",
    }).then((r) => { if (r.error) console.log("audit_log_platform insert skipped:", r.error.message); });

    return json({ ok: true, deletion_requested_at: deletionRequestedAt }, 200);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "Unexpected error" }, 500);
  }
});
