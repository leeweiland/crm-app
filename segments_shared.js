// Pulled out of contacts_backend.js so automations_backend.js can use these
// without creating a circular import: contacts_backend.js needs to call
// automations_backend.js's fireTrigger() on list/tag changes, and
// automations_backend.js needs the contact-matching predicate for its
// "condition" step -- both sides importing straight from each other would
// cycle. Pure data/functions only, no side effects, safe for anything to
// import.
export const CONTACTS_FILE = "crm_contacts.json";
export const SEGMENTS_FILE = "crm_segments.json";

export function digitsOnly(phone) { return String(phone || "").replace(/\D/g, ""); }

// A person is the same contact if EITHER their email OR their phone
// matches -- not "phone only when there's no email" like several importers
// used to do. Someone re-entering through a different channel (e.g. a
// Close lead with only a phone on file, later filling out a web form with
// their email) must land on the existing record, not a duplicate. Phone
// compares on the last 10 digits so formatting/country-code differences
// ("+18085551234" vs "808-555-1234") don't cause a false miss.
// Beyond the contact's own primary email/phone, also checks the identity
// signals Hyros/merges have already surfaced: hyrosOriginLead.email (Hyros's
// own "this pre-conversion click identity belongs to that lead" link),
// hyrosPhones (every phone Hyros ever saw for the lead, not just one), and
// altEmails (emails folded in by a manual/bulk duplicate merge). Without
// this, a new AC/Close record matching only a contact's ORIGIN identity
// would create a fresh duplicate instead of attaching to the already-merged
// person -- exactly the gap that let 8,000+ Hyros-flagged duplicates sit
// unmerged before this was added.
export function findContactMatch(contacts, email, phone) {
  const normEmail = String(email || "").trim().toLowerCase();
  const normPhone = digitsOnly(phone).slice(-10);
  return contacts.find(c =>
    (normEmail && c.email?.toLowerCase() === normEmail) ||
    (normPhone && digitsOnly(c.phone).slice(-10) === normPhone) ||
    (normEmail && (c.altEmails || []).some(e => e.toLowerCase() === normEmail)) ||
    (normEmail && c.hyrosOriginLead?.email?.toLowerCase() === normEmail) ||
    (normPhone && (c.hyrosPhones || []).some(p => digitsOnly(p).slice(-10) === normPhone))
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

// filter shape: { all: [ {field, op, value}, ... ] } | { any: [...] }
// field: "status" | "smsOptOut" | "emailOptOut" | "tags" | "listIds" | "customFields.<fieldId>"
//      | "emailOpened" | "emailClicked" | "visitedPage"
// op: "eq" | "neq" | "includes" | "excludes" | "exists"           (legacy, still fully supported)
//   | "any_of" | "all_of" | "not_any_of" | "not_all_of"           (new -- value is an array, array-valued fields only)
//   | "contains"                                                   (new -- substring match, visitedPage only)
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
    actual = !!contact.emailEngagement?.opened;
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
    default: return false;
  }
}
export function matchesSegment(contact, filter) {
  if (!filter) return true;
  if (filter.all) return filter.all.every(c => evalCondition(contact, c));
  if (filter.any) return filter.any.some(c => evalCondition(contact, c));
  return true;
}
