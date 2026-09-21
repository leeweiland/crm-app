// Pulled out of contacts_backend.js so automations_backend.js can use these
// without creating a circular import: contacts_backend.js needs to call
// automations_backend.js's fireTrigger() on list/tag changes, and
// automations_backend.js needs the contact-matching predicate for its
// "condition" step -- both sides importing straight from each other would
// cycle. Pure data/functions only, no side effects, safe for anything to
// import.
import { readJson } from "./auth_backend.js";

export const CONTACTS_FILE = "crm_contacts.json";
export const SEGMENTS_FILE = "crm_segments.json";
export const STAFF_ACTIVITY_FILE = "crm_staff_activity.json";
// Duplicated from statuses_backend.js's own STATUSES_FILE (not imported) --
// statuses_backend.js needs to import CONTACTS_FILE/sqlite sync helpers
// from here and sqlite_inbox.js to cascade-rename a status across every
// contact, and both of those already import from this module, so pulling
// STATUSES_FILE the other way round would cycle back here. Just a filename
// string, safe to duplicate.
const STATUSES_FILE = "crm_statuses.json";

export function digitsOnly(phone) { return String(phone || "").replace(/\D/g, ""); }

// Settings > Statuses' drag-to-reorder position is a real pipeline
// hierarchy (POTENTIAL lowest, FINISHED highest) -- higher order means
// further along, and a contact should never move backward in that
// hierarchy from an AUTOMATED trigger (a re-submitted form, a mistakenly-
// booked second call). A human explicitly picking a status from the
// dropdown bypasses this entirely (contacts_backend.js's PATCH handler
// sets contact.status directly, no guard) -- only inferred status changes
// go through here.
export function getStatusOrderMap() {
  return new Map(readJson(STATUSES_FILE, []).map(s => [s.label, s.order]));
}
// Returns true if it actually changed contact.status. Fails OPEN (applies
// the change) whenever either label isn't found in the hierarchy -- a
// custom status someone added, or one that got renamed/deleted, must
// never silently get stuck because this guard can't place it, only ever
// block a move it can actually confirm is a downgrade.
export function applyAdvancingStatus(contact, newLabel, orderMap) {
  if (!newLabel || contact.status === newLabel) return false;
  if (!contact.status) { contact.status = newLabel; return true; }
  const map = orderMap || getStatusOrderMap();
  const curOrder = map.get(contact.status);
  const newOrder = map.get(newLabel);
  if (curOrder == null || newOrder == null || newOrder >= curOrder) { contact.status = newLabel; return true; }
  return false;
}

// A person is the same contact if EITHER their email OR their phone
// matches -- not "phone only when there's no email" like several importers
// used to do. Someone re-entering through a different channel (e.g. a
// Close lead with only a phone on file, later filling out a web form with
// their email) must land on the existing record, not a duplicate. Phone
// compares on the last 10 digits so formatting/country-code differences
// ("+18085551234" vs "808-555-1234") don't cause a false miss.
// Beyond the contact's own primary email/phone, also checks the identity
// signals Hyros/merges/multi-contact-method imports have already surfaced:
// hyrosOriginLead.email (Hyros's own "this pre-conversion click identity
// belongs to that lead" link), hyrosPhones (every phone Hyros ever saw for
// the lead, not just one), altEmails (emails folded in by a manual/bulk
// duplicate merge, or a source system that had more than one email on
// file), and altPhones (same idea as altEmails, for phones -- kept
// separate from hyrosPhones rather than merged into it, since that field
// is specifically Hyros's own click-identity signal and this app's own
// multi-phone-per-contact support shouldn't be coupled to whether Hyros
// happens to be connected). Without this, a new AC/Close record matching
// only a contact's ORIGIN identity would create a fresh duplicate instead
// of attaching to the already-merged person -- exactly the gap that let
// 8,000+ Hyros-flagged duplicates sit unmerged before this was added.
export function findContactMatch(contacts, email, phone) {
  const normEmail = String(email || "").trim().toLowerCase();
  const normPhone = digitsOnly(phone).slice(-10);
  return contacts.find(c =>
    (normEmail && c.email?.toLowerCase() === normEmail) ||
    (normPhone && digitsOnly(c.phone).slice(-10) === normPhone) ||
    (normEmail && (c.altEmails || []).some(e => e.toLowerCase() === normEmail)) ||
    (normEmail && c.hyrosOriginLead?.email?.toLowerCase() === normEmail) ||
    (normPhone && (c.hyrosPhones || []).some(p => digitsOnly(p).slice(-10) === normPhone)) ||
    (normPhone && (c.altPhones || []).some(p => digitsOnly(p).slice(-10) === normPhone))
  ) || null;
}

