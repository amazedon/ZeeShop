// supabase/functions/_shared/push.ts
//
// Shared helper — actually sends a Web Push notification to one
// subscription, using the VAPID keys. Used by daily-alerts and
// send-broadcast so the encryption/sending logic lives in one place.

import webpush from "npm:web-push@3.6.7";

let configured = false;
function ensureConfigured() {
  if (configured) return;
  webpush.setVapidDetails(
    "mailto:help@ememart.com",
    Deno.env.get("VAPID_PUBLIC_KEY")!,
    Deno.env.get("VAPID_PRIVATE_KEY")!
  );
  configured = true;
}

export async function sendPushToSubscription(
  sub: { endpoint: string; p256dh: string; auth_key: string },
  payload: { title: string; body: string; url?: string }
): Promise<{ success: boolean; shouldDeactivate: boolean; error?: string }> {
  ensureConfigured();
  try {
    await webpush.sendNotification(
      {
        endpoint: sub.endpoint,
        keys: { p256dh: sub.p256dh, auth: sub.auth_key },
      },
      JSON.stringify(payload)
    );
    return { success: true, shouldDeactivate: false };
  } catch (e) {
    const err = e as { statusCode?: number; message?: string };
    // 404/410 means the subscription is dead (browser data cleared,
    // uninstalled, etc.) — safe to deactivate so we stop wasting sends on it.
    const shouldDeactivate = err.statusCode === 404 || err.statusCode === 410;
    return { success: false, shouldDeactivate, error: err.message || "Unknown push error" };
  }
}
