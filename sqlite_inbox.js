// Live-synced conversation-summary database for the Inbox sidebar. Reads
// this instead of parsing crm_conversation_index.json + crm_contacts.json
// (~470MB combined and growing) on every request -- see git history on
// inbox_backend.js for the numbers (JSON path: ~2.4-7s per request; this:
// ~0-150ms). Kept in sync incrementally, not by periodic rebuild:
//   - message_index.js's upsertConversationSummary/recomputeConversation
//     Summary/removeConversationSummary call syncMessageFields/deleteRow
//     here on every send/receive/status-change/delete, same trigger points
//     that already update crm_conversation_index.json.
//   - conversation_meta.js's setConvoMeta calls syncMetaFields here on
//     every pin/star/archive/done toggle.
//   - contacts_backend.js's PATCH handler calls syncContactFields here on
//     every status/type/name/email/assignment change.
// Every sync function is wrapped in try/catch by its caller's own
// discipline (see those files) so a bug here can never take down the
// actual send/receive/save it's piggybacking on -- worst case, that one
// row goes stale until the next thing touches it, not a lost message.
//
// build_db.mjs remains as a one-time/disaster-recovery full rebuild (e.g.
// if this file is ever deleted, or to reseed after restoring a JSON
// backup) -- not part of normal operation anymore.
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "fs";
import { join } from "path";
import { DATA_DIR, readJson } from "./auth_backend.js";
import { CONTACTS_FILE } from "./segments_shared.js";

// Declared locally rather than imported from scheduling_backend.js, which
// already imports syncContactFields from THIS file -- that import would be
// circular (same reasoning as auth_backend.js's own local FOOTER_TEMPLATES_FILE).
const BOOKINGS_FILE = "crm_bookings.json";
const DB_PATH = join(DATA_DIR, "crm_prototype.db");
let db = null;
export function sqliteInboxAvailable() {
  if (db) return true;
  if (!existsSync(DB_PATH)) return false;
  db = new DatabaseSync(DB_PATH);
  // Without this, a write from this connection can throw "database is
  // locked" immediately whenever anything else (an ad hoc one-off script
  // opening its own connection to the same file, a concurrent request)
  // holds the lock for even a moment -- confirmed live tonight running a
  // side script against this same file while the server was up. 5s is
  // generous for real contention to clear without hanging a request
  // indefinitely.
  db.exec("PRAGMA busy_timeout = 5000;");
  // WAL mode (2026-09-16): the main thread and background_worker.js each
  // open their own connection to this same file now (see BACKGROUND_WORKER
  // in server.js) -- genuinely concurrent OS threads, not just interleaved
  // async on one event loop like before. The default rollback-journal mode
  // takes an exclusive lock for the DURATION of any write, blocking every
  // other connection's reads too, not just other writers -- confirmed live
  // as a real cause of an otherwise-fast contact lookup (getContactByIdFast)
  // taking 1.3s, coinciding with the worker's own tick doing sqlite writes
  // at the same moment. WAL lets any number of readers proceed concurrently
  // with a single writer, which is exactly this two-connection shape.
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      key TEXT PRIMARY KEY, contact_id TEXT, display_name TEXT, first TEXT, last TEXT, email TEXT,
      status TEXT, program_type TEXT, owner_id TEXT,
      last_at_ms INTEGER, last_inbound_at_ms INTEGER, unread_count INTEGER,
      pinned INTEGER DEFAULT 0, starred INTEGER DEFAULT 0, archived INTEGER DEFAULT 0, done INTEGER DEFAULT 0,
      hidden INTEGER DEFAULT 0,
      last_channel TEXT, last_direction TEXT, last_preview TEXT, last_status TEXT, last_opened INTEGER,
      last_message_id TEXT, last_by_channel_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sort_default ON conversations(archived, pinned, last_inbound_at_ms);
    CREATE INDEX IF NOT EXISTS idx_sort_fallback ON conversations(archived, pinned, last_at_ms);
    CREATE INDEX IF NOT EXISTS idx_status ON conversations(status);
    CREATE INDEX IF NOT EXISTS idx_program_type ON conversations(program_type);
    CREATE INDEX IF NOT EXISTS idx_starred ON conversations(archived, starred);
    CREATE INDEX IF NOT EXISTS idx_unread ON conversations(archived, unread_count);
    CREATE INDEX IF NOT EXISTS idx_display_name ON conversations(display_name);
    CREATE INDEX IF NOT EXISTS idx_email ON conversations(email);
  `);
  // CREATE TABLE IF NOT EXISTS is a no-op against an already-existing table
  // from an earlier schema version (e.g. production's original build, made
  // before these columns existed) -- ALTER TABLE ADD COLUMN is what actually
  // evolves it without losing the already-populated rows. phone/first_seen_at
  // were a real regression, not just a later addition like owner_id: the
  // Inbox's chat panel silently lost the contact's phone (and "Since" date)
  // the moment this became the default read path, since neither ever made
  // it into this table's columns or the row-mapping code -- confirmed live
  // against a real contact with a phone on file that the panel showed no
  // phone for at all.
  const existingCols = new Set(db.prepare("PRAGMA table_info(conversations)").all().map(c => c.name));
  for (const col of ["owner_id", "phone", "first_seen_at"]) {
    if (!existingCols.has(col)) db.exec(`ALTER TABLE conversations ADD COLUMN ${col} TEXT`);
  }
  // Same "index has to come after the ALTER that adds the column" reasoning
  // as idx_hidden below -- owner_id had no index at all until the Inbox
  // sidebar's owner filter needed one; without it, filtering ~170k rows by
  // owner_id would be a full table scan on every request. Unconditional
  // (not gated on "just added the column" like the ALTER above) since
  // owner_id already exists on every real deployment by now -- CREATE INDEX
  // IF NOT EXISTS is a cheap no-op once it's there, same as every other
  // index in this function.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_owner_id ON conversations(owner_id)`);
  // hidden's own CREATE INDEX has to run down here too, AFTER the ALTER
  // TABLE that actually adds the column on an existing (pre-this-feature)
  // database -- confirmed live that bundling "CREATE INDEX ...(hidden)"
  // into the CREATE TABLE block above throws "no such column: hidden" on
  // any database where CREATE TABLE IF NOT EXISTS was a no-op (i.e. every
  // real deployment, since the table already existed long before this
  // column did), which safeSqliteSync's try/catch was swallowing silently
  // -- so hidden's ALTER TABLE never actually got reached at all.
  if (!existingCols.has("hidden")) {
    db.exec(`ALTER TABLE conversations ADD COLUMN hidden INTEGER DEFAULT 0`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_hidden ON conversations(hidden)`);
  }
  // Marks a row's last_preview as already correct -- see
  // queryConversationsSqlite's lazy-fix block below. Defaults to 0 (not
  // NULL) so every pre-existing row is treated as unfixed until it's
  // actually viewed, without needing a separate backfill pass over rows
  // nobody's looking at.
  if (!existingCols.has("preview_fixed")) {
    db.exec(`ALTER TABLE conversations ADD COLUMN preview_fixed INTEGER DEFAULT 0`);
  }
  // Renewal alerts (2026-09-19): renew_by_ms is the student's END DATE (UTC
  // midnight of that date; set by syncContactFields / backfillRenewalDates),
  // renew_ack is the alert level (1 orange / 2 pink) that was already
  // "handled" when the thread was last marked done -- so Mark Done clears the
  // alert but the step up to pink (1 month out) raises it again.
  if (!existingCols.has("renew_by_ms")) db.exec(`ALTER TABLE conversations ADD COLUMN renew_by_ms INTEGER`);
  if (!existingCols.has("renew_ack")) db.exec(`ALTER TABLE conversations ADD COLUMN renew_ack INTEGER DEFAULT 0`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_renew ON conversations(renew_by_ms)`);
  // Deliberately separate from `done`/unread_count -- viewing a thread and
  // responding to it are two different things (see inbox.html's
  // selectConversation comment): opening it should clear the per-row
  // unread badge/glow immediately, but must NOT move the conversation out
  // of Unresponded on its own, only an actual reply or explicit "Mark
  // Done" does that. NULL means never viewed (or viewed before any
  // inbound message existed) -- treated as "has something unseen" below
  // whenever there's a real inbound message, same as a fresh unread badge.
  if (!existingCols.has("last_seen_at_ms")) {
    db.exec(`ALTER TABLE conversations ADD COLUMN last_seen_at_ms INTEGER`);
  }
  // Per-user now (was a single shared last_seen_at_ms) -- {userId: ms} as
  // JSON, since a whole team seeing one shared "opened" flag meant the
  // glow cleared for everyone the instant ANY one person looked, not just
  // whoever actually opened it. last_seen_at_ms itself is left in place,
  // unused, rather than dropped -- SQLite can't cheaply drop a column on
  // older versions, and there's nothing else still reading it.
  if (!existingCols.has("last_seen_by_json")) {
    db.exec(`ALTER TABLE conversations ADD COLUMN last_seen_by_json TEXT`);
  }
  // Fast-path index for the Contacts page and single-contact lookups --
  // separate table from `conversations` above (which only has a row per
  // contact that's actually exchanged a message, and is missing tags/
  // listIds/type/emailOptOut/smsOptOut/createdAt entirely). GET /api/contacts
  // and GET /api/contacts/:id used to always fall back to a full
  // readJson(CONTACTS_FILE, []) -- a ~190MB JSON.parse -- on every single
  // request, confirmed live as the dominant cost behind Contacts (10+s) and
  // contact-detail (~5s) page loads. tags/listIds stay JSON text columns
  // (queried via json_each, confirmed available in node:sqlite) rather than
  // a join table -- simpler, and filtering by one tag/list is already rare
  // enough that an unindexed json_each scan over an otherwise-indexed,
  // already-narrowed row set is fine.
  db.exec(`
    CREATE TABLE IF NOT EXISTS contacts_idx (
      id TEXT PRIMARY KEY, type TEXT, account_name TEXT,
      first TEXT, last TEXT, email TEXT, phone TEXT,
      status TEXT, program_type TEXT, owner_id TEXT,
      email_opt_out INTEGER DEFAULT 0, sms_opt_out INTEGER DEFAULT 0,
      first_seen_at TEXT, created_at TEXT, updated_at TEXT,
      tags_json TEXT, list_ids_json TEXT, raw_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_ci_status ON contacts_idx(status);
    CREATE INDEX IF NOT EXISTS idx_ci_type ON contacts_idx(type);
    CREATE INDEX IF NOT EXISTS idx_ci_email_opt_out ON contacts_idx(email_opt_out);
    CREATE INDEX IF NOT EXISTS idx_ci_owner_id ON contacts_idx(owner_id);
    CREATE INDEX IF NOT EXISTS idx_ci_first ON contacts_idx(first);
    CREATE INDEX IF NOT EXISTS idx_ci_last ON contacts_idx(last);
    CREATE INDEX IF NOT EXISTS idx_ci_email ON contacts_idx(email);
    CREATE INDEX IF NOT EXISTS idx_ci_created_at ON contacts_idx(created_at);
  `);
  return true;
}

