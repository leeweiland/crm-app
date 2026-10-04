// Postgres-backed contacts store, with crm_contacts.json kept as a live
// dual-write safety net during the migration (see the audit this was built
// from: 190 call sites across 32 files touch CONTACTS_FILE today).
//
// Design principle: nearly every consumer's BUSINESS LOGIC (findContactMatch,
// matchesSegment, applyAdvancingStatus, the merge field-rules, etc.) stays
// completely unchanged -- it already just operates on plain JS contact
// objects. This module's only job is to source/persist those same-shaped
// objects from/to Postgres instead of a JSON file, so call sites mostly just
// swap *where the object came from*, not *what they do with it*.
//
// Reads and writes are both SYNCHRONOUS, same as readJson/writeJson(CONTACTS_FILE)
// today: an in-memory cache (loaded from Postgres at startup) backs every
// read, and every write updates it immediately, so none of the ~190 call
// sites need to become async just to keep working. The JSON file is written
// FIRST on every write, synchronously, via the exact same auth_backend.js
// helpers every call site already used -- that's what stays authoritative
// for durability during this migration's dual-write period. Postgres is
// persisted in the background (fire-and-forget, logged on failure, never
// awaited) -- see the Writes section below for the full reasoning.
//
// Cross-thread consistency: BACKGROUND_WORKER=1 runs the scheduler tick and
// webhook processing on a separate worker_thread with its OWN independent
// copy of this module's in-memory cache (confirmed: worker_threads have
// separate V8 heaps/module registries) -- a write on one thread does NOT
// update the other thread's cache. Every read/write here first checks the
// JSON file's mtime (cheap: one statSync) and reloads the in-memory cache
// from JSON -- never Postgres, which could still be catching up from the
// very write that changed that mtime -- if it's changed since last seen.
// This is the exact same mtime-staleness-detection pattern auth_backend.js's
// own _mtimeCache already uses for this identical cross-thread/cross-process
// problem on every other JSON file in the app.
import { statSync } from "fs";
import { join } from "path";
import pg from "pg";
import {
  readJson, writeJson, appendJsonRecordFast, DATA_DIR,
  updateJsonArrayRecordByField, updateAllJsonArrayRecordsByField,
  removeValuesFromArrayField, updateJsonArrayRecordsByIds, updateJsonArrayRecordsByIdSet,
} from "./auth_backend.js";

export const CONTACTS_FILE = "crm_contacts.json";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 10 });

const EXTRA_KEYS = [
  "hyrosIps", "hyrosPhones", "altEmails", "altPhones", "mergedHyrosLeadIds",
  "address", "hyrosOriginLead", "clickIds", "visitedPaths",
  "emailSuppressedAt", "emailSuppressedReason", "testContact",
];

// Postgres row -> the exact same plain-object shape readJson(CONTACTS_FILE)
// has always produced, so downstream logic needs zero changes. Date fields
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

const UPSERT_SQL = `
  INSERT INTO contacts (
    id, first, last, email, phone, status, source, account_name, owner_id, program_type,
    sms_opt_out, email_opt_out, email_opened, email_clicked, email_opened_at, email_clicked_at,
    email_unsubscribed_at, first_seen_at, created_at, updated_at, tags, list_ids,
    external_ids, custom_fields, extra
  ) VALUES (
    $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23::jsonb,$24::jsonb,$25::jsonb
  )
  ON CONFLICT (id) DO UPDATE SET
    first=$2, last=$3, email=$4, phone=$5, status=$6, source=$7, account_name=$8, owner_id=$9,
    program_type=$10, sms_opt_out=$11, email_opt_out=$12, email_opened=$13, email_clicked=$14,
    email_opened_at=$15, email_clicked_at=$16, email_unsubscribed_at=$17, first_seen_at=$18,
    created_at=$19, updated_at=$20, tags=$21, list_ids=$22, external_ids=$23::jsonb,
    custom_fields=$24::jsonb, extra=$25::jsonb
`;
const UPSERT_PARAM_ORDER = [
  "id", "first", "last", "email", "phone", "status", "source", "account_name", "owner_id", "program_type",
  "sms_opt_out", "email_opt_out", "email_opened", "email_clicked", "email_opened_at", "email_clicked_at",
  "email_unsubscribed_at", "first_seen_at", "created_at", "updated_at", "tags", "list_ids",
  "external_ids", "custom_fields", "extra",
];
async function upsertRow(client, c) {
  const p = contactToParams(c);
  await client.query(UPSERT_SQL, UPSERT_PARAM_ORDER.map(k => p[k]));
}

