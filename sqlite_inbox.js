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

const DB_PATH = join(DATA_DIR, "crm_prototype.db");
let db = null;
export function sqliteInboxAvailable() {
  if (db) return true;
  if (!existsSync(DB_PATH)) return false;
  db = new DatabaseSync(DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      key TEXT PRIMARY KEY, contact_id TEXT, display_name TEXT, first TEXT, last TEXT, email TEXT,
      status TEXT, program_type TEXT, owner_id TEXT,
      last_at_ms INTEGER, last_inbound_at_ms INTEGER, unread_count INTEGER,
      pinned INTEGER DEFAULT 0, starred INTEGER DEFAULT 0, archived INTEGER DEFAULT 0, done INTEGER DEFAULT 0,
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
  `);
  // CREATE TABLE IF NOT EXISTS is a no-op against an already-existing table
  // from an earlier schema version (e.g. production's original build, made
  // before owner_id existed) -- ALTER TABLE ADD COLUMN is what actually
  // evolves it without losing the already-populated rows.
  const existingCols = new Set(db.prepare("PRAGMA table_info(conversations)").all().map(c => c.name));
  if (!existingCols.has("owner_id")) db.exec("ALTER TABLE conversations ADD COLUMN owner_id TEXT");
  return true;
}

const toMs = (s) => { const t = s ? new Date(s).getTime() : NaN; return Number.isFinite(t) ? t : null; };

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
      (key, contact_id, display_name, first, last, email, status, program_type, owner_id,
       last_at_ms, last_inbound_at_ms, unread_count,
       last_channel, last_direction, last_preview, last_status, last_opened, last_message_id, last_by_channel_json)
    VALUES (:key, :contactId, :displayName, :first, :last, :email, :status, :programType, :ownerId,
            :lastAtMs, :lastInboundAtMs, :unreadCount,
            :lastChannel, :lastDirection, :lastPreview, :lastStatus, :lastOpened, :lastMessageId, :lastByChannelJson)
    ON CONFLICT(key) DO UPDATE SET
      last_at_ms=excluded.last_at_ms, last_inbound_at_ms=excluded.last_inbound_at_ms, unread_count=excluded.unread_count,
      last_channel=excluded.last_channel, last_direction=excluded.last_direction, last_preview=excluded.last_preview,
      last_status=excluded.last_status, last_opened=excluded.last_opened, last_message_id=excluded.last_message_id,
      last_by_channel_json=excluded.last_by_channel_json
  `).run({
    key: g.key, contactId: g.contactId || null,
    displayName: displayName ?? displayNameFallback,
    first: contact?.first || null, last: contact?.last || null, email: contact?.email || null,
    status: contact?.status || null, programType: contact?.programType || null, ownerId: contact?.ownerId || null,
    lastAtMs: toMs(g.last?.createdAt), lastInboundAtMs: toMs(g.lastInboundAt), unreadCount: g.unreadCount || 0,
    lastChannel: g.last?.channel || null, lastDirection: g.last?.direction || null,
    lastPreview: g.last?.subject || g.last?.bodyPreview || "",
    lastStatus: g.lastMine?.status || null, lastOpened: g.lastMine?.opened ? 1 : 0,
    lastMessageId: g.last?.id || null, lastByChannelJson: JSON.stringify(g.lastByChannel || {}),
  });
}

export function deleteConversationRow(key) {
  if (!sqliteInboxAvailable()) return;
  db.prepare("DELETE FROM conversations WHERE key = ?").run(key);
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
    UPDATE conversations SET pinned = :pinned, starred = :starred, archived = :archived, done = :done
    WHERE contact_id = :contactId
  `).run({
    contactId,
    pinned: meta.pinned ? 1 : 0, starred: meta.starred ? 1 : 0,
    archived: meta.archived ? 1 : 0, done: meta.done ? 1 : 0,
  });
}

// contacts_backend.js's PATCH -- status/type/name/email/assignment. Same
// no-op-if-no-row reasoning as syncMetaFields above.
export function syncContactFields(contactId, contact) {
  if (!sqliteInboxAvailable()) return;
  const displayName = `${contact.first || ""} ${contact.last || ""}`.trim() || "Unknown";
  db.prepare(`
    UPDATE conversations SET display_name = :displayName, first = :first, last = :last, email = :email,
      status = :status, program_type = :programType, owner_id = :ownerId
    WHERE contact_id = :contactId
  `).run({
    contactId, displayName,
    first: contact.first || null, last: contact.last || null, email: contact.email || null,
    status: contact.status || null, programType: contact.programType || null, ownerId: contact.ownerId || null,
  });
}

// Mirrors GET /api/inbox/conversations' filter/sort/pagination contract in
// inbox_backend.js -- see that handler for what each param means. Returns
// the same {conversations, total, hasMore} shape so the frontend needs zero
// changes to consume either path.
export function queryConversationsSqlite({ channel, statusFilter, typeFilter, bucket, sortDir, search, limit, offset }) {
  if (!sqliteInboxAvailable()) return null;

  const where = [];
  const params = {};
  if (bucket === "archived") { where.push("archived = 1"); }
  else {
    where.push("archived = 0");
    if (bucket === "done") where.push("done = 1");
    else if (bucket === "unresponded") where.push("unread_count > 0");
    else if (bucket === "favorites") where.push("starred = 1");
  }
  if (statusFilter) { where.push("status = :status"); params.status = statusFilter; }
  if (typeFilter) { where.push("program_type = :programType"); params.programType = typeFilter; }
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
  const dir = sortDir === "oldest" ? "ASC" : "DESC";
  const orderSql = `ORDER BY pinned DESC, (last_inbound_at_ms IS NULL) ASC, COALESCE(last_inbound_at_ms, last_at_ms) ${dir}`;

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

  const conversations = rows.map(r => {
    let last = null;
    if (channel) {
      try { last = JSON.parse(r.last_by_channel_json || "{}")[channel]; } catch { last = null; }
    }
    return {
      key: r.key, contactId: r.contact_id,
      contact: r.contact_id ? { status: r.status, programType: r.program_type, email: r.email, first: r.first, last: r.last, ownerId: r.owner_id } : null,
      displayName: r.display_name,
      lastChannel: last?.channel || r.last_channel, lastDirection: last?.direction || r.last_direction,
      lastPreview: last?.subject || last?.bodyPreview || r.last_preview,
      lastAt: last?.createdAt || (r.last_at_ms ? new Date(r.last_at_ms).toISOString() : null),
      lastInboundAt: r.last_inbound_at_ms ? new Date(r.last_inbound_at_ms).toISOString() : null,
      lastMessageId: last?.id || r.last_message_id,
      unreadCount: r.unread_count,
      pinned: !!r.pinned, starred: !!r.starred, archived: !!r.archived, done: !!r.done,
      lastStatus: r.last_status, lastOpened: !!r.last_opened,
    };
  });
  return { conversations, total, hasMore: offset + limit < total };
}