// firstSeenAt is "when this person first appeared in ANY connected system"
// (AC contact created / Close lead created / Hyros lead created), distinct
// from our own createdAt (just when WE imported them) -- the Contacts list
// "Created" column shows firstSeenAt so it reflects the real oldest date
// across sources, not whichever day someone happened to click Import. Only
// ever moves earlier -- an older date discovered later (re-importing from a
// second source, or a duplicate merge) should win, never a newer one
// overwriting a genuinely earlier date. Shared here (not in import_backend.js)
// so hyros_backend.js can use it too without a circular import.
export function markFirstSeen(contact, candidateISO) {
  if (!candidateISO) return;
  if (!contact.firstSeenAt || new Date(candidateISO) < new Date(contact.firstSeenAt)) contact.firstSeenAt = candidateISO;
}

// The date a contact actually BECAME a lead, as epoch ms (null if unknown): the
// oldest of their firstSeenAt (AC contact created / Close lead created / Hyros
// lead created -- see markFirstSeen) and their createdAt. createdAt alone is
// wrong for anyone imported: 145K Hyros/AC contacts were bulk-imported on
// Aug 21-23 2026, so their createdAt is the import day, years after they
// really became leads -- a "new leads since Sep 6" filter on createdAt matched
// all of them. Taking the earlier of the two also keeps brand-new native
// contacts (form/booking, no firstSeenAt until a sync fills it in) correct,
// and drops a "new" contact who turns out to have been in AC/Close for years.
// Hyros stamped its lead times with a wrong -09:00 offset on what are really
// UTC clock digits (same correction as reporting_backend.js's hyrosLeadMs);
// only the -09:00 case is touched, so an AC date that later moved firstSeenAt
// earlier (real -05:00/-06:00 offsets) is read as-is.
export function leadDateMs(contact) {
  const times = [];
  const fs = contact.firstSeenAt;
  if (fs) {
    const t = contact.source === "hyros_import" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?-09:00$/.test(fs)
      ? Date.parse(fs.slice(0, 19) + "Z")
      : new Date(fs).getTime();
    if (!isNaN(t)) times.push(t);
  }
  if (contact.createdAt) {
    const t = new Date(contact.createdAt).getTime();
    if (!isNaN(t)) times.push(t);
  }
  return times.length ? Math.min(...times) : null;
}