// ── In-memory cache (sync reads) ──────────────────────────────────────────
let _cache = [];
let _byId = new Map();
let _loaded = false;
const CONTACTS_PATH = join(DATA_DIR, CONTACTS_FILE);
let _lastKnownMtimeMs = null;

function rebuildIndex() { _byId = new Map(_cache.map(c => [c.id, c])); }
function clone(c) { return c ? JSON.parse(JSON.stringify(c)) : c; }

export async function loadContactsCache() {
  const r = await pool.query("SELECT * FROM contacts");
  _cache = r.rows.map(rowToContact);
  rebuildIndex();
  _loaded = true;
  try { _lastKnownMtimeMs = statSync(CONTACTS_PATH).mtimeMs; } catch { _lastKnownMtimeMs = null; }
  console.log(`[contacts_db] loaded ${_cache.length} contacts from Postgres`);
}

function assertLoaded() {
  if (!_loaded) throw new Error("contacts_db: cache not loaded yet -- loadContactsCache() must be awaited at startup before any request touches contacts");
}

// See the module header for why this exists: a write on the OTHER thread
// (main vs. BACKGROUND_WORKER) never updates this thread's in-memory cache
// on its own. One statSync per call is cheap; the full JSON reload only
// happens on the rare occasion the mtime has actually moved since this
// thread last checked.
function syncFromJsonIfChanged() {
  let mtimeMs;
  try { mtimeMs = statSync(CONTACTS_PATH).mtimeMs; } catch { return; }
  if (mtimeMs === _lastKnownMtimeMs) return;
  _cache = readJson(CONTACTS_FILE, []);
  rebuildIndex();
  _lastKnownMtimeMs = mtimeMs;
}

// ── Reads (sync, same shape/semantics as readJson(CONTACTS_FILE, [])) ────
export function getAllContacts() { assertLoaded(); syncFromJsonIfChanged(); return clone(_cache); }
export function getContactById(id) { assertLoaded(); syncFromJsonIfChanged(); return clone(_byId.get(id)) || null; }
export function getContactsByIds(ids) { assertLoaded(); syncFromJsonIfChanged(); const set = new Set(ids); return clone(_cache.filter(c => set.has(c.id))); }
export function findContactById(id) { return getContactById(id); } // alias for call sites that currently do contacts.find(c => c.id === id)

// ── Writes ─────────────────────────────────────────────────────────────────
// Design: the JSON write happens FIRST, synchronously, via the exact same
// auth_backend.js helper every call site already uses today -- zero change
// to how/when that becomes durable, so every one of the ~150 read call sites
// and the handful of write call sites keep their current sync/async shape
// unchanged; nothing in this migration needs to flip a currently-synchronous
// function into an async one just to keep working. The in-memory cache (what
// every read in the app actually sees) is updated synchronously right after,
// from the SAME result the JSON helper produced, so a read immediately after
// a write sees the fresh data either way -- same consistency guarantee the
// app already has today. Postgres is persisted in the BACKGROUND
// (fire-and-forget, logged on failure, never awaited by the caller) --
// during this dual-write period JSON remains the synchronously-durable
// source of truth for recovery purposes (per the agreed plan: JSON keeps
// running for some days specifically as that safety net), so a crash in the
// tiny window before a background Postgres persist finishes is a recoverable
// staleness, never a data-loss event.
function persistToPostgresInBackground(contact, label) {
  if (!contact) return;
  pool.connect().then(client =>
    upsertRow(client, contact).catch(e => console.error(`[contacts_db] Postgres sync failed (${label}) -- JSON is already correct, Postgres will be behind until this is investigated:`, e.message)).finally(() => client.release())
  ).catch(e => console.error(`[contacts_db] Postgres connection failed (${label}):`, e.message));
}
function deleteFromPostgresInBackground(ids, label) {
  if (!ids.length) return;
  pool.connect().then(client =>
    client.query("DELETE FROM contacts WHERE id = ANY($1)", [ids]).catch(e => console.error(`[contacts_db] Postgres delete failed (${label}):`, e.message)).finally(() => client.release())
  ).catch(e => console.error(`[contacts_db] Postgres connection failed (${label}):`, e.message));
}
// Called after this thread's own JSON write -- without it, the next read on
// THIS thread would see its own write as "the file changed externally" and
// pay for a wasted full reload of data it already has fresh in memory.
function markOwnWrite() {
  try { _lastKnownMtimeMs = statSync(CONTACTS_PATH).mtimeMs; } catch {}
}

