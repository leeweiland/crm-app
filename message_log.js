import { randomUUID } from "crypto";
import { appendJsonRecordFast, appendToJsonObjectFast, readJson } from "./auth_backend.js";
import { appendContactMessage, updateContactMessage, upsertConversationSummary, recomputeConversationSummary, appendSourceMessage, updateSourceMessageStatus, getSourceMessages, recordDailyStatsNew, recordDailyStatsTransition } from "./message_index.js";

export const MESSAGE_LOG_FILE = "crm_message_log.json";
// Small persisted index so a delivery/open/click/bounce webhook (arriving
// with only the provider's own message id) can find "which of our rows is
// this" in O(1) instead of scanning the whole message log for it -- see
// updateMessageStatusByProviderId below. Only ever grows going forward from
// when this was added; historical messages sent before it existed simply
// aren't in it; a webhook for one of those is a no-op instead of falling
// back to the full scan that filled the disk and hung the server (2026-08-29
// incident -- see git history on this file for the postmortem comment).
export const PROVIDER_ID_INDEX_FILE = "crm_provider_id_index.json";
// Same idea, keyed by OUR OWN row id instead of the provider's -- lets
// something that only has a message's own id (e.g. /api/email/click's ?m=)
// find its contactId in O(1) too, instead of the same full-log scan.
export const MESSAGE_ID_INDEX_FILE = "crm_message_id_index.json";

// logMessage/updateMessage* used to do readJson(MESSAGE_LOG_FILE,
// [])+writeJson on every single send/webhook -- at 12GB+ (millions of
// records, many carrying full email bodies) that parses+restringifies the
// ENTIRE log for every new message or status update, which both risks OOM
// and made every send/webhook take 100+ seconds. Even after switching to
// appendJsonRecords/updateJsonArrayRecordByField (bounded memory, never
// hold the full parsed array), logMessage was STILL confirmed live to hang
// every single send for 30-100+ seconds: appendJsonRecords still copies the
// entire existing file to append even one record (fine for bulk imports,
// which batch thousands of records per call; fatal for a live per-message
// call). logMessage now uses appendJsonRecordFast, a true in-place append
// that never touches existing bytes. updateMessageById/
// updateMessageStatusByProviderId still do a full-file pass (needed --
// they look up an arbitrary EXISTING message by id, which could be
// anywhere in the file) -- see email_backend.js/sms_backend.js, which no
// longer call updateMessageById at all for their own just-created row on
// the send path, logging once with the final status instead.
export function logMessage({ id, channel, direction, contactId, sourceType, sourceId, providerMessageId, to, from, subject, body, bodyPreview, status, failReason, createdAt, extra }) {
  const row = {
    // Accepts a pre-generated id -- email_backend.js's click-tracking link
    // wrapping needs the row's id baked into the email body BEFORE the send
    // (and therefore before this log call) happens, so it can't wait for
    // logMessage to mint one itself.
    id: id || randomUUID(), channel, direction,
    contactId: contactId || null,
    sourceType: sourceType || "manual", sourceId: sourceId || null,
    providerMessageId: providerMessageId || null,
    to: to || null, from: from || null, subject: subject || null,
    body: body || "", bodyPreview: bodyPreview || "",
    status: status || "queued",
    failReason: failReason || null,
    statusHistory: [{ status: status || "queued", at: createdAt || new Date().toISOString() }],
    sentAt: status === "sent" ? (createdAt || new Date().toISOString()) : null,
    // Real messages always log at the moment they happen, so `createdAt`
    // is never passed -- the override only exists for gmail_backend.js's
    // reconciliation path, which discovers a message well after Gmail
    // itself sent/received it and needs it to sort into its true place in
    // the thread instead of jumping to the top as if it just arrived.
    createdAt: createdAt || new Date().toISOString(),
    inboxDone: false,
    // Optional caller-specific fields merged in as-is (e.g. ac_sync.js's
    // acCampaignId, a reference into its own shared content store rather
    // than duplicating a campaign's full HTML onto every recipient's own
    // record -- confirmed live that duplicating it filled a 46GB volume
    // solid). Never read/interpreted by logMessage itself, purely a
    // passthrough so callers with their own bolt-on metadata don't need
    // logMessage's core shape to know about every one of them.
    ...(extra || {}),
  };
  appendJsonRecordFast(MESSAGE_LOG_FILE, row);
  appendContactMessage(row);
  appendSourceMessage(row);
  recordDailyStatsNew(row);
  upsertConversationSummary(row);
  if (row.providerMessageId) appendToJsonObjectFast(PROVIDER_ID_INDEX_FILE, row.providerMessageId, { id: row.id, contactId: row.contactId });
  appendToJsonObjectFast(MESSAGE_ID_INDEX_FILE, row.id, { contactId: row.contactId });
  return row;
}
// Was a full scan+rewrite of the entire main log to find one row by
// providerMessageId -- confirmed live (2026-08-29) that this filled the
// volume's remaining disk space (the copy needs roughly the file's own size
// in free space to complete) and blocked the whole single-threaded server
// for its duration, taking the app down. Now looks the row up in the small
// index instead (populated by logMessage above) and only touches the
// per-contact file, the per-source file, and the conversation summary, all
// cheap regardless of the main log's size. Deliberately does NOT also patch
// the main log's own copy of this message -- crm_message_log.json is
// write-once-append-only now; nothing reads it back for status (see
// getMessagesForSource below, which used to read stale status straight off
// it -- that staleness is exactly what routing status updates through the
// per-source file here fixes, not just the speed).
export function updateMessageStatusByProviderId(providerMessageId, status, extra) {
  if (!providerMessageId) return null;
  const entry = readJson(PROVIDER_ID_INDEX_FILE, {})[providerMessageId];
  if (!entry) return null;
  let oldStatus = null;
  const found = updateContactMessage(entry.contactId, "id", entry.id, row => {
    oldStatus = row.status;
    row.status = status;
    row.statusHistory.push({ status, at: new Date().toISOString(), ...(extra || {}) });
    return row;
  });
  if (found) {
    recomputeConversationSummary(entry.contactId);
    if (found.sourceType && found.sourceId) updateSourceMessageStatus(found.sourceType, found.sourceId, found.id, { status });
    recordDailyStatsTransition(found, oldStatus, status);
  }
  return found;
}
// Used by /api/email/click (marking a message "clicked" by our own row id).
// Same fix as updateMessageStatusByProviderId above: was a full scan of the
// main log to find the row by id, which is exactly the class of bug that
// caused the 2026-08-29 outage -- now O(1) via MESSAGE_ID_INDEX_FILE.
export function updateMessageById(id, patch) {
  const entry = readJson(MESSAGE_ID_INDEX_FILE, {})[id];
  if (!entry) return null;
  let oldStatus = null;
  const found = updateContactMessage(entry.contactId, "id", id, row => {
    oldStatus = row.status;
    Object.assign(row, patch);
    if (patch.status) row.statusHistory.push({ status: patch.status, at: new Date().toISOString() });
    return row;
  });
  if (found) {
    recomputeConversationSummary(entry.contactId);
    if (found.sourceType && found.sourceId) updateSourceMessageStatus(found.sourceType, found.sourceId, id, patch);
    if (patch.status) recordDailyStatsTransition(found, oldStatus, patch.status);
  }
  return found;
}
export function getMessagesForSource(sourceType, sourceId) {
  return getSourceMessages(sourceType, sourceId);
}
