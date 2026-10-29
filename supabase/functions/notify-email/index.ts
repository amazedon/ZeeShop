// supabase/functions/notify-email/index.ts
//
// ONE place that sends every financial email (wallet funding, airtime/data,
// bills, electricity tokens, admin credits). Other functions call it with the
// service-role key and never wait for it, so an email problem can NEVER block
// or roll back money movement.
//
// HOW IT SENDS (first that is configured wins, the next is the fallback):
//   1. Termii TEMPLATE — your approved "ZeeShop Bill Receipt" template, through Termii's
//                      POST /api/templates/send-email (NOT the OTP "email token" route, which always uses the OTP layout).
//                      Needs TERMII_API_KEY + TERMII_RECEIPT_TEMPLATE_ID (+ optional TERMII_EMAIL_CONFIG_ID).
//   2. Termii SMTP   — TERMII_SMTP_HOST / TERMII_SMTP_PORT / TERMII_SMTP_USER / TERMII_SMTP_PASS
//                      (port 465 = implicit TLS; Supabase blocks 25 and 587)
//   3. Resend (HTTP) — RESEND_API_KEY
//   4. None          — the email is logged as "skipped"; nothing breaks.
// EMAIL_FROM (e.g. ZeeShop <no-reply@yourdomain.com>) is needed only for 2 and 3.
//
// Template placeholders (each template uses only its own subset; every one is always sent):
//   general:     service_type recipient_label recipient_phone plan_details customer_name transaction_id transaction_date payment_method amount status
//   electricity: service_type token disco_name meter_number meter_type units customer_name order_amount payment_amount transaction_id
//                transaction_time transaction_date customer_phone payment_method reference status customer_address disco_hotline amount
//   pin:         service_type recipient_phone pins customer_name transaction_id transaction_date payment_method amount status
//
// Deploy:  supabase functions deploy notify-email
// Only callers holding the service-role key are accepted.

import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";

const APP_NAME = Deno.env.get("APP_NAME") || "ZeeShop";
const SUPPORT_EMAIL = Deno.env.get("SUPPORT_EMAIL") || "";
const EMAIL_FROM = Deno.env.get("EMAIL_FROM") || "";
const SMTP_HOST = Deno.env.get("TERMII_SMTP_HOST") || "";
const SMTP_PORT = Number(Deno.env.get("TERMII_SMTP_PORT")) || 465;
const SMTP_USER = Deno.env.get("TERMII_SMTP_USER") || "";
const SMTP_PASS = Deno.env.get("TERMII_SMTP_PASS") || "";
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") || "";
const TERMII_API_KEY = Deno.env.get("TERMII_API_KEY") || "";
const TERMII_BASE_URL = (Deno.env.get("TERMII_BASE_URL") || "https://api.ng.termii.com").replace(/\/+$/, "");
const TERMII_EMAIL_CONFIG_ID = Deno.env.get("TERMII_EMAIL_CONFIG_ID") || "01a04442-c633-7ad5-8100-1bab0ab67914";
// Three Termii templates (see the receipt-*.html files). Each is optional: a type whose template ID is not set
// falls back to the built-in layout below, so nothing breaks while you are still setting Termii up.
//   TERMII_RECEIPT_TEMPLATE_ID      general receipt  (airtime, data, TV, betting, ISP, wallet funding)
//   TERMII_ELECTRICITY_TEMPLATE_ID  electricity receipt (shows the meter token)
//   TERMII_PIN_TEMPLATE_ID          PIN receipt (result checker PINs / vouchers)
const RECEIPT_TEMPLATE_ID = Deno.env.get("TERMII_RECEIPT_TEMPLATE_ID") || "";
const ELECTRICITY_TEMPLATE_ID = Deno.env.get("TERMII_ELECTRICITY_TEMPLATE_ID") || "";
const PIN_TEMPLATE_ID = Deno.env.get("TERMII_PIN_TEMPLATE_ID") || "";
// "ZeeShop Email OTP" template (sign-up, password reset and Bill Payments PIN codes).
//   TERMII_OTP_TEMPLATE_ID   the template's ID. Leave unset to keep the built-in layout.
//   TERMII_OTP_VAR           the {{variable}} that holds the code in that template (default "otp")
//   TERMII_OTP_EXPIRY_VAR    optional: the {{variable}} that shows the minutes (only set it if the template has one)
const OTP_TEMPLATE_ID = Deno.env.get("TERMII_OTP_TEMPLATE_ID") || "";
const OTP_VAR = Deno.env.get("TERMII_OTP_VAR") || "otp";
const OTP_EXPIRY_VAR = Deno.env.get("TERMII_OTP_EXPIRY_VAR") || "";

