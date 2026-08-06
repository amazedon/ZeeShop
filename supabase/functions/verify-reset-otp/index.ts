// supabase/functions/verify-reset-otp/index.ts
//
// Checks a submitted code against the most recent unexpired,
// unconsumed row in password_reset_otp_codes for that email.
// This is a UX check only — it does NOT consume the code, because the
// front end calls this before showing the "set new password" screen,
// and the code must still be valid when apply-reset-password re-checks
// it (that function is the one that actually consumes it). Never trust
// that this endpoint having been called means anything on its own —
// apply-reset-password re-validates independently.

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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { email, code } = await req.json();
    if (!email || !code) {
      return new Response(JSON.stringify({ verified: false, error: "Email and code are required." }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: rows, error: dbError } = await supabase
      .from("password_reset_otp_codes")
      .select("id, code_hash, expires_at, consumed_at")
      .eq("email", email)
      .order("created_at", { ascending: false })
      .limit(1);
    if (dbError) throw new Error("Could not check the code: " + dbError.message);

    const row = rows && rows[0];
    if (!row) {
      return new Response(JSON.stringify({ verified: false, error: "No code was requested for this email." }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (row.consumed_at) {
      return new Response(JSON.stringify({ verified: false, error: "This code has already been used. Request a new one." }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (new Date(row.expires_at).getTime() < Date.now()) {
      return new Response(JSON.stringify({ verified: false, error: "This code has expired. Request a new one." }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const submittedHash = await sha256(String(code).trim());
    if (submittedHash !== row.code_hash) {
      return new Response(JSON.stringify({ verified: false, error: "That code is incorrect." }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ verified: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ verified: false, error: err.message || "Something went wrong." }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
