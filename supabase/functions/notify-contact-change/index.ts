// supabase/functions/notify-contact-change/index.ts
//
// Fires right after a business owner changes their email, phone, username,
// or password from My Profile — emails the OLD address on file so the real
// owner finds out immediately if someone else made the change, even if
// that person also had a valid session or the correct current password.
//
// Deliberately does NOT trust the client for the destination address or
// for what changed. The client sends only { field }, a Bearer token for
// the currently-signed-in Supabase Auth session, and (for email/phone
// changes) the new value being set. This function looks up the caller's
// OWN app_users row server-side via that token, and emails whatever
// email is on file for them right NOW — before the client's own
// enqueueSync PATCH has had a chance to overwrite it. That ordering is
// why the client must call this BEFORE queuing the actual field update,
// not after.
//
// Also mints a time-limited revert token for email/phone changes and
// includes an "Undo this change" link in the email — see
// revert-contact-change/index.ts, which is what that link calls.
//
// One-time setup required in Supabase:
//   create table contact_change_tokens (
//     id uuid primary key default gen_random_uuid(),
//     app_user_id uuid not null references app_users(id) on delete cascade,
//     field text not null check (field in ('email','phone')),
//     old_value text,
//     new_value text,
//     token text not null unique,
//     created_at timestamptz default now(),
//     expires_at timestamptz not null,
//     used_at timestamptz
//   );

import { createClient } from "npm:@supabase/supabase-js@2";

const TERMII_API_KEY = Deno.env.get("TERMII_API_KEY")!;
const TERMII_BASE_URL = Deno.env.get("TERMII_BASE_URL")!;
const TERMII_EMAIL_CONFIG_ID = Deno.env.get("TERMII_EMAIL_CONFIG_ID")!;
const SITE_URL = Deno.env.get("SITE_URL") || "https://zed.ememart.com";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const VALID_FIELDS = ["email", "phone", "username", "password"];

function json(body: Record<string, unknown>, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Fixed, safe copy per field — never interpolates attacker-suppliable text
// into the email body, to avoid this becoming a phishing/injection vector.
function messageFor(field: string, revertLink: string | null): { subject: string; bodyHtml: string } {
  const labels: Record<string, string> = {
    email: "email address",
    phone: "phone number",
    username: "username",
    password: "password",
  };
  const label = labels[field] || "account details";
  const revertBlock = revertLink
    ? `<p>If this wasn't you, click below within the next 48 hours to undo it and lock the account:</p>
       <p><a href="${revertLink}" style="display:inline-block;padding:10px 18px;background:#D98E1E;color:#12213B;font-weight:700;text-decoration:none;border-radius:8px;">Undo This Change</a></p>`
    : `<p>If this wasn't you, contact support immediately — your account password should be considered compromised.</p>`;
  return {
    subject: `Your ZeeShop ${label} was just changed`,
    bodyHtml: `<p>Your ZeeShop account's ${label} was just changed.</p>${revertBlock}`,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization") || "";
    const token = authHeader.replace(/^Bearer\s+/i, "");
    if (!token) return json({ error: "Not authenticated." }, 401);

    const { data: callerData, error: callerErr } = await supabase.auth.getUser(token);
    if (callerErr || !callerData?.user) return json({ error: "Not authenticated." }, 401);

    const { field, new_value } = await req.json();
    if (!VALID_FIELDS.includes(field)) {
      return json({ error: "Invalid field." }, 400);
    }

    // Look up the caller's OWN row — never anyone else's. This is what
    // stops this endpoint being usable to spam or probe other accounts.
    let { data: userRow, error: userErr } = await supabase
      .from("app_users")
      .select("id, email, phone")
      .eq("auth_user_id", callerData.user.id)
      .maybeSingle();

    // Fallback: same identity-split scenario as loadOwnerBusinessData,
    // verify-payment, create-join-code, and regenerate-connect-code —
    // someone who signed up with email+password and is now here via
    // "Continue with Google" (or vice versa) on the same email can be a
    // second, separate Supabase Auth identity if Google-account linking
    // isn't enabled on the project. This is exactly the scenario where
    // this security notification matters most, so it shouldn't be the
    // one place that silently goes quiet because of it.
    if (!userRow && callerData.user.email) {
      const { data: emailMatch } = await supabase
        .from("app_users")
        .select("id, email, phone, auth_user_id")
        .eq("role", "master")
        .ilike("email", callerData.user.email)
        .maybeSingle();
      if (emailMatch) {
        await supabase.from("app_users").update({ auth_user_id: callerData.user.id }).eq("id", emailMatch.id);
        userRow = emailMatch;
      }
    }

    if (userErr) return json({ error: userErr.message }, 500);
    if (!userRow) return json({ error: "No matching account found." }, 404);

    const oldEmail = userRow.email;
    if (!oldEmail) {
      // Nothing to notify — this account has no email on file (shouldn't
      // normally happen for a master/owner account, but don't fail loudly).
      return json({ ok: true, notified: false }, 200);
    }

    let revertLink: string | null = null;
    if ((field === "email" || field === "phone") && new_value) {
      const oldValue = field === "email" ? userRow.email : userRow.phone;
      const revertToken = randomToken();
      const expiresAt = new Date(Date.now() + 48 * 60 * 60_000).toISOString();
      const { error: tokenErr } = await supabase.from("contact_change_tokens").insert({
        app_user_id: userRow.id,
        field,
        old_value: oldValue,
        new_value,
        token: revertToken,
        expires_at: expiresAt,
      });
      if (tokenErr) {
        // Table probably doesn't exist yet — see setup comment above.
        // Don't fail the whole notification over this; still send the
        // plain "contact support" version.
        console.log("contact_change_tokens insert skipped:", tokenErr.message);
      } else {
        revertLink = `${SITE_URL}/revert-contact-change?token=${revertToken}`;
      }
    }

    const { subject, bodyHtml } = messageFor(field, revertLink);

    const termiiRes = await fetch(`${TERMII_BASE_URL}/api/email/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: TERMII_API_KEY,
        email_address: oldEmail,
        subject,
        content: bodyHtml,
        emailConfigurationId: TERMII_EMAIL_CONFIG_ID,
      }),
    });
    const termiiData = await termiiRes.json().catch(() => ({}));
    if (!termiiRes.ok) {
      console.log("Termii notify send failed:", JSON.stringify(termiiData));
      // Still return ok — a failed notification shouldn't block the user's
      // own profile save, which already happened client-side.
    }

    return json({ ok: true, notified: true }, 200);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "Unexpected error" }, 500);
  }
});
