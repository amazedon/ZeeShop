/* ============================================================
   ZED — OFFLINE SYNC ENGINE (Phase 0 foundation)
   ============================================================
   How it works:
   1. Every local change (create/update/delete) is recorded with
      enqueueSync(table, op, payload) — this is called RIGHT AFTER
      the existing local state.push()/save() calls, so nothing about
      the app's current instant, offline-first feel changes.
   2. Queued changes are stored in localStorage under SYNC_QUEUE_KEY,
      so they survive app restarts even if sync never happened.
   3. Whenever the app detects it's online (on load, on the browser's
      'online' event, and on a periodic timer as a safety net —
      mobile browsers don't always fire 'online' reliably), it
      flushes the queue: sends each pending change to Supabase in
      order, one at a time, removing it from the queue on success.
   4. If a push fails (still offline, or a real error), that item
      and everything after it stays queued for the next attempt —
      changes are never applied out of order.
   This file only handles PUSHING local changes up. Pulling down
   changes made on other devices is a separate piece (added when a
   business actually manages more than one device) — for a single
   owner/single device business, the queue above keeps the local
   copy and the Supabase copy consistent by itself.
   ============================================================ */

const SYNC_QUEUE_KEY = 'zed_sync_queue_v1';
const SYNC_SUPABASE_URL = 'https://beypnkzrgqrkjttsxlju.supabase.co';

function loadSyncQueue(){
  try{
    return JSON.parse(localStorage.getItem(SYNC_QUEUE_KEY) || '[]');
  }catch(e){ return []; }
}

function saveSyncQueue(queue){
  localStorage.setItem(SYNC_QUEUE_KEY, JSON.stringify(queue));
}

/**
 * Call this right after any local state change that should eventually
 * reach Supabase. Safe to call while offline — it just queues.
 *   table:   the Supabase table name, e.g. 'businesses', 'shops', 'app_users'
 *   op:      'insert' | 'update' | 'delete'
 *   payload: the full row (insert/update) or { id } (delete)
 */
function enqueueSync(table, op, payload){
  const queue = loadSyncQueue();
  queue.push({
    id: (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random()),
    table, op, payload,
    createdAt: new Date().toISOString(),
    attempts: 0
  });
  saveSyncQueue(queue);
  // try immediately in case we're online — harmless no-op if not
  flushSyncQueue();
  // also register a Background Sync request, so the queue can flush
  // even if the app gets closed before the immediate attempt above
  // succeeds (Chrome/Android only — silently does nothing elsewhere)
  registerBackgroundSync();
}

async function registerBackgroundSync(){
  try{
    if('serviceWorker' in navigator && 'SyncManager' in window){
      const reg = await navigator.serviceWorker.ready;
      await reg.sync.register('zed-flush-sync-queue');
    }
  }catch(e){ /* not supported on this browser — the normal online/load triggers still cover it */ }
}

// The service worker asks us to flush whenever a real Background Sync
// event fires (see sw.js) — this only works while a page is at least
// loaded in the background/recently, same limitation Background Sync
// itself has on most browsers.
if('serviceWorker' in navigator){
  navigator.serviceWorker.addEventListener('message', (event)=>{
    if(event.data && event.data.type === 'ZED_FLUSH_SYNC_QUEUE'){
      flushSyncQueue();
    }
  });
}

let syncInProgress = false;

// Lightweight, inspectable status so a UI (or just the console, for now)
// can tell WHY nothing is syncing instead of it failing completely silently.
// This was the root cause of staff data never reaching other devices: the
// queue blocked forever with no signal anywhere that it was blocked.
window.__zedSyncStatus = { lastAttempt: null, lastError: null, pendingCount: 0 };
function noteSyncStatus(error){
  window.__zedSyncStatus.lastAttempt = new Date().toISOString();
  window.__zedSyncStatus.lastError = error || null;
  window.__zedSyncStatus.pendingCount = loadSyncQueue().length;
  if(error) console.warn('[zed-sync]', error);
}

