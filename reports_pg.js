// The Reporting tab's data reads as Postgres queries (2026-10-22). Used by
// reporting_backend.js when messages and records both live in Postgres
// (MESSAGES_STORE=pg + RECORDS_STORE=pg): instead of every contact plus
// each one's whole message history, each report asks for exactly the rows
// it counts. The counting itself stays in reporting_backend.js, unchanged,
// so the numbers are the same ones the file version produced.
import { sharedSyncQuery } from "./contacts_pg_sync.js";
import { rowToContact } from "./contacts_db.js";
import { MESSAGES_PG } from "./messages_db.js";
import { RECORDS_PG } from "./records_db.js";

export const REPORTS_PG = MESSAGES_PG && RECORDS_PG;

let _q = null;
function q(sql, params) {
  if (!_q) _q = sharedSyncQuery();
  return _q(sql, params);
}
const iso = (ms) => new Date(ms).toISOString();

// Message timestamps are stored as the original ISO strings (some legacy
// rows carry offsets or odd formats); safe_ts parses them like JavaScript's
// Date would, and gives NULL -- never matching a range -- for anything
// unparseable. Created at server start (ensureReportFunctions).
export const REPORT_FUNCTIONS_SQL = `
CREATE OR REPLACE FUNCTION safe_ts(t text) RETURNS timestamptz AS $$
BEGIN
  IF t IS NULL OR t = '' THEN RETURN NULL; END IF;
  RETURN t::timestamptz;
EXCEPTION WHEN others THEN RETURN NULL;
END $$ LANGUAGE plpgsql IMMUTABLE;`;
export function ensureReportFunctions() { q(REPORT_FUNCTIONS_SQL); }

const NOT_TEST = `coalesce(extra->>'testContact', '') <> 'true'`;
export function testContactIds() {
  return q(`SELECT id FROM contacts WHERE extra->>'testContact' = 'true'`).map(r => r.id);
}

// getMessagesForSource for many sources at once, already limited to sends
// in [startMs, endMs] and without test contacts' messages -- the rows
// statsFromSources used to build by reading every source in full.
export function sourceMessagesInRange(sourceType, sourceIds, startMs, endMs, testIds) {
  if (!sourceIds.length) return [];
  return q(
    `SELECT id, contact_id, to_addr, status, coalesce(nullif(sent_at, ''), created_at) AS sent_at, provider_message_id
       FROM messages
      WHERE source_type = $1 AND source_id = ANY($2)
        AND safe_ts(coalesce(nullif(sent_at, ''), created_at)) BETWEEN $3::timestamptz AND $4::timestamptz
        AND NOT (coalesce(contact_id, '') = ANY($5))`,
    [sourceType, sourceIds, iso(startMs), iso(endMs), testIds]
  ).map(r => ({ id: r.id, contactId: r.contact_id, to: r.to_addr, status: r.status, sentAt: r.sent_at, providerMessageId: r.provider_message_id }));
}

// Inbound messages on one channel for a set of contacts -- all countReplies
// ever looked at in each contact's history.
export function inboundByContact(contactIds, channel) {
  const out = new Map();
  if (!contactIds.length) return out;
  for (const r of q(
    `SELECT contact_id, created_at, extra->'inReplyTo' AS in_reply_to FROM messages
      WHERE contact_id = ANY($1) AND channel = $2 AND direction = 'inbound'`, [contactIds, channel]
  )) {
    if (!out.has(r.contact_id)) out.set(r.contact_id, []);
    out.get(r.contact_id).push({ channel, direction: "inbound", createdAt: r.created_at, inReplyTo: r.in_reply_to });
  }
  return out;
}

// A team member's most recently updated (non-test) contacts.
export function recentOwnedContactIds(ownerId, limit) {
  return q(
    `SELECT id FROM contacts WHERE owner_id = $1 AND ${NOT_TEST} ORDER BY safe_ts(updated_at) DESC NULLS LAST LIMIT $2`, [ownerId, limit]
  ).map(r => r.id);
}
// Their email/SMS in the range -- just the fields Sent-by-user counts.
export function emailSmsInRange(contactIds, startMs, endMs) {
  if (!contactIds.length) return [];
  return q(
    `SELECT channel, direction, source_type FROM messages
      WHERE contact_id = ANY($1) AND channel IN ('email', 'sms')
        AND safe_ts(created_at) BETWEEN $2::timestamptz AND $3::timestamptz`, [contactIds, iso(startMs), iso(endMs)]
  ).map(r => ({ channel: r.channel, direction: r.direction, sourceType: r.source_type }));
}

export function contactsByIds(ids, { excludeTest = false } = {}) {
  if (!ids.length) return [];
  return q(`SELECT * FROM contacts WHERE id = ANY($1)${excludeTest ? ` AND ${NOT_TEST}` : ""}`, [ids]).map(rowToContact);
}
// Contacts the Hyros-source part of Attribution can count: imported from
// Hyros, or carrying one of its "@source" tags. Only the fields it reads.
export function hyrosCandidates(sourceTagIds) {
  return q(
    `SELECT id, source, tags, status, first_seen_at, created_at FROM contacts
      WHERE ${NOT_TEST} AND (source = 'hyros_import' OR tags && $1::text[])`, [sourceTagIds]
  ).map(r => ({ id: r.id, source: r.source, tags: r.tags || [], status: r.status, firstSeenAt: r.first_seen_at, createdAt: r.created_at }));
}

// contactsById for Attribution without loading every contact: anything not
// fetched yet is looked up (non-test only, like the full list it replaces);
// prefetch() pulls a batch in one query.
export class LazyContactMap extends Map {
  get(id) {
    if (!id) return undefined;
    if (!super.has(id)) super.set(id, contactsByIds([id], { excludeTest: true })[0]);
    return super.get(id);
  }
  prefetch(ids) {
    const missing = [...new Set(ids)].filter(id => id && !super.has(id));
    for (let i = 0; i < missing.length; i += 5000) {
      const chunk = missing.slice(i, i + 5000);
      const found = new Map(contactsByIds(chunk, { excludeTest: true }).map(c => [c.id, c]));
      for (const id of chunk) super.set(id, found.get(id));
    }
  }
}
