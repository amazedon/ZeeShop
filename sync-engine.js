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

    // The business row itself (plan, expiry, connect code, active status)
    // needs an actual UPDATE every pull, not just "add if missing" like
    // everything below — it's a singleton that already exists locally, so
    // mergeFlat's insert-only logic would never apply an admin-side change
    // (e.g. a plan grant from the super-admin panel) to it. This was why
    // plan changes showed in the admin panel but never reached the owner's
    // own device until they fully logged out and back in.
    if(bizId){
      try{
        const res = await fetch(`${SYNC_SUPABASE_URL}/rest/v1/businesses?id=eq.${bizId}&select=*`, { headers });
        if(res.ok){
          const rows = await res.json();
          if(rows[0]){
            const b = rows[0];
            const fresh = {
              subscriptionPlan: b.subscription_plan || 'free',
              subscriptionExpiresAt: b.subscription_expires_at || null,
              connectCode: b.connect_code || null,
              isActive: b.is_active !== false,
              deletionRequestedAt: b.deletion_requested_at || null,
              name: b.name, country: b.country, currency: b.currency,
              autoRenewEnabled: b.auto_renew_enabled || false,
              autoRenewPlan: b.auto_renew_plan || null,
              autoRenewInterval: b.auto_renew_interval || null,
              // Added along with the fix that made these actually push in
              // the first place — logo, business type, CAC/registration
              // number, and tax settings previously had no pull path at
              // all, on top of no push path, so they never reached any
              // device except the one they were set on.
              businessType: b.business_type || '', registrationNumber: b.registration_number || '',
              taxName: b.tax_name || 'VAT', taxPercent: b.tax_percent || 0,
              logoDataUrl: b.logo_data_url || null
            };
            if(JSON.stringify(fresh) !== JSON.stringify({
              subscriptionPlan: state.business.subscriptionPlan, subscriptionExpiresAt: state.business.subscriptionExpiresAt,
              connectCode: state.business.connectCode, isActive: state.business.isActive,
              deletionRequestedAt: state.business.deletionRequestedAt,
              name: state.business.name, country: state.business.country, currency: state.business.currency,
              autoRenewEnabled: state.business.autoRenewEnabled, autoRenewPlan: state.business.autoRenewPlan,
              autoRenewInterval: state.business.autoRenewInterval,
              businessType: state.business.businessType, registrationNumber: state.business.registrationNumber,
              taxName: state.business.taxName, taxPercent: state.business.taxPercent,
              logoDataUrl: state.business.logoDataUrl
            })){
              Object.assign(state.business, fresh);
              changed = true;
            }
          }
        }
      }catch(e){ /* best-effort — don't let this block the rest of the pull */ }
    }

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

    // Pending-edit guard: if THIS device has a not-yet-pushed local change
    // queued for a given table+id, a pull must not overwrite it with the
    // (now stale, pre-change) server copy — that would silently discard the
    // user's own edit until it got overwritten again by their own eventual
    // push. Once the push succeeds, the next pull correctly picks up the
    // server's now-current copy like anything else.
    const pendingByTable = {};
    loadSyncQueue().forEach(item=>{
      if(!pendingByTable[item.table]) pendingByTable[item.table] = new Set();
      if(item.payload && item.payload.id) pendingByTable[item.table].add(item.payload.id);
    });
    function isPending(table, id){ return !!(pendingByTable[table] && pendingByTable[table].has(id)); }

    // Replaces the old insert-only mergeFlat: a row that already exists
    // locally now gets its fields REFRESHED from the server (unless a local
    // edit for that same id is still queued, per isPending above), not just
    // left alone forever. This is what makes things like "mark a credit sale
    // paid on one device" or "deactivate a staff member" actually show up on
    // every other device, instead of only in whichever device made the change.
    function mergeUpdate(table, rows, arr, mapFn){
      rows.forEach(row=>{
        if(isPending(table, row.id)) return;
        const mapped = mapFn(row);
        const idx = arr.findIndex(x=>x.id===row.id);
        if(idx === -1){
          arr.push(mapped);
          changed = true;
        } else if(JSON.stringify(arr[idx]) !== JSON.stringify(mapped)){
          arr[idx] = mapped;
          changed = true;
        }
      });
    }

    // Fetch shops FIRST and separately — everything shop-scoped below
    // (goods, sales) needs the resulting shop id list to filter by, since
    // neither of those tables has its own business_id column to filter on
    // directly. Previously goods and sales were fetched with NO scoping
    // filter at all ("false" meant "joined onto an already-scoped parent
    // below" for batches/variants/sale_items, which is true — but goods and
    // sales themselves were never actually scoped by anything, client-side,
    // meaning this device relied 100% on RLS alone to keep every OTHER
    // business's product catalog and sales out of its local storage. Same
    // belt-and-braces standard as the rest of this function now applies here.
    const shopsRes = await fetchTable('shops', true);
    mergeUpdate('shops', shopsRes, state.shops, r=>({
      id:r.id, businessId:r.business_id, name:r.name, address:r.address||'', phone:r.phone||'', email:r.email||'',
      receiptFooter:r.receipt_footer||'Thank you for your business!', receiptTerms:r.receipt_terms||'',
      auctionDiscountDefault:r.auction_discount_default!=null?r.auction_discount_default:30,
      isWarehouse:!!r.is_warehouse
    }));
    const myShopIds = state.shops.filter(s=>s.businessId===bizId).map(s=>s.id);
    async function fetchByShop(table){
      if(myShopIds.length===0) return [];
      try{
        const res = await fetch(`${SYNC_SUPABASE_URL}/rest/v1/${table}?select=*&shop_id=in.(${myShopIds.join(',')})`, { headers });
        if(!res.ok) return [];
        return await res.json();
      }catch(e){ return []; }
    }

    const [
      users, groups, customers, goods, batches, variants,
      suppliers, purchases, expenses, salaries, emp, ros, notes,
      rooms, bookings, comms, sales, saleItems, auditRows, empHistory, stockAdj
    ] = await Promise.all([
      fetchTable('app_users', true), fetchTable('customer_groups', true), fetchTable('customers', true),
      fetchByShop('goods'), fetchTable('good_batches', false), fetchTable('good_variants', false),
      fetchTable('suppliers', true), fetchTable('supplier_purchases', true), fetchTable('expenses', true), fetchTable('salary_payments', true),
      fetchTable('employment_records', true), fetchTable('record_only_staff', true), fetchTable('shop_notes', true),
      fetchTable('rooms', true), fetchTable('lodging_bookings', true), fetchTable('communication_log', true),
      fetchByShop('sales'), fetchTable('sale_items', false), fetchTable('audit_log', true), fetchTable('employment_record_history', true),
      fetchByShop('stock_adjustments')
    ]);

    mergeUpdate('app_users', users, state.users, r=>({
      id:r.id, businessId:r.business_id, username:r.username, email:r.email, phone:r.phone||'',
      firstName:r.first_name, lastName:r.last_name||'', role:r.role, isActive:r.is_active, canAddGoods:r.can_add_goods,
      // These five were missing from this mapping entirely — mergeUpdate
      // does a full object replacement on update, not a field-by-field
      // merge, so leaving them out didn't just fail to refresh them: it
      // would have silently WIPED them from the local user record the
      // first time any app_users update pulled in on another device
      // (e.g. right after the deactivate/permissions fixes we just made).
      canSell:r.can_sell, canSellCredit:r.can_sell_credit, canRecordCash:r.can_record_cash,
      canVoidReturn:r.can_void_return, isSuperAdmin:r.is_super_admin||false, managesShopIds:r.manages_shop_ids||[],
      nameChangeRequest:r.name_change_request||null,
      passwordHash:r.password_hash||null, pinHash:r.pin_hash||null, pinLength:r.pin_length||null
    }));

    mergeUpdate('customer_groups', groups, state.customerGroups, r=>({ id:r.id, businessId:r.business_id, name:r.name }));

    mergeUpdate('customers', customers, state.customers, r=>({
      id:r.id, businessId:r.business_id, groupId:r.group_id, fullName:r.full_name, country:r.country,
      phoneE164:r.phone_e164||'', whatsappNumber:r.whatsapp_number||'', email:r.email||'', address:r.address||'',
      notes:r.notes||'', consentGiven:r.consent_given, createdByUserId:r.created_by_user_id
    }));

    goods.forEach(r=>{
      const existing = state.goods.find(x=>x.id===r.id);
      const remoteBatches = batches.filter(b=>b.good_id===r.id).map(b=>({
        id:b.id, qtyRemaining:b.qty_remaining, expiryDate:b.expiry_date, costPrice:b.cost_price,
        batchNo:b.batch_no, auctionActive:b.auction_active, auctionPrice:b.auction_price, auctionDiscount:b.auction_discount
      }));
      const remoteVariants = variants.filter(v=>v.good_id===r.id).map(v=>({
        id:v.id, size:v.size, color:v.color, label:v.label, qty:v.qty
      }));

      if(!existing){
        const g = {
          id:r.id, shopId:r.shop_id, name:r.name, basePrice:r.base_price, costPrice:r.cost_price,
          emoji:'🛍️', groupPrices:[], barcode:r.barcode||null, reorderLevel:r.reorder_level, hasVariants:r.has_variants,
          batches: remoteBatches, variants: remoteVariants
        };
        if(r.spec){ g.spec = r.spec; g.specLabel = r.spec_label; }
        if(r.dimension_value){ g.dimension = { value:r.dimension_value, unit:r.dimension_unit }; }
        state.goods.push(g);
        changed = true;
        return;
      }

      // Good already known locally — refresh its own fields (name, price,
      // reorder level, etc.) unless this device has an unpushed edit queued.
      if(!isPending('goods', r.id)){
        const fresh = { name:r.name, basePrice:r.base_price, costPrice:r.cost_price, barcode:r.barcode||null, reorderLevel:r.reorder_level, hasVariants:r.has_variants };
        Object.assign(existing, fresh);
        changed = true;
      }
      // Batches and variants are pushed as their OWN queue items (see
      // syncSaleInsert's stock deduction and sale-return handling), so each
      // one needs its own pending check — otherwise, say, one still-queued
      // batch decrement would block every OTHER batch on the same good from
      // ever refreshing, or vice versa.
      remoteBatches.forEach(rb=>{
        if(isPending('good_batches', rb.id)) return;
        const idx = existing.batches.findIndex(x=>x.id===rb.id);
        if(idx===-1){ existing.batches.push(rb); changed = true; }
        else if(JSON.stringify(existing.batches[idx]) !== JSON.stringify(rb)){ existing.batches[idx] = rb; changed = true; }
      });
      remoteVariants.forEach(rv=>{
        if(isPending('good_variants', rv.id)) return;
        const idx = existing.variants.findIndex(x=>x.id===rv.id);
        if(idx===-1){ existing.variants.push(rv); changed = true; }
        else if(JSON.stringify(existing.variants[idx]) !== JSON.stringify(rv)){ existing.variants[idx] = rv; changed = true; }
      });
    });

    mergeUpdate('suppliers', suppliers, state.suppliers, r=>({
      id:r.id, businessId:r.business_id, name:r.name, country:r.country, phone:r.phone||'',
      suppliesWhat:r.supplies_what||'', notes:r.notes||'', createdByUserId:r.created_by_user_id
    }));

    mergeUpdate('supplier_purchases', purchases, state.supplierPurchases, r=>({
      id:r.id, businessId:r.business_id, supplierId:r.supplier_id, shopId:r.shop_id, goodId:r.good_id,
      itemName:r.item_name, qty:r.qty, costPrice:r.cost_price, totalAmount:r.total_amount,
      paidAmount:r.paid_amount, balance:r.balance, date:r.date, createdByUserId:r.created_by_user_id, createdAt:r.created_at
    }));

    mergeUpdate('expenses', expenses, state.expenses, r=>({
      id:r.id, businessId:r.business_id, shopId:r.shop_id, category:r.category, description:r.description||'',
      amount:r.amount, date:r.date, createdByUserId:r.created_by_user_id
    }));

    mergeUpdate('salary_payments', salaries, state.salaryPayments, r=>({
      id:r.id, userId:r.user_id, businessId:r.business_id, shopId:r.shop_id, amount:r.amount, date:r.date,
      note:r.note||'', recordedByUserId:r.recorded_by_user_id, createdAt:r.created_at, linkedExpenseId:r.linked_expense_id
    }));

    mergeUpdate('employment_records', emp, state.employmentRecords, r=>{
      const existingRec = state.employmentRecords.find(x=>x.id===r.id);
      return {
        id:r.id, userId:r.user_id, businessId:r.business_id, employmentType:r.employment_type,
        resumptionDate:r.resumption_date, salaryAmount:r.salary_amount, salaryFrequency:r.salary_frequency,
        settlementDate:r.settlement_date, settlementTerms:r.settlement_terms||'', notes:r.notes||'',
        // original/history are local-only concepts (no such columns exist on
        // employment_records itself — history lives in its own table, fetched
        // separately below) — mergeUpdate does a full replace on update, so
        // without this, pulling an amendment made on another device would
        // silently WIPE this device's copy of the amendment trail instead of
        // extending it.
        original: existingRec ? existingRec.original : { employmentType:r.employment_type, resumptionDate:r.resumption_date, salaryAmount:r.salary_amount, salaryFrequency:r.salary_frequency, settlementDate:r.settlement_date, settlementTerms:r.settlement_terms||'', notes:r.notes||'' },
        history: existingRec ? existingRec.history : []
      };
    });

    // Each amendment is its own immutable row (never updated once written),
    // so this is insert-only merging — same pattern as audit_log.
    empHistory.forEach(h=>{
      const rec = state.employmentRecords.find(x=>x.id===h.employment_record_id);
      if(!rec) return;
      if(!rec.history.some(x=>x.id===h.id)){
        rec.history.push({ id:h.id, changedAt:h.created_at, changedBy:h.changed_by_user_id, previousValues:h.previous_values, reason:h.reason||'' });
        changed = true;
      }
    });

    // Stock corrections are permanent, append-only records by design — see
    // openStockCorrectionModal in app.html — so this is also insert-only,
    // same reasoning as audit_log and employment history above.
    mergeUpdate('stock_adjustments', stockAdj, state.stockAdjustments, r=>({
      id:r.id, businessId:r.business_id, shopId:r.shop_id, goodId:r.good_id, goodName:r.good_name,
      batchId:r.batch_id, oldQty:r.old_qty, newQty:r.new_qty, difference:r.difference, reason:r.reason||'',
      adjustedByUserId:r.adjusted_by_user_id, adjustedAt:r.created_at
    }));

    mergeUpdate('record_only_staff', ros, state.recordOnlyStaff, r=>({
      id:r.id, businessId:r.business_id, firstName:r.first_name, lastName:r.last_name||'', phone:r.phone||'',
      email:r.email||'', notes:r.notes||'', isActive:r.is_active, createdByUserId:r.created_by_user_id, createdAt:r.created_at
    }));

    mergeUpdate('shop_notes', notes, state.shopNotes, r=>({
      id:r.id, businessId:r.business_id, shopId:r.shop_id, authorUserId:r.author_user_id,
      title:r.title, text:r.text||'', createdAt:r.created_at, updatedAt:r.updated_at, isHandover:!!r.is_handover
    }));

    mergeUpdate('audit_log', auditRows, state.auditLog, r=>({
      id:r.id, businessId:r.business_id, userId:r.user_id, action:r.action, details:r.details,
      timestamp:r.created_at || r.timestamp
    }));

    mergeUpdate('rooms', rooms, state.rooms, r=>({
      id:r.id, businessId:r.business_id, shopId:r.shop_id, name:r.name, roomType:r.room_type||'',
      ratePerNight:r.rate_per_night, createdAt:r.created_at
    }));

    mergeUpdate('lodging_bookings', bookings, state.lodgingBookings, r=>({
      id:r.id, businessId:r.business_id, shopId:r.shop_id, roomId:r.room_id, guestName:r.guest_name,
      guestPhone:r.guest_phone||'', checkIn:r.check_in, checkOut:r.check_out, nights:r.nights,
      ratePerNight:r.rate_per_night, totalAmount:r.total_amount, paidAmount:r.paid_amount, balance:r.balance,
      idType:r.id_type, idNumber:r.id_number, address:r.address, comingFrom:r.coming_from,
      kinName:r.kin_name, kinPhone:r.kin_phone, plateNumber:r.plate_number, numGuests:r.num_guests,
      purpose:r.purpose, status:r.status, createdByUserId:r.created_by_user_id, createdAt:r.created_at,
      checkedOutAt:r.checked_out_at
    }));

    mergeUpdate('communication_log', comms, state.communicationLog, r=>({
      id:r.id, businessId:r.business_id, customerId:r.customer_id, userId:null, type:r.channel, timestamp:r.sent_at
    }));

    sales.forEach(r=>{
      const remoteItems = saleItems.filter(si=>si.sale_id===r.id).map(si=>({
        saleItemId:si.id, goodId:si.good_id, batchId:si.batch_id, variantId:si.variant_id, variantLabel:si.variant_label||'',
        qty:si.qty, priceUsed:si.price_used, note:si.note||'', returnedQty:si.returned_qty||0
      }));
      const existing = state.sales.find(x=>x.id===r.id);
      if(!existing){
        state.sales.push({
          id:r.id, shopId:r.shop_id, customerId:r.customer_id, walkInName:r.walk_in_name||'',
          walkInPhone:r.walk_in_phone||'', note:r.note||'', itemsSubtotal:r.items_subtotal, discount:r.discount,
          taxAmount:r.tax_amount, taxPct:r.tax_pct, subtotal:r.subtotal, paidAmount:r.paid_amount,
          balance:r.balance, dueDate:r.due_date, status:r.status, soldByUserId:r.sold_by_user_id,
          receiptSent:r.receipt_sent, date:r.date, items: remoteItems
        });
        changed = true;
        return;
      }
      // A sale already exists locally once created, but its financial
      // fields change afterward — a credit payment collected, a return
      // processed, a void — each pushed as its own 'sales' update. Refresh
      // them here unless this device itself has one of those still queued.
      if(!isPending('sales', r.id)){
        const fresh = { subtotal:r.subtotal, paidAmount:r.paid_amount, balance:r.balance, status:r.status, receiptSent:r.receipt_sent };
        if(JSON.stringify({ subtotal:existing.subtotal, paidAmount:existing.paidAmount, balance:existing.balance, status:existing.status, receiptSent:existing.receiptSent }) !== JSON.stringify(fresh)){
          Object.assign(existing, fresh);
          changed = true;
        }
      }
      remoteItems.forEach(ri=>{
        if(!ri.saleItemId || isPending('sale_items', ri.saleItemId)) return;
        const idx = existing.items.findIndex(x=>x.saleItemId===ri.saleItemId);
        if(idx!==-1 && JSON.stringify(existing.items[idx]) !== JSON.stringify(ri)){
          existing.items[idx] = ri;
          changed = true;
        }
      });
    });

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
