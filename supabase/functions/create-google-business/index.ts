// supabase/functions/create-google-business/index.ts
//
// Fixes a real, apparently longstanding bug: completing signup previously
// did a direct client-side insert into `businesses` (and shops/app_users/
// customer_groups) using the freshly-authenticated user's own session.
// That insert has no path to succeed under RLS for someone with no
// existing app_users row yet — there's no policy that can authorize "let
// a brand new person create their first business," since every other
// write in this app is scoped by an existing business/staff relationship
// that doesn't exist yet at this exact moment. The error surfaces as:
// "new row violates row-level security policy for table businesses" —
// confirmed on the Google signup path, and the plain email+password path
// did the identical insert wrapped in a try/catch that silently swallowed
// the failure ("Local account still works even if Supabase fails"),
// meaning manual signups likely hit this too, just invisibly.
//
// This replaces ALL of those client-side creation paths with one
// server-side function using the service role key, which cannot be
// blocked by RLS the way a client-authenticated insert can.
//
// Used for both:
//   - Full details already collected (the original signup form, BOTH the
//     Google path and the plain email+password path) — pass
//     name/country/currency/phone/username explicitly, and password_hash
//     for the email+password case (omit entirely for Google, which has
//     no password).
//   - Minimal/instant setup (Finish Setup deferred to later) — omit
//     country/currency/phone/username and they default to placeholders,
//     with setup_complete: false so the app's own Finish Setup gate
//     picks up the rest afterward.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: Record<string, unknown>, status: number) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization") || "";
    const token = authHeader.replace(/^Bearer\s+/i, "");
    if (!token) return json({ error: "Not authenticated." }, 401);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const admin = createClient(supabaseUrl, serviceKey);

    const { data: callerData, error: callerErr } = await admin.auth.getUser(token);
    if (callerErr || !callerData?.user) return json({ error: "Not authenticated." }, 401);

    // Refuse if this auth identity (or this email) already has a
    // business — prevents accidentally creating a second, orphaned
    // business for someone who already has one, e.g. a double-click or
    // a retry after a slow response.
    const { data: existingById } = await admin
      .from("app_users").select("id").eq("auth_user_id", callerData.user.id).maybeSingle();
    if (existingById) return json({ error: "This account already has a business." }, 409);

    if (callerData.user.email) {
      const { data: existingByEmail } = await admin
        .from("app_users").select("id").eq("role", "master").ilike("email", callerData.user.email).maybeSingle();
      if (existingByEmail) {
        // Same identity-split scenario fixed elsewhere in this app — heal
        // it here too rather than create a duplicate business.
        await admin.from("app_users").update({ auth_user_id: callerData.user.id }).eq("id", existingByEmail.id);
        return json({ error: "This account already has a business — reconnected instead of creating a new one." }, 409);
      }
    }

    const body = await req.json();
    const firstName = body.first_name || "there";
    const lastName = body.last_name || "";
    const minimal = !body.name; // no business name supplied = instant-setup path
    const bizName = body.name || `${firstName}'s Shop`;
    const country = body.country || null;
    const currency = body.currency || null;
    const phone = body.phone || null;
    const email = callerData.user.email || null;

    const emailPrefix = (email || "user").split("@")[0].replace(/[^a-z0-9_]/gi, "").toLowerCase() || "user";
    let username = body.username || `${emailPrefix}${Math.floor(100 + Math.random() * 900)}`;

    const bizId = crypto.randomUUID();
    const shopId = crypto.randomUUID();
    const userId = crypto.randomUUID();

    const insertAll = async (uname: string) => {
      const { error: bizErr } = await admin.from("businesses").insert({
        id: bizId, name: bizName, business_type: "", registration_number: "", country, currency,
        timezone: body.timezone || "UTC", language: "en", tax_name: "VAT", tax_percent: 0,
        subscription_plan: "free", owner_auth_user_id: callerData.user.id, setup_complete: !minimal,
      });
      if (bizErr) throw bizErr;

      const { error: shopErr } = await admin.from("shops").insert({
        id: shopId, business_id: bizId, name: bizName + " — Main Shop", address: "", phone, email,
      });
      if (shopErr) throw shopErr;

      const { error: userErr } = await admin.from("app_users").insert({
        id: userId, business_id: bizId, username: uname, email, phone, first_name: firstName, last_name: lastName,
        role: "master", is_active: true, can_add_goods: true, can_sell: true, can_sell_credit: true,
        can_record_cash: true, can_void_return: true, can_share: true, password_hash: body.password_hash || null, auth_user_id: callerData.user.id,
      });
      if (userErr) throw userErr;
    };

    try {
      await insertAll(username);
    } catch (e) {
      // Most likely a username collision on the auto-generated default —
      // retry once with a different suffix before surfacing a real error.
      username = `${emailPrefix}${Math.floor(1000 + Math.random() * 9000)}`;
      await insertAll(username);
    }

    const groupIds = { retail: crypto.randomUUID(), wholesale: crypto.randomUUID(), vip: crypto.randomUUID() };
    for (const [name, id] of [["Retail", groupIds.retail], ["Wholesale", groupIds.wholesale], ["VIP", groupIds.vip]] as const) {
      await admin.from("customer_groups").insert({ id, business_id: bizId, name });
    }

    return json({
      ok: true,
      business: { id: bizId, name: bizName, country, currency, setupComplete: !minimal },
      shop: { id: shopId, name: bizName + " — Main Shop", phone, email },
      user: { id: userId, username, firstName, lastName, phone, email },
      customerGroups: [
        { id: groupIds.retail, name: "Retail" },
        { id: groupIds.wholesale, name: "Wholesale" },
        { id: groupIds.vip, name: "VIP" },
      ],
    }, 200);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "Unexpected error" }, 500);
  }
});
