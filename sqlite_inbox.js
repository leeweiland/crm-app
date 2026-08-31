// EXPERIMENTAL / test-only. Reads the prototype conversation-summary
// database (built by build_db.mjs from crm_conversation_index.json +
// crm_contacts.json + crm_conversation_meta.json -- see that script's
// comments) instead of parsing those ~470MB of JSON on every request. Not
// used by default -- see inbox_backend.js's GET /api/inbox/conversations,
// which only calls into this when the request carries ?_sqlite=1, so normal
// Inbox usage is completely unaffected either way.
//
// IMPORTANT CAVEAT: this database is a ONE-TIME SNAPSHOT, not kept in sync
// with new messages/pins/stars the way crm_conversation_index.json is --
// it will read increasingly stale until (if ever) something rebuilds it or
// wires up incremental updates. Fine for timing a load-speed comparison;
// not fine to treat as a real data source yet.
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "fs";
import { join } from "path";
import { DATA_DIR } from "./auth_backend.js";

const DB_PATH = join(DATA_DIR, "crm_prototype.db");
let db = null;
export function sqliteInboxAvailable() {
  if (db) return true;
  if (!existsSync(DB_PATH)) return false;
  db = new DatabaseSync(DB_PATH, { readOnly: true });
  return true;
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
  // size) -- fine for a test, worth a dedicated column later if this sticks.
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
      contact: r.contact_id ? { status: r.status, programType: r.program_type, email: r.email, first: r.first, last: r.last } : null,
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
