import { readJson, writeJson } from "./auth_backend.js";
import { CONTACTS_FILE } from "./segments_shared.js";
import { MESSAGE_LOG_FILE } from "./message_log.js";
import { getComplianceSettings } from "./integrations_backend.js";
import { setConvoMeta } from "./conversation_meta.js";

// Real carriers require the ENTIRE message body to be exactly one reserved
// word (case/punctuation-insensitive) to trigger opt-out -- substring
// matching would false-positive on something like "please don't stop
// texting me".
function isStopKeyword(text, keywords) {
  const cleaned = String(text || "").trim().toUpperCase().replace(/[^A-Z]/g, "");
  if (!cleaned) return false;
  return keywords.some(k => cleaned === String(k).trim().toUpperCase().replace(/[^A-Z]/g, ""));
}

// SMS-only: STOP is a carrier-compliance keyword and only ever implies SMS
// opt-out, never email -- email opt-out only ever happens via an explicit
// unsubscribe-link click.
//
// Always re-derives from the contact's chronologically LATEST inbound SMS
// in the full log, rather than trusting whichever single message triggered
// the call -- someone who said STOP once but kept replying normally
// afterward (i.e. their most recent message ISN'T a stop keyword) must
// never get retroactively suppressed just because "stop" appears somewhere
// in their history. Only ever ADDS the suppression, never removes it --
// un-suppressing a contact stays a deliberate human decision.
// Called after logging a live inbound SMS (Twilio webhook) and after a
// Close history import merges a contact's SMS activity, so both a live
// "STOP" reply and one they already sent before this CRM existed get caught.
export function recheckStopStatus(contactId) {
  if (!contactId) return false;
  const settings = getComplianceSettings();
  if (!settings.stopKeywordsEnabled) return false;

  const log = readJson(MESSAGE_LOG_FILE, []);
  const latestInbound = log
    .filter(m => m.contactId === contactId && m.channel === "sms" && m.direction === "inbound")
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
  if (!latestInbound || !isStopKeyword(latestInbound.body || latestInbound.bodyPreview, settings.stopKeywords)) return false;

  const contacts = readJson(CONTACTS_FILE, []);
  const contact = contacts.find(c => c.id === contactId);
  if (!contact || contact.status === "STOP") return false;
  contact.status = "STOP";
  contact.smsOptOut = true;
  contact.updatedAt = new Date().toISOString();
  writeJson(CONTACTS_FILE, contacts);
  // A suppressed contact has nothing left to action in the Inbox -- get
  // their thread out of the main list the same way a real STOP reply
  // would in any texting platform.
  setConvoMeta(contactId, { archived: true });
  return true;
}

// Applied whenever a contact's status is being set to STOP or BAD FIT /
// BLACKLIST, from any path (manual status dropdown, the Inbox's Blacklist
// context-menu action, etc). Mutates the in-memory contact only -- the
// caller already owns the writeJson(CONTACTS_FILE, ...) for this edit --
// but does archive the conversation directly, since that's a separate file.
export function applyStatusOptOut(contact) {
  const settings = getComplianceSettings();
  if (!settings.blacklistAutoOptOut) return;
  if (contact.status === "STOP") { contact.smsOptOut = true; setConvoMeta(contact.id, { archived: true }); }
  else if (contact.status === "BAD FIT / BLACKLIST") { contact.smsOptOut = true; contact.emailOptOut = true; setConvoMeta(contact.id, { archived: true }); }
}
