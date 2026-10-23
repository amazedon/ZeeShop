// supabase/functions/send-termii-otp/index.ts
//
// Branded OTP emails through Termii's Email Product Notification API
//   POST https://api.ng.termii.com/api/templates/send-email
//   body: { api_key, email, subject, email_configuration_id, template_id, variables: { ... } }
//
// SECURITY DESIGN — the browser never supplies (or sees) the code:
//   { action: "send",   email }          -> server makes a 6-digit code, stores only its HASH, emails it
//   { action: "verify", email, code }    -> server checks the hash (expiry, 5 attempts, one use)
// If the browser could send { otpCode }, anyone could use your Termii credit to email arbitrary codes to arbitrary
// people, and a code generated in the browser could be read by an attacker, so verifying it would mean nothing.
//
// Server-to-server only: another Edge Function that already creates its own codes can call this with the header
//   x-internal-key: <INTERNAL_OTP_KEY secret>   and body { email, otpCode, templateId? }  to just deliver an email.
//
// Secrets (Edge Functions -> Secrets):
//   TERMII_API_KEY            required
//   TERMII_TEMPLATE_ID        OPTIONAL. Set it to use a template you built in Termii (POST /api/templates/send-email).
//                             Leave it unset/blank to use Termii's default Email Token route (POST /api/email/otp/send),
//                             which needs no template: { api_key, email_address, code, email_configuration_id }.
//   TERMII_OTP_VAR            optional, default "otp"; only used in template mode (the {{variable}} name for the code)
//   TERMII_EXTRA_VARS         optional JSON for other template variables, e.g. {"company_name":"ZeeShop"}
//   TERMII_EMAIL_CONFIG_ID    optional, defaults to 01a04442-c633-7ad5-8100-1bab0ab67914
//   TERMII_BASE_URL           optional, defaults to https://api.ng.termii.com
//   OTP_PEPPER                optional extra secret mixed into the stored hash (falls back to the service key)
//   INTERNAL_OTP_KEY          optional, only for the server-to-server mode
//   ALLOWED_ORIGINS           optional, comma separated; default zeeshop.ememart.com and op.ememart.com

import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const TERMII_BASE_URL = (Deno.env.get("TERMII_BASE_URL") || "https://api.ng.termii.com").replace(/\/+$/, "");
const EMAIL_CONFIG_ID = Deno.env.get("TERMII_EMAIL_CONFIG_ID") || "01a04442-c633-7ad5-8100-1bab0ab67914";
const OTP_VAR = Deno.env.get("TERMII_OTP_VAR") || "otp";
const SUBJECT = "Your ZeeShop verification code";

const OTP_TTL_MIN = 10;
const MAX_ATTEMPTS = 5;
const RESEND_COOLDOWN_SEC = 60;
const MAX_SENDS_PER_HOUR = 5;

const DEFAULT_ORIGINS = ["https://zeeshop.ememart.com", "https://op.ememart.com"];

