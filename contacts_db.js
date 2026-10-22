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
import { statSync, openSync, writeSync, closeSync, renameSync } from "fs";
import { threadId } from "worker_threads";
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

// ── Remote mode (worker threads) ──────────────────────────────────────────
// Until 2026-10-22 every worker thread called loadContactsCache() and held
// its own full copy of all contacts (~400MB per 148k contacts measured,
// x10 threads = most of the app's memory bill). A worker that calls
// useContactsFromPostgres() instead holds NO copy: every read is a
// synchronous Postgres query (contacts_pg_sync.js) and every write goes
// through the same durable queue as before. Same function names, same
// return shapes, so none of the call sites change.
//
// Read-your-own-writes: a write is queued, not committed, when the call
// returns -- so until it commits, the written rows sit in _overlay and
// every read on this thread is served from there first (exactly what the
// cache gave callers). Pending engagement/tag changes (coalesced for 5s,
// see queueContactEngagementUpdate) are applied on top of every read the
// same way. No LISTEN connection: there's no cache to keep fresh.
let _remote = null;           // querySync, when this thread runs in remote mode
const _overlay = new Map();   // id -> { c: contact | null (deleted), seq }
let _overlaySeq = 0;
let _pendingFull = null;      // writeAllContacts() snapshot until it commits
let _fullReadsLogged = 0;
const REMOTE_FIELD_COLUMNS = { id: "id", status: "status", email: "email", phone: "phone" };

export async function useContactsFromPostgres(label = String(threadId)) {
  const { sharedSyncQuery } = await import("./contacts_pg_sync.js");
  const querySync = sharedSyncQuery();
  // Usage line every 5 minutes (only when there was any), so the real cost
  // of remote mode on each worker is visible in the logs, not guessed.
  const stats = { queries: 0, ms: 0, full: 0, slowest: 0 };
  _remote = (sql, params) => {
    const t = Date.now();
    try { return querySync(sql, params); }
    finally { const ms = Date.now() - t; stats.queries++; stats.ms += ms; if (ms > stats.slowest) stats.slowest = ms; if (sql === "SELECT * FROM contacts") stats.full++; }
  };
  setInterval(() => {
    if (!stats.queries) return;
    console.log(`[contacts_db] remote usage (${label}, last 5m): ${stats.queries} queries, avg ${(stats.ms / stats.queries).toFixed(1)}ms, slowest ${stats.slowest}ms, full reads ${stats.full}`);
    Object.assign(stats, { queries: 0, ms: 0, full: 0, slowest: 0 });
  }, 5 * 60 * 1000).unref?.();
  _remote("SELECT 1"); // fail at startup, not on the first contact lookup
  _loaded = true;
  console.log("[contacts_db] remote mode: contacts read from Postgres on demand (no in-memory copy on this thread)");
}
export function contactsRemoteMode() { return !!_remote; }
// What every worker thread except background_worker.js calls at startup.
// WORKER_CONTACTS_CACHE=1 puts them back on a full per-thread copy (the
// pre-2026-10-22 behavior) without a code change, if remote mode ever
// misbehaves.
export async function initWorkerContacts(label) {
  if (process.env.WORKER_CONTACTS_CACHE === "1") return loadContactsCache();
  return useContactsFromPostgres(label);
}

