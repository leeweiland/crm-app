import { randomUUID } from "crypto";
import { readJson, writeJson } from "./auth_backend.js";

export const MESSAGE_LOG_FILE = "crm_message_log.json";

// Single source of truth for all send/receive activity across every
// channel (email now, SMS in Phase 4) and every source (campaign,
// automation step, workflow step, manual, inbound) -- reporting rolls up
// from this one file by filtering on sourceType/sourceId, rather than each
// feature keeping its own duplicate counters.
export function logMessage({ channel, direction, contactId, sourceType, sourceId, providerMessageId, to, from, subject, bodyPreview, status }) {
  const log = readJson(MESSAGE_LOG_FILE, []);
  const row = {
    id: randomUUID(), channel, direction,
    contactId: contactId || null,
    sourceType: sourceType || "manual", sourceId: sourceId || null,
    providerMessageId: providerMessageId || null,
    to: to || null, from: from || null, subject: subject || null, bodyPreview: bodyPreview || "",
    status: status || "queued",
    statusHistory: [{ status: status || "queued", at: new Date().toISOString() }],
    sentAt: status === "sent" ? new Date().toISOString() : null,
    createdAt: new Date().toISOString(),
  };
  log.push(row);
  writeJson(MESSAGE_LOG_FILE, log);
  return row;
}

// Delivery/open/click/bounce webhooks (SES/Twilio) arrive keyed by the
// provider's own message id, not our row id -- this is the join point.
export function updateMessageStatusByProviderId(providerMessageId, status, extra) {
  const log = readJson(MESSAGE_LOG_FILE, []);
  const row = log.find(m => m.providerMessageId === providerMessageId);
  if (!row) return null;
  row.status = status;
  row.statusHistory.push({ status, at: new Date().toISOString(), ...(extra || {}) });
  writeJson(MESSAGE_LOG_FILE, log);
  return row;
}

export function getMessagesForSource(sourceType, sourceId) {
  return readJson(MESSAGE_LOG_FILE, []).filter(m => m.sourceType === sourceType && m.sourceId === sourceId);
}