// ---------- helpers ----------
const esc = (v: unknown) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

const naira = (n: unknown) => {
  const x = Number(n);
  if (!Number.isFinite(x)) return "—";
  return "₦" + x.toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

const when = (iso?: string) =>
  new Date(iso || Date.now()).toLocaleString("en-NG", { timeZone: "Africa/Lagos", dateStyle: "medium", timeStyle: "short" });

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

type Row = [label: string, value: unknown, opts?: { mono?: boolean; strong?: boolean }];

function shell(opts: { title: string; greeting: string; intro: string; rows: Row[]; highlight?: string; footerNote?: string }) {
  const rows = opts.rows
    .filter((r) => r[1] !== undefined && r[1] !== null && String(r[1]).trim() !== "")
    .map(([label, value, o]) => `
      <tr>
        <td style="padding:10px 0;border-bottom:1px solid #EEEAE0;color:#6B7280;font-size:13px;width:42%;vertical-align:top;">${esc(label)}</td>
        <td style="padding:10px 0;border-bottom:1px solid #EEEAE0;color:#12213B;font-size:14px;text-align:right;${o?.strong ? "font-weight:800;" : "font-weight:600;"}${o?.mono ? "font-family:Consolas,Menlo,monospace;" : ""}word-break:break-word;">${esc(value)}</td>
      </tr>`).join("");

  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(opts.title)}</title></head>
<body style="margin:0;padding:0;background:#F1EEE6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F1EEE6;padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#FFFFFF;border-radius:16px;overflow:hidden;border:1px solid #E4E0D6;">
        <tr><td style="background:#12213B;padding:20px 24px;">
          <div style="color:#FFFFFF;font-size:18px;font-weight:800;">${esc(APP_NAME)}</div>
          <div style="color:#F2A93B;font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;margin-top:2px;">${esc(opts.title)}</div>
        </td></tr>
        <tr><td style="padding:24px;">
          <p style="margin:0 0 6px;color:#12213B;font-size:16px;font-weight:700;">${esc(opts.greeting)}</p>
          <p style="margin:0 0 18px;color:#242B38;font-size:14px;line-height:1.5;">${esc(opts.intro)}</p>
          ${opts.highlight || ""}
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table>
          ${opts.footerNote ? `<p style="margin:18px 0 0;color:#6B7280;font-size:12px;line-height:1.5;">${esc(opts.footerNote)}</p>` : ""}
        </td></tr>
        <tr><td style="background:#FBFAF7;padding:16px 24px;border-top:1px solid #E4E0D6;">
          <p style="margin:0;color:#6B7280;font-size:11.5px;line-height:1.5;">
            Didn't make this transaction? ${SUPPORT_EMAIL ? `Contact us at ${esc(SUPPORT_EMAIL)}` : "Contact support"} right away.
            This is an automated receipt from ${esc(APP_NAME)}.
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  const text = [
    `${APP_NAME} — ${opts.title}`, "", opts.greeting, opts.intro, "",
    ...opts.rows.filter((r) => r[1] !== undefined && r[1] !== null && String(r[1]).trim() !== "").map(([l, v]) => `${l}: ${v}`),
    ...(opts.footerNote ? ["", opts.footerNote] : []),
  ].join("\n");

  return { html, text };
}