const toMs = (s) => { const t = s ? new Date(s).getTime() : NaN; return Number.isFinite(t) ? t : null; };
// Per-user "seen" lookup for the row's last_seen_by_json blob -- null (never
// seen by THIS user) whenever currentUserId is missing, unparseable, or
// simply has no entry yet, all of which correctly fall through to "treat as
// unseen" in the hasUnseen check below.
function lastSeenByMeMs(row, currentUserId) {
  if (!currentUserId) return null;
  try {
    const byUser = JSON.parse(row.last_seen_by_json || "{}");
    return toMs(byUser[currentUserId]);
  } catch { return null; }
}
// crm_bookings.json is tiny (production: a few dozen rows) -- one full read
// per conversation-list request, same cost class as getConvoMetaMap's own
// full-file read, not worth a real join/index over.
function upcomingBookedContactIds() {
  const now = Date.now();
  return new Set(
    readJson(BOOKINGS_FILE, [])
      .filter(b => b.status === "confirmed" && b.contactId && new Date(b.startAt).getTime() > now)
      .map(b => b.contactId)
  );
}

// message_index.js calls this with the same `g` group object it just wrote
// to crm_conversation_index.json (upsert or recompute) -- key/contactId/
// last/lastMine/lastInboundAt/unreadCount/lastByChannel, see its
// emptyGroup/foldMessageIntoGroup. A brand-new row (first message ever for
// this key) also needs contact fields seeded, since nothing else will --
// every later contact-field change goes through syncContactFields instead
// of re-reading contacts.json on every single message.
export function syncMessageFields(g) {
  if (!sqliteInboxAvailable()) return;
  const displayNameFallback = g.last ? (g.last.direction === "inbound" ? g.last.from : g.last.to) || "Unknown" : "Unknown";
  const exists = db.prepare("SELECT 1 FROM conversations WHERE key = ?").get(g.key);
  let contact = null;
  if (!exists && g.contactId) {
    contact = readJson(CONTACTS_FILE, []).find(c => c.id === g.contactId) || null;
  }
  const displayName = contact ? `${contact.first || ""} ${contact.last || ""}`.trim() || displayNameFallback : (exists ? undefined : displayNameFallback);
  db.prepare(`
    INSERT INTO conversations
      (key, contact_id, display_name, first, last, email, phone, first_seen_at, status, program_type, owner_id,
       last_at_ms, last_inbound_at_ms, unread_count,
       last_channel, last_direction, last_preview, last_status, last_opened, last_message_id, last_by_channel_json,
       preview_fixed, renew_by_ms)
    VALUES (:key, :contactId, :displayName, :first, :last, :email, :phone, :firstSeenAt, :status, :programType, :ownerId,
            :lastAtMs, :lastInboundAtMs, :unreadCount,
            :lastChannel, :lastDirection, :lastPreview, :lastStatus, :lastOpened, :lastMessageId, :lastByChannelJson,
            1, :renewByMs)
    ON CONFLICT(key) DO UPDATE SET
      last_at_ms=excluded.last_at_ms, last_inbound_at_ms=excluded.last_inbound_at_ms, unread_count=excluded.unread_count,
      last_channel=excluded.last_channel, last_direction=excluded.last_direction, last_preview=excluded.last_preview,
      last_status=excluded.last_status, last_opened=excluded.last_opened, last_message_id=excluded.last_message_id,
      last_by_channel_json=excluded.last_by_channel_json, preview_fixed=1
  `).run({
    key: g.key, contactId: g.contactId || null,
    displayName: displayName ?? displayNameFallback,
    first: contact?.first || null, last: contact?.last || null, email: contact?.email || null,
    phone: contact?.phone || null, firstSeenAt: contact?.firstSeenAt || null,
    status: contact?.status || null, programType: contact?.programType || null, ownerId: contact?.ownerId || null,
    lastAtMs: toMs(g.last?.createdAt), lastInboundAtMs: toMs(g.lastInboundAt), unreadCount: g.unreadCount || 0,
    lastChannel: g.last?.channel || null, lastDirection: g.last?.direction || null,
    // Body snippet, not the subject line -- see inbox_backend.js's JSON-
    // fallback path for the same fix/reasoning.
    lastPreview: g.last?.bodyPreview || g.last?.subject || "",
    lastStatus: g.lastMine?.status || null, lastOpened: g.lastMine?.opened ? 1 : 0,
    lastMessageId: g.last?.id || null, lastByChannelJson: JSON.stringify(g.lastByChannel || {}),
    renewByMs: contact ? endDateMsFromContact(contact) : null, // only used when this call CREATES the row (see ON CONFLICT above)
  });
}

