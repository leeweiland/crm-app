// Postgres message store (2026-10-22). With MESSAGES_STORE=pg every message
// read/write that used to go to JSON files goes to one `messages` table:
//
//   msg_by_contact/ + msg_by_contact_status/   -> rows by contact_id
//   msg_by_source/  + msg_by_source_status/    -> rows by (source_type, source_id)
//   crm_provider_id_index.json (346MB, object) -> provider_message_id index
//   crm_message_id_index.json                  -> primary key
//   crm_message_log.json (12.5GB, append-only) -> the table itself
//   crm_daily_message_stats.json               -> message_daily_stats, kept by a trigger
//
// One row per message, updated in place -- no overlays to fold, no
// duplicate-key index growth, no full-file rewrites, and a status update is
// one atomic UPDATE, so two threads handling events for the same message
// can't race each other's open/click counts any more.
//
// Every function here is synchronous, like the file code it replaces
// (~50 callers depend on that): queries run through contacts_pg_sync.js.
//
// Schema lives in messages_schema.sql and is created by
// backchannel/messages_backfill.mjs, which also copies the history in.
import { sharedSyncQuery } from "./contacts_pg_sync.js";

export const MESSAGES_PG = process.env.MESSAGES_STORE === "pg";

let _q = null;
function q(sql, params) {
  if (!_q) _q = sharedSyncQuery();
  return _q(sql, params);
}

// Fields with their own column. Anything else on a row (mediaUrl, Gmail's
// threadId/references, ac_sync's acCampaignId, legacy import ids, ...) is
// kept verbatim in `extra`. A text column only takes a string (or null) --
// a non-string value in one of those fields goes to `extra` instead, so a
// row always reads back exactly as it was written.
const TEXT_COLUMNS = {
  contactId: "contact_id", channel: "channel", direction: "direction", sourceType: "source_type", sourceId: "source_id",
  providerMessageId: "provider_message_id", to: "to_addr", from: "from_addr", subject: "subject", body: "body",
  bodyPreview: "body_preview", status: "status", failReason: "fail_reason", sentAt: "sent_at", createdAt: "created_at",
};
const CORE_KEYS = new Set(["id", "statusHistory", "inboxDone", ...Object.keys(TEXT_COLUMNS)]);
export const MESSAGE_COLUMNS = [
  "id", ...Object.values(TEXT_COLUMNS), "status_history", "inbox_done", "extra", "open_count", "click_count", "day", "is_test",
];
const JSONB = new Set(["status_history", "extra"]);
const ENGAGED = ["opened", "clicked", "bounced", "complained"];

function dayOf(iso) { return typeof iso === "string" ? iso.slice(0, 10) : null; }
// Postgres rejects the NUL character in text and jsonb (old imported email
// bodies occasionally carry one) -- strip it rather than fail the write.
const NUL = /\u0000/g;
const NUL_ESCAPE = /\\u0000/g;
const cleanText = (v) => (typeof v === "string" ? v.replace(NUL, "") : v);
const cleanJson = (v) => JSON.stringify(v).replace(NUL_ESCAPE, "");

// Message object -> column values, in MESSAGE_COLUMNS order. isTest: the
// contact is flagged testContact at write time (kept out of daily stats,
// same rule crm_daily_message_stats.json always applied).
export function messageToParams(m, isTest = false) {
  const extra = {};
  const cols = {};
  for (const [key, col] of Object.entries(TEXT_COLUMNS)) {
    const v = m[key];
    if (v == null || typeof v === "string") cols[col] = v ?? null;
    else { cols[col] = null; extra[key] = v; }
  }
  for (const k of Object.keys(m)) if (!CORE_KEYS.has(k) && m[k] !== undefined) extra[k] = m[k];
  const hist = Array.isArray(m.statusHistory) ? m.statusHistory : [];
  return [
    m.id, ...Object.values(TEXT_COLUMNS).map(c => cleanText(cols[c])),
    cleanJson(hist), !!m.inboxDone, cleanJson(extra),
    hist.filter(h => h?.status === "opened").length, hist.filter(h => h?.status === "clicked").length,
    dayOf(m.createdAt), !!isTest,
  ];
}
export function rowToMessage(r) {
  if (!r) return null;
  const m = { id: r.id };
  for (const [key, col] of Object.entries(TEXT_COLUMNS)) m[key] = r[col];
  m.statusHistory = r.status_history || [];
  m.inboxDone = !!r.inbox_done;
  return r.extra ? Object.assign(m, r.extra) : m;
}
const SELECT_COLS = `id, ${Object.values(TEXT_COLUMNS).join(", ")}, status_history, inbox_done, extra`;