const greet = (name?: string) => `Hi ${String(name || "").trim().split(" ")[0] || "there"},`;

// Token printed in groups of 4 digits when it is a plain number, otherwise as received.
function tokenBlock(token: string) {
  const t = String(token || "").trim();
  const shown = /^\d{12,}$/.test(t) ? t.replace(/(\d{4})(?=\d)/g, "$1 ") : t;
  return `<div style="background:#12213B;border-radius:12px;padding:16px;margin:0 0 18px;text-align:center;">
    <div style="color:#F2A93B;font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;">Your meter token</div>
    <div style="color:#FFFFFF;font-family:Consolas,Menlo,monospace;font-size:22px;font-weight:700;letter-spacing:1px;margin-top:6px;word-break:break-all;">${esc(shown)}</div>
  </div>`;
}

// ---------- the four templates ----------
type Payload = { type: string; to: string; name?: string; data: Record<string, any> };

function build(p: Payload): { subject: string; html: string; text: string } | null {
  const d = p.data || {};
  const g = greet(p.name);

  if (p.type === "otp") {
    const why = d.purpose === "reset" ? "reset your password" : d.purpose === "bill_pin" ? "reset your Bill Payments PIN" : "verify your email";
    const mins = Number(d.minutes) || 5;
    const { html, text } = shell({
      title: "Your verification code",
      greeting: "Hello,",
      intro: `Use this code to ${why}. It expires in ${mins} minutes.`,
      rows: [["Verification code", String(d.code || ""), { strong: true, mono: true }]],
      footerNote: "Never share this code with anyone. ZeeShop will never ask you for it.",
    });
    return { subject: "Your ZeeShop verification code", html, text };
  }

  if (p.type === "wallet_funding") {
    const byAdmin = !!d.credited_by_admin;
    const fee = Number(d.fee || 0);
    const { html, text } = shell({
      title: byAdmin ? "Wallet credited by Admin" : "Wallet funded",
      greeting: g,
      intro: byAdmin
        ? `Your ${APP_NAME} wallet was credited by an administrator.`
        : `Your ${APP_NAME} wallet has been funded successfully.`,
      rows: [
        ["Amount credited", naira(d.amount), { strong: true }],
        ["Fee charged", fee > 0 ? naira(fee) : "None"],
        ["Previous balance", naira(d.previous_balance)],
        ["New balance", naira(d.new_balance), { strong: true }],
        ["Method", d.method || (byAdmin ? "Admin credit" : "")],
        ["Reference", d.reference, { mono: true }],
        ["Date", when(d.date)],
      ],
    });
    return { subject: `${byAdmin ? "Wallet credited by Admin" : "Wallet funded"}: ${naira(d.amount)}`, html, text };
  }

  if (p.type === "vtu_purchase") {
    const { html, text } = shell({
      title: `${d.service || "Purchase"} successful`,
      greeting: g,
      intro: `Your ${String(d.service || "purchase").toLowerCase()} purchase was successful.`,
      rows: [
        ["Phone number", d.phone, { strong: true }],
        ["Network", d.network],
        ["Plan / amount", d.plan],
        ["Amount charged", naira(d.amount), { strong: true }],
        ["Reference", d.reference, { mono: true }],
        ["New balance", naira(d.new_balance)],
        ["Date", when(d.date)],
      ],
    });
    return { subject: `${d.service || "Purchase"} successful: ${d.phone || ""} (${naira(d.amount)})`, html, text };
  }

  if (p.type === "bill_payment") {
    const extra: Row[] = Array.isArray(d.extra) ? d.extra.map((e: any) => [String(e.label), e.value, e.mono ? { mono: true } : undefined] as Row) : [];
    const { html, text } = shell({
      title: `${d.service || "Bill payment"} successful`,
      greeting: g,
      intro: `Your ${String(d.service || "bill").toLowerCase()} payment was successful.`,
      rows: [
        ["Service", d.service],
        ["Provider", d.provider],
        [d.recipient_label || "Account / customer ID", d.recipient, { strong: true }],
        ["Plan", d.plan],
        ...extra,
        ["Amount paid", naira(d.amount), { strong: true }],
        ["Reference", d.reference, { mono: true }],
        ["New balance", naira(d.new_balance)],
        ["Date", when(d.date)],
      ],
    });
    return { subject: `${d.service || "Bill payment"} successful: ${naira(d.amount)}`, html, text };
  }

  if (p.type === "electricity_token") {
    const pending = !d.token;
    const { html, text } = shell({
      title: "Electricity payment",
      greeting: g,
      intro: pending
        ? "Your electricity payment was received. The token is not available yet — check Transaction History in the app shortly."
        : "Your electricity payment was successful. Your token is below.",
      highlight: pending ? "" : tokenBlock(d.token),
      rows: [
        ["Token", d.token, { mono: true, strong: true }],
        ["Units (kWh)", d.units],
        ["Meter number", d.meter_number, { strong: true }],
        ["Meter type", d.meter_type],
        ["Provider", d.provider],
        ["Customer name", d.customer_name],
        ["Amount paid", naira(d.amount), { strong: true }],
        ["Reference", d.reference, { mono: true }],
        ["New balance", naira(d.new_balance)],
        ["Date", when(d.date)],
      ],
      footerNote: "Keep this token private. Anyone who has it can load the units onto the meter.",
    });
    return { subject: `Electricity token: ${d.meter_number || ""} (${naira(d.amount)})`, html, text };
  }

  return null;
}

