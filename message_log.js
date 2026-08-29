import { randomUUID } from "crypto";
import { appendJsonRecords, updateJsonArrayRecordByField, readJsonArrayFiltered } from "./auth_backend.js";

export const MESSAGE_LOG_FILE = "crm_message_log.json";

// logMessage/updateMessage* used to do readJson(MESSAGE_LOG_FILE,
// [])+writeJson on every single send/webhook -- at 12GB+ (millions of
// records, many carrying full email bodies) that parses+restringifies the
// ENTIRE log for every new message or status update, which both risks OOM
// and made every send/webhook take 100+ seconds. appendJsonRecords/
// updateJsonArrayRecordByField never hold the full parsed array.
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
  appendJsonRecords(MESSAGE_LOG_FILE, [row]);
  return row;
}
export function updateMessageStatusByProviderId(providerMessageId, status, extra) {
  if (!providerMessageId) return null;
  return updateJsonArrayRecordByField(MESSAGE_LOG_FILE, "providerMessageId", providerMessageId, row => {
    row.status = status;
    row.statusHistory.push({ status, at: new Date().toISOString(), ...(extra || {}) });
    return row;
  });
}
export function updateMessageById(id, patch) {
  return updateJsonArrayRecordByField(MESSAGE_LOG_FILE, "id", id, row => {
    Object.assign(row, patch);
    if (patch.status) row.statusHistory.push({ status: patch.status, at: new Date().toISOString() });
    return row;
  });
}
export function getMessagesForSource(sourceType, sourceId) {
  return readJsonArrayFiltered(MESSAGE_LOG_FILE, m => m.sourceType === sourceType && m.sourceId === sourceId);
}
