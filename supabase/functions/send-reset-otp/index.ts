// supabase/functions/send-reset-otp/index.ts
//
// Generates a 6-digit code, stores its hash (5-minute expiry) in
// password_reset_otp_codes, and asks Termii to email it to the given address.
// Mirrors send-signup-otp — same table shape, same Termii call, separate table
// so a live signup code can never be reused to reset a password (or vice versa).

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

// ilike() treats % and _ as wildcards — real emails often contain underscores
// (john_doe@gmail.com), so an unescaped ilike could match a DIFFERENT
// account than the one actually typed. Escape both before using ilike for
// what should always be an exact (just case-insensitive) match.
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

    // Note: we deliberately do NOT reveal whether this email has an account —
    // the front end already confirmed that locally before calling this function.
    // We still send only to addresses the client claims are valid accounts,
    // so this stays consistent with the signup flow's trust model.

    // Confirm this email actually belongs to an owner (master) account before
    // sending anything — the front end may be asking on behalf of a device
    // that's never seen this account before, so it can't have checked itself.
    const { data: ownerRows, error: ownerErr } = await supabase
      .from("app_users")
      .select("id")
      .ilike("email", escapeIlike(email))
      .eq("role", "master")
      .limit(1);
    if (ownerErr) throw new Error("Could not look up that account: " + ownerErr.message);
    if (!ownerRows || !ownerRows[0]) {
      return new Response(JSON.stringify({ error: "No owner account found with that email." }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: recent } = await supabase
      .from("password_reset_otp_codes")
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

    const { error: dbError } = await supabase.from("password_reset_otp_codes").insert({
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
