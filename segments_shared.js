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
// op: "eq" | "neq" | "includes" | "excludes" | "exists"
function evalCondition(contact, cond) {
  const { field, op, value } = cond;
  let actual;
  if (field.startsWith("customFields.")) {
    actual = contact.customFields?.[field.slice("customFields.".length)];
  } else {
    actual = contact[field];
  }
  // smsOptOut/emailOptOut are real booleans on the contact, but the filter
  // UI's <select> always sends a string ("true"/"false") -- coerce both
  // sides so "eq"/"neq" compares like-for-like instead of a boolean never
  // strictly-equaling the string "true".
  if (field === "smsOptOut" || field === "emailOptOut") {
    actual = !!actual;
    const boolValue = value === true || value === "true";
    switch (op) {
      case "eq": return actual === boolValue;
      case "neq": return actual !== boolValue;
      default: return false;
    }
  }
  switch (op) {
    case "eq": return actual === value;
    case "neq": return actual !== value;
    case "includes": return Array.isArray(actual) && actual.includes(value);
    case "excludes": return Array.isArray(actual) && !actual.includes(value);
    case "exists": return actual !== undefined && actual !== null && actual !== "";
    default: return false;
  }
}
export function matchesSegment(contact, filter) {
  if (!filter) return true;
  if (filter.all) return filter.all.every(c => evalCondition(contact, c));
  if (filter.any) return filter.any.some(c => evalCondition(contact, c));
  return true;
}
