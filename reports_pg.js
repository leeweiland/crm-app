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
// Two index-only reads: every inbound message's channel/time (the
// messages_inbound_contact covering index), then In-Reply-To for the few
// inbound messages that carry one (messages_inreplyto).
export function inboundByContact(contactIds, channel) {
  const out = new Map();
  if (!contactIds.length) return out;
  const replyTo = new Map();
  for (const r of q(
    `SELECT contact_id, created_at, extra->'inReplyTo' AS in_reply_to FROM messages
      WHERE contact_id = ANY($1) AND direction = 'inbound' AND extra ? 'inReplyTo' AND channel = $2`, [contactIds, channel]
  )) {
    if (!replyTo.has(r.contact_id)) replyTo.set(r.contact_id, []);
    replyTo.get(r.contact_id).push({ channel, direction: "inbound", createdAt: r.created_at, inReplyTo: r.in_reply_to });
  }
  for (const r of q(
    `SELECT contact_id, created_at FROM messages WHERE contact_id = ANY($1) AND direction = 'inbound' AND channel = $2`, [contactIds, channel]
  )) {
    if (!out.has(r.contact_id)) out.set(r.contact_id, []);
    out.get(r.contact_id).push({ channel, direction: "inbound", createdAt: r.created_at, inReplyTo: null });
  }
  // Same rows, with In-Reply-To filled in where there is one.
  for (const [cid, withReply] of replyTo) out.set(cid, [...withReply, ...(out.get(cid) || [])]);
  return out;
}

// The 1:1 messages one team member personally sent in the range, counted by
// SENDER (2026-10-23 -- was by contact owner, capped at 300 contacts, which
// credited nobody for sends to someone else's lead): every CRM Inbox send
// is recorded under the user who sent it (the only way to tell, since SMS
// all go out on the one shared number), plus emails from their own mailbox
// picked up from Gmail ("Name <address>"). A mailbox's Sent folder holds a
// lot that isn't a 1:1 email, so those are left out:
//   - mail to themselves / the team (lead notifications, test sends)
//   - mail sent under another name (the PRA Chat app sends as "PRA Chat")
//   - Gmail's copy of something the CRM itself sent through that mailbox
//     (AI agent replies, booking reminders): same contact, same subject,
//     within 15 minutes
//   - the same subject to 5+ people the same day (a broadcast, not 1:1)
//   - the same Gmail message stored twice (the old Gmail duplicate check
//     failed once its index outgrew 300MB) -- counted once
// For Lee's October that's 635 Gmail rows -> 35 real 1:1 emails.
const GMAIL_FROM = "lower(coalesce(substring(from_addr from '<([^>]+)>'), from_addr))";
const GMAIL_FROM_M = "lower(coalesce(substring(m.from_addr from '<([^>]+)>'), m.from_addr))";
const BULK_RECIPIENTS = 5;
const COPY_WINDOW_SECONDS = 900;
export function personalSendsInRange(user, teamAddresses, startMs, endMs, testIds) {
  const range = [iso(startMs), iso(endMs)];
  const out = { email: 0, sms: 0, contactIds: new Set() };
  for (const r of q(
    `SELECT channel, contact_id FROM messages
      WHERE source_type = 'inbox' AND source_id = $1 AND direction = 'outbound' AND channel IN ('email', 'sms')
        AND safe_ts(created_at) BETWEEN $2::timestamptz AND $3::timestamptz AND NOT (coalesce(contact_id, '') = ANY($4))`,
    [user.id, ...range, testIds]
  )) { out[r.channel]++; if (r.contact_id) out.contactIds.add(r.contact_id); }
  const mine = [...new Set([user.gmailEmail, user.email].filter(Boolean).map(a => a.toLowerCase()))];
  if (!mine.length) return out;
  const team = new Set(teamAddresses.filter(Boolean).map(a => a.toLowerCase()));
  const ownName = `${user.first || ""} ${user.last || ""}`.trim().toLowerCase();
  const rows = q(
    `SELECT m.id, m.provider_message_id AS pid, m.contact_id, m.subject, left(m.created_at, 10) AS day,
            lower(coalesce(substring(m.to_addr from '<([^>]+)>'), m.to_addr)) AS to_email,
            trim(both ' "' from split_part(m.from_addr, '<', 1)) AS from_name,
            EXISTS (SELECT 1 FROM messages o WHERE o.contact_id = m.contact_id AND o.direction = 'outbound' AND o.channel = 'email'
                      AND o.source_type <> 'gmail_sent' AND o.subject = m.subject
                      AND abs(extract(epoch FROM safe_ts(o.created_at) - safe_ts(m.created_at))) < ${COPY_WINDOW_SECONDS}) AS crm_copy
       FROM messages m
      WHERE m.source_type = 'gmail_sent' AND ${GMAIL_FROM_M} = ANY($1)
        AND safe_ts(m.created_at) BETWEEN $2::timestamptz AND $3::timestamptz AND NOT (coalesce(m.contact_id, '') = ANY($4))`,
    [mine, ...range, testIds]
  );
  const ownSender = (n) => !n || ownName.includes(n.toLowerCase()) || mine.includes(n.toLowerCase());
  let kept = rows.filter(r => !team.has(r.to_email) && ownSender(r.from_name) && !r.crm_copy);
  const bulkKey = (r) => `${r.day}|${String(r.subject || "").replace(/^(re|fwd?):\s*/i, "").toLowerCase()}`;
  const recipients = new Map();
  for (const r of kept) { const k = bulkKey(r); if (!recipients.has(k)) recipients.set(k, new Set()); recipients.get(k).add(r.contact_id); }
  kept = kept.filter(r => !String(r.subject || "").trim() || recipients.get(bulkKey(r)).size < BULK_RECIPIENTS);
  out.email += new Set(kept.map(r => r.pid || r.id)).size;
  for (const r of kept) if (r.contact_id) out.contactIds.add(r.contact_id);
  return out;
}
export const GMAIL_SENT_FROM_INDEX_SQL = `CREATE INDEX CONCURRENTLY IF NOT EXISTS messages_gmail_sent_from ON messages ((${GMAIL_FROM}), created_at) INCLUDE (contact_id) WHERE source_type = 'gmail_sent'`;
// Inbound email/SMS in the range from these contacts (index-only:
// messages_inbound_contact).
export function inboundCountsInRange(contactIds, startMs, endMs) {
  const out = { email: 0, sms: 0 };
  if (!contactIds.length) return out;
  for (const r of q(
    `SELECT channel, count(DISTINCT coalesce(provider_message_id, id))::int AS n FROM messages
      WHERE contact_id = ANY($1) AND direction = 'inbound' AND channel IN ('email', 'sms')
        AND safe_ts(created_at) BETWEEN $2::timestamptz AND $3::timestamptz GROUP BY 1`,
    [contactIds, iso(startMs), iso(endMs)]
  )) out[r.channel] = r.n;
  return out;
}
export function ownedContactIds(ownerId) {
  return q(`SELECT id FROM contacts WHERE owner_id = $1 AND ${NOT_TEST}`, [ownerId]).map(r => r.id);
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