function corsFor(req: Request): Record<string, string> {
  const allowed = (Deno.env.get("ALLOWED_ORIGINS") || "").split(",").map((s) => s.trim()).filter(Boolean);
  const list = allowed.length ? allowed : DEFAULT_ORIGINS;
  const origin = req.headers.get("origin") || "";
  return {
    "Access-Control-Allow-Origin": list.includes(origin) ? origin : list[0],
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-internal-key",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

function reply(cors: Record<string, string>, body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}

function normEmail(v: unknown): string | null {
  const e = String(v ?? "").trim().toLowerCase();
  return e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : null;
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function makeCode(): string {
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000;
  return String(n).padStart(6, "0");
}

function extraVars(): Record<string, string> {
  try {
    const raw = Deno.env.get("TERMII_EXTRA_VARS");
    return raw ? JSON.parse(raw) : {};
  } catch (_e) {
    return {};
  }
}

async function sendViaTermii(apiKey: string, templateId: string, email: string, code: string): Promise<boolean> {
  // No template configured -> Termii's default Email Token route (no template needed).
  if (!templateId) {
    const r = await fetch(`${TERMII_BASE_URL}/api/email/otp/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: apiKey, email_address: email, code, email_configuration_id: EMAIL_CONFIG_ID }),
    });
    const d = await r.json().catch(() => null);
    const good = r.ok && (d?.code === "ok" || /success/i.test(String(d?.message || "")));
    if (!good) console.error("Termii email/otp/send failed:", r.status, JSON.stringify(d)?.slice(0, 400));
    return good;
  }
  const res = await fetch(`${TERMII_BASE_URL}/api/templates/send-email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: apiKey,
      email,
      subject: SUBJECT,
      email_configuration_id: EMAIL_CONFIG_ID,
      template_id: templateId,
      variables: { ...extraVars(), [OTP_VAR]: code, expiry_minutes: String(OTP_TTL_MIN) },
    }),
  });
  const data = await res.json().catch(() => null);
  const ok = res.ok && (data?.code === "ok" || /success/i.test(String(data?.message || "")));
  if (!ok) console.error("Termii send-email failed:", res.status, JSON.stringify(data)?.slice(0, 400)); // never log the api key
  return ok;
}

Deno.serve(async (req: Request) => {
  const cors = corsFor(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return reply(cors, { success: false, error: "Method not allowed." }, 405);

  try {
    const body = await req.json().catch(() => ({}));
    const email = normEmail(body.email);
    if (!email) return reply(cors, { success: false, error: "Please enter a valid email address." }, 400);

    const apiKey = Deno.env.get("TERMII_API_KEY") || "";
    const defaultTemplate = Deno.env.get("TERMII_TEMPLATE_ID") || "";

    // ---- server-to-server delivery only (caller already owns the code) ----
    if (body.otpCode !== undefined) {
      const internal = Deno.env.get("INTERNAL_OTP_KEY") || "";
      if (!internal || !safeEqual(req.headers.get("x-internal-key") || "", internal)) {
        return reply(cors, { success: false, error: "Not allowed." }, 403);
      }
      const code = String(body.otpCode);
      const templateId = String(body.templateId || defaultTemplate);
      if (!/^\d{4,8}$/.test(code)) return reply(cors, { success: false, error: "otpCode must be 4 to 8 digits." }, 400);
      if (!apiKey) return reply(cors, { success: false, error: "Email service is not configured." }, 500);
      const ok = await sendViaTermii(apiKey, templateId, email, code);
      return ok ? reply(cors, { success: true }) : reply(cors, { success: false, error: "Could not send the email. Please try again." }, 502);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceKey) return reply(cors, { success: false, error: "Server is not configured." }, 500);
    const admin = createClient(supabaseUrl, serviceKey);
    const pepper = Deno.env.get("OTP_PEPPER") || serviceKey;
    const hashOf = (code: string) => sha256Hex(`${email}|${code}|${pepper}`);

    // ---- verify ----
    if (body.action === "verify") {
      const code = String(body.code ?? "").trim();
      if (!/^\d{6}$/.test(code)) return reply(cors, { success: false, error: "Enter the 6-digit code." }, 400);

      const { data: rows } = await admin.from("email_otps").select("id, code_hash, attempts")
        .eq("email", email).is("used_at", null).gt("expires_at", new Date().toISOString())
        .order("created_at", { ascending: false }).limit(1);
      const row: any = rows && rows[0];
      if (!row) return reply(cors, { success: false, error: "This code has expired. Please request a new one." }, 400);
      if (row.attempts >= MAX_ATTEMPTS) return reply(cors, { success: false, error: "Too many wrong attempts. Please request a new code." }, 429);

      await admin.from("email_otps").update({ attempts: row.attempts + 1 }).eq("id", row.id);
      if (!safeEqual(await hashOf(code), String(row.code_hash))) {
        const left = Math.max(0, MAX_ATTEMPTS - (row.attempts + 1));
        return reply(cors, { success: false, error: left ? `Incorrect code. ${left} attempt${left === 1 ? "" : "s"} left.` : "Too many wrong attempts. Please request a new code." }, 400);
      }
      await admin.from("email_otps").update({ used_at: new Date().toISOString() }).eq("id", row.id);
      return reply(cors, { success: true });
    }

    // ---- send ----
    if (!apiKey) {
      console.error("send-termii-otp: missing secret TERMII_API_KEY");
      return reply(cors, { success: false, error: "Email service is not configured yet. Please contact support." }, 500);
    }

    const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { data: recent } = await admin.from("email_otps").select("created_at")
      .eq("email", email).gt("created_at", hourAgo).order("created_at", { ascending: false });
    const sent = recent || [];
    if (sent.length >= MAX_SENDS_PER_HOUR) {
      return reply(cors, { success: false, error: "Too many codes requested. Please try again later.", retry_after: 3600 }, 429);
    }
    if (sent.length) {
      const wait = RESEND_COOLDOWN_SEC - Math.floor((Date.now() - Date.parse(String((sent[0] as any).created_at))) / 1000);
      if (wait > 0) return reply(cors, { success: false, error: `Please wait ${wait}s before requesting another code.`, retry_after: wait }, 429);
    }

    const code = makeCode();
    const { data: ins, error: insErr } = await admin.from("email_otps").insert({
      email, code_hash: await hashOf(code), purpose: String(body.purpose || "generic").slice(0, 40),
      expires_at: new Date(Date.now() + OTP_TTL_MIN * 60 * 1000).toISOString(),
    }).select("id").single();
    if (insErr || !ins) {
      console.error("send-termii-otp insert failed:", insErr?.message);
      return reply(cors, { success: false, error: "Could not create a code. Please try again." }, 500);
    }

    const ok = await sendViaTermii(apiKey, defaultTemplate, email, code);
    if (!ok) {
      await admin.from("email_otps").delete().eq("id", (ins as any).id);
      return reply(cors, { success: false, error: "Could not send the email. Please try again." }, 502);
    }
    return reply(cors, { success: true, expires_in: OTP_TTL_MIN * 60, retry_after: RESEND_COOLDOWN_SEC });
  } catch (e) {
    console.error("send-termii-otp error:", e instanceof Error ? e.message : e);
    return reply(cors, { success: false, error: "Something went wrong. Please try again." }, 500);
  }
});