// Fast contact-by-email lookup for gmail_backend.js's inbound poller --
// same reasoning as everything else in this file: avoids a full
// ~190MB CONTACTS_FILE read for the common case (a known lead, already
// with a conversation row, replying by email). Only ever a fallback
// source for existing conversations, not a full contacts index -- a
// contact with no messages yet has no row here and needs the real
// contacts-file lookup, same as the caller already accounts for.
export function findContactIdByEmail(email) {
  if (!sqliteInboxAvailable() || !email) return null;
  // Plain equality, not LOWER(email) = ? -- contact.email is already
  // lowercased at the source (newContactRecord's .toLowerCase()), so the
  // stored column is too. A LOWER()-wrapped column can't use idx_email
  // below (SQLite can't index a computed expression against a plain
  // column index -- exactly the mistake queryConversationsSqlite's ORDER
  // BY made, see that fix's comment); matching the already-normalized
  // form on both sides keeps this a real indexed lookup instead.
  const row = db.prepare("SELECT contact_id FROM conversations WHERE email = ? AND contact_id IS NOT NULL LIMIT 1").get(email.toLowerCase());
  return row?.contact_id || null;
}

// Bounded "who's actually been active recently" lookup -- used by
// ac_sync.js's catch-up instead of iterating every AC-linked contact
// (160,623 of them, checked live) to find who a recent send would
// plausibly have touched.
export function getRecentlyActiveContactIds(sinceMs) {
  if (!sqliteInboxAvailable()) return [];
  return db.prepare("SELECT contact_id FROM conversations WHERE contact_id IS NOT NULL AND last_at_ms > ?").all(sinceMs).map(r => r.contact_id);
}

export function deleteConversationRow(key) {
  if (!sqliteInboxAvailable()) return;
  db.prepare("DELETE FROM conversations WHERE key = ?").run(key);
}