const DEAD_LETTER_KEY = 'zed_sync_dead_letter_v1';
function moveToDeadLetter(item, reason){
  try{
    const dead = JSON.parse(localStorage.getItem(DEAD_LETTER_KEY) || '[]');
    dead.push({ ...item, failedAt: new Date().toISOString(), reason });
    // Cap it — this is a diagnostic log, not a growing liability.
    localStorage.setItem(DEAD_LETTER_KEY, JSON.stringify(dead.slice(-100)));
  }catch(e){ /* best-effort */ }
}

async function flushSyncQueue(){
  if(syncInProgress) return;         // avoid overlapping flushes
  if(!navigator.onLine) return;      // quick check before trying network
  const session = await getCachedAuthSession();
  if(!session){
    noteSyncStatus('No Supabase session on this device — sign in again to resume syncing.');
    return;
  }

  syncInProgress = true;
  try{
    let queue = loadSyncQueue();
    while(queue.length > 0){
      const item = queue[0];
      const result = await pushSyncItem(item, session.access_token);
      if(result === 'ok'){
        queue.shift();
        saveSyncQueue(queue);
        continue;
      }
      if(result === 'permanent'){
        // Bad data that will never succeed (e.g. schema mismatch) — dropping it
        // is safer than letting it jam every future item behind it forever.
        moveToDeadLetter(item, 'rejected by server — see console for the table/op');
        queue.shift();
        saveSyncQueue(queue);
        noteSyncStatus(`Dropped a ${item.table} ${item.op} that the server permanently rejected.`);
        continue;
      }
      // 'retry' — auth expired, offline mid-flush, or a transient server error.
      item.attempts = (item.attempts || 0) + 1;
      saveSyncQueue(queue);
      noteSyncStatus(`Push paused on a ${item.table} ${item.op} — will retry.`);
      break; // stop here — keep order, retry this item (and the rest) next time
    }
    if(queue.length === 0) noteSyncStatus(null);
  } finally {
    syncInProgress = false;
  }
}

async function pushSyncItem(item, accessToken){
  const headers = {
    'apikey': SITE_CONTENT_ANON_KEY,
    'Authorization': 'Bearer ' + accessToken,
    'Content-Type': 'application/json'
  };
  try{
    let res;
    if(item.op === 'insert'){
      res = await fetch(`${SYNC_SUPABASE_URL}/rest/v1/${item.table}`, {
        method: 'POST',
        headers: { ...headers, 'Prefer': 'return=minimal,resolution=merge-duplicates' },
        body: JSON.stringify(item.payload)
      });
    } else if(item.op === 'update'){
      res = await fetch(`${SYNC_SUPABASE_URL}/rest/v1/${item.table}?id=eq.${item.payload.id}`, {
        method: 'PATCH',
        headers: { ...headers, 'Prefer': 'return=minimal' },
        body: JSON.stringify(item.payload)
      });
    } else if(item.op === 'delete'){
      res = await fetch(`${SYNC_SUPABASE_URL}/rest/v1/${item.table}?id=eq.${item.payload.id}`, {
        method: 'DELETE',
        headers
      });
    } else {
      return 'permanent'; // unknown op — drop it rather than block the queue forever
    }
    if(res.ok) return 'ok';
    // 401/403 — the session just expired mid-flush; retry once a fresh token
    // is available rather than discarding real data.
    if(res.status === 401 || res.status === 403) return 'retry';
    // Other 4xx (bad/malformed data, constraint violation, etc.) will never
    // succeed no matter how many times we retry — drop it so it doesn't
    // block every other queued change behind it.
    if(res.status >= 400 && res.status < 500) return 'permanent';
    return 'retry'; // 5xx / unexpected — transient, worth retrying
  }catch(e){
    return 'retry'; // network error — definitely offline, try again later
  }
}

/**
 * Returns the current cached Supabase Auth session (from supabase-js's own
 * localStorage-persisted session), or null if the owner isn't logged in.
 * This does NOT require network — supabase-js caches the session locally
 * after the first successful login, which is what makes offline PIN-login
 * for staff possible afterward.
 */
