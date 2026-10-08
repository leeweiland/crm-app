// Postgres-backed contacts store. Postgres is the ONLY store (2026-10-08);
// crm_contacts.json is no longer read or written by the app.
//
// History, because it explains the shape of this file: the Postgres
// migration kept crm_contacts.json as a synchronous "dual-write safety net"
// that was supposed to run for a few days and then be retired. It never
// was. By 2026-10-08 that file was 194MB / 176k records, every contact
// write was a full streaming rewrite of it (~5.5s under a file lock), and
// -- worse -- its mtime was how the 7 OS threads of this app noticed each
// other's contact changes: any write on one thread made every other thread
// re-read all 194MB on its next contact lookup. That coupling is what let a
// burst of email opens (engagement/tag writes on the notification threads)
// slow the campaign send loop on its own thread, and it was the single
// largest I/O cost left in the system. Confirmed by direct code trace and
// /proc I/O counters, not inferred.
//
// Design now:
//   - Every read is served from this thread's in-memory cache (loaded from
//     Postgres at startup), exactly as before. All ~190 call sites keep
//     their synchronous shape.
//   - Every write updates this thread's cache synchronously, then enqueues
//     the Postgres write on a serialized, retried queue (so two writes to
//     the same contact can never land out of order), and NOTIFYs
//     `contacts_changed` with the affected ids inside the same transaction.
//   - Every thread holds one dedicated LISTEN connection; on a
//     notification from a DIFFERENT origin it fetches just those rows and
//     patches its own cache. The writer ignores its own notifications, so
//     its cache can never be rolled back to an older row by a notification
//     for a write it has already superseded in memory. Separate processes
//     (backchannel scripts) use the same channel -- see
//     backchannel/contacts_pg.mjs -- so there is one mechanism for
//     cross-thread and cross-process freshness, and no file polling.
//   - A daily JSON snapshot (crm_contacts_export.json) is written from the
//     scheduler thread for disaster recovery / offline tooling only;
//     nothing reads it live.
//
// Durability: a write is durable once its queued Postgres transaction
// commits, which is normally milliseconds after the call returns. A crash
// in that window loses only that window's writes (the queue retries
// transient failures and logs loudly on permanent ones). That is the same
// window the background Postgres persist already had under the dual-write
// -- the JSON never actually protected against it, because the JSON was
// itself only a replica of what this cache held.
import { randomUUID } from "crypto";
import { statSync } from "fs";
import { join } from "path";
import pg from "pg";
import { writeJson, DATA_DIR } from "./auth_backend.js";

// Small per-thread pool: reads never touch Postgres, and writes are
// serialized through one queue, so this is bounded by the queue (1) plus
// the occasional direct fetch from the listener.
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const CHANNEL = "contacts_changed";
const ORIGIN = randomUUID(); // identifies THIS thread's writes in notifications
export const CONTACTS_EXPORT_FILE = "crm_contacts_export.json";

const EXTRA_KEYS = [
  "hyrosIps", "hyrosPhones", "altEmails", "altPhones", "mergedHyrosLeadIds",
  "address", "hyrosOriginLead", "clickIds", "visitedPaths",
  "emailSuppressedAt", "emailSuppressedReason", "testContact",
];

// Postgres row -> the exact same plain-object shape readJson(CONTACTS_FILE)
// always produced, so downstream logic needs zero changes. Date fields
// are plain TEXT columns (not timestamptz) specifically so the original
// string -- including things like a Hyros "-09:00" offset that
// segments_shared.js's leadDateMs() pattern-matches on -- survives exactly,
// never silently normalized to a different timezone representation.
function rowToContact(row) {
  if (!row) return null;
  const c = {
    id: row.id,
    type: "contact",
    first: row.first,
    last: row.last,
    email: row.email,
    phone: row.phone,
    status: row.status,
    source: row.source,
    accountName: row.account_name,
    ownerId: row.owner_id,
    tags: row.tags || [],
    listIds: row.list_ids || [],
    externalIds: row.external_ids || {},
    customFields: row.custom_fields || {},
    smsOptOut: !!row.sms_opt_out,
    emailOptOut: !!row.email_opt_out,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.program_type != null) c.programType = row.program_type;
  if (row.first_seen_at != null) c.firstSeenAt = row.first_seen_at;
  if (row.email_unsubscribed_at != null) c.emailUnsubscribedAt = row.email_unsubscribed_at;
  if (row.email_opened || row.email_clicked || row.email_opened_at || row.email_clicked_at) {
    c.emailEngagement = {};
    if (row.email_opened) c.emailEngagement.opened = true;
    if (row.email_clicked) c.emailEngagement.clicked = true;
    if (row.email_opened_at != null) c.emailEngagement.openedAt = row.email_opened_at;
    if (row.email_clicked_at != null) c.emailEngagement.clickedAt = row.email_clicked_at;
  }
  const extra = row.extra || {};
  for (const k of EXTRA_KEYS) if (extra[k] !== undefined) c[k] = extra[k];
  return c;
}