// ── Renewal alerts ─────────────────────────────────────────────────────
// An ENROLLED student whose END DATE (the "END DATE" contact custom field, set
// from the kickoff form) is within 2 months gets an orange alert, within 1
// month a pink one. The alert stays through the end date and for 30 days
// after (a student who's just lapsed still needs the conversation); beyond
// that they're treated as gone, so an old, never-updated ENROLLED contact
// with a long-past end date can't flood Unresponded.
const DAY_MS = 86400000;
function alaskaTodayMs() {
  return Date.parse(new Intl.DateTimeFormat("en-CA", { timeZone: "America/Anchorage" }).format(new Date()) + "T00:00:00Z");
}
function addMonthsMs(ms, n) {
  const d = new Date(ms), day = d.getUTCDate();
  d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + n);
  const dim = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, dim));
  return d.getTime();
}
export function renewalWindow() {
  const today = alaskaTodayMs();
  return { lo: today - 30 * DAY_MS, orange: addMonthsMs(today, 2), pink: addMonthsMs(today, 1) };
}
// 0 = no alert, 1 = orange (<= 2 months), 2 = pink (<= 1 month)
export function renewalLevel(status, renewByMs, win = renewalWindow()) {
  if (status !== "ENROLLED" || renewByMs == null) return 0;
  if (renewByMs < win.lo || renewByMs > win.orange) return 0;
  return renewByMs <= win.pink ? 2 : 1;
}
// The end date is a plain text custom field, so people (or the kickoff form's
// date picker) may have produced ISO, m/d/yyyy, or "Sep 11, 2027".
export function parseEndDateMs(text) {
  const t = String(text ?? "").trim();
  if (!t) return null;
  let y, m, d, mt;
  if ((mt = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(t))) { y = +mt[1]; m = +mt[2]; d = +mt[3]; }
  else if ((mt = /^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/.exec(t))) { y = +mt[3]; m = +mt[1]; d = +mt[2]; if (m > 12) { const x = m; m = d; d = x; } }
  else { const dt = new Date(t + " 12:00 UTC"); if (isNaN(dt)) return null; return Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate()); }
  const ms = Date.UTC(y, m - 1, d);
  const chk = new Date(ms);
  return chk.getUTCFullYear() === y && chk.getUTCMonth() === m - 1 && chk.getUTCDate() === d ? ms : null;
}
function endDateFieldId() {
  const defs = readJson("crm_custom_fields.json", []);
  return defs.find(f => f.entityType === "contact" && String(f.label).trim().toUpperCase() === "END DATE")?.id || null;
}
function endDateMsFromContact(contact, fieldId = endDateFieldId()) {
  const cf = contact?.customFields || {};
  // the field definition first; the kickoff form also stores the raw answer under its code
  return parseEndDateMs((fieldId && cf[fieldId]) || cf.end_date);
}
// The same alert, computed from a full contact record -- attached (never stored) to every contact
// the API returns (contacts_backend.js's publicContact), so the Contacts table, the contact page,
// the Inbox contact popup and a chat opened by deep link can all show it without their own maths.
let _endFieldCache = { at: 0, id: null };
function endDateFieldIdCached() {
  if (Date.now() - _endFieldCache.at > 30000) _endFieldCache = { at: Date.now(), id: endDateFieldId() };
  return _endFieldCache.id;
}
export function renewalForContact(contact, win) {
  if (!contact || contact.status !== "ENROLLED") return null; // cheap early-out: the full list endpoint calls this for every contact
  const ms = endDateMsFromContact(contact, endDateFieldIdCached());
  const level = renewalLevel(contact.status, ms, win || renewalWindow());
  return level ? { level: level === 2 ? "pink" : "orange", endDate: new Date(ms).toISOString().slice(0, 10) } : null;
}
// Run at boot -- every contact that already has an end date gets its row
// stamped without waiting for something to touch that contact.
export function backfillRenewalDates(contacts) {
  if (!sqliteInboxAvailable()) return 0;
  const fieldId = endDateFieldId();
  // ONE pass to load contact_id -> rows, then update by primary key ONLY where the value differs.
  // The previous "UPDATE ... WHERE contact_id = :id" per contact scanned the whole ~175k-row
  // table each time (no index on contact_id; contacts with no conversation cost a FULL scan):
  // with ~1,100 end dates that added ~2 minutes to every boot (2026-09-20 outages).
  const rowsByContact = new Map();
  for (const r of db.prepare("SELECT key, contact_id, renew_by_ms FROM conversations WHERE contact_id IS NOT NULL").all()) {
    (rowsByContact.get(r.contact_id) || rowsByContact.set(r.contact_id, []).get(r.contact_id)).push(r);
  }
  const upd = db.prepare("UPDATE conversations SET renew_by_ms = :ms WHERE key = :key");
  let n = 0;
  db.exec("BEGIN");
  try {
    for (const c of contacts) {
      const ms = endDateMsFromContact(c, fieldId);
      if (ms == null) continue;
      for (const row of rowsByContact.get(c.id) || []) if (row.renew_by_ms !== ms) { upd.run({ ms, key: row.key }); n++; }
    }
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
  return n;
}

// conversation_meta.js's setConvoMeta -- pin/star/archive/done. Silently
// no-ops if this contact has no conversation row yet (meta can be set
// before any message exists in some flows) -- syncMessageFields will pick
// up meta-independent fields on the eventual first message; a meta value
// set before that point is only ever readable/writable via the JSON path
// until then, an acceptable gap since the Inbox has nothing to show for a
// contact with zero messages anyway.
export function syncMetaFields(contactId, meta) {
  if (!sqliteInboxAvailable()) return;
  db.prepare(`
    UPDATE conversations SET pinned = :pinned, starred = :starred, archived = :archived, done = :done, hidden = :hidden, last_seen_by_json = :lastSeenByJson
    WHERE contact_id = :contactId
  `).run({
    contactId,
    pinned: meta.pinned ? 1 : 0, starred: meta.starred ? 1 : 0,
    archived: meta.archived ? 1 : 0, done: meta.done ? 1 : 0, hidden: meta.hidden ? 1 : 0,
    lastSeenByJson: JSON.stringify(meta.lastSeenBy || {}),
  });
  const rn = db.prepare("SELECT status, renew_by_ms FROM conversations WHERE contact_id = ?").get(contactId);
  if (rn && rn.renew_by_ms != null) {
    db.prepare("UPDATE conversations SET renew_ack = :ack WHERE contact_id = :contactId").run({ ack: meta.done ? renewalLevel(rn.status, rn.renew_by_ms) : 0, contactId });
  }
}

// contacts_backend.js's PATCH -- status/type/name/email/assignment. Same
// no-op-if-no-row reasoning as syncMetaFields above.
export function syncContactFields(contactId, contact) {
  if (!sqliteInboxAvailable()) return;
  const displayName = `${contact.first || ""} ${contact.last || ""}`.trim() || "Unknown";
  db.prepare(`
    UPDATE conversations SET display_name = :displayName, first = :first, last = :last, email = :email,
      phone = :phone, first_seen_at = :firstSeenAt,
      status = :status, program_type = :programType, owner_id = :ownerId, renew_by_ms = :renewByMs
    WHERE contact_id = :contactId
  `).run({
    contactId, displayName, renewByMs: endDateMsFromContact(contact),
    first: contact.first || null, last: contact.last || null, email: contact.email || null,
    phone: contact.phone || null, firstSeenAt: contact.firstSeenAt || null,
    status: contact.status || null, programType: contact.programType || null, ownerId: contact.ownerId || null,
  });
  // Every call site above already exists (see commit 9268cc6's audit of
  // every writeJson(CONTACTS_FILE, ...) call in the app) -- piggybacking
  // the Contacts-page index on the exact same call sites instead of
  // touching each one a second time.
  upsertContactIndex(contact);
}

// syncContactFields for many contacts in ONE transaction. Each call above is
// two autocommitted statements, i.e. two fsyncs -- ~40ms each on the volume, so
// 1,600 contacts froze the whole server for ~140s (2026-09-21). One
// transaction pays that fsync once.
export function syncContactFieldsBatch(contacts) {
  if (!sqliteInboxAvailable() || !contacts?.length) return;
  db.exec("BEGIN");
  try {
    for (const c of contacts) syncContactFields(c.id, c);
    db.exec("COMMIT");
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch { /* nothing open */ }
    throw e;
  }
}

// contacts_idx mirrors the Contacts page's own filter/sort/search needs --
// see its CREATE TABLE comment above. raw_json is the full stored record
// (customFields, externalIds, tags, listIds, etc, everything a single
// GET /api/contacts/:id needs), so a lookup by id never has to reconstruct
// a contact from flattened columns.
export function upsertContactIndex(contact) {
  if (!sqliteInboxAvailable() || !contact?.id) return;
  db.prepare(`
    INSERT INTO contacts_idx (id, type, account_name, first, last, email, phone, status, program_type, owner_id,
      email_opt_out, sms_opt_out, first_seen_at, created_at, updated_at, tags_json, list_ids_json, raw_json)
    VALUES (:id, :type, :accountName, :first, :last, :email, :phone, :status, :programType, :ownerId,
      :emailOptOut, :smsOptOut, :firstSeenAt, :createdAt, :updatedAt, :tagsJson, :listIdsJson, :rawJson)
    ON CONFLICT(id) DO UPDATE SET
      type = excluded.type, account_name = excluded.account_name, first = excluded.first, last = excluded.last,
      email = excluded.email, phone = excluded.phone, status = excluded.status, program_type = excluded.program_type,
      owner_id = excluded.owner_id, email_opt_out = excluded.email_opt_out, sms_opt_out = excluded.sms_opt_out,
      first_seen_at = excluded.first_seen_at, created_at = excluded.created_at, updated_at = excluded.updated_at,
      tags_json = excluded.tags_json, list_ids_json = excluded.list_ids_json, raw_json = excluded.raw_json
  `).run({
    id: contact.id, type: contact.type || null, accountName: contact.accountName || null,
    first: contact.first || null, last: contact.last || null, email: contact.email || null, phone: contact.phone || null,
    status: contact.status || null, programType: contact.programType || null, ownerId: contact.ownerId || null,
    emailOptOut: contact.emailOptOut ? 1 : 0, smsOptOut: contact.smsOptOut ? 1 : 0,
    firstSeenAt: contact.firstSeenAt || null, createdAt: contact.createdAt || null, updatedAt: contact.updatedAt || null,
    tagsJson: JSON.stringify(contact.tags || []), listIdsJson: JSON.stringify(contact.listIds || []),
    rawJson: JSON.stringify(contact),
  });
}
export function deleteContactIndex(id) {
  if (!sqliteInboxAvailable() || !id) return;
  db.prepare(`DELETE FROM contacts_idx WHERE id = ?`).run(id);
}
export function contactsIndexCount() {
  if (!sqliteInboxAvailable()) return 0;
  return db.prepare(`SELECT COUNT(*) as n FROM contacts_idx`).get().n;
}
// One-time bulk populate -- everything above only ever upserts ONE contact
// per call, so without this, every contact that existed before this
// feature shipped (i.e. all ~176k of them in production) would simply be
// missing from the index until something happens to individually touch
// it. Runs inside the already-running server process (a separate one-off
// script sharing this container with the live server was confirmed live
// to destabilize it -- see compliance_backend.js's status-migration
// history for the exact incident), in one transaction so 176k inserts pay
// SQLite's per-transaction fsync cost once, not 176k times.
export function backfillContactsIndex(contacts) {
  if (!sqliteInboxAvailable()) return 0;
  db.exec("BEGIN");
  try {
    for (const c of contacts) upsertContactIndex(c);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return contacts.length;
}

// Bulk companion to syncContactFields above -- renaming a status definition
// in Settings (statuses_backend.js) cascades across every contact holding
// the old label, which for a status like STOP can be tens of thousands of
// rows. One set-based UPDATE instead of a syncContactFields() call per
// contact, since contact.status is a free-standing string copy, not a
// foreign key, on both the contacts.json side AND this denormalized column.
export function renameStatusInSqlite(oldLabel, newLabel) {
  if (!sqliteInboxAvailable()) return;
  db.prepare(`UPDATE conversations SET status = :newLabel WHERE status = :oldLabel`).run({ oldLabel, newLabel });
}

// One-time repair: a side script resyncing ~29k rows tonight (the STOP
// status recovery) ran against this same file from a SEPARATE process
// while the server was up, and "database is locked" from that contention
// made most of those syncContactFields() calls silently fail (caught,
// logged, swallowed -- by design, so a sync bug never takes down the
// actual save it's piggybacking on, but that also means it never retried).
// This runs from INSIDE the server's own connection instead -- no cross-
// process contention possible -- and only touches rows still showing the
// stale "STOP" value, pulling each one's real current status from
// contacts.json. Safe to call repeatedly; a no-op once nothing's left.
// Time-budgeted, same reasoning as every other scheduler batch job in this
// app -- confirmed live tonight that an unbounded version of this (every
// stale row, one call) could run long enough to stall the whole tick
// behind it under real write contention on this same table.
const STALE_ROW_REPAIR_BATCH_MS = 8000;
const STALE_ROW_REPAIR_LIMIT = 300;
// Shared by every "bulk status reassignment happened in contacts.json,
// SQLite's denormalized copy needs to catch up" repair -- takes whichever
// OLD label(s) are now stale and fixes rows still showing one of them,
// batched/time-budgeted for the same reason as every other scheduler job
// here (see resyncStaleStopRows's own history: an unbounded version of
// this stalled a whole tick under real write contention).
function resyncRowsWithStaleStatus(staleLabels, logTag, includeNull) {
  if (!sqliteInboxAvailable()) return;
  const placeholders = staleLabels.map(() => "?").join(",");
  // syncContactFields writes `contact.status || null` -- a blank
  // contact.status ("") lands in this column as NULL, not "", so matching
  // blank-status rows needs an explicit IS NULL, not just IN (...).
  const nullClause = includeNull ? " OR status IS NULL" : "";
  const staleRows = db.prepare(`SELECT contact_id FROM conversations WHERE status IN (${placeholders})${nullClause} LIMIT ${STALE_ROW_REPAIR_LIMIT}`).all(...staleLabels);
  if (!staleRows.length) return; // the common case forever after this repair actually finishes
  const contactsById = new Map(readJson(CONTACTS_FILE, []).map(c => [c.id, c]));
  const t0 = Date.now();
  let fixed = 0, missing = 0;
  for (const row of staleRows) {
    if (Date.now() - t0 > STALE_ROW_REPAIR_BATCH_MS) break;
    const c = contactsById.get(row.contact_id);
    if (!c) { missing++; continue; }
    syncContactFields(c.id, c);
    fixed++;
  }
  console.log(`[sqlite-repair:${logTag}] this batch: ${staleRows.length} fetched, fixed: ${fixed}, missing contact: ${missing}`);
}
export function resyncStaleStopRows() { resyncRowsWithStaleStatus(["STOP"], "stop", false); }
// The other legacy Close labels that were never real status definitions
// (SMS WE SENT LAST, SMS THEY REPLIED, POTENTIAL RE-ADD, a couple of
// date-stamped one-off campaign markers, TINY KIDS, a stray "Customer",
// and blank) -- reassigned in contacts.json to BLACKLIST (the "BAD FIT /
// BLACKLIST" ones) or POTENTIAL (everything else), same cascade gap as
// every other status cleanup tonight if this denormalized copy weren't
// also fixed.
export function resyncStaleLegacyLabelRows() {
  resyncRowsWithStaleStatus(
    ["BAD FIT / BLACKLIST", "SMS WE SENT LAST", "SMS THEY REPLIED", "POTENTIAL RE-ADD",
      "2ND TEXT SENT 2021-10-8", "TINY KIDS", "1st TEXT SENT b", "Customer"],
    "legacy-labels", true
  );
}

// last_preview switched from subject-first to body-first (see inbox_
// backend.js's own comment), but existing rows keep whatever was already
// stored until something touches them. Rather than sweep all ~176k rows
// up front (that read every contact's message file whether or not anyone
// ever looks at that conversation, and contends with live traffic's own
// disk I/O for as long as it takes), each row is fixed lazily the first
// time it's actually returned by a query -- see the preview_fixed check in
// queryConversationsSqlite below. A conversation nobody opens never costs
// anything; one that's on-screen gets corrected (and cached) the moment
// it's requested, same as scrolling the sidebar naturally would.
const SIDEBAR_CHANNELS = new Set(["email", "sms", "form", "booking", "activity", "meeting"]);
function computeLastPreview(contactId) {
  const msgs = readJson(`msg_by_contact/${contactId}.json`, []);
  const sidebarMsgs = msgs.filter((m) => SIDEBAR_CHANNELS.has(m.channel));
  if (!sidebarMsgs.length) return null;
  const last = sidebarMsgs.reduce((a, b) => (new Date(b.createdAt) > new Date(a.createdAt) ? b : a));
  return last.bodyPreview || last.subject || "";
}

// Mirrors GET /api/inbox/conversations' filter/sort/pagination contract in
// inbox_backend.js -- see that handler for what each param means. Returns
// the same {conversations, total, hasMore} shape so the frontend needs zero
// changes to consume either path.
export function queryConversationsSqlite({ channel, statusFilter, typeFilter, ownerFilter, bucket, sortDir, search, limit, offset, currentUserId }) {
  if (!sqliteInboxAvailable()) return null;

  const where = [];
  const params = {};
  const renewWin = renewalWindow();
  // Hidden (blacklisted contacts, set via compliance_backend.js's
  // applyStatusOptOut -- permanent, no reverse trigger) is its own
  // dedicated bucket, kept separate from generic "archived" so a plain
  // manually-archived conversation and a blacklisted one don't blend into
  // the same tab.
  if (bucket === "hidden") { where.push("hidden = 1"); }
  else if (bucket === "archived") { where.push("archived = 1", "hidden = 0"); }
  else {
    // Unresponded enforces archived/hidden inside its own subquery below. Repeating them out here
    // makes SQLite drive the query off idx_sort_default (a full scan) instead of the key list.
    if (bucket !== "unresponded") where.push("archived = 0", "hidden = 0");
    if (bucket === "done") where.push("done = 1");
    else if (bucket === "unresponded") {
      // Unread inbound OR an ENROLLED student inside the renewal window whose alert
      // hasn't been handled (not marked done, or the alert has since stepped up to pink).
      // Two indexed lookups unioned into a key list (idx_unread / idx_renew), NOT a plain
      // "unread_count > 0 OR ..." -- that OR stops SQLite using either index and made this
      // (the default) view scan the whole ~170k-row table: measured ~255ms vs ~0ms.
      where.push("key IN (SELECT key FROM conversations WHERE archived = 0 AND hidden = 0 AND unread_count > 0 UNION SELECT key FROM conversations INDEXED BY idx_renew WHERE renew_by_ms BETWEEN :renewLo AND :renewOrange AND status = 'ENROLLED' AND archived = 0 AND hidden = 0 AND (done = 0 OR renew_ack < (CASE WHEN renew_by_ms <= :renewPink THEN 2 ELSE 1 END)))");
      params.renewLo = renewWin.lo; params.renewOrange = renewWin.orange; params.renewPink = renewWin.pink;
    }
    else if (bucket === "favorites") where.push("starred = 1");
  }
  if (statusFilter) { where.push("status = :status"); params.status = statusFilter; }
  if (typeFilter) { where.push("program_type = :programType"); params.programType = typeFilter; }
  // "unassigned" (empty/NULL owner_id) vs a specific user id -- so a coach
  // like Josh can filter the sidebar down to exactly his own leads.
  if (ownerFilter === "unassigned") { where.push("(owner_id IS NULL OR owner_id = '')"); }
  else if (ownerFilter) { where.push("owner_id = :ownerId"); params.ownerId = ownerFilter; }
  if (search) { where.push("LOWER(display_name) LIKE :search"); params.search = `%${search.toLowerCase()}%`; }
  // Channel filter changes which message counts as "last" for a row -- only
  // conversations with at least one message on that channel qualify, and
  // the JSON-per-channel snapshot (last_by_channel_json) stands in for
  // `last` when present. json_extract can't use a plain index, so this path
  // is the one case here that's O(matching rows scanned) rather than O(page
  // size) -- fine for now, worth a dedicated column later if it's hot.
  if (channel) { where.push("json_extract(last_by_channel_json, :channelPath) IS NOT NULL"); params.channelPath = `$.${channel}`; }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  // Same tie-break intent as the JS comparator this replaces: pinned always
  // first; among the rest, conversations with a real inbound reply sort by
  // that reply's time, newest/oldest per sortDir.
  //
  // Plain columns, NOT a computed expression (this used to be `ORDER BY
  // pinned DESC, (last_inbound_at_ms IS NULL) ASC, COALESCE(last_inbound_at_ms,
  // last_at_ms) DESC`) -- confirmed live via EXPLAIN QUERY PLAN that SQLite
  // can't use idx_sort_default/idx_sort_fallback to satisfy an ORDER BY
  // built from IS NULL/COALESCE, so it fell back to "USE TEMP B-TREE FOR
  // ORDER BY": sorting the ENTIRE ~170k-row matching set from scratch on
  // every single request regardless of LIMIT, measured live at 3-5.6s+
  // (this is what made the Inbox sidebar "take 30 seconds to load" --
  // exactly the JSON-fold cost this table exists to avoid, paid again
  // anyway). last_inbound_at_ms DESC already puts NULLs (no reply yet)
  // last on its own -- SQLite's default NULL ordering does the "never-
  // replied sorts after every real reply" job the IS NULL term used to do,
  // for free, in whichever direction dir is. last_at_ms as the tie-break
  // sub-sorts within a shared last_inbound_at_ms value (including the
  // NULL group) instead of leaving same-value rows in arbitrary order --
  // confirmed via EXPLAIN QUERY PLAN this uses idx_sort_default for the
  // pinned+last_inbound_at_ms part and only needs a (cheap, small-group)
  // temp sort for that last tie-break column, not a full-table one.
  const dir = sortDir === "oldest" ? "ASC" : "DESC";
  const orderSql = `ORDER BY pinned DESC, last_inbound_at_ms ${dir}, last_at_ms ${dir}`;

  const total = db.prepare(`SELECT COUNT(*) as n FROM conversations ${whereSql}`).get(params).n;
  // LIMIT/OFFSET as bound params (rather than literal ints) defeats SQLite's
  // "keep only the top-K rows while sorting" optimization -- with the value
  // unknown at prepare time, it sorted the WHOLE matching set first instead
  // (confirmed live: ~6s vs ~0.1s for the identical query, literal vs bound).
  // Safe to inline here since limit/offset are already clamped ints from the
  // caller (Math.min/Math.max/parseInt above), never raw request text.
  const safeLimit = Math.max(1, Math.min(200, Math.trunc(limit) || 40));
  const safeOffset = Math.max(0, Math.trunc(offset) || 0);
  const rows = db.prepare(`
    SELECT * FROM conversations ${whereSql} ${orderSql} LIMIT ${safeLimit} OFFSET ${safeOffset}
  `).all(params);

  // Lazy preview-text fix, scoped to just this page (at most safeLimit
  // rows, never the whole table) -- see computeLastPreview's comment.
  const fixes = [];
  for (const r of rows) {
    if (r.preview_fixed || !r.contact_id) continue;
    const correctPreview = computeLastPreview(r.contact_id);
    if (correctPreview === null) continue;
    r.last_preview = correctPreview;
    fixes.push({ contactId: r.contact_id, preview: correctPreview });
  }
  if (fixes.length) {
    const upd = db.prepare("UPDATE conversations SET last_preview = :preview, preview_fixed = 1 WHERE contact_id = :contactId");
    db.exec("BEGIN");
    for (const f of fixes) upd.run({ preview: f.preview, contactId: f.contactId });
    db.exec("COMMIT");
  }

  const bookedContactIds = upcomingBookedContactIds();
  const conversations = rows.map(r => {
    let last = null;
    if (channel) {
      try { last = JSON.parse(r.last_by_channel_json || "{}")[channel]; } catch { last = null; }
    }
    const lastSeenMs = lastSeenByMeMs(r, currentUserId);
    const rLevel = r.contact_id ? renewalLevel(r.status, r.renew_by_ms, renewWin) : 0;
    const renewal = rLevel ? { level: rLevel === 2 ? "pink" : "orange", endDate: new Date(r.renew_by_ms).toISOString().slice(0, 10), unhandled: !r.done || (r.renew_ack || 0) < rLevel } : null;
    return {
      key: r.key, contactId: r.contact_id, renewal,
      hasUpcomingBooking: !!r.contact_id && bookedContactIds.has(r.contact_id),
      contact: r.contact_id ? { status: r.status, programType: r.program_type, email: r.email, phone: r.phone, firstSeenAt: r.first_seen_at, first: r.first, last: r.last, ownerId: r.owner_id, renewal } : null,
      displayName: r.display_name,
      lastChannel: last?.channel || r.last_channel, lastDirection: last?.direction || r.last_direction,
      lastPreview: last?.bodyPreview || last?.subject || r.last_preview,
      lastAt: last?.createdAt || (r.last_at_ms ? new Date(r.last_at_ms).toISOString() : null),
      lastInboundAt: r.last_inbound_at_ms ? new Date(r.last_inbound_at_ms).toISOString() : null,
      lastMessageId: last?.id || r.last_message_id,
      // Hidden (blacklisted) conversations never show an unread badge --
      // see the "hidden" bucket comment above and inbox_backend.js's
      // matching JSON-fallback path.
      unreadCount: r.hidden ? 0 : r.unread_count,
      // Separate from unreadCount/done -- drives just the per-row visual
      // badge/glow, cleared the moment THIS user opens the conversation
      // (inbox.html's /opened call stamps last_seen_by_json[currentUserId]),
      // whether or not it's actually been responded to, and independent of
      // whether some OTHER teammate has already looked at it -- each
      // person's own glow only clears for themselves. true whenever there's
      // a real inbound message that showed up at or after the last time
      // THIS user looked (or they've never looked at all).
      hasUnseen: !r.hidden && !!r.last_inbound_at_ms && (lastSeenMs == null || r.last_inbound_at_ms > lastSeenMs),
      pinned: !!r.pinned, starred: !!r.starred, archived: !!r.archived, done: !!r.done,
      lastStatus: r.last_status, lastOpened: !!r.last_opened,
    };
  });
  return { conversations, total, hasMore: offset + limit < total };
}

// Trivial indexed lookup by primary key -- turns contact-detail.html's
// ~5s single-contact load (a full readJson(CONTACTS_FILE, []).find(...)
// linear scan over ~190MB) into effectively instant. raw_json is the exact
// stored contact record, so the caller gets back the identical shape a
// readJson+find would have.
export function getContactByIdSqlite(id) {
  if (!sqliteInboxAvailable() || !id) return undefined;
  const row = db.prepare(`SELECT raw_json FROM contacts_idx WHERE id = ?`).get(id);
  if (!row) return null;
  try { return JSON.parse(row.raw_json); } catch { return null; }
}
// For scheduler jobs that only ever need to resolve a handful of specific
// contact ids (a due meeting/booking/AI-outreach-batch's own contactId) --
// meetings_backend.js's checkMeetingReminders, scheduling_backend.js's
// sendDueBookingReminders, and ai_active_backend.js's processAiActiveBatches
// each used to independently readJson(CONTACTS_FILE, []) (~190MB,
// synchronous, blocks the single Node thread) on every ~30s tick just to
// build a Map for a few lookups. Confirmed live via Railway logs this was a
// direct cause of multi-second stalls on unrelated concurrent requests
// (e.g. an Inbox reply landing mid-tick). Falls back to a plain find() over
// the full file only if SQLite indexing genuinely isn't available --
// production always has it (same index the Contacts page's own search/
// filter/sort already depends on), so this fallback exists for
// environment-safety, not as a real expected path.
export function getContactByIdFast(id) {
  if (sqliteInboxAvailable()) return getContactByIdSqlite(id);
  return readJson(CONTACTS_FILE, []).find(c => c.id === id) || null;
}

// For a caller that needs MANY specific contacts at once (a whole review
// queue's worth of rows, not "the one contact this request is about") --
// confirmed live (2026-09-16): duplicates_backend.js's GET /api/duplicates
// and /api/duplicates/visitor-matches call getContactByIdFast once PER
// PENDING ROW, and with 3,682 pending visitor matches + 1,486 pending
// duplicate pairs sitting unreviewed in production, that's thousands of
// separate SQLite round trips per page load -- individually fast, but the
// per-query overhead adds up to roughly the same multi-second cost the
// full-file scan this replaced had, just moved to different code. One
// batched `WHERE id IN (...)` query does the same lookups in a single
// round trip. Chunked at 500 ids/query -- SQLite's default host-parameter
// ceiling is 999; well under it with room to spare, and a Map lookup
// afterward is why the caller doesn't need this to preserve input order.
export function getContactsByIdsFast(ids) {
  const uniqueIds = [...new Set(ids)].filter(Boolean);
  const result = new Map();
  if (!uniqueIds.length) return result;
  if (!sqliteInboxAvailable()) {
    const contacts = readJson(CONTACTS_FILE, []);
    const idSet = new Set(uniqueIds);
    for (const c of contacts) if (idSet.has(c.id)) result.set(c.id, c);
    return result;
  }
  const CHUNK = 500;
  for (let i = 0; i < uniqueIds.length; i += CHUNK) {
    const chunk = uniqueIds.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => "?").join(",");
    const rows = db.prepare(`SELECT id, raw_json FROM contacts_idx WHERE id IN (${placeholders})`).all(...chunk);
    for (const row of rows) {
      try { result.set(row.id, JSON.parse(row.raw_json)); } catch { /* skip a corrupt row rather than fail the whole batch */ }
    }
  }
  return result;
}

// One GROUP BY instead of a full readJson(CONTACTS_FILE, []) + per-contact
// JS loop -- same data, but SQLite does the json_each explode/count
// natively over the compact indexed table instead of a ~190MB JSON.parse
// materializing 176k live objects just to tally two numbers per tag.
export function tagCountsSqlite() {
  if (!sqliteInboxAvailable()) return null;
  const rows = db.prepare(`SELECT value as tagId, COUNT(*) as n FROM contacts_idx, json_each(tags_json) GROUP BY value`).all();
  const counts = {};
  for (const r of rows) counts[r.tagId] = r.n;
  return counts;
}
export function listCountsSqlite() {
  if (!sqliteInboxAvailable()) return null;
  const rows = db.prepare(`
    SELECT value as listId, COUNT(*) as total, SUM(CASE WHEN email_opt_out = 0 THEN 1 ELSE 0 END) as subscribed
    FROM contacts_idx, json_each(list_ids_json) GROUP BY value
  `).all();
  const counts = {};
  for (const r of rows) counts[r.listId] = { total: r.total, subscribed: r.subscribed };
  return counts;
}

// Deliberately does NOT handle the arbitrary segment-condition ("advanced
// filter") case -- matchesSegment's condition language (segments_shared.js)
// covers customFields.*/visitedPage/relative-time operators that aren't
// columns here, and this app already had one production outage from a
// clever-but-wrong fast path on this exact file (see contacts_backend.js's
// "REVERTED to plain readJson+filter" comment). The caller falls back to
// the old full-read path whenever advancedFilter is present; this only
// ever serves the plain q/status/tag/listId/type/emailOptOut/sort case,
// which covers the default Contacts view and every column-header sort.
export function queryContactsSqlite({ q, status, tag, listId, type, emailOptOut, sortField, sortDir, limit, offset }) {
  if (!sqliteInboxAvailable()) return null;

  const where = [];
  const params = {};
  // COALESCE(...,'') on both sides of || -- SQLite string concatenation
  // returns NULL if EITHER operand is NULL, and upsertContactIndex stores
  // an empty-string first/last as NULL (`contact.last || null`), so a
  // contact with no last name would silently never match ANY search
  // without this -- confirmed live via a direct fast-vs-slow-path diff.
  if (q) { where.push("(LOWER(COALESCE(first,'') || ' ' || COALESCE(last,'')) LIKE :q OR LOWER(COALESCE(email,'')) LIKE :q OR LOWER(COALESCE(account_name,'')) LIKE :q)"); params.q = `%${q.toLowerCase()}%`; }
  if (status) { where.push("status = :status"); params.status = status; }
  if (type) { where.push("type = :type"); params.type = type; }
  if (emailOptOut !== null && emailOptOut !== undefined) { where.push("email_opt_out = :emailOptOut"); params.emailOptOut = emailOptOut ? 1 : 0; }
  // json_each is unindexed (a per-row table-valued scan), same tradeoff
  // sqlite_inbox.js's channel filter above already accepts -- fine here
  // since tag/listId filtering is a much rarer path (one specific List/Tag
  // view) than the default Contacts list.
  if (tag) { where.push("EXISTS (SELECT 1 FROM json_each(tags_json) WHERE value = :tag)"); params.tag = tag; }
  if (listId) { where.push("EXISTS (SELECT 1 FROM json_each(list_ids_json) WHERE value = :listId)"); params.listId = listId; }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  // LOWER(...) on every text column -- SQLite's default TEXT comparison is
  // byte-wise/case-sensitive (uppercase sorts before lowercase), but the
  // JS comparator this replaces explicitly lowercases both sides first.
  // Confirmed live via a direct fast-vs-slow-path diff: same row set,
  // different order, on every text-column sort without this.
  const SORT_COLUMNS = {
    first: "LOWER(first)", last: "LOWER(last)", email: "LOWER(email)", phone: "LOWER(phone)", status: "LOWER(status)",
    smsOptOut: "sms_opt_out", emailOptOut: "email_opt_out", programType: "LOWER(program_type)",
    createdAt: "COALESCE(first_seen_at, created_at)",
  };
  const dir = sortDir === "desc" ? "DESC" : "ASC";
  const orderSql = sortField && SORT_COLUMNS[sortField] ? `ORDER BY ${SORT_COLUMNS[sortField]} ${dir}` : "";

  const total = db.prepare(`SELECT COUNT(*) as n FROM contacts_idx ${whereSql}`).get(params).n;
  // limit === null means "no limit param at all" -- several existing
  // callers (inbox.html, workflow-detail.html, reporting.html) fetch this
  // endpoint with none and expect the FULL matching set back, same as the
  // full-read fallback's `page = filtered` (no slice) when there's no
  // limitParam. Literal LIMIT/OFFSET (not bound params) for the same
  // reason queryConversationsSqlite above uses literals -- bound values
  // defeat SQLite's top-K optimization; safe since both are already
  // clamped ints (or explicitly null) from the caller, never raw request text.
  let limitSql = "";
  if (limit !== null && limit !== undefined) {
    const safeLimit = Math.max(1, Math.min(200, Math.trunc(limit) || 50));
    const safeOffset = Math.max(0, Math.trunc(offset) || 0);
    limitSql = `LIMIT ${safeLimit} OFFSET ${safeOffset}`;
  }
  const rows = db.prepare(`SELECT raw_json FROM contacts_idx ${whereSql} ${orderSql} ${limitSql}`).all(params);
  const contacts = rows.map(r => { try { return JSON.parse(r.raw_json); } catch { return null; } }).filter(Boolean);
  return { contacts, total };
}