// Equivalent of appendJsonRecordFast(CONTACTS_FILE, contact) -- create one new contact.
export function createContact(contact) {
  syncFromJsonIfChanged();
  appendJsonRecordFast(CONTACTS_FILE, contact);
  markOwnWrite();
  _cache.push(contact);
  _byId.set(contact.id, contact);
  persistToPostgresInBackground(contact, "createContact");
  return contact;
}

// Equivalent of updateJsonArrayRecordByField(CONTACTS_FILE, field, value, updater).
export function updateContactByField(field, value, updater) {
  syncFromJsonIfChanged();
  const result = updateJsonArrayRecordByField(CONTACTS_FILE, field, value, updater);
  markOwnWrite();
  if (!result) return null;
  const existing = field === "id" ? _byId.get(value) : _cache.find(c => c[field] === value);
  if (existing) Object.assign(existing, result); else _cache.push(result);
  if (field !== "id") rebuildIndex(); else _byId.set(result.id, existing || result);
  persistToPostgresInBackground(existing || result, "updateContactByField");
  return result;
}
export function updateContactById(id, updater) { return updateContactByField("id", id, updater); }

// Equivalent of updateJsonArrayRecordsByIds(CONTACTS_FILE, ids, updater) --
// updater returning null deletes that record, matching the existing helper's
// own contract exactly.
export function updateContactsByIds(ids, updater) {
  syncFromJsonIfChanged();
  const results = updateJsonArrayRecordsByIds(CONTACTS_FILE, ids, updater);
  markOwnWrite();
  const resultIds = new Set(results.map(r => r.id));
  const deletedIds = ids.filter(id => _byId.has(id) && !resultIds.has(id));
  for (const r of results) { const existing = _byId.get(r.id); if (existing) Object.assign(existing, r); else _cache.push(r); }
  if (deletedIds.length) { const delSet = new Set(deletedIds); _cache = _cache.filter(c => !delSet.has(c.id)); }
  rebuildIndex();
  for (const r of results) persistToPostgresInBackground(r, "updateContactsByIds");
  deleteFromPostgresInBackground(deletedIds, "updateContactsByIds");
  return results;
}
export function updateContactsByIdSet(idSet, updater) {
  syncFromJsonIfChanged();
  const results = updateJsonArrayRecordsByIdSet(CONTACTS_FILE, idSet, updater);
  markOwnWrite();
  const resultIds = new Set(results.map(r => r.id));
  const deletedIds = [...idSet].filter(id => _byId.has(id) && !resultIds.has(id));
  for (const r of results) { const existing = _byId.get(r.id); if (existing) Object.assign(existing, r); else _cache.push(r); }
  if (deletedIds.length) { const delSet = new Set(deletedIds); _cache = _cache.filter(c => !delSet.has(c.id)); }
  rebuildIndex();
  for (const r of results) persistToPostgresInBackground(r, "updateContactsByIdSet");
  deleteFromPostgresInBackground(deletedIds, "updateContactsByIdSet");
  return results;
}