function overlayPut(contacts) {
  const seq = ++_overlaySeq;
  for (const c of contacts) _overlay.set(c.id, { c: clone(c), seq });
  return seq;
}
function overlayDelete(ids) {
  const seq = ++_overlaySeq;
  for (const id of ids) _overlay.set(id, { c: null, seq });
  return seq;
}
// Once the queued write commits, Postgres has it -- drop the overlay entry,
// unless a later write to the same contact has replaced it meanwhile.
function overlayRelease(ids, seq, done) {
  Promise.resolve(done).finally(() => { for (const id of ids) if (_overlay.get(id)?.seq === seq) _overlay.delete(id); });
}
function applyPending(c) {
  const p = _pendingEngagement.get(c.id);
  if (p) {
    c.emailEngagement = c.emailEngagement || {};
    if (p.opened) { c.emailEngagement.opened = true; if (!c.emailEngagement.openedAt || new Date(p.openedAt) > new Date(c.emailEngagement.openedAt)) c.emailEngagement.openedAt = p.openedAt; }
    if (p.clicked) { c.emailEngagement.clicked = true; if (!c.emailEngagement.clickedAt || new Date(p.clickedAt) > new Date(c.emailEngagement.clickedAt)) c.emailEngagement.clickedAt = p.clickedAt; }
  }
  const t = _pendingTagChanges.get(c.id);
  if (t) {
    c.tags = c.tags || [];
    for (const a of t.add) if (!c.tags.includes(a)) c.tags.push(a);
    if (t.remove.size) c.tags = c.tags.filter(x => !t.remove.has(x));
  }
  return c;
}
function remoteRows(sql, params) { return _remote(sql, params).map(rowToContact); }
function remoteById(ids) {
  const out = new Map();
  const missing = [];
  for (const id of ids) {
    if (_pendingFull) { const c = _pendingFull.byId.get(id); if (c) out.set(id, clone(c)); continue; }
    const o = _overlay.get(id);
    if (o) { if (o.c) out.set(id, clone(o.c)); } else missing.push(id);
  }
  if (missing.length) for (const c of remoteRows("SELECT * FROM contacts WHERE id = ANY($1)", [missing])) out.set(c.id, c);
  for (const c of out.values()) applyPending(c);
  return out;
}
// Every contact -- one full SELECT. Only the rare whole-audience jobs on a
// worker should land here (campaign recipient resolution, AI Active's
// 5-minute top-up, daily segment triggers); logged so a hot path that
// starts doing this per event shows up in the logs immediately.
function remoteAll() {
  if (_fullReadsLogged < 50) {
    _fullReadsLogged++;
    const caller = (new Error().stack || "").split("\n").slice(3, 6).map(s => s.trim()).join(" <- ");
    console.log(`[contacts_db] remote full read (${_fullReadsLogged}/50 logged): ${caller}`);
  }
  let list;
  if (_pendingFull) list = _pendingFull.list.map(clone);
  else {
    list = remoteRows("SELECT * FROM contacts");
    if (_overlay.size) {
      const idx = new Map(list.map((c, i) => [c.id, i]));
      const deleted = new Set();
      for (const [id, o] of _overlay) {
        if (!o.c) { deleted.add(id); continue; }
        if (idx.has(id)) list[idx.get(id)] = clone(o.c); else list.push(clone(o.c));
      }
      if (deleted.size) list = list.filter(c => !deleted.has(c.id));
    }
  }
  if (_pendingEngagement.size || _pendingTagChanges.size) for (const c of list) if (_pendingEngagement.has(c.id) || _pendingTagChanges.has(c.id)) applyPending(c);
  return list;
}
// Contacts where contact[field] === value. id/status/email/phone are real
// columns; anything else falls back to a full read (no caller does that today).
function remoteByField(field, value) {
  const col = REMOTE_FIELD_COLUMNS[field];
  if (!col || _pendingFull) return remoteAll().filter(c => c[field] === value);
  const found = new Map();
  for (const c of remoteRows(`SELECT * FROM contacts WHERE ${col} = $1`, [value])) if (!_overlay.has(c.id)) found.set(c.id, applyPending(c));
  for (const [id, o] of _overlay) if (o.c && o.c[field] === value) found.set(id, applyPending(clone(o.c)));
  return [...found.values()];
}

function assertLoaded() {
  if (!_loaded) throw new Error("contacts_db: cache not loaded yet -- loadContactsCache() must be awaited at startup before any request touches contacts");
}

// ── Reads (sync) ──────────────────────────────────────────────────────────
export function getAllContacts() { assertLoaded(); return _remote ? remoteAll() : clone(_cache); }
// The live cache itself, NOT a copy -- read-only callers only (anything that
// mutates a returned contact would corrupt the cache). Used solely by the
// reports in report_worker.js's own process, where a full copy of all
// contacts per report was the single biggest memory cost.
export function getAllContactsNoCopy() { assertLoaded(); return _remote ? remoteAll() : _cache; }
export function getContactById(id) {
  assertLoaded();
  if (_remote) return id ? remoteById([id]).get(id) || null : null;
  return clone(_byId.get(id)) || null;
}
export function getContactsByIds(ids) {
  assertLoaded();
  if (_remote) { const found = remoteById([...new Set(ids)]); return ids.filter(id => found.has(id)).filter((id, i, a) => a.indexOf(id) === i).map(id => found.get(id)); }
  const set = new Set(ids); return clone(_cache.filter(c => set.has(c.id)));
}
export function findContactById(id) { return getContactById(id); } // alias for call sites that currently do contacts.find(c => c.id === id)

