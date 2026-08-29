import { randomUUID } from "crypto";
import { appendJsonRecordFast, updateJsonArrayRecordByField, readJsonArrayFiltered } from "./auth_backend.js";
import { appendContactMessage, updateContactMessage, upsertConversationSummary, recomputeConversationSummary } from "./message_index.js";

export const MESSAGE_LOG_FILE = "crm_message_log.json";

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
export function logMessage({ channel, direction, contactId, sourceType, sourceId, providerMessageId, to, from, subject, body, bodyPreview, status }) {
  const row = {
    id: randomUUID(), channel, direction,
    contactId: contactId || null,
    sourceType: sourceType || "manual", sourceId: sourceId || null,
    providerMessageId: providerMessageId || null,
    to: to || null, from: from || null, subject: subject || null,
    body: body || "", bodyPreview: bodyPreview || "",
    status: status || "queued",
    statusHistory: [{ status: status || "queued", at: new Date().toISOString() }],
    sentAt: status === "sent" ? new Date().toISOString() : null,
    createdAt: new Date().toISOString(),
    inboxDone: false,
  };
  appendJsonRecordFast(MESSAGE_LOG_FILE, row);
  appendContactMessage(row);
  upsertConversationSummary(row);
  return row;
}
// EMERGENCY DISABLE (2026-08-29): this used to scan+rewrite the entire main
// log to find one row by providerMessageId -- confirmed live, that scan
// against the 12GB log filled the volume's remaining disk space (the copy
// needs roughly the file's own size in free space to complete) and blocked
// the whole single-threaded server for the duration, taking the app down.
// There is currently no providerMessageId -> contactId index, so there is
// no cheap way to do this lookup. Delivery/open/click/bounce webhooks now
// no-op instead of updating anything -- read-receipt ticks and per-message
// status in the Inbox will not reflect these events until a proper index
// is built (see the TODO this leaves: a small persisted
// providerMessageId->{id,contactId} map, appended to via
// appendJsonRecordFast at send time, exactly like msg_by_contact). Do not
// re-enable the full-log scan below without that index in place.
export function updateMessageStatusByProviderId(providerMessageId, status, extra) {
  return null;
}
export function updateMessageById(id, patch) {
  const found = updateJsonArrayRecordByField(MESSAGE_LOG_FILE, "id", id, row => {
    Object.assign(row, patch);
    if (patch.status) row.statusHistory.push({ status: patch.status, at: new Date().toISOString() });
    return row;
  });
  if (found) {
    updateContactMessage(found.contactId, "id", id, () => found);
    recomputeConversationSummary(found.contactId);
  }
  return found;
}
export function getMessagesForSource(sourceType, sourceId) {
  return readJsonArrayFiltered(MESSAGE_LOG_FILE, m => m.sourceType === sourceType && m.sourceId === sourceId);
}