// Plain contact object -> Postgres column values, for INSERT/UPDATE.
function contactToParams(c) {
  const eng = c.emailEngagement || {};
  const extra = {};
  for (const k of EXTRA_KEYS) if (c[k] !== undefined) extra[k] = c[k];
  return {
    id: c.id,
    first: c.first ?? null,
    last: c.last ?? null,
    email: c.email ?? null,
    phone: c.phone ?? null,
    status: c.status ?? null,
    source: c.source ?? null,
    account_name: c.accountName ?? null,
    owner_id: c.ownerId ?? null,
    program_type: c.programType ?? null,
    sms_opt_out: !!c.smsOptOut,
    email_opt_out: !!c.emailOptOut,
    email_opened: !!(eng.opened || eng.clicked),
    email_clicked: !!eng.clicked,
    email_opened_at: eng.openedAt ?? null,
    email_clicked_at: eng.clickedAt ?? null,
    email_unsubscribed_at: c.emailUnsubscribedAt ?? null,
    first_seen_at: c.firstSeenAt ?? null,
    created_at: c.createdAt ?? null,
    updated_at: c.updatedAt ?? null,
    tags: c.tags || [],
    list_ids: c.listIds || [],
    external_ids: JSON.stringify(c.externalIds || {}),
    custom_fields: JSON.stringify(c.customFields || {}),
    extra: JSON.stringify(extra),
  };
}
const COLUMNS = [
  "id", "first", "last", "email", "phone", "status", "source", "account_name", "owner_id", "program_type",
  "sms_opt_out", "email_opt_out", "email_opened", "email_clicked", "email_opened_at", "email_clicked_at",
  "email_unsubscribed_at", "first_seen_at", "created_at", "updated_at", "tags", "list_ids",
  "external_ids", "custom_fields", "extra",
];
const JSONB_COLUMNS = new Set(["external_ids", "custom_fields", "extra"]);
// One multi-row UPSERT per chunk -- 25 columns x 500 rows stays well under
// Postgres's 65,535-parameter limit and is one round trip instead of 500.
const UPSERT_CHUNK = 500;
function upsertSql(rowCount) {
  const rows = [];
  for (let r = 0; r < rowCount; r++) {
    rows.push("(" + COLUMNS.map((col, i) => `$${r * COLUMNS.length + i + 1}${JSONB_COLUMNS.has(col) ? "::jsonb" : ""}`).join(",") + ")");
  }
  const updates = COLUMNS.filter(c => c !== "id").map(c => `${c}=excluded.${c}`).join(", ");
  return `INSERT INTO contacts (${COLUMNS.join(", ")}) VALUES ${rows.join(",")} ON CONFLICT (id) DO UPDATE SET ${updates}`;
}
async function upsertRows(client, contacts) {
  for (let i = 0; i < contacts.length; i += UPSERT_CHUNK) {
    const chunk = contacts.slice(i, i + UPSERT_CHUNK);
    const params = [];
    for (const c of chunk) { const p = contactToParams(c); for (const col of COLUMNS) params.push(p[col]); }
    await client.query(upsertSql(chunk.length), params);
  }
}

// ── In-memory cache (sync reads) ──────────────────────────────────────────
let _cache = [];
let _byId = new Map();
let _loaded = false;

function rebuildIndex() { _byId = new Map(_cache.map(c => [c.id, c])); }
function clone(c) { return c ? JSON.parse(JSON.stringify(c)) : c; }
// Make `existing` byte-for-byte equal to `fresh` while keeping its object
// identity (callers may hold references) -- deletes keys `fresh` lacks,
// which a plain Object.assign would leave behind as stale data.
function replaceInPlace(existing, fresh) {
  for (const k of Object.keys(existing)) if (!(k in fresh)) delete existing[k];
  Object.assign(existing, fresh);
  return existing;
}