// filter shape: { all: [ {field, op, value}, ... ] } | { any: [...] }
// field: "status" | "smsOptOut" | "emailOptOut" | "tags" | "listIds" | "customFields.<fieldId>"
//      | "emailOpened" | "emailClicked" | "visitedPage" | "firstSeenAt" | "createdAt"
// op: "eq" | "neq" | "includes" | "excludes" | "exists"           (legacy, still fully supported)
//   | "any_of" | "all_of" | "not_any_of" | "not_all_of"           (new -- value is an array, array-valued fields only)
//   | "contains"                                                   (new -- substring match, visitedPage only)
//   | "within_last_hours"                                          (new -- value is a number of hours, firstSeenAt/createdAt only, re-evaluated against Date.now() every read)
//   | "between"                                                    (new -- value is {from, to} ISO timestamps, firstSeenAt/createdAt only; a FIXED calendar window baked into the filter at save time, unlike within_last_hours -- e.g. "created on this specific date". `to` is exclusive.)
//   | "within_last_days"                                           (new -- value is a number of days, emailOpened/emailClicked only: latest such event within the last N days, incl. imported ActiveCampaign history)
//   | "after"                                                       (new -- value is a single ISO timestamp, firstSeenAt/createdAt only; a FIXED lower bound with no upper bound, so it keeps matching every new contact from that point forward -- e.g. "leads since Sep 6, 2026, ongoing".)
//   | "gt" | "gte" | "lt" | "lte"                                  (new -- customFields.<id> only; numeric comparison, value is a number. "$85,000" / "85,000" read as 85000; a blank or non-numeric field never matches, so "income > 60000" can't be satisfied by a contact with no estimate.)
//
// field "staffActivity:<userId>" with op "within_last_days" | "not_within_last_days"
// (value = number of days): whether that team member has an email or SMS
// conversation with the contact -- any message they sent, or an email
// received at their own address -- in the last N days. Backed by the small
// crm_staff_activity.json index (staff_activity.js), never the message log.
//
// emailOpened/emailClicked and visitedPage are deliberately NOT read from
// crm_message_log.json / crm_page_visits.json here -- both can grow huge in
// production (crm_message_log.json is 12+GB and a full-file scan against it
// already caused a real outage, see message_log.js's postmortem comment).
// Instead they read two small denormalized properties written directly onto
// the contact record as each event happens (see contacts_backend.js's
// markContactEmailEngagement/markContactVisitedPage, called from
// email_backend.js's SES webhook and tracking_backend.js's pageview
// handler) -- matchesSegment stays exactly as cheap as it already was,
// touching only the contact object already in memory.
function evalCondition(contact, cond) {
  const { field, op, value } = cond;

  // "within_last_hours" is deliberately computed against Date.now() at
  // EVALUATION time, not a fixed cutoff baked in when the segment was
  // saved -- a saved "new leads, last 72 hours" segment has to keep
  // meaning "the last 72 hours" every time it's read (campaign send,
  // segment preview, bulk-enroll), not "whoever matched on the day I
  // created this segment".
  //
  // firstSeenAt and createdAt are the SAME condition here: both mean the
  // contact's lead date (leadDateMs, above -- the oldest of their Hyros/Close/
  // AC dates and createdAt), never the raw createdAt, which for an imported
  // contact is just the day they were bulk-loaded into this CRM. Using the
  // earlier of the two also covers what the old split was for: a brand-new
  // native contact has no firstSeenAt until a sync fills it in (confirmed
  // 2026-09-14 it can lag by weeks), so its createdAt stands in immediately.
  if ((field === "firstSeenAt" || field === "createdAt") && op === "within_last_hours") {
    const at = leadDateMs(contact);
    if (at == null) return false;
    const ageMs = Date.now() - at;
    return ageMs >= 0 && ageMs <= Number(value) * 3600 * 1000;
  }
  if ((field === "firstSeenAt" || field === "createdAt") && op === "between") {
    const t = leadDateMs(contact);
    if (t == null) return false;
    return t >= new Date(value.from).getTime() && t < new Date(value.to).getTime();
  }
  if ((field === "firstSeenAt" || field === "createdAt") && op === "after") {
    const t = leadDateMs(contact);
    if (t == null) return false;
    return t >= new Date(value).getTime();
  }

  // "Opened / clicked an email in the last N days". Reads the LATEST event
  // time kept on the contact (emailEngagement.openedAt/clickedAt), which the
  // live SES webhook, the AC sync on conversation open, and the back-channel copy of
  // AC's own last-open/last-click dates (backchannel/ac_engagement.mjs) all feed -- no message-log
  // scan here. A click counts as an open (same as the chat panel: ActiveCampaign
  // exposes no open pixel for bulk sends, only clicks), so "opened" takes the
  // later of the two.
  if ((field === "emailOpened" || field === "emailClicked") && op === "within_last_days") {
    const eng = contact.emailEngagement || {};
    const ms = v => { const t = v ? new Date(v).getTime() : NaN; return isNaN(t) ? 0 : t; };
    const at = field === "emailOpened" ? Math.max(ms(eng.openedAt), ms(eng.clickedAt)) : ms(eng.clickedAt);
    if (!at) return false;
    const ageMs = Date.now() - at;
    return ageMs >= 0 && ageMs <= Number(value) * 24 * 3600 * 1000;
  }

  if (field.startsWith("staffActivity:") && (op === "within_last_days" || op === "not_within_last_days")) {
    const lastAt = Date.parse(staffActivityIndex()[field.slice("staffActivity:".length)]?.[contact.id] || "");
    const recent = !isNaN(lastAt) && Date.now() - lastAt <= Number(value) * 24 * 3600 * 1000;
    return op === "within_last_days" ? recent : !recent;
  }

  if (field === "visitedPage") {
    const paths = contact.visitedPaths || [];
    switch (op) {
      case "eq": return paths.includes(value);
      case "neq": return !paths.includes(value);
      case "contains": return paths.some(p => p.toLowerCase().includes(String(value || "").toLowerCase()));
      default: return false;
    }
  }

  let actual;
  if (field.startsWith("customFields.")) {
    actual = contact.customFields?.[field.slice("customFields.".length)];
  } else if (field === "emailOpened") {
    actual = !!(contact.emailEngagement?.opened || contact.emailEngagement?.clicked); // a click implies an open
  } else if (field === "emailClicked") {
    actual = !!contact.emailEngagement?.clicked;
  } else {
    actual = contact[field];
  }
  // smsOptOut/emailOptOut/emailOpened/emailClicked are real booleans, but
  // the filter UI's <select> always sends a string ("true"/"false") --
  // coerce both sides so "eq"/"neq" compares like-for-like instead of a
  // boolean never strictly-equaling the string "true".
  if (field === "smsOptOut" || field === "emailOptOut" || field === "emailOpened" || field === "emailClicked") {
    actual = !!actual;
    const boolValue = value === true || value === "true";
    switch (op) {
      case "eq": return actual === boolValue;
      case "neq": return actual !== boolValue;
      default: return false;
    }
  }
  // any_of/not_any_of also work against a SCALAR actual (e.g. status) --
  // "is any of [A, B, C]" then just means "equals one of these", same
  // idea as a SQL `IN (...)`. all_of/not_all_of stay array-only: a scalar
  // can never simultaneously equal more than one selected value.
  switch (op) {
    case "eq": return actual === value;
    case "neq": return actual !== value;
    case "includes": return Array.isArray(actual) && actual.includes(value);
    case "excludes": return Array.isArray(actual) && !actual.includes(value);
    case "exists": return actual !== undefined && actual !== null && actual !== "";
    case "any_of": return Array.isArray(value) && (Array.isArray(actual) ? value.some(v => actual.includes(v)) : value.includes(actual));
    case "all_of": return Array.isArray(actual) && Array.isArray(value) && value.length > 0 && value.every(v => actual.includes(v));
    case "not_any_of": return !(Array.isArray(value) && (Array.isArray(actual) ? value.some(v => actual.includes(v)) : value.includes(actual)));
    case "not_all_of": return !(Array.isArray(actual) && Array.isArray(value) && value.length > 0 && value.every(v => actual.includes(v)));
    case "gt": case "gte": case "lt": case "lte": {
      const a = toNumber(actual), b = toNumber(value);
      if (isNaN(a) || isNaN(b)) return false;
      return op === "gt" ? a > b : op === "gte" ? a >= b : op === "lt" ? a < b : a <= b;
    }
    default: return false;
  }
}
// Custom-field values are free text -- tolerate "$85,000" but never treat a
// blank as zero (Number("") is 0, which would make every empty field "< 60000").
function toNumber(v) {
  const s = String(v ?? "").replace(/[$,\s]/g, "");
  return s === "" ? NaN : Number(s);
}
// crm_staff_activity.json: { [userId]: { [contactId]: lastActivityISO } }. A
// segment pass calls evalCondition once per contact, and readJson stats the
// file every time -- a 2-second memo keeps a full-contacts pass to one read.
let _staffIdx = null, _staffIdxAt = 0;
function staffActivityIndex() {
  if (!_staffIdx || Date.now() - _staffIdxAt > 2000) { _staffIdx = readJson(STAFF_ACTIVITY_FILE, {}); _staffIdxAt = Date.now(); }
  return _staffIdx;
}
export function matchesSegment(contact, filter) {
  if (!filter) return true;
  if (filter.all) return filter.all.every(c => evalCondition(contact, c));
  if (filter.any) return filter.any.some(c => evalCondition(contact, c));
  return true;
}

// Shared by any "bulk add to automation/sequence" endpoint -- the caller
// sends either an explicit contactIds array (already-selected contacts,
// from the Contacts table's bulk-select) or a segmentId/tagId to resolve
// server-side (from the Segments/Tags tab's row-level "Add to..." action),
// so the frontend never has to already know every contact id in a segment
// or tag just to enroll it. contactId (singular) is kept too since
// workflow-detail.html's existing one-at-a-time "Manually Enroll" UI
// already sends that shape.
export function resolveBulkContactIds(body) {
  if (Array.isArray(body.contactIds) && body.contactIds.length) return body.contactIds;
  if (body.contactId) return [body.contactId];
  if (body.segmentId) {
    const segments = readJson(SEGMENTS_FILE, []);
    const segment = segments.find(s => s.id === body.segmentId);
    if (!segment) return [];
    return readJson(CONTACTS_FILE, []).filter(c => matchesSegment(c, segment.filter)).map(c => c.id);
  }
  if (body.tagId) {
    return readJson(CONTACTS_FILE, []).filter(c => (c.tags || []).includes(body.tagId)).map(c => c.id);
  }
  return [];
}
