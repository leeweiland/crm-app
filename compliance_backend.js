import { readJson, writeJson } from "./auth_backend.js";
import { CONTACTS_FILE } from "./segments_shared.js";
import { MESSAGE_LOG_FILE } from "./message_log.js";
import { getContactMessages } from "./message_index.js";
import { getComplianceSettings } from "./integrations_backend.js";
import { getConvoMeta, setConvoMeta } from "./conversation_meta.js";
import { syncContactFields } from "./sqlite_inbox.js";

// Real carriers require the ENTIRE message body to be exactly one reserved
// word (case/punctuation-insensitive) to trigger opt-out -- substring
// matching would false-positive on something like "please don't stop
// texting me".
export function isStopKeyword(text, keywords) {
  const cleaned = String(text || "").trim().toUpperCase().replace(/[^A-Z]/g, "");
  if (!cleaned) return false;
  return keywords.some(k => cleaned === String(k).trim().toUpperCase().replace(/[^A-Z]/g, ""));
}

// SMS-only: STOP is a carrier-compliance keyword and only ever implies SMS
// opt-out, never email -- email opt-out only ever happens via an explicit
// unsubscribe-link click.
//
// Sets ONLY smsOptOut, never contact.status. Deliberately keeping these
// separate: status is a sales-pipeline stage (POTENTIAL/APPLICATION/
// BOOKED/ENROLLED/etc), and someone who is genuinely ENROLLED (or BOOKED,
// or mid-APPLICATION) can still text STOP just to stop receiving texts --
// that must suppress SMS, not silently erase their real pipeline stage by
// overwriting it with "STOP". Confirmed live: this used to also set
// contact.status = "STOP", and a live audit of imported Close leads found
// real ENROLLED/APPLICATION/BOOKED people whose status had been clobbered
// this way, with no way to recover what it used to be. smsOptOut is the
// one and only source of truth for "don't text this person" now; a
// contact's status value of "STOP" is reserved for someone a human
// deliberately moved to that pipeline stage themselves (see
// applyStatusOptOut below, which reacts to a MANUAL status change instead
// of driving one).
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
  if (!contact || contact.smsOptOut) return false;
  contact.smsOptOut = true;
  contact.updatedAt = new Date().toISOString();
  writeJson(CONTACTS_FILE, contacts);
  // A suppressed contact has nothing left to action in the Inbox -- get
  // their thread out of the main list the same way a real STOP reply
  // would in any texting platform.
  setConvoMeta(contactId, { archived: true });
  return true;
}

// The exact status label used across the app for the permanent-opt-out
// pipeline stage. Status labels are freely editable text, not stable ids,
// so anything that checks a status BY STRING has to track a rename by
// hand -- this constant is the one place that string lives, so a future
// rename only has to happen here. (This label was found live-renamed to
// "BAD FIT / BLACKLIST" on 561 contacts with none of this string-matching
// code updated to follow -- see the 2026-09-01 status-rename cleanup that
// renamed the status definition and those 561 contacts back to plain
// "BLACKLIST" to match this code, rather than the other way around.)
export const BLACKLIST_STATUS_LABEL = "BLACKLIST";

// Applied whenever a contact's status is being set to STOP or the
// blacklist status, from any path (manual status dropdown, the Inbox's
// Blacklist context-menu action, etc). Mutates the in-memory contact only
// -- the caller already owns the writeJson(CONTACTS_FILE, ...) for this
// edit -- but does update the conversation directly, since that's a
// separate file.
//
// BLACKLIST hides the conversation (not archives it) -- same bucket the
// Inbox sidebar's "Hidden" filter already shows, so there's one single
// place to review every blacklisted contact rather than a dedicated
// tab of its own. A hidden conversation's inbound messages also stop
// counting toward unreadCount (see inbox_backend.js/sqlite_inbox.js) --
// permanently quarantined, not something that should ever demand
// attention again.
export function applyStatusOptOut(contact) {
  const settings = getComplianceSettings();
  if (!settings.blacklistAutoOptOut) return;
  if (contact.status === "STOP") { contact.smsOptOut = true; setConvoMeta(contact.id, { archived: true }); }
  else if (contact.status === BLACKLIST_STATUS_LABEL) { contact.smsOptOut = true; contact.emailOptOut = true; setConvoMeta(contact.id, { hidden: true }); }
}

// A reply CONTAINING (not being exactly) one of these words moves the
// contact straight to the blacklist status -- same effect a human
// blacklisting them manually has, via applyStatusOptOut: both channels
// opted out, archived, no reverse trigger, ever. Deliberately NOT the same
// whole-message-only check isStopKeyword uses for the carrier-compliance
// STOP keywords above -- those are reserved single-word replies by
// convention (real carriers require an exact match there), but someone
// texting something hostile/abusive rarely sends ONLY that word on its
// own, so requiring an exact match here meant this essentially never
// fired in practice. Previously two separate lists (a reversible "hide"
// action and a permanent "blacklist" action) -- merged into one, always
// permanent, since a message containing one of these words doesn't need
// a softer, reversible response.
export function containsTriggerWord(text, keywords) {
  const cleaned = String(text || "").toLowerCase();
  if (!cleaned) return false;
  return keywords.some(k => {
    const kw = String(k).trim().toLowerCase();
    return kw && cleaned.includes(kw);
  });
}
// Called once per inbound SMS, right alongside recheckStopStatus (reads
// the per-contact message file, not the full multi-GB log recheckStopStatus
// reads -- see message_index.js's own comment on why that split exists).
export function checkAutoTriggers(contactId) {
  if (!contactId) return;
  const settings = getComplianceSettings();
  if (!settings.triggerKeywordsEnabled || !settings.triggerKeywords.length) return;
  const latestInbound = getContactMessages(contactId)
    .filter(m => m.channel === "sms" && m.direction === "inbound")
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
  if (!latestInbound) return;
  const body = latestInbound.body || latestInbound.bodyPreview;
  if (!containsTriggerWord(body, settings.triggerKeywords)) return;

  const contacts = readJson(CONTACTS_FILE, []);
  const contact = contacts.find(c => c.id === contactId);
  if (contact && contact.status !== BLACKLIST_STATUS_LABEL) {
    contact.status = BLACKLIST_STATUS_LABEL;
    contact.updatedAt = new Date().toISOString();
    applyStatusOptOut(contact);
    writeJson(CONTACTS_FILE, contacts);
    // Status changed but this doesn't go through contacts_backend.js's
    // PATCH handler (the usual place that syncs a status change to the
    // sidebar's SQLite snapshot) -- without this, the Blacklist filter
    // tab and every other view keeps showing the OLD status until
    // something else happens to touch this contact. Confirmed live:
    // this was silently missing and the filter tab stayed empty.
    try { syncContactFields(contact.id, contact); } catch (e) { console.error("[sqlite_inbox] contact sync failed:", e.message); }
  }
}