export async function loadContactsCache() {
  const r = await pool.query("SELECT * FROM contacts");
  _cache = r.rows.map(rowToContact);
  rebuildIndex();
  _loaded = true;
  console.log(`[contacts_db] loaded ${_cache.length} contacts from Postgres`);
  if (process.env.CONTACTS_DB_NO_LISTEN !== "1") await startContactsListener();
}

function assertLoaded() {
  if (!_loaded) throw new Error("contacts_db: cache not loaded yet -- loadContactsCache() must be awaited at startup before any request touches contacts");
}

// ── Reads (sync) ──────────────────────────────────────────────────────────
export function getAllContacts() { assertLoaded(); return clone(_cache); }
export function getContactById(id) { assertLoaded(); return clone(_byId.get(id)) || null; }
export function getContactsByIds(ids) { assertLoaded(); const set = new Set(ids); return clone(_cache.filter(c => set.has(c.id))); }
export function findContactById(id) { return getContactById(id); } // alias for call sites that currently do contacts.find(c => c.id === id)

// ── Durable write queue ───────────────────────────────────────────────────
// Strictly serialized: every write on this thread runs after the previous
// one committed, so the order rows reach Postgres is the order the app
// made them. Transient failures retry with backoff; a permanent one is
// logged loudly (the in-memory state is still correct and the next write
// to that contact re-sends the full row).
let _queue = Promise.resolve();
let _pendingWrites = 0;
const RETRY_DELAYS_MS = [250, 1000, 4000];
function enqueue(label, work) {
  _pendingWrites++;
  _queue = _queue.then(async () => {
    for (let attempt = 0; ; attempt++) {
      const client = await pool.connect().catch(e => { console.error(`[contacts_db] Postgres connect failed (${label}):`, e.message); return null; });
      if (client) {
        try {
          await client.query("BEGIN");
          await work(client);
          await client.query("COMMIT");
          return;
        } catch (e) {
          try { await client.query("ROLLBACK"); } catch { /* connection already gone */ }
          if (attempt >= RETRY_DELAYS_MS.length) { console.error(`[contacts_db] Postgres write FAILED after ${attempt + 1} attempts (${label}) -- in-memory state is ahead of Postgres for these rows until their next write:`, e.message); return; }
          console.error(`[contacts_db] Postgres write failed (${label}, attempt ${attempt + 1}), retrying:`, e.message);
        } finally { client.release(); }
      } else if (attempt >= RETRY_DELAYS_MS.length) { console.error(`[contacts_db] giving up on write (${label}) -- no Postgres connection`); return; }
      await new Promise(r => setTimeout(r, RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)]));
    }
  }).finally(() => { _pendingWrites--; });
  return _queue;
}
// Lets a graceful shutdown (or a test) wait for everything queued so far.
export function flushContactWrites() { return _queue; }
export function pendingContactWrites() { return _pendingWrites; }

// NOTIFY payloads are capped at 8000 bytes -- ids are chunked to stay
// well under it; the listener side just handles each chunk independently.
const NOTIFY_IDS_PER_CHUNK = 150;
async function notify(client, body) {
  await client.query("SELECT pg_notify($1, $2)", [CHANNEL, JSON.stringify({ o: ORIGIN, ...body })]);
}
async function notifyIds(client, key, ids) {
  for (let i = 0; i < ids.length; i += NOTIFY_IDS_PER_CHUNK) await notify(client, { [key]: ids.slice(i, i + NOTIFY_IDS_PER_CHUNK) });
}
function queueUpsert(label, contacts) {
  if (!contacts.length) return;
  const snapshot = contacts.map(clone); // the rows as they are NOW, not whatever they become by the time the queue reaches them
  return enqueue(label, async (client) => { await upsertRows(client, snapshot); await notifyIds(client, "ids", snapshot.map(c => c.id)); });
}
function queueDelete(label, ids) {
  if (!ids.length) return;
  return enqueue(label, async (client) => { await client.query("DELETE FROM contacts WHERE id = ANY($1)", [ids]); await notifyIds(client, "del", ids); });
}