function placeholders(rowCount, offset = 0) {
  const n = MESSAGE_COLUMNS.length;
  const rows = [];
  for (let r = 0; r < rowCount; r++) {
    rows.push("(" + MESSAGE_COLUMNS.map((col, i) => `$${offset + r * n + i + 1}${JSONB.has(col) ? "::jsonb" : ""}`).join(",") + ")");
  }
  return rows.join(",");
}
const INSERT_CHUNK = 500; // 24 columns x 500 rows, well under Postgres's 65,535-parameter limit

// New messages. A row whose id already exists is left alone (a retried
// send can't duplicate itself).
export function insertMessages(messages, isTestFor = () => false) {
  for (let i = 0; i < messages.length; i += INSERT_CHUNK) {
    const chunk = messages.slice(i, i + INSERT_CHUNK);
    const params = chunk.flatMap(m => messageToParams(m, isTestFor(m.contactId)));
    q(`INSERT INTO messages (${MESSAGE_COLUMNS.join(", ")}) VALUES ${placeholders(chunk.length)} ON CONFLICT (id) DO NOTHING`, params);
  }
}
// Whole rows written back after a caller edited them in JS (mark done,
// inferred opens, ad-hoc updaters). Status counters/day are recomputed from
// the row; seq (original order) is kept.
const UPSERT_SET = MESSAGE_COLUMNS.filter(c => c !== "id" && c !== "is_test").map(c => `${c}=excluded.${c}`).join(", ");
export function writeMessages(messages) {
  for (let i = 0; i < messages.length; i += INSERT_CHUNK) {
    const chunk = messages.slice(i, i + INSERT_CHUNK);
    q(`INSERT INTO messages (${MESSAGE_COLUMNS.join(", ")}) VALUES ${placeholders(chunk.length)} ON CONFLICT (id) DO UPDATE SET ${UPSERT_SET}`, chunk.flatMap(m => messageToParams(m)));
  }
}