// Batched write path specifically for email-open/click engagement flags
// (2026-10-04). Confirmed live on a 23k-recipient campaign send: every
// genuine Open/Click webhook called updateContactByField, which does ONE
// full streaming read+write pass over the ENTIRE crm_contacts.json (194MB
// on disk) under withFileLock -- the same lock the send loop's own writes
// need -- regardless of which single contact changed. With hundreds of
// real opens/clicks landing concurrently with an active send, this was
// the dominant cost behind throughput sitting near 0.5-1/sec against a
// 13/sec design target, confirmed by direct code trace plus file-size
// measurement (not inferred).
//
// queueContactEngagementUpdate updates the in-memory cache IMMEDIATELY
// (every read -- getContactById, segment matching, ac_sync.js's own
// emailEngagement check -- sees the change with zero delay, identical to
// before this existed) but defers the on-disk write, coalescing up to
// ENGAGEMENT_FLUSH_DELAY_MS worth of DISTINCT CONTACTS' updates into one
// updateContactsByIdSet call -- the exact same already-proven,
// already-in-production batch-by-id-set primitive used elsewhere in this
// file, not new low-level file-scanning logic. One streaming pass over
// the file now amortizes across however many contacts opened/clicked in
// that window, instead of one full pass per contact. Same debounced-batch
// shape as message_index.js's flushConversationIndex.
//
// Bounded, accepted risk: if the process crashes/redeploys between
// queuing and the next flush, a pending engagement flag for a handful of
// contacts is lost on disk (though it was already visible to every
// in-process read before the crash). emailEngagement is non-critical,
// best-effort analytics/segment data, never used for compliance,
// financial, or irreversible-action logic -- an acceptable tradeoff
// against the alternative of permanently capping throughput at a
// fraction of the account's real send rate. Postgres (already
// fire-and-forget/eventually-consistent for every write in this file)
// is unaffected -- the flush persists to it exactly like any other write
// here, just batched the same as the JSON side.
const _pendingEngagement = new Map(); // contactId -> { opened?, openedAt?, clicked?, clickedAt? }
let _engagementFlushTimer = null;
const ENGAGEMENT_FLUSH_DELAY_MS = 5000;

export function queueContactEngagementUpdate(contactId, kind, atISO) {
  if (!contactId) return null;
  syncFromJsonIfChanged();
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

  if (!_engagementFlushTimer) {
    _engagementFlushTimer = setTimeout(flushEngagementUpdates, ENGAGEMENT_FLUSH_DELAY_MS);
    if (_engagementFlushTimer.unref) _engagementFlushTimer.unref();
  }
  return existing ? { ...existing } : null;
}

// Listener hook, not a direct import of sqlite_inbox.js -- that file
// already imports FROM this one (getAllContacts/getContactById), so
// importing it back here would be circular. contacts_backend.js (which
// already imports both modules independently) wires syncContactFieldsBatch
// in as a listener once at startup instead. Confirmed live history behind
// why this needs to be batched too, not just the JSON write: sqlite_inbox.js's
// own syncContactFieldsBatch comment documents the EXACT same shape of bug
// here before -- "1,600 contacts froze the whole server for ~140s
// (2026-09-21)" from calling the unbatched, autocommitted syncContactFields
// once per contact instead of one transaction for all of them. Calling it
// once per engagement event (as markContactEmailEngagement used to) was
// exactly that same mistake, just not yet caught for this call site.
const _engagementFlushListeners = [];
export function onEngagementFlush(fn) { _engagementFlushListeners.push(fn); }