// ── Cross-thread / cross-process freshness ────────────────────────────────
let _listener = null;
let _listenerReconnectMs = 1000;
let _firstNotificationLogged = false;
async function startContactsListener() {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  client.on("notification", (msg) => {
    let payload = null;
    try { payload = JSON.parse(msg.payload || "{}"); } catch { return; }
    if (!payload || payload.o === ORIGIN) return; // our own write -- cache already ahead of it
    applyContactsChangeNotification(payload).catch(e => console.error("[contacts_db] applying contact change notification failed:", e.message));
  });
  client.on("error", (e) => { console.error("[contacts_db] listener connection error, reconnecting:", e.message); scheduleListenerReconnect(); });
  client.on("end", () => { if (_listener === client) scheduleListenerReconnect(); });
  try {
    await client.connect();
    await client.query(`LISTEN ${CHANNEL}`);
    _listener = client;
    _listenerReconnectMs = 1000;
  } catch (e) {
    console.error("[contacts_db] listener connect failed, will retry:", e.message);
    try { await client.end(); } catch { /* never connected */ }
    scheduleListenerReconnect();
  }
}
function scheduleListenerReconnect() {
  if (_listener) { const old = _listener; _listener = null; old.end().catch(() => {}); }
  const delay = _listenerReconnectMs;
  _listenerReconnectMs = Math.min(_listenerReconnectMs * 2, 30_000);
  const t = setTimeout(() => startContactsListener(), delay);
  if (t.unref) t.unref();
}
// Exported for the listener and for tests. `ids`: fetch those rows and
// replace them in the cache (insert if new). `del`: drop them. `full`: a
// bulk replace happened elsewhere (writeAllContacts) -- reload everything.
export async function applyContactsChangeNotification(payload) {
  if (!_loaded) return;
  if (!_firstNotificationLogged) { _firstNotificationLogged = true; console.log("[contacts_db] cross-thread contact refresh active (first notification applied)"); }
  if (payload.full) {
    const r = await pool.query("SELECT * FROM contacts");
    _cache = r.rows.map(rowToContact);
    rebuildIndex();
    return;
  }
  if (Array.isArray(payload.del) && payload.del.length) {
    const delSet = new Set(payload.del);
    _cache = _cache.filter(c => !delSet.has(c.id));
    rebuildIndex();
  }
  if (Array.isArray(payload.ids) && payload.ids.length) {
    const r = await pool.query("SELECT * FROM contacts WHERE id = ANY($1)", [payload.ids]);
    let added = false;
    for (const row of r.rows) {
      const fresh = rowToContact(row);
      const existing = _byId.get(fresh.id);
      if (existing) replaceInPlace(existing, fresh);
      else { _cache.push(fresh); _byId.set(fresh.id, fresh); added = true; }
    }
    if (added) rebuildIndex();
  }
}

// ── Writes ─────────────────────────────────────────────────────────────────
// Every write: mutate this thread's cache synchronously (so a read right
// after sees it, same consistency guarantee as always), then queue the
// durable Postgres write + notification. Names/signatures are unchanged
// from the dual-write era so no call site changes.

export function createContact(contact) {
  assertLoaded();
  _cache.push(contact);
  _byId.set(contact.id, contact);
  queueUpsert("createContact", [contact]);
  return contact;
}

// updater(copy) -> updated record. Returns the updated record, or null when
// no contact matched. A null return from the updater leaves the contact
// untouched (this single-record helper never deletes).
export function updateContactByField(field, value, updater) {
  assertLoaded();
  const existing = field === "id" ? _byId.get(value) : _cache.find(c => c[field] === value);
  if (!existing) return null;
  const updated = updater(clone(existing));
  if (!updated) return null;
  const oldId = existing.id;
  replaceInPlace(existing, updated);
  if (existing.id !== oldId) rebuildIndex();
  queueUpsert("updateContactByField", [existing]);
  return clone(existing);
}
export function updateContactById(id, updater) { return updateContactByField("id", id, updater); }