// First contact whose phone / altPhones / hyrosPhones ends in the same 10
// digits. Replaces sms_backend.js's getAllContacts().find(...) -- which
// deep-copied every contact just to match one inbound text's sender.
const last10 = (p) => String(p || "").replace(/\D/g, "").slice(-10);
function phoneMatches(c, digits) {
  return last10(c.phone) === digits || (c.altPhones || []).some(p => last10(p) === digits) || (c.hyrosPhones || []).some(p => last10(p) === digits);
}
export function findContactByPhoneDigits(phone) {
  assertLoaded();
  const digits = last10(phone);
  if (!digits) return null;
  if (!_remote) { const c = _cache.find(c => phoneMatches(c, digits)); return c ? clone(c) : null; }
  if (_pendingFull) return remoteAll().find(c => phoneMatches(c, digits)) || null;
  for (const o of _overlay.values()) if (o.c && phoneMatches(o.c, digits)) return applyPending(clone(o.c));
  // Primary phone first (indexed-ish, cheap); alt/hyros phones only when
  // that misses. Oldest contact wins a tie -- deterministic, where the
  // cache's answer depended on load order.
  const rows = remoteRows(
    `SELECT * FROM contacts WHERE right(regexp_replace(coalesce(phone,''), '\\D', '', 'g'), 10) = $1 ORDER BY created_at ASC NULLS LAST LIMIT 20`, [digits]
  );
  let c = rows.find(r => !_overlay.has(r.id));
  if (!c) {
    const alt = remoteRows(
      `SELECT * FROM contacts WHERE (extra ? 'altPhones' OR extra ? 'hyrosPhones')
         AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(coalesce(extra->'altPhones','[]'::jsonb) || coalesce(extra->'hyrosPhones','[]'::jsonb)) p
                     WHERE right(regexp_replace(p, '\\D', '', 'g'), 10) = $1)
       ORDER BY created_at ASC NULLS LAST LIMIT 20`, [digits]
    );
    c = alt.find(r => !_overlay.has(r.id) && phoneMatches(r, digits));
  }
  return c ? applyPending(c) : null;
}

// ── Targeted reads instead of getAllContacts() (2026-10-22) ────────────────
// With CONTACTS_STORE=pg the main thread and background_worker.js hold no
// copy either, so "all contacts, then filter in JS" becomes one of these.
// Same results in both modes: a `prefilter` ({ sql, params }, a WHERE clause
// over the contacts table using $1..$n) only narrows what's fetched -- it
// must match a SUPERSET of the contacts wanted, and the JS predicate the
// caller passes is still applied to every candidate, so it alone decides.

// Every contact (or every prefilter match) in chunks of CHUNK, never all of
// them in memory at once. Cache mode iterates the cache (copies, as always).
const CHUNK = 5000;
export function forEachContact(fn, prefilter) {
  assertLoaded();
  if (!_remote) { for (const c of _cache) fn(clone(c)); return; }
  if (_pendingFull) { for (const c of remoteAll()) fn(c); return; }
  const where = prefilter?.sql ? `AND (${prefilter.sql})` : "";
  const params = prefilter?.params || [];
  let after = "";
  for (;;) {
    const rows = _remote(`SELECT * FROM contacts WHERE id > $${params.length + 1} ${where} ORDER BY id LIMIT ${CHUNK}`, [...params, after]);
    for (const r of rows) { if (!_overlay.has(r.id)) fn(applyPending(rowToContact(r))); }
    if (rows.length < CHUNK) break;
    after = rows[rows.length - 1].id;
  }
  // Rows this thread wrote but Postgres hasn't committed yet.
  for (const o of _overlay.values()) if (o.c) fn(applyPending(clone(o.c)));
}
export function filterContacts(predicate, prefilter) {
  const out = [];
  forEachContact((c) => { if (predicate(c)) out.push(c); }, prefilter);
  return out;
}
// id -> contact for a list of ids (missing ids simply absent).
export function getContactsMapByIds(ids) {
  assertLoaded();
  const unique = [...new Set((ids || []).filter(Boolean))];
  if (!_remote) { const m = new Map(); for (const id of unique) { const c = _byId.get(id); if (c) m.set(id, clone(c)); } return m; }
  const m = new Map();
  for (let i = 0; i < unique.length; i += CHUNK) for (const [id, c] of remoteById(unique.slice(i, i + CHUNK))) m.set(id, c);
  return m;
}

