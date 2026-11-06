// supabase/functions/verify-receipt/index.ts
// PUBLIC (no login). Deploy with:  supabase functions deploy verify-receipt --no-verify-jwt
// Anyone who scans a receipt's QR gets ONLY: the shop's public details (name, type, logo, address, phone, email - owner can hide the contact ones), receipt number, date, amount, paid so far, balance owed, status, times checked.
// Never the buyer's name/phone, the items, or the staff name.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const body = await req.json().catch(() => ({}));
    const id = String(body.id || "").trim();
    // Only the full, unguessable sale ID (as carried by the QR) is accepted — so receipts cannot be browsed or enumerated.
    if (!UUID.test(id)) return json({ found: false });

    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: sale } = await admin.from("sales")
      .select("id, shop_id, subtotal, paid_amount, balance, status, sold_at, date").eq("id", id).maybeSingle();
    if (!sale) return json({ found: false });

    const { data: shop } = await admin.from("shops").select("name, address, phone, email, business_id").eq("id", sale.shop_id).maybeSingle();
    let currency = "NGN", bizType = "", regNo = "", logo: string | null = null, showContact = true;
    if (shop?.business_id) {
      const { data: biz } = await admin.from("businesses").select("currency, business_type, registration_number, logo_data_url").eq("id", shop.business_id).maybeSingle();
      if (biz?.currency) currency = biz.currency;
      bizType = biz?.business_type || ""; regNo = biz?.registration_number || ""; logo = biz?.logo_data_url || null;
      // the owner can switch the contact details off (Settings → "Show my address, phone and email when someone scans a receipt")
      try {
        const { data: pub } = await admin.from("business_extras").select("data, deleted").eq("business_id", shop.business_id).eq("kind", "pub").eq("key", "contact").maybeSingle();
        if (pub && !pub.deleted && pub.data && pub.data.show === false) showContact = false;
      } catch (_e) { /* table missing — default to showing */ }
    }

    const total = Number(sale.subtotal || 0), paid = Number(sale.paid_amount || 0);
    let status = "unpaid";
    if (sale.status === "voided") status = "voided";
    else if (sale.status === "paid" || (total > 0 && paid >= total) || Number(sale.balance || 0) <= 0) status = "paid";
    else if (paid > 0) status = "part";

    // what is still owed (the shop's own recorded balance is the truth; fall back to total minus paid)
    const owed = status === "paid" || status === "voided" ? 0 : Math.max(0, Number(sale.balance || 0) > 0 ? Number(sale.balance) : total - paid);

    // times this receipt has been checked (best-effort: works once receipt-verify.sql has been run)
    let checks = 0;
    try {
      const { data: row } = await admin.from("receipt_checks").select("n").eq("sale_id", id).maybeSingle();
      checks = (row?.n || 0) + 1;
      await admin.from("receipt_checks").upsert({ sale_id: id, n: checks, last_at: new Date().toISOString() });
    } catch (_e) { /* table missing — just skip the counter */ }

    return json({
      found: true,
      shop: shop?.name || "",
      business_type: bizType,
      reg_no: showContact ? regNo : "",
      logo,
      address: showContact ? (shop?.address || "") : "",
      phone: showContact ? (shop?.phone || "") : "",
      email: showContact ? (shop?.email || "") : "",
      receipt_no: String(sale.id).slice(-6).toUpperCase(),
      date: sale.sold_at || sale.date,
      amount: total,
      paid: status === "voided" ? 0 : Math.min(paid, total || paid),
      balance: owed,
      currency,
      status,
      checks,
    });
  } catch (_e) {
    return json({ error: "Could not check this receipt right now." }, 500);
  }
});