// updater returning null deletes that record, matching the original JSON
// helper's own contract exactly. Returns the updated records.
export function updateContactsByIds(ids, updater) { return updateContactsByIdSet(new Set(ids), updater); }
export function updateContactsByIdSet(idSet, updater) {
  assertLoaded();
  const results = [], deletedIds = [];
  for (const id of idSet) {
    const existing = _byId.get(id);
    if (!existing) continue;
    const updated = updater(clone(existing));
    if (updated === null) { deletedIds.push(id); continue; }
    if (!updated) continue;
    replaceInPlace(existing, updated);
    results.push(existing);
  }
  if (deletedIds.length) { const delSet = new Set(deletedIds); _cache = _cache.filter(c => !delSet.has(c.id)); rebuildIndex(); }
  queueUpsert("updateContactsByIdSet", results);
  queueDelete("updateContactsByIdSet", deletedIds);
  return results.map(clone);
}

// Batched write path for email-open/click engagement flags and automation
// add_tag/remove_tag steps. The in-memory contact is updated IMMEDIATELY
// (every read -- getContactById, segment matching, the next automation
// step's own getContact -- sees it with zero delay), and the Postgres
// write is coalesced: up to ENGAGEMENT_FLUSH_DELAY_MS worth of DISTINCT
// contacts' changes become ONE batched UPSERT + one notification, instead
// of one write per open/click/tag. (Under the old dual-write this window
// was what made a 194MB streaming rewrite affordable at all; it stays
// because a campaign's open burst is still hundreds of distinct contacts a
// minute and one round trip per window is simply cheaper than one per
// event.) The same flush also feeds onEngagementFlush listeners
// (contacts_backend.js wires syncContactFieldsBatch, the SQLite mirror).
const _pendingEngagement = new Map(); // contactId -> { opened?, openedAt?, clicked?, clickedAt? }
const _pendingTagChanges = new Map(); // contactId -> { add: Set<tagId>, remove: Set<tagId> }
let _engagementFlushTimer = null;
const ENGAGEMENT_FLUSH_DELAY_MS = 5000;
function scheduleEngagementFlush() {
  if (_engagementFlushTimer) return;
  _engagementFlushTimer = setTimeout(flushEngagementUpdates, ENGAGEMENT_FLUSH_DELAY_MS);
  if (_engagementFlushTimer.unref) _engagementFlushTimer.unref();
}
export function queueContactEngagementUpdate(contactId, kind, atISO) {
  if (!contactId) return null;
  const at = atISO && !isNaN(new Date(atISO)) ? new Date(atISO).toISOString() : new Date().toISOString();
  const atKey = `${kind}At`;
  const existing = _byId.get(contactId);
  if (existing) {
    existing.emailEngagement = existing.emailEngagement || {};
    existing.emailEngagement[kind] = true;
    if (!existing.emailEngagement[atKey] || new Date(at) > new Date(existing.emailEngagement[atKey])) existing.emailEngagement[atKey] = at;
  }
  const pending = _pendingEngagement.get(contactId) || {};
  pending[kind] = true;
  if (!pending[atKey] || new Date(at) > new Date(pending[atKey])) pending[atKey] = at;
  _pendingEngagement.set(contactId, pending);
  scheduleEngagementFlush();
  return existing ? { ...existing } : null;
}
export function queueContactTagChange(contactId, { add, remove } = {}) {
  if (!contactId || (!add && !remove)) return;
  const existing = _byId.get(contactId);
  if (existing) {
    existing.tags = existing.tags || [];
    if (add && !existing.tags.includes(add)) existing.tags.push(add);
    if (remove) existing.tags = existing.tags.filter(t => t !== remove);
  }
  const pending = _pendingTagChanges.get(contactId) || { add: new Set(), remove: new Set() };
  // Last operation on a given tag within the window wins.
  if (add) { pending.add.add(add); pending.remove.delete(add); }
  if (remove) { pending.remove.add(remove); pending.add.delete(remove); }
  _pendingTagChanges.set(contactId, pending);
  scheduleEngagementFlush();
}
const _engagementFlushListeners = [];
export function onEngagementFlush(fn) { _engagementFlushListeners.push(fn); }
function flushEngagementUpdates() {
  _engagementFlushTimer = null;
  if (!_pendingEngagement.size && !_pendingTagChanges.size) return;
  const pending = new Map(_pendingEngagement); _pendingEngagement.clear();
  const tags = new Map(_pendingTagChanges); _pendingTagChanges.clear();
  const ids = new Set([...pending.keys(), ...tags.keys()]);
  const results = updateContactsByIdSet(ids, (c) => {
    const p = pending.get(c.id);
    if (p) {
      c.emailEngagement = c.emailEngagement || {};
      if (p.opened) { c.emailEngagement.opened = true; if (!c.emailEngagement.openedAt || new Date(p.openedAt) > new Date(c.emailEngagement.openedAt)) c.emailEngagement.openedAt = p.openedAt; }
      if (p.clicked) { c.emailEngagement.clicked = true; if (!c.emailEngagement.clickedAt || new Date(p.clickedAt) > new Date(c.emailEngagement.clickedAt)) c.emailEngagement.clickedAt = p.clickedAt; }
    }
    const t = tags.get(c.id);
    if (t) {
      c.tags = c.tags || [];
      for (const a of t.add) if (!c.tags.includes(a)) c.tags.push(a);
      if (t.remove.size) c.tags = c.tags.filter(x => !t.remove.has(x));
    }
    return c;
  });
  for (const fn of _engagementFlushListeners) { try { fn(results); } catch (e) { console.error("[contacts_db] engagement flush listener failed:", e.message); } }
}

