// supabase/functions/send-signup-otp/index.ts
//
// Generates a 6-digit code, stores its hash (5-minute expiry) in
// signup_otp_codes, and asks Termii to email it to the given address.
// The Termii API key never leaves this server-side function.
//
// Also checks — server-side, so it works no matter which device is
// signing up — whether this email already has an account. The front end's
// own duplicate check only sees what's on that one device's local storage,
// which can't catch "this email already signed up on a different phone."

import { createClient } from "npm:@supabase/supabase-js@2";

const TERMII_API_KEY = Deno.env.get("TERMII_API_KEY")!;
const TERMII_BASE_URL = Deno.env.get("TERMII_BASE_URL")!; // e.g. https://v3.api.termii.com
const TERMII_EMAIL_CONFIG_ID = Deno.env.get("TERMII_EMAIL_CONFIG_ID")!;

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

// ilike() treats % and _ as wildcards — escape both so an email containing
// an underscore (very common) can't accidentally match a different account.
function escapeIlike(s: string): string {
  return s.replace(/[%_]/g, (c) => "\\" + c);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { email } = await req.json();
    if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
      return new Response(JSON.stringify({ error: "A valid email address is required." }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Block signup for an email that already has an account anywhere —
    // not just on this device. Checked before sending anything, so no
    // OTP gets wasted on an email that can't actually complete signup.
    const { data: existingRows, error: existingErr } = await supabase
      .from("app_users")
      .select("id")
      .ilike("email", escapeIlike(email))
      .limit(1);
    if (existingErr) throw new Error("Could not check that email: " + existingErr.message);
    if (existingRows && existingRows[0]) {
      return new Response(JSON.stringify({ error: "An account with this email already exists. Try logging in instead." }), {
        status: 409,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: recent } = await supabase
      .from("signup_otp_codes")
      .select("created_at")
      .eq("email", email)
      .order("created_at", { ascending: false })
      .limit(1);
    if (recent && recent[0] && Date.now() - new Date(recent[0].created_at).getTime() < 60_000) {
      return new Response(JSON.stringify({ error: "Please wait a minute before requesting another code." }), {
        status: 429,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const code = String(Math.floor(100000 + Math.random() * 900000));
    const codeHash = await sha256(code);
    const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();

    const { error: dbError } = await supabase.from("signup_otp_codes").insert({
      email,
      code_hash: codeHash,
      expires_at: expiresAt,
    });
    if (dbError) throw new Error("Could not save the code: " + dbError.message);

    const termiiRes = await fetch(`${TERMII_BASE_URL}/api/email/otp/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: TERMII_API_KEY,
        email_address: email,
        code,
        emailConfigurationId: TERMII_EMAIL_CONFIG_ID,
      }),
    });
    const termiiData = await termiiRes.json();
    console.log("Termii response:", JSON.stringify(termiiData));
    if (!termiiRes.ok || termiiData.code !== "ok") {
      throw new Error("Termii could not send the email: " + JSON.stringify(termiiData));
    }

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