function flushEngagementUpdates() {
  _engagementFlushTimer = null;
  if (!_pendingEngagement.size) return;
  const pending = new Map(_pendingEngagement);
  _pendingEngagement.clear();
  const results = updateContactsByIdSet(new Set(pending.keys()), (c) => {
    const p = pending.get(c.id);
    if (!p) return c;
    c.emailEngagement = c.emailEngagement || {};
    if (p.opened) {
      c.emailEngagement.opened = true;
      if (!c.emailEngagement.openedAt || new Date(p.openedAt) > new Date(c.emailEngagement.openedAt)) c.emailEngagement.openedAt = p.openedAt;
    }
    if (p.clicked) {
      c.emailEngagement.clicked = true;
      if (!c.emailEngagement.clickedAt || new Date(p.clickedAt) > new Date(c.emailEngagement.clickedAt)) c.emailEngagement.clickedAt = p.clickedAt;
    }
    return c;
  });
  for (const fn of _engagementFlushListeners) { try { fn(results); } catch (e) { console.error("[contacts_db] engagement flush listener failed:", e.message); } }
}
// Equivalent of updateAllJsonArrayRecordsByField(CONTACTS_FILE, field, value, updater)
// -- every record where contact[field] === value, not just the first.
// Returns the array of updated records (not just a count) so callers that
// need to act on exactly which ones changed (e.g. re-sync them to the
// sqlite index) don't have to re-derive that set themselves.
export function updateAllContactsByField(field, value, updater) {
  syncFromJsonIfChanged();
  // Snapshot which ids matched BEFORE the update, from the in-memory cache
  // (just synced fresh above) -- the updater may change `field` itself (as
  // this one does: status === "BAD FIT / BLACKLIST" -> "BLACKLIST"), so
  // matching AFTER the JSON write would miss everything the update already
  // moved off the old value.
  const matchedIds = new Set(_cache.filter(c => c[field] === value).map(c => c.id));
  const changedCount = updateAllJsonArrayRecordsByField(CONTACTS_FILE, field, value, updater);
  markOwnWrite();
  if (!changedCount) return [];
  const freshAll = readJson(CONTACTS_FILE, []); // one read for the whole batch, not one per record
  const updatedRecords = [];
  for (const fresh of freshAll) {
    if (!matchedIds.has(fresh.id)) continue;
    const existing = _byId.get(fresh.id);
    if (existing) Object.assign(existing, fresh);
    updatedRecords.push(existing || fresh);
  }
  for (const r of updatedRecords) persistToPostgresInBackground(r, "updateAllContactsByField");
  return updatedRecords;
}

// Equivalent of removeValuesFromArrayField(CONTACTS_FILE, fieldName, valuesToRemove).
export function removeValuesFromContactsArrayField(fieldName, valuesToRemove) {
  syncFromJsonIfChanged();
  const changedCount = removeValuesFromArrayField(CONTACTS_FILE, fieldName, valuesToRemove);
  markOwnWrite();
  if (!changedCount) return 0;
  const removeSet = new Set(valuesToRemove);
  const affected = _cache.filter(c => Array.isArray(c[fieldName]) && c[fieldName].some(v => removeSet.has(v)));
  for (const c of affected) { c[fieldName] = c[fieldName].filter(v => !removeSet.has(v)); persistToPostgresInBackground(c, "removeValuesFromContactsArrayField"); }
  return changedCount;
}

// Equivalent of a full readJson+modify+writeJson(CONTACTS_FILE, contacts)
// round trip -- bulk importer paths that build/modify a whole in-memory
// array and save it back in one shot.
export function writeAllContacts(contacts) {
  syncFromJsonIfChanged();
  writeJson(CONTACTS_FILE, contacts);
  markOwnWrite();
  const newIds = new Set(contacts.map(c => c.id));
  const removedIds = _cache.filter(c => !newIds.has(c.id)).map(c => c.id);
  _cache = contacts.map(clone);
  rebuildIndex();
  for (const c of contacts) persistToPostgresInBackground(c, "writeAllContacts");
  deleteFromPostgresInBackground(removedIds, "writeAllContacts");
}

// Equivalent of readJson+filter(id !== target)+writeJson -- delete one contact.
// Does NOT handle the cross-file cascade (conversation summary, message
// file, sqlite index) that contacts_backend.js's delete routes do today --
// callers must still do that themselves, exactly as they do now, this only
// replaces the CONTACTS_FILE half of that sequence.
export function deleteContact(id) { return deleteContacts([id]); }
export function deleteContacts(ids) {
  syncFromJsonIfChanged();
  const idSet = new Set(ids);
  writeJson(CONTACTS_FILE, readJson(CONTACTS_FILE, []).filter(c => !idSet.has(c.id)));
  markOwnWrite();
  _cache = _cache.filter(c => !idSet.has(c.id));
  rebuildIndex();
  deleteFromPostgresInBackground(ids, "deleteContacts");
}

export { pool as contactsPool };