// Every record where contact[field] === value, not just the first. Returns
// the updated records so callers can re-sync exactly those elsewhere.
export function updateAllContactsByField(field, value, updater) {
  assertLoaded();
  const matched = _cache.filter(c => c[field] === value);
  return updateContactsByIdSet(new Set(matched.map(c => c.id)), updater);
}

// Remove the given values from an array field on every contact that has
// any of them (e.g. a deleted tag/list id). Returns how many changed.
export function removeValuesFromContactsArrayField(fieldName, valuesToRemove) {
  assertLoaded();
  const removeSet = new Set(valuesToRemove);
  const affected = _cache.filter(c => Array.isArray(c[fieldName]) && c[fieldName].some(v => removeSet.has(v)));
  for (const c of affected) c[fieldName] = c[fieldName].filter(v => !removeSet.has(v));
  queueUpsert("removeValuesFromContactsArrayField", affected);
  return affected.length;
}

// Bulk importer paths that build/modify a whole array and save it back in
// one shot. Other threads get a single "full" notification and reload.
export function writeAllContacts(contacts) {
  assertLoaded();
  const newIds = new Set(contacts.map(c => c.id));
  const removedIds = _cache.filter(c => !newIds.has(c.id)).map(c => c.id);
  _cache = contacts.map(clone);
  rebuildIndex();
  // The queue preserves order, so a later in-place edit or delete still
  // lands after this upsert -- no second deep clone of 176k rows needed.
  const snapshot = _cache;
  enqueue("writeAllContacts", async (client) => {
    await upsertRows(client, snapshot);
    if (removedIds.length) await client.query("DELETE FROM contacts WHERE id = ANY($1)", [removedIds]);
    await notify(client, { full: 1 });
  });
}

// Does NOT handle the cross-file cascade (conversation summary, message
// file, sqlite index) that contacts_backend.js's delete routes do -- callers
// still do that themselves, this only removes the contact record.
export function deleteContact(id) { return deleteContacts([id]); }
export function deleteContacts(ids) {
  assertLoaded();
  const idSet = new Set(ids);
  _cache = _cache.filter(c => !idSet.has(c.id));
  rebuildIndex();
  queueDelete("deleteContacts", [...idSet]);
}

// Daily JSON snapshot for disaster recovery / offline tooling
// (rebuild_conversation_db.mjs reads it). Never read by the live app.
// Runs on the scheduler thread; one ~200MB atomic write per day.
export function exportContactsSnapshotIfDue(maxAgeMs = 24 * 60 * 60 * 1000) {
  assertLoaded();
  const p = join(DATA_DIR, CONTACTS_EXPORT_FILE);
  try { if (Date.now() - statSync(p).mtimeMs < maxAgeMs) return false; } catch { /* no export yet */ }
  writeJson(CONTACTS_EXPORT_FILE, _cache);
  console.log(`[contacts_db] wrote ${CONTACTS_EXPORT_FILE} (${_cache.length} contacts)`);
  return true;
}

// rowToContact/contactToParams are the ONE definition of the contact
// shape on both sides of Postgres -- backchannel/contacts_pg.mjs imports
// them so a standalone script can never drift from what the app writes.
export { pool as contactsPool, rowToContact, contactToParams, COLUMNS as CONTACT_COLUMNS, CHANNEL as CONTACTS_CHANGED_CHANNEL };
