// Pulled out of contacts_backend.js so automations_backend.js can use these
// without creating a circular import: contacts_backend.js needs to call
// automations_backend.js's fireTrigger() on list/tag changes, and
// automations_backend.js needs the contact-matching predicate for its
// "condition" step -- both sides importing straight from each other would
// cycle. Pure data/functions only, no side effects, safe for anything to
// import.
export const CONTACTS_FILE = "crm_contacts.json";
export const SEGMENTS_FILE = "crm_segments.json";

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