// ── Reads ──────────────────────────────────────────────────────────────────
// Same order the per-contact file had: the order messages were logged.
export function getContactMessages(contactId) {
  if (!contactId) return [];
  return q(`SELECT ${SELECT_COLS} FROM messages WHERE contact_id = $1 ORDER BY seq`, [contactId]).map(rowToMessage);
}
export function getMessageById(id) {
  if (!id) return null;
  return rowToMessage(q(`SELECT ${SELECT_COLS} FROM messages WHERE id = $1`, [id])[0]);
}
export function getMessagesByIds(ids) {
  if (!ids?.length) return [];
  return q(`SELECT ${SELECT_COLS} FROM messages WHERE id = ANY($1) ORDER BY seq`, [ids]).map(rowToMessage);
}
// The slim shape msg_by_source rows always had.
export function getSourceMessages(sourceType, sourceId) {
  if (!sourceType || !sourceId) return [];
  return q(
    `SELECT id, contact_id, to_addr, extra->'to' AS to_json, status, sent_at, created_at, provider_message_id
       FROM messages WHERE source_type = $1 AND source_id = $2 ORDER BY seq`, [sourceType, sourceId]
  ).map(r => ({ id: r.id, contactId: r.contact_id, to: r.to_addr ?? r.to_json ?? null, status: r.status, sentAt: r.sent_at || r.created_at, providerMessageId: r.provider_message_id }));
}
// What crm_provider_id_index.json answered: does this provider id belong to
// one of our messages, and which.
export function getMessageByProviderId(providerMessageId) {
  if (!providerMessageId) return null;
  return rowToMessage(q(`SELECT ${SELECT_COLS} FROM messages WHERE provider_message_id = $1 ORDER BY seq DESC LIMIT 1`, [providerMessageId])[0]);
}
export function providerIdsExisting(providerIds) {
  if (!providerIds?.length) return new Set();
  return new Set(q(`SELECT DISTINCT provider_message_id FROM messages WHERE provider_message_id = ANY($1)`, [providerIds]).map(r => r.provider_message_id));
}
// Unmatched ("Potential Contact") messages: no contact yet, matched on the
// other party's address.
function theirAddrSql() { return "(CASE WHEN direction = 'inbound' THEN from_addr ELSE to_addr END)"; }
export function getUnmatchedMessages(channel, address) {
  return q(`SELECT ${SELECT_COLS} FROM messages WHERE contact_id IS NULL AND channel = $1 AND ${theirAddrSql()} = $2 ORDER BY seq`, [channel, address]).map(rowToMessage);
}
export function getUnmatchedByDigits(digits) {
  return q(
    `SELECT ${SELECT_COLS} FROM messages WHERE contact_id IS NULL AND channel = 'sms'
       AND right(regexp_replace(coalesce(${theirAddrSql()}, ''), '\\D', '', 'g'), 10) = right($1, 10) ORDER BY seq`, [digits]
  ).map(rowToMessage);
}
export function getUnmatchedByEmail(email) {
  return q(`SELECT ${SELECT_COLS} FROM messages WHERE contact_id IS NULL AND channel = 'email' AND lower(${theirAddrSql()}) = lower($1) ORDER BY seq`, [email]).map(rowToMessage);
}
// Newest-first inbound messages for the Inbox's primary/emails/messages tabs.
export function recentInboundMessages({ channel = null, done = null, limit = 1000 }) {
  const where = ["direction = 'inbound'"];
  const params = [];
  if (channel) { params.push(channel); where.push(`channel = $${params.length}`); }
  if (done !== null) { params.push(!!done); where.push(`inbox_done = $${params.length}`); }
  params.push(limit);
  return q(`SELECT ${SELECT_COLS} FROM messages WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT $${params.length}`, params).map(rowToMessage);
}

// ── Status / patch updates ────────────────────────────────────────────────
// patch keys with a column update that column; anything else merges into
// extra. historyAdd (optional) is appended to statusHistory.
// "delivered" never replaces an opened/clicked/bounced/complained status
// (SES can deliver the Delivery event after the Open) -- the same rule the
// campaign reports' per-source status always followed.
function patchSet(patch, params) {
  const sets = [];
  const extra = {};
  for (const [k, v] of Object.entries(patch || {})) {
    if (k === "id" || k === "statusHistory") continue;
    if (k === "status") {
      params.push(v);
      const p = `$${params.length}`;
      sets.push(`status = CASE WHEN ${p} = 'delivered' AND m.status = ANY('{${ENGAGED.join(",")}}') THEN m.status ELSE ${p} END`);
      sets.push(`open_count = m.open_count + (${p} = 'opened')::int`, `click_count = m.click_count + (${p} = 'clicked')::int`);
    } else if (k === "inboxDone") { params.push(!!v); sets.push(`inbox_done = $${params.length}`); }
    else if (TEXT_COLUMNS[k] && (v == null || typeof v === "string")) {
      params.push(v ?? null); sets.push(`${TEXT_COLUMNS[k]} = $${params.length}`);
      if (k === "createdAt") { params.push(dayOf(v)); sets.push(`day = $${params.length}`); }
    } else extra[k] = v;
  }
  if (Object.keys(extra).length) { params.push(JSON.stringify(extra)); sets.push(`extra = m.extra || $${params.length}::jsonb`); }
  return sets;
}
const RETURNING = `m.id, m.contact_id, m.source_type, m.source_id, m.channel, m.direction, m.created_at, m.status, m.provider_message_id,
  old.status AS old_status, old.open_count AS old_open, old.click_count AS old_click`;
