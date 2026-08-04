import { createClient } from "npm:@supabase/supabase-js@2";

const TERMII_API_KEY = Deno.env.get("TERMII_API_KEY")!;
const TERMII_BASE_URL = Deno.env.get("TERMII_BASE_URL")!;
const TERMII_EMAIL_CONFIG_ID = Deno.env.get("TERMII_EMAIL_CONFIG_ID")!;

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

async function sha256(text: string) {
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
    const { email } = await req.json();
    if (!email ||!/^\S+@\S+\.\S+$/.test(email)) {
      return new Response(JSON.stringify({ error: "A valid email address is required." }), {
        status: 400,
        headers: {...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: recent } = await supabase
     .from("password_reset_otp_codes")
     .select("created_at")
     .eq("email", email)
     .order("created_at", { ascending: false })
     .limit(1);

    if (recent && recent[0] && Date.now() - new Date(recent[0].created_at).getTime() < 60000) {
      return new Response(JSON.stringify({ error: "Please wait a minute before requesting another code." }), {
        status: 429,
        headers: {...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const code = String(Math.floor(100000 + Math.random() * 900000));
    const codeHash = await sha256(code);
    const expiresAt = new Date(Date.now() + 5 * 60000).toISOString();

    const { error: dbError } = await supabase.from("password_reset_otp_codes").insert({
      email,
      code_hash: codeHash,
      expires_at: expiresAt,
    });

    if (dbError) throw new Error("Could not save the code: " + dbError.message);

    const termiiRes = await fetch(TERMII_BASE_URL + "/api/email/otp/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: TERMII_API_KEY,
        email_address: email,
        code: code,
        email_configuration_id: TERMII_EMAIL_CONFIG_ID,
      }),
    });

    const termiiData = await termiiRes.json();
    console.log("Termii response:", JSON.stringify(termiiData));

    if (!termiiRes.ok) {
      throw new Error("Termii could not send the email: " + JSON.stringify(termiiData));
    }

    return new Response(JSON.stringify({ success: true }), {
      headers: {...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.log(err);
    const message = err instanceof Error? err.message : "Something went wrong.";
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: {...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