// segments_shared.js's findContactMatch rule, without every contact in
// memory: email (or an alt / Hyros-origin email) or the last 10 phone
// digits (or an alt / Hyros phone). Postgres side uses the
// contact_identity_keys GIN index (ensureContactIndexes); the exact JS rule
// below still decides. Several matches: the oldest contact wins
// (deterministic -- the cache's answer depended on load order).
const lower = (s) => String(s || "").toLowerCase();
const lastTen = (p) => String(p || "").replace(/\D/g, "").slice(-10);
function matchesIdentity(c, normEmail, normPhone) {
  return (normEmail && lower(c.email) === normEmail && !!c.email) ||
    (normPhone && lastTen(c.phone) === normPhone) ||
    (normEmail && (c.altEmails || []).some(e => lower(e) === normEmail)) ||
    (normEmail && lower(c.hyrosOriginLead?.email) === normEmail && !!c.hyrosOriginLead?.email) ||
    (normPhone && (c.hyrosPhones || []).some(p => lastTen(p) === normPhone)) ||
    (normPhone && (c.altPhones || []).some(p => lastTen(p) === normPhone));
}
export function findContactMatchDb(email, phone) {
  assertLoaded();
  const normEmail = String(email || "").trim().toLowerCase();
  const normPhone = lastTen(phone);
  if (!normEmail && !normPhone) return null;
  if (!_remote) { const c = _cache.find(x => matchesIdentity(x, normEmail, normPhone)); return c ? clone(c) : null; }
  for (const o of _overlay.values()) if (o.c && matchesIdentity(o.c, normEmail, normPhone)) return applyPending(clone(o.c));
  const keys = [...(normEmail ? [`e:${normEmail}`] : []), ...(normPhone ? [`p:${normPhone}`] : [])];
  const rows = _remote(
    `SELECT * FROM contacts WHERE contact_identity_keys(email, phone, extra) && $1::text[] ORDER BY created_at NULLS LAST, id LIMIT 50`, [keys]
  );
  for (const r of rows) {
    if (_overlay.has(r.id)) continue;
    const c = rowToContact(r);
    if (matchesIdentity(c, normEmail, normPhone)) return applyPending(c);
  }
  return null;
}
// Gmail's sender lookup: the contact whose email or one of its altEmails is
// exactly this address (lowercase), or null.
export function findContactIdByEmailOrAlt(email) {
  const e = lower(email);
  if (!e) return null;
  const is = (c) => lower(c.email) === e || (c.altEmails || []).some(a => lower(a) === e);
  if (!_remote) return _cache.find(is)?.id || null;
  const hit = filterContacts(is, { sql: "contact_identity_keys(email, phone, extra) && $1::text[]", params: [[`e:${e}`]] });
  return hit[0]?.id || null;
}
// Contact whose externalIds[key] === value (importers' "already imported?").
export function findContactByExternalId(key, value) {
  assertLoaded();
  if (!value) return null;
  if (!_remote) { const c = _cache.find(x => x.externalIds?.[key] === value); return c ? clone(c) : null; }
  for (const o of _overlay.values()) if (o.c?.externalIds?.[key] === value) return applyPending(clone(o.c));
  const r = _remote(`SELECT * FROM contacts WHERE external_ids @> $1::jsonb ORDER BY created_at NULLS LAST, id LIMIT 5`, [JSON.stringify({ [key]: value })])
    .map(rowToContact).find(c => !_overlay.has(c.id) && c.externalIds?.[key] === value);
  return r ? applyPending(r) : null;
}
// Per-id counts of an array field (tags / listIds), plus how many of those
// contacts aren't email-opted-out -- the Contacts page's tag/list counts.
export function countArrayFieldValues(field) {
  assertLoaded();
  const col = { tags: "tags", listIds: "list_ids" }[field];
  if (!_remote || !col) {
    const counts = {};
    forEachContact((c) => { for (const v of c[field] || []) { const e = counts[v] || (counts[v] = { total: 0, subscribed: 0 }); e.total++; if (!c.emailOptOut) e.subscribed++; } });
    return counts;
  }
  const counts = {};
  for (const r of _remote(`SELECT v, count(*)::int AS total, count(*) FILTER (WHERE NOT email_opt_out)::int AS subscribed FROM contacts, unnest(${col}) AS v GROUP BY v`, [])) {
    counts[r.v] = { total: r.total, subscribed: r.subscribed };
  }
  return counts;
}
export function countContacts() {
  assertLoaded();
  return _remote ? Number(_remote(`SELECT count(*)::int AS n FROM contacts`, [])[0].n) : _cache.length;
}

