// supabase/functions/log-audit-event/index.ts
//
// Same defensive pattern as reset-staff-pin, update-staff-permissions, and
// manage-name-change-request — but for a different reason. audit_log
// writes are an INSERT (not an UPDATE on someone else's row), which is
// usually a much simpler case for Row Level Security to get right, so
// this one was NOT independently confirmed broken the way those three
// were. It's hardened anyway because an audit trail that might silently
// go missing is worse than a small amount of redundant plumbing — the
// whole point of this feature is that an Owner can trust it completely.

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

    const { id, business_id, user_id, action, details } = await req.json();
    if (!id || !business_id || !action) return json({ error: "Missing id, business_id, or action." }, 400);

    // Confirm the caller genuinely belongs to the business they're logging
    // an event for — this is the one check that keeps this endpoint from
    // being usable to write fake audit entries into someone else's log.
    let { data: callerRow } = await admin
      .from("app_users")
      .select("id, business_id, auth_user_id")
      .eq("auth_user_id", callerData.user.id)
      .maybeSingle();

    if (!callerRow && callerData.user.email) {
      const { data: emailMatch } = await admin
        .from("app_users")
        .select("id, business_id, auth_user_id")
        .ilike("email", callerData.user.email)
        .maybeSingle();
      if (emailMatch) {
        await admin.from("app_users").update({ auth_user_id: callerData.user.id }).eq("id", emailMatch.id);
        callerRow = emailMatch;
      }
    }
    if (!callerRow) return json({ error: "No matching account found for this session." }, 404);
    if (callerRow.business_id !== business_id) return json({ error: "Cannot log an event for a different business." }, 403);

    const { error: insertErr } = await admin.from("audit_log").insert({
      id, business_id, user_id: user_id || callerRow.id, action, details,
    });
    if (insertErr) return json({ error: insertErr.message }, 500);

    return json({ ok: true }, 200);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "Unexpected error" }, 500);
  }
});
