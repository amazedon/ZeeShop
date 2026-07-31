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
}

let syncInProgress = false;

async function flushSyncQueue(){
  if(syncInProgress) return;         // avoid overlapping flushes
  if(!navigator.onLine) return;      // quick check before trying network
  const session = await getCachedAuthSession();
  if(!session) return;               // owner not logged in to Supabase yet — nothing to push against

  syncInProgress = true;
  try{
    let queue = loadSyncQueue();
    while(queue.length > 0){
      const item = queue[0];
      const success = await pushSyncItem(item, session.access_token);
      if(!success){
        item.attempts = (item.attempts || 0) + 1;
        saveSyncQueue(queue);
        break; // stop here — keep order, retry this item (and the rest) next time
      }
      queue.shift();
      saveSyncQueue(queue);
    }
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
      return true; // unknown op — drop it rather than block the queue forever
    }
    if(res.ok) return true;
    // A 4xx that isn't auth-related (e.g. bad data) would block forever if retried
    // forever — but we still leave it queued and surface it, rather than silently
    // discard a shop owner's data. It'll show up in the (future) sync-status UI.
    return false;
  }catch(e){
    return false; // network error — definitely offline, try again later
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