// Indexes the targeted reads above rely on (idempotent; created without
// blocking writes). Run once by server.js when CONTACTS_STORE=pg.
export const CONTACT_INDEXES_SQL = [
  `CREATE OR REPLACE FUNCTION contact_identity_keys(email text, phone text, extra jsonb) RETURNS text[] LANGUAGE sql IMMUTABLE AS $f$
     SELECT coalesce(array_agg(DISTINCT k), '{}') FROM (
       SELECT 'e:' || lower(email) AS k WHERE coalesce(email, '') <> ''
       UNION ALL SELECT 'e:' || lower(x) FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(extra->'altEmails') = 'array' THEN extra->'altEmails' ELSE '[]'::jsonb END) x WHERE x <> ''
       UNION ALL SELECT 'e:' || lower(extra->'hyrosOriginLead'->>'email') WHERE coalesce(extra->'hyrosOriginLead'->>'email', '') <> ''
       UNION ALL SELECT 'p:' || right(regexp_replace(coalesce(phone, ''), '\\D', '', 'g'), 10) WHERE regexp_replace(coalesce(phone, ''), '\\D', '', 'g') <> ''
       UNION ALL SELECT 'p:' || right(regexp_replace(x, '\\D', '', 'g'), 10) FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(extra->'altPhones') = 'array' THEN extra->'altPhones' ELSE '[]'::jsonb END) x WHERE regexp_replace(x, '\\D', '', 'g') <> ''
       UNION ALL SELECT 'p:' || right(regexp_replace(x, '\\D', '', 'g'), 10) FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(extra->'hyrosPhones') = 'array' THEN extra->'hyrosPhones' ELSE '[]'::jsonb END) x WHERE regexp_replace(x, '\\D', '', 'g') <> ''
     ) keys $f$`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS contacts_identity_keys ON contacts USING gin (contact_identity_keys(email, phone, extra))`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS contacts_external_ids ON contacts USING gin (external_ids jsonb_path_ops)`,
];

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
  const seq = _remote ? overlayPut(snapshot) : 0;
  const done = enqueue(label, async (client) => { await upsertRows(client, snapshot); await notifyIds(client, "ids", snapshot.map(c => c.id)); });
  if (_remote) overlayRelease(snapshot.map(c => c.id), seq, done);
  return done;
}
function queueDelete(label, ids) {
  if (!ids.length) return;
  const seq = _remote ? overlayDelete(ids) : 0;
  const done = enqueue(label, async (client) => { await client.query("DELETE FROM contacts WHERE id = ANY($1)", [ids]); await notifyIds(client, "del", ids); });
  if (_remote) overlayRelease(ids, seq, done);
  return done;
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
  if (_remote) { queueUpsert("createContact", [contact]); return contact; }
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
  if (_remote) {
    const current = field === "id" ? getContactById(value) : remoteByField(field, value)[0] || null;
    if (!current) return null;
    const updated = updater(current);
    if (!updated) return null;
    queueUpsert("updateContactByField", [updated]);
    return clone(updated);
  }
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
  if (_remote) {
    const found = remoteById([...idSet]);
    for (const id of idSet) {
      const current = found.get(id);
      if (!current) continue;
      const updated = updater(current);
      if (updated === null) { deletedIds.push(id); continue; }
      if (!updated) continue;
      results.push(updated);
    }
    queueUpsert("updateContactsByIdSet", results);
    queueDelete("updateContactsByIdSet", deletedIds);
    return results.map(clone);
  }
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
  const matched = _remote ? remoteByField(field, value) : _cache.filter(c => c[field] === value);
  return updateContactsByIdSet(new Set(matched.map(c => c.id)), updater);
}

