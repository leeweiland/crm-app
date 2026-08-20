import { readJson, writeJson } from "./auth_backend.js";

export const CONVERSATION_META_FILE = "crm_conversation_meta.json";

// Pin/star/done/archived flags per contact -- conversations themselves
// aren't a stored entity in this app (they're derived on the fly from the
// message log), so this is the one small piece of state that IS worth
// persisting separately rather than re-deriving. Split into its own module
// (rather than living in inbox_backend.js, where it started) so other
// backends -- compliance, email unsubscribe, contact status changes -- can
// archive a conversation without importing inbox_backend.js and risking a
// cycle back through its own sendEmail/sendSms imports.
export function getConvoMeta(contactId) {
  return readJson(CONVERSATION_META_FILE, []).find(m => m.contactId === contactId) || null;
}
export function setConvoMeta(contactId, patch) {
  const all = readJson(CONVERSATION_META_FILE, []);
  let row = all.find(m => m.contactId === contactId);
  if (!row) { row = { contactId, pinned: false, starred: false, done: false, archived: false }; all.push(row); }
  Object.assign(row, patch);
  writeJson(CONVERSATION_META_FILE, all);
  return row;
}