function applyUpdate(whereSql, whereParams, patch, historyAdd) {
  const params = [...whereParams];
  const sets = patchSet(patch, params);
  if (historyAdd) { params.push(JSON.stringify([historyAdd])); sets.push(`status_history = m.status_history || $${params.length}::jsonb`); }
  if (!sets.length) return null;
  const r = q(
    `WITH old AS (SELECT id, status, open_count, click_count FROM messages WHERE ${whereSql} ORDER BY seq DESC LIMIT 1 FOR UPDATE)
     UPDATE messages m SET ${sets.join(", ")} FROM old WHERE m.id = old.id RETURNING ${RETURNING}`, params
  )[0];
  if (!r) return null;
  return {
    id: r.id, contactId: r.contact_id, sourceType: r.source_type, sourceId: r.source_id, channel: r.channel, direction: r.direction,
    createdAt: r.created_at, status: r.status, providerMessageId: r.provider_message_id,
    oldStatus: r.old_status, oldOpenCount: r.old_open, oldClickCount: r.old_click,
  };
}
// One SES/Twilio status event, applied atomically. Returns the updated
// entry plus the status/counters it had before (for repeat detection), or
// null when the provider id isn't ours.
export function updateStatusByProviderId(providerMessageId, status, historyAdd) {
  if (!providerMessageId) return null;
  return applyUpdate("provider_message_id = $1", [providerMessageId], { status }, historyAdd);
}
export function updateMessageFields(id, patch, historyAdd) {
  if (!id) return null;
  return applyUpdate("id = $1", [id], patch, historyAdd);
}

// ── Bulk per-contact operations ───────────────────────────────────────────
export function markInboundDone(contactId) {
  if (!contactId) return 0;
  return q(`UPDATE messages SET inbox_done = true WHERE contact_id = $1 AND direction = 'inbound' AND NOT inbox_done RETURNING id`, [contactId]).length;
}
export function deleteContactMessages(contactId) {
  if (!contactId) return 0;
  return q(`DELETE FROM messages WHERE contact_id = $1 RETURNING id`, [contactId]).length;
}
export function deleteMessagesByIds(contactId, ids) {
  if (!contactId || !ids?.length) return 0;
  return q(`DELETE FROM messages WHERE contact_id = $1 AND id = ANY($2) RETURNING id`, [contactId, ids]).length;
}
export function deleteUnmatchedConversation(channel, address) {
  return q(`DELETE FROM messages WHERE contact_id IS NULL AND channel = $1 AND ${theirAddrSql()} = $2 RETURNING id`, [channel, address]).length;
}
export function assignMessagesToContact(ids, contactId) {
  if (!ids?.length) return 0;
  return q(`UPDATE messages SET contact_id = $2 WHERE id = ANY($1) RETURNING id`, [ids, contactId]).length;
}
// Contact merge: every message of the losing contact now belongs to the winner.
export function reassignContactMessages(fromContactId, toContactId) {
  if (!fromContactId || !toContactId) return 0;
  return q(`UPDATE messages SET contact_id = $2 WHERE contact_id = $1 RETURNING id`, [fromContactId, toContactId]).length;
}
export function contactIdsForMessageIds(ids) {
  if (!ids?.length) return [];
  return q(`SELECT DISTINCT contact_id FROM messages WHERE id = ANY($1) AND contact_id IS NOT NULL`, [ids]).map(r => r.contact_id);
}

// How many of one source's messages are in each status (and whether SES
// accepted them) -- all the Campaigns list's rollup needs. Answered from
// the messages_source_status covering index without reading message rows.
export function sourceStatusCounts(sourceType, sourceId) {
  return q(
    `SELECT status, provider_message_id IS NOT NULL AS has_pid, count(*)::int AS n FROM messages
      WHERE source_type = $1 AND source_id = $2 GROUP BY 1, 2`, [sourceType, sourceId]
  ).map(r => ({ status: r.status, hasPid: r.has_pid, n: r.n }));
}

// ── Daily stats ───────────────────────────────────────────────────────────
// message_daily_stats holds (day, channel, direction, source_type, status)
// counts, maintained by a trigger on messages (messages_schema.sql). Folded
// here into the exact bucket shape crm_daily_message_stats.json had.
export function getDailyStatsRows(startDay, endDay) {
  return q(`SELECT day, channel, direction, source_type, status, n FROM message_daily_stats WHERE day >= $1 AND day <= $2 AND n > 0`, [startDay, endDay]);
}