// DisCo customer-care numbers shown on the electricity receipt. Add the ones you know; anything not listed shows "—".
// (Matched against the provider name your app sends, ignoring upper/lower case.)
const DISCO_HOTLINES: [RegExp, string][] = [
  [/eedc|enugu/i, "84700100"],
  // [/ikeja|ikedc/i, "<number>"],
  // [/eko|ekedc/i, "<number>"],
];
const hotlineFor = (provider: unknown) => {
  const p = String(provider ?? "");
  const hit = DISCO_HOTLINES.find(([re]) => re.test(p));
  return hit ? hit[1] : "";
};

// ---------- Termii template route ----------
// Maps one of our email types onto a Termii template and that template's placeholders. Every placeholder always
// gets a value (Termii cannot hide a row), so anything missing becomes "—". Returns null when the type has no
// template configured; the built-in HTML layout is used instead.
const dash = (v: unknown) => { const t = String(v ?? "").trim(); return t || "—"; };

// 4861 8975 8310 0744 4456 → 4861-8975-8310-0744-4456 when it is a plain number
const dashToken = (token: unknown) => {
  const t = String(token ?? "").trim();
  return /^\d{12,}$/.test(t) ? t.replace(/(\d{4})(?=\d)/g, "$1-") : t;
};

function receiptVars(p: Payload): { subject: string; templateId: string; variables: Record<string, string> } | null {
  const d = p.data || {};
  const name = String(p.name || d.customer_name || "").trim().split(" ")[0] || "Customer";
  const common = {
    customer_name: name,
    transaction_date: when(d.date),
    status: "SUCCESSFUL",
    support_email: SUPPORT_EMAIL || "help@ememart.com",
    transaction_id: dash(d.reference),
    payment_method: "ZeeShop Bill Wallet",
    amount: naira(d.amount),
  };

  if (!RECEIPT_TEMPLATE_ID && !ELECTRICITY_TEMPLATE_ID && !PIN_TEMPLATE_ID) return null;

  if (p.type === "electricity_token") {
    if (!ELECTRICITY_TEMPLATE_ID || !d.token) return null;   // no token yet → built-in "token not available yet" layout
    return {
      subject: `Electricity token: ${d.meter_number || ""} (${naira(d.amount)})`,
      templateId: ELECTRICITY_TEMPLATE_ID,
      variables: { ...common, service_type: "Electricity", token: dashToken(d.token), disco_name: dash(d.provider),
        meter_number: dash(d.meter_number), meter_type: dash(d.meter_type), units: dash(d.units),
        customer_name: dash(d.customer_name || name),
        order_amount: naira(d.amount), payment_amount: naira(d.amount),
        transaction_id: dash(d.tx_id || d.reference), reference: dash(d.reference),
        transaction_time: when(d.created_at || d.date),
        customer_phone: dash(d.customer_phone), customer_address: dash(d.customer_address),
        disco_hotline: dash(hotlineFor(d.provider)) },
    };
  }

  if (p.type === "bill_payment") {
    const pinRow = Array.isArray(d.extra) ? d.extra.find((e: any) => /^PIN/i.test(String(e?.label || ""))) : null;
    if (pinRow && PIN_TEMPLATE_ID) {
      return {
        subject: `${d.service || "PIN purchase"} successful: ${naira(d.amount)}`,
        templateId: PIN_TEMPLATE_ID,
        variables: { ...common, service_type: dash(d.service), recipient_phone: dash(d.recipient), pins: String(pinRow.value) },
      };
    }
    if (!RECEIPT_TEMPLATE_ID) return null;
    return {
      subject: `${d.service || "Bill payment"} successful: ${naira(d.amount)}`,
      templateId: RECEIPT_TEMPLATE_ID,
      variables: { ...common, service_type: dash(d.service), recipient_label: dash(d.recipient_label || "Account / customer ID"),
        recipient_phone: dash(d.recipient), plan_details: dash([d.provider, d.plan].filter(Boolean).join(" · ")) },
    };
  }

  if (!RECEIPT_TEMPLATE_ID) return null;

  if (p.type === "wallet_funding") {
    const byAdmin = !!d.credited_by_admin;
    return {
      subject: `${byAdmin ? "Wallet credited by Admin" : "Wallet funded"}: ${naira(d.amount)}`,
      templateId: RECEIPT_TEMPLATE_ID,
      variables: { ...common, payment_method: String(d.method || (byAdmin ? "Admin credit" : "Bank transfer")),
        service_type: byAdmin ? "Wallet credited by Admin" : "Wallet funding", recipient_label: "Credited to",
        recipient_phone: "ZeeShop Bill Wallet", plan_details: Number(d.fee) > 0 ? `Fee charged ${naira(d.fee)}` : "No fee" },
    };
  }
  if (p.type === "otp") {
    if (!OTP_TEMPLATE_ID || !d.code) return null;
    return {
      subject: "Your ZeeShop verification code",
      templateId: OTP_TEMPLATE_ID,
      variables: { [OTP_VAR]: String(d.code), ...(OTP_EXPIRY_VAR ? { [OTP_EXPIRY_VAR]: String(Number(d.minutes) || 5) } : {}) },
    };
  }
  if (p.type === "vtu_purchase") {
    return {
      subject: `${d.service || "Purchase"} successful: ${d.phone || ""} (${naira(d.amount)})`,
      templateId: RECEIPT_TEMPLATE_ID,
      variables: { ...common, service_type: dash(d.service), recipient_label: "Phone Number",
        recipient_phone: dash(d.phone), plan_details: dash([d.network, d.plan].filter(Boolean).join(" · ")) },
    };
  }
  return null;
}