async function getCachedAuthSession(){
  if(!window.sb) return null;
  const { data } = await window.sb.auth.getSession();
  return data.session || null;
}

// Try to flush whenever the browser regains connectivity.
window.addEventListener('online', flushSyncQueue);
// Safety-net poll — mobile browsers don't always fire 'online' reliably.
setInterval(flushSyncQueue, 30000);
// Try once on load too, in case there's a backlog from being offline earlier.
window.addEventListener('load', flushSyncQueue);

/* ============================================================
   PULL-SYNC — bring in records created on OTHER devices
   ============================================================
   Scope, by design: this brings in anything new that doesn't already
   exist locally (matched by id). It never overwrites a record that's
   already here — so there's zero risk of one device's local edits
   getting clobbered by a stale copy from another device. Real
   two-way conflict resolution (both devices editing the SAME record
   at the same time) is a much deeper problem and isn't attempted here.

   Known limitation: pulled-in staff (app_users) can log in with their
   real password/PIN on this device too, since those hashes ARE synced
   — but the very first owner login on a brand-new device still needs
   the owner to sign in with their email/password once, online, before
   any of this can run (same as any first-time login anywhere).
   ============================================================ */

let pullInProgress = false;

async function pullSync(){
  if(pullInProgress) return;
  if(!navigator.onLine) return;
  if(typeof state === 'undefined' || !state) return; // app state not ready yet
  const session = await getCachedAuthSession();
  if(!session) return;

  pullInProgress = true;
  try{
    const headers = { 'apikey': SITE_CONTENT_ANON_KEY, 'Authorization': 'Bearer ' + session.access_token };
    let changed = false;
    const bizId = state.business && state.business.id;

    // Scope every query to this business explicitly rather than depending
    // solely on RLS — belt-and-braces so a policy gap can't leak another
    // business's rows onto this device. Tables without a business_id column
    // (batches/variants/sale items) are joined onto already-scoped parents
    // below, so they don't need their own filter.
    async function fetchTable(table, scoped){
      try{
        const filter = (scoped && bizId) ? `&business_id=eq.${bizId}` : '';
        const res = await fetch(`${SYNC_SUPABASE_URL}/rest/v1/${table}?select=*${filter}`, { headers });
        if(!res.ok) return [];
        return await res.json();
      }catch(e){ return []; }
    }

    function mergeFlat(rows, arr, mapFn){
      rows.forEach(row=>{
        if(!arr.some(x=>x.id===row.id)){
          arr.push(mapFn(row));
          changed = true;
        }
      });
    }

    const [
      shops, users, groups, customers, goods, batches, variants,
      suppliers, purchases, expenses, salaries, emp, ros, notes,
      rooms, bookings, comms, sales, saleItems
    ] = await Promise.all([
      fetchTable('shops', true), fetchTable('app_users', true), fetchTable('customer_groups', true), fetchTable('customers', true),
      fetchTable('goods', false), fetchTable('good_batches', false), fetchTable('good_variants', false),
      fetchTable('suppliers', true), fetchTable('supplier_purchases', true), fetchTable('expenses', true), fetchTable('salary_payments', true),
      fetchTable('employment_records', true), fetchTable('record_only_staff', true), fetchTable('shop_notes', true),
      fetchTable('rooms', true), fetchTable('lodging_bookings', true), fetchTable('communication_log', true),
      fetchTable('sales', false), fetchTable('sale_items', false)
    ]);

    mergeFlat(shops, state.shops, r=>({
      id:r.id, businessId:r.business_id, name:r.name, address:r.address||'', phone:r.phone||'', email:r.email||''
    }));

    mergeFlat(users, state.users, r=>({
      id:r.id, businessId:r.business_id, username:r.username, email:r.email, phone:r.phone||'',
      firstName:r.first_name, lastName:r.last_name||'', role:r.role, isActive:r.is_active, canAddGoods:r.can_add_goods,
      passwordHash:r.password_hash||null, pinHash:r.pin_hash||null, pinLength:r.pin_length||null
    }));

    mergeFlat(groups, state.customerGroups, r=>({ id:r.id, businessId:r.business_id, name:r.name }));

    mergeFlat(customers, state.customers, r=>({
      id:r.id, businessId:r.business_id, groupId:r.group_id, fullName:r.full_name, country:r.country,
      phoneE164:r.phone_e164||'', whatsappNumber:r.whatsapp_number||'', email:r.email||'', address:r.address||'',
      notes:r.notes||'', consentGiven:r.consent_given, createdByUserId:r.created_by_user_id
    }));

    goods.forEach(r=>{
      if(!state.goods.some(x=>x.id===r.id)){
        const g = {
          id:r.id, shopId:r.shop_id, name:r.name, basePrice:r.base_price, costPrice:r.cost_price,
          emoji:'🛍️', groupPrices:[], barcode:r.barcode||null, reorderLevel:r.reorder_level, hasVariants:r.has_variants,
          batches: batches.filter(b=>b.good_id===r.id).map(b=>({
            id:b.id, qtyRemaining:b.qty_remaining, expiryDate:b.expiry_date, costPrice:b.cost_price,
            batchNo:b.batch_no, auctionActive:b.auction_active, auctionPrice:b.auction_price, auctionDiscount:b.auction_discount
          })),
          variants: variants.filter(v=>v.good_id===r.id).map(v=>({
            id:v.id, size:v.size, color:v.color, label:v.label, qty:v.qty
          }))
        };
        if(r.spec){ g.spec = r.spec; g.specLabel = r.spec_label; }
        if(r.dimension_value){ g.dimension = { value:r.dimension_value, unit:r.dimension_unit }; }
        state.goods.push(g);
        changed = true;
      }
    });

    mergeFlat(suppliers, state.suppliers, r=>({
      id:r.id, businessId:r.business_id, name:r.name, country:r.country, phone:r.phone||'',
      suppliesWhat:r.supplies_what||'', notes:r.notes||'', createdByUserId:r.created_by_user_id
    }));

    mergeFlat(purchases, state.supplierPurchases, r=>({
      id:r.id, businessId:r.business_id, supplierId:r.supplier_id, shopId:r.shop_id, goodId:r.good_id,
      itemName:r.item_name, qty:r.qty, costPrice:r.cost_price, totalAmount:r.total_amount,
      paidAmount:r.paid_amount, balance:r.balance, date:r.date, createdByUserId:r.created_by_user_id, createdAt:r.created_at
    }));

    mergeFlat(expenses, state.expenses, r=>({
      id:r.id, businessId:r.business_id, shopId:r.shop_id, category:r.category, description:r.description||'',
      amount:r.amount, date:r.date, createdByUserId:r.created_by_user_id
    }));

    mergeFlat(salaries, state.salaryPayments, r=>({
      id:r.id, userId:r.user_id, businessId:r.business_id, shopId:r.shop_id, amount:r.amount, date:r.date,
      note:r.note||'', recordedByUserId:r.recorded_by_user_id, createdAt:r.created_at, linkedExpenseId:r.linked_expense_id
    }));

    mergeFlat(emp, state.employmentRecords, r=>({
      id:r.id, userId:r.user_id, businessId:r.business_id, employmentType:r.employment_type,
      resumptionDate:r.resumption_date, salaryAmount:r.salary_amount, salaryFrequency:r.salary_frequency,
      settlementDate:r.settlement_date, settlementTerms:r.settlement_terms||'', notes:r.notes||'',
      original:{}, history:[]
    }));

    mergeFlat(ros, state.recordOnlyStaff, r=>({
      id:r.id, businessId:r.business_id, firstName:r.first_name, lastName:r.last_name||'', phone:r.phone||'',
      email:r.email||'', notes:r.notes||'', isActive:r.is_active, createdByUserId:r.created_by_user_id
    }));

    mergeFlat(notes, state.shopNotes, r=>({
      id:r.id, businessId:r.business_id, shopId:r.shop_id, authorUserId:r.author_user_id,
      title:r.title, text:r.text||'', createdAt:r.created_at, updatedAt:r.updated_at
    }));

    mergeFlat(rooms, state.rooms, r=>({
      id:r.id, businessId:r.business_id, shopId:r.shop_id, name:r.name, roomType:r.room_type||'',
      ratePerNight:r.rate_per_night, createdAt:r.created_at
    }));

    mergeFlat(bookings, state.lodgingBookings, r=>({
      id:r.id, businessId:r.business_id, shopId:r.shop_id, roomId:r.room_id, guestName:r.guest_name,
      guestPhone:r.guest_phone||'', checkIn:r.check_in, checkOut:r.check_out, nights:r.nights,
      ratePerNight:r.rate_per_night, totalAmount:r.total_amount, paidAmount:r.paid_amount, balance:r.balance,
      idType:r.id_type, idNumber:r.id_number, address:r.address, comingFrom:r.coming_from,
      kinName:r.kin_name, kinPhone:r.kin_phone, plateNumber:r.plate_number, numGuests:r.num_guests,
      purpose:r.purpose, status:r.status, createdByUserId:r.created_by_user_id, createdAt:r.created_at,
      checkedOutAt:r.checked_out_at
    }));

    mergeFlat(comms, state.communicationLog, r=>({
      id:r.id, businessId:r.business_id, customerId:r.customer_id, userId:null, type:r.channel, timestamp:r.sent_at
    }));

    sales.forEach(r=>{
      if(!state.sales.some(x=>x.id===r.id)){
        state.sales.push({
          id:r.id, shopId:r.shop_id, customerId:r.customer_id, walkInName:r.walk_in_name||'',
          walkInPhone:r.walk_in_phone||'', note:r.note||'', itemsSubtotal:r.items_subtotal, discount:r.discount,
          taxAmount:r.tax_amount, taxPct:r.tax_pct, subtotal:r.subtotal, paidAmount:r.paid_amount,
          balance:r.balance, dueDate:r.due_date, status:r.status, soldByUserId:r.sold_by_user_id,
          receiptSent:r.receipt_sent, date:r.date,
          items: saleItems.filter(si=>si.sale_id===r.id).map(si=>({
            goodId:si.good_id, batchId:si.batch_id, variantId:si.variant_id, variantLabel:si.variant_label||'',
            qty:si.qty, priceUsed:si.price_used, note:si.note||''
          }))
        });
        changed = true;
      }
    });

    // Business-level fields that only the SERVER should ever be the source of
    // truth for — a completed webhook payment, an auto-renewal charge, or a
    // manual grant from the Super Admin panel can all change these without
    // this device knowing, so (unlike everything else in this function)
    // these specific fields DO get overwritten locally, not just added-if-missing.
    try{
      const bizRes = await fetch(`${SYNC_SUPABASE_URL}/rest/v1/businesses?select=subscription_plan,subscription_expires_at,auto_renew_enabled,auto_renew_plan,auto_renew_interval`, { headers });
      if(bizRes.ok){
        const bizRows = await bizRes.json();
        if(bizRows[0] && state.business){
          const r = bizRows[0];
          state.business.subscriptionPlan = r.subscription_plan;
          state.business.subscriptionExpiresAt = r.subscription_expires_at;
          state.business.autoRenewEnabled = r.auto_renew_enabled;
          state.business.autoRenewPlan = r.auto_renew_plan;
          state.business.autoRenewInterval = r.auto_renew_interval;
          changed = true;
        }
      }
    }catch(e){ /* keep local copy on any failure */ }

    if(changed && typeof save === 'function'){
      save();
      if(typeof render === 'function') render();
    }
  } finally {
    pullInProgress = false;
  }
}

window.addEventListener('online', pullSync);
setInterval(pullSync, 60000); // less frequent than push — pulling is heavier
window.addEventListener('load', pullSync);
