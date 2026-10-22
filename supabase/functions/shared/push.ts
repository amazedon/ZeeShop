// supabase/functions/_shared/push.ts
//
// Shared helper — sends a Web Push notification to one subscription using VAPID.
// Used by daily-alerts and send-broadcast.
//
// FIX: the old version used Deno.env.get("VAPID_PUBLIC_KEY")! — the "!" only silences TypeScript, so a missing or
// misnamed secret reached web-push as `undefined` and threw "No key set vapidDetails.publicKey". Now the secrets are
// checked explicitly, and callers get a clean { ok:false, error } they can return as JSON.
//
// Secrets (set once):
//   supabase secrets set VAPID_PUBLIC_KEY=... VAPID_PRIVATE_KEY=... VAPID_SUBJECT=mailto:help@ememart.com

import webpush from "npm:web-push@3.6.7";

export type VapidCheck = { ok: true; publicKey: string } | { ok: false; error: string; missing: string[] };

export function checkVapid(): VapidCheck {
  const publicKey = (Deno.env.get("VAPID_PUBLIC_KEY") || "").trim();
  const privateKey = (Deno.env.get("VAPID_PRIVATE_KEY") || "").trim();
  const subject = (Deno.env.get("VAPID_SUBJECT") || "mailto:help@ememart.com").trim();
  const missing: string[] = [];
  if (!publicKey) missing.push("VAPID_PUBLIC_KEY");
  if (!privateKey) missing.push("VAPID_PRIVATE_KEY");
  if (!/^(mailto:|https:\/\/)/i.test(subject)) missing.push("VAPID_SUBJECT (must start with mailto: or https://)");
  if (missing.length) {
    return {
      ok: false,
      missing,
      error: `Push is not configured on the server. Missing/invalid secret(s): ${missing.join(", ")}. ` +
        `Run: supabase secrets set VAPID_PUBLIC_KEY=... VAPID_PRIVATE_KEY=... VAPID_SUBJECT=mailto:help@ememart.com`,
    };
  }
  return { ok: true, publicKey };
}

export function getVapidPublicKey(): string {
  return (Deno.env.get("VAPID_PUBLIC_KEY") || "").trim();
}

let configured = false;
function ensureConfigured(): string | null {
  if (configured) return null;
  const check = checkVapid();
  if (!check.ok) return check.error;
  try {
    webpush.setVapidDetails(
      (Deno.env.get("VAPID_SUBJECT") || "mailto:help@ememart.com").trim(),
      (Deno.env.get("VAPID_PUBLIC_KEY") || "").trim(),
      (Deno.env.get("VAPID_PRIVATE_KEY") || "").trim(),
    );
  } catch (e) {
    return "VAPID keys are invalid (regenerate with: npx web-push generate-vapid-keys): " + ((e as Error).message || e);
  }
  configured = true;
  return null;
}

export async function sendPushToSubscription(
  sub: { endpoint: string; p256dh: string; auth_key: string },
  payload: { title: string; body: string; url?: string; tag?: string },
): Promise<{ success: boolean; shouldDeactivate: boolean; error?: string }> {
  const cfgError = ensureConfigured();
  if (cfgError) return { success: false, shouldDeactivate: false, error: cfgError };
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth_key } },
      JSON.stringify(payload),
      { TTL: 60 * 60 * 24, urgency: "high" },
    );
    return { success: true, shouldDeactivate: false };
  } catch (e) {
    const err = e as { statusCode?: number; message?: string };
    // 404/410 = the subscription is gone for good (browser data cleared, app uninstalled, permission revoked).
    const shouldDeactivate = err.statusCode === 404 || err.statusCode === 410;
    return { success: false, shouldDeactivate, error: err.message || "Unknown push error" };
  }
}