// Remove the given values from an array field on every contact that has
// any of them (e.g. a deleted tag/list id). Returns how many changed.
export function removeValuesFromContactsArrayField(fieldName, valuesToRemove) {
  assertLoaded();
  const removeSet = new Set(valuesToRemove);
  if (_remote) {
    const col = { tags: "tags", listIds: "list_ids" }[fieldName];
    const candidates = col && !_pendingFull
      ? [...remoteById(_remote(`SELECT id FROM contacts WHERE ${col} && $1::text[]`, [[...removeSet]]).map(r => r.id).concat([..._overlay.keys()])).values()]
      : remoteAll();
    const affected = candidates.filter(c => Array.isArray(c[fieldName]) && c[fieldName].some(v => removeSet.has(v)));
    for (const c of affected) c[fieldName] = c[fieldName].filter(v => !removeSet.has(v));
    queueUpsert("removeValuesFromContactsArrayField", affected);
    return affected.length;
  }
  const affected = _cache.filter(c => Array.isArray(c[fieldName]) && c[fieldName].some(v => removeSet.has(v)));
  for (const c of affected) c[fieldName] = c[fieldName].filter(v => !removeSet.has(v));
  queueUpsert("removeValuesFromContactsArrayField", affected);
  return affected.length;
}

// Bulk importer paths that build/modify a whole array and save it back in
// one shot. Other threads get a single "full" notification and reload.
export function writeAllContacts(contacts) {
  assertLoaded();
  if (_remote) {
    const newIds = new Set(contacts.map(c => c.id));
    const removedIds = remoteAll().filter(c => !newIds.has(c.id)).map(c => c.id);
    const list = contacts.map(clone);
    const full = { list, byId: new Map(list.map(c => [c.id, c])) };
    _pendingFull = full;
    const done = enqueue("writeAllContacts", async (client) => {
      await upsertRows(client, list);
      if (removedIds.length) await client.query("DELETE FROM contacts WHERE id = ANY($1)", [removedIds]);
      await notify(client, { full: 1 });
    });
    done.finally(() => { if (_pendingFull === full) _pendingFull = null; });
    return;
  }
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
  if (_remote) { queueDelete("deleteContacts", [...idSet]); return; }
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
  if (!_remote) {
    writeJson(CONTACTS_EXPORT_FILE, _cache);
    console.log(`[contacts_db] wrote ${CONTACTS_EXPORT_FILE} (${_cache.length} contacts)`);
    return true;
  }
  // No copy on this thread: stream the export out chunk by chunk, then
  // swap it into place in one rename.
  const tmp = `${p}.tmp${process.pid}_${Date.now()}`;
  const fd = openSync(tmp, "w");
  let n = 0, buf = [];
  const flush = () => { if (buf.length) { writeSync(fd, buf.join("")); buf = []; } };
  try {
    writeSync(fd, "[");
    forEachContact((c) => { buf.push((n++ ? "," : "") + JSON.stringify(c)); if (buf.length >= 2000) flush(); });
    flush();
    writeSync(fd, "]");
  } finally { closeSync(fd); }
  renameSync(tmp, p);
  console.log(`[contacts_db] wrote ${CONTACTS_EXPORT_FILE} (${n} contacts, streamed)`);
  return true;
}

// The lookup indexes CONTACT_INDEXES_SQL describes, built without blocking
// writes (CREATE INDEX CONCURRENTLY) and without blocking this thread
// (async, on the write pool). Safe to call on every boot.
export async function ensureContactIndexes() {
  for (const sql of CONTACT_INDEXES_SQL) {
    const t = Date.now();
    try { await pool.query(sql); }
    catch (e) { console.error("[contacts_db] index setup failed:", e.message); return; }
    if (Date.now() - t > 2000) console.log(`[contacts_db] built ${sql.match(/(contacts_\w+|contact_identity_keys)/)?.[1] || "index"} in ${((Date.now() - t) / 1000).toFixed(0)}s`);
  }
}

// rowToContact/contactToParams are the ONE definition of the contact
// shape on both sides of Postgres -- backchannel/contacts_pg.mjs imports
// them so a standalone script can never drift from what the app writes.
export { pool as contactsPool, rowToContact, contactToParams, COLUMNS as CONTACT_COLUMNS, CHANNEL as CONTACTS_CHANGED_CHANNEL };
