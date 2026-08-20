// supabase/functions/revert-contact-change/index.ts
//
// The endpoint behind the "Undo This Change" link emailed by
// notify-contact-change. Deliberately a simple GET-friendly link (no
// login required) since it's meant to be clickable straight from an
// email on any device — the security here comes from the token itself
// being a long random secret only the old email address ever received,
// not from requiring a session.
//
// On a valid, unexpired, unused token: reverts the field back to its
// old value, marks the token used (so it can't be replayed), and force-
// signs-out the account by clearing its password/PIN hash to an unusable
// placeholder — the real owner must then use Forgot Password to set a
// fresh one, since if someone else changed the contact info, the
// password itself should be treated as compromised too.
//
// Uses the same contact_change_tokens table created for
// notify-contact-change — see that file's header for the setup SQL.

import { createClient } from "npm:@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function html(body: string, status = 200) {
  return new Response(
    `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
     <style>body{font-family:sans-serif;max-width:480px;margin:60px auto;padding:0 20px;color:#12213B;text-align:center;}
     h2{margin-bottom:8px;} a{color:#D98E1E;}</style></head>
     <body>${body}</body></html>`,
    { status, headers: { ...corsHeaders, "Content-Type": "text/html" } }
  );
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const url = new URL(req.url);
    const token = url.searchParams.get("token") || (await req.json().catch(() => ({}))).token;
    if (!token) return html("<h2>Missing link</h2><p>This undo link looks incomplete.</p>", 400);

    const { data: row, error: rowErr } = await supabase
      .from("contact_change_tokens")
      .select("*")
      .eq("token", token)
      .maybeSingle();
    if (rowErr) return html(`<h2>Something went wrong</h2><p>${rowErr.message}</p>`, 500);
    if (!row) return html("<h2>Link not found</h2><p>This undo link is invalid.</p>", 404);
    if (row.used_at) return html("<h2>Already used</h2><p>This change has already been undone.</p>", 200);
    if (new Date(row.expires_at).getTime() < Date.now()) {
      return html("<h2>Link expired</h2><p>This undo link is more than 48 hours old. Contact support instead.</p>", 410);
    }

    const revertField = row.field === "email" ? { email: row.old_value } : { phone: row.old_value };

    // Also force a password reset — if someone else was able to change
    // contact info, treat the password as compromised too, not just the
    // contact field. Setting an unusable placeholder hash means no
    // password will ever match it; only Forgot Password (which goes to
    // the now-restored real email) can get back in.
    const { error: updErr } = await supabase
      .from("app_users")
      .update({ ...revertField, password_hash: "REVOKED_" + crypto.randomUUID() })
      .eq("id", row.app_user_id);
    if (updErr) return html(`<h2>Could not undo the change</h2><p>${updErr.message}</p>`, 500);

    await supabase.from("contact_change_tokens").update({ used_at: new Date().toISOString() }).eq("id", row.id);

    await supabase.from("audit_log_platform").insert({
      actor_auth_user_id: null,
      action: "contact_change_reverted",
      target_business_id: null,
      detail: `Reverted ${row.field} to ${row.old_value} via emailed undo link; password reset forced.`,
    }).then((r) => { if (r.error) console.log("audit_log_platform insert skipped:", r.error.message); });

    return html(
      `<h2>Change undone ✅</h2>
       <p>Your ${row.field} has been restored to <b>${row.old_value}</b>.</p>
       <p>Your password has also been reset for safety — use <b>Forgot Password</b> on the login screen to set a new one.</p>`
    );
  } catch (e) {
    return html(`<h2>Something went wrong</h2><p>${e instanceof Error ? e.message : "Unexpected error"}</p>`, 500);
  }
});