async function sendTermiiTemplate(to: string, subject: string, templateId: string, variables: Record<string, string>) {
  const res = await fetch(`${TERMII_BASE_URL}/api/templates/send-email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: TERMII_API_KEY, email: to, subject, email_configuration_id: TERMII_EMAIL_CONFIG_ID,
      template_id: templateId, variables,
    }),
  });
  const data = await res.json().catch(() => null);
  const ok = res.ok && (data?.code === "ok" || /success/i.test(String(data?.message || "")));
  if (!ok) throw new Error(`Termii ${res.status}: ${JSON.stringify(data)?.slice(0, 250)}`);   // never includes the api key
}

// ---------- sending ----------
async function sendSmtp(to: string, subject: string, html: string, text: string) {
  const client = new SMTPClient({
    connection: { hostname: SMTP_HOST, port: SMTP_PORT, tls: SMTP_PORT === 465, auth: { username: SMTP_USER, password: SMTP_PASS } },
  });
  try {
    await client.send({ from: EMAIL_FROM, to, subject, content: text, html });
  } finally {
    try { await client.close(); } catch (_e) { /* ignore */ }
  }
}

async function sendResend(to: string, subject: string, html: string, text: string) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: EMAIL_FROM, to: [to], subject, html, text }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

const reply = (body: Record<string, unknown>, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return reply({ error: "POST only" }, 405);

  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  const bearer = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!serviceKey || !safeEqual(bearer, serviceKey)) return reply({ error: "Not allowed." }, 401);

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey);
  let payload: Payload;
  try { payload = await req.json(); } catch (_e) { return reply({ error: "Bad JSON" }, 400); }

  const to = String(payload?.to || "").trim();
  const log = async (status: string, provider: string, subject: string | null, error?: string) => {
    const { error: e } = await admin.from("email_notifications_log").insert({
      type: String(payload?.type || "unknown"), to_email: to || null, subject, status, provider, error: error ? error.slice(0, 500) : null,
    });
    if (e) console.warn("email log insert failed:", e.message);
  };

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) { await log("skipped", "none", null, "no valid recipient email"); return reply({ ok: false, skipped: "no recipient" }); }

  const built = build(payload);
  if (!built) { await log("skipped", "none", null, "unknown type"); return reply({ ok: false, skipped: "unknown type" }); }

  const errors: string[] = [];

  // 1) The approved Termii receipt template (the branded layout), when configured.
  const tpl = TERMII_API_KEY ? receiptVars(payload) : null;
  if (tpl) {
    try { await sendTermiiTemplate(to, tpl.subject, tpl.templateId, tpl.variables); await log("sent", "termii-template", tpl.subject); return reply({ ok: true, provider: "termii-template" }); }
    catch (e) { errors.push("termii-template: " + (e instanceof Error ? e.message : String(e))); console.error("notify-email Termii template failed:", errors[0]); }
  }

  if (!EMAIL_FROM) {
    await log(errors.length ? "failed" : "skipped", "none", built.subject, errors.join(" | ") || "EMAIL_FROM is not set");
    return reply({ ok: false, skipped: errors.length ? undefined : "EMAIL_FROM not set", error: errors.join(" | ") || undefined });
  }

  if (SMTP_HOST && SMTP_USER && SMTP_PASS) {
    try { await sendSmtp(to, built.subject, built.html, built.text); await log("sent", "smtp", built.subject); return reply({ ok: true, provider: "smtp" }); }
    catch (e) { errors.push("smtp: " + (e instanceof Error ? e.message : String(e))); console.error("notify-email SMTP failed:", errors[0]); }
  }
  if (RESEND_API_KEY) {
    try { await sendResend(to, built.subject, built.html, built.text); await log("sent", "resend", built.subject, errors.join(" | ") || undefined); return reply({ ok: true, provider: "resend" }); }
    catch (e) { errors.push("resend: " + (e instanceof Error ? e.message : String(e))); console.error("notify-email Resend failed:", errors[errors.length - 1]); }
  }
  await log(errors.length ? "failed" : "skipped", "none", built.subject, errors.join(" | ") || "no email provider configured");
  return reply({ ok: false, error: errors.join(" | ") || "no email provider configured" });
});
