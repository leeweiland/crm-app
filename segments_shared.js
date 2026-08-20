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
export function findContactMatch(contacts, email, phone) {
  const normEmail = String(email || "").trim().toLowerCase();
  const normPhone = digitsOnly(phone).slice(-10);
  return contacts.find(c =>
    (normEmail && c.email?.toLowerCase() === normEmail) ||
    (normPhone && digitsOnly(c.phone).slice(-10) === normPhone)
  ) || null;
}

// filter shape: { all: [ {field, op, value}, ... ] } | { any: [...] }
// field: "status" | "tags" | "listIds" | "customFields.<fieldId>"
// op: "eq" | "neq" | "includes" | "excludes" | "exists"
function evalCondition(contact, cond) {
  const { field, op, value } = cond;
  let actual;
  if (field.startsWith("customFields.")) {
    actual = contact.customFields?.[field.slice("customFields.".length)];
  } else {
    actual = contact[field];
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
