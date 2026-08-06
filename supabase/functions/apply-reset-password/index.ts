// supabase/functions/apply-reset-password/index.ts
//
// The one function actually authorized to change a password during
// password recovery. Takes { email, code, newPassword } and:
//   1. Re-validates the code itself (never trusts that verify-reset-otp
//      was called first — that endpoint is UX-only and doesn't consume
//      the code, precisely so this check can't be skipped).
//   2. Looks up the owner's Supabase Auth user id via
//      businesses.owner_auth_user_id (joined through app_users.business_id).
//   3. Updates the Supabase Auth password (admin API — this is the only
//      place that's allowed to happen, since it needs the service role key).
//   4. Updates app_users.password_hash using the SAME weak/non-cryptographic
//      hash the front end uses locally (see hash() in app.html), so that
//      once this row syncs back down to any device via pullSync(), local
//      offline login still works and matches.
//   5. Marks the code consumed, so it can't be replayed.

import { createClient } from "npm:@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

async function sha256(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Mirrors app.html's client-side hash(): let h=0; for each char, h = (h*31 + code)|0; return 'h'+h.
// Must stay byte-for-byte identical to that function, or local offline login breaks after a reset.
function localStyleHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  }
  return "h" + h;
}

// See send-reset-otp for why this escaping matters — an unescaped ilike
// could otherwise match a different account's row.
function escapeIlike(s: string): string {
  return s.replace(/[%_]/g, (c) => "\\" + c);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { email, code, newPassword } = await req.json();
    if (!email || !code || !newPassword) {
      return new Response(JSON.stringify({ error: "Email, code, and new password are all required." }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (String(newPassword).length < 6) {
      return new Response(JSON.stringify({ error: "Password must be at least 6 characters." }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 1. Re-validate the code — this is the real gate, independent of verify-reset-otp.
    const { data: codeRows, error: codeErr } = await supabase
      .from("password_reset_otp_codes")
      .select("id, code_hash, expires_at, consumed_at")
      .eq("email", email)
      .order("created_at", { ascending: false })
      .limit(1);
    if (codeErr) throw new Error("Could not check the code: " + codeErr.message);
    const row = codeRows && codeRows[0];
    if (!row) {
      return new Response(JSON.stringify({ error: "No code was requested for this email." }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (row.consumed_at) {
      return new Response(JSON.stringify({ error: "This code has already been used. Request a new one." }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (new Date(row.expires_at).getTime() < Date.now()) {
      return new Response(JSON.stringify({ error: "This code has expired. Request a new one." }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const submittedHash = await sha256(String(code).trim());
    if (submittedHash !== row.code_hash) {
      return new Response(JSON.stringify({ error: "That code is incorrect." }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 2. Find the owner account and their business (for the Auth user id).
    const { data: ownerRows, error: ownerErr } = await supabase
      .from("app_users")
      .select("id, business_id")
      .ilike("email", escapeIlike(email))
      .eq("role", "master")
      .limit(1);
    if (ownerErr) throw new Error("Could not look up that account: " + ownerErr.message);
    const owner = ownerRows && ownerRows[0];
    if (!owner) {
      return new Response(JSON.stringify({ error: "No owner account found with that email." }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: bizRows, error: bizErr } = await supabase
      .from("businesses")
      .select("owner_auth_user_id")
      .eq("id", owner.business_id)
      .limit(1);
    if (bizErr) throw new Error("Could not look up the business: " + bizErr.message);
    const authUserId = bizRows && bizRows[0] && bizRows[0].owner_auth_user_id;

    // 3. Update the real Supabase Auth password (only place allowed to do this).
    if (authUserId) {
      const { error: authUpdateErr } = await supabase.auth.admin.updateUserById(authUserId, {
        password: newPassword,
      });
      if (authUpdateErr) throw new Error("Could not update the account password: " + authUpdateErr.message);
    }

    // 4. Keep app_users.password_hash consistent with what local devices compute.
    const { error: rowUpdateErr } = await supabase
      .from("app_users")
      .update({ password_hash: localStyleHash(newPassword) })
      .eq("id", owner.id);
    if (rowUpdateErr) throw new Error("Could not save the new password: " + rowUpdateErr.message);

    // 5. Consume the code so it can't be replayed.
    await supabase
      .from("password_reset_otp_codes")
      .update({ consumed_at: new Date().toISOString() })
      .eq("id", row.id);

    return new Response(JSON.stringify({ success: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message || "Something went wrong." }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
