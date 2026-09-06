import { readJson, writeJson } from "./auth_backend.js";
import { syncMetaFields } from "./sqlite_inbox.js";

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
// Same lookup as getConvoMeta, but for callers (the conversation-list
// endpoint) that need it once per contact in a loop -- reads the file a
// single time and hands back a Map instead of paying a fresh readJson +
// linear .find() per contact.
export function getConvoMetaMap() {
  const map = new Map();
  for (const m of readJson(CONVERSATION_META_FILE, [])) map.set(m.contactId, m);
  return map;
}
export function setConvoMeta(contactId, patch) {
  const all = readJson(CONVERSATION_META_FILE, []);
  let row = all.find(m => m.contactId === contactId);
  if (!row) { row = { contactId, pinned: false, starred: false, done: false, archived: false, hidden: false, lastSeenAt: null }; all.push(row); }
  Object.assign(row, patch);
  writeJson(CONVERSATION_META_FILE, all);
  // Best-effort, same reasoning as message_index.js's safeSqliteSync -- a
  // sync bug here shouldn't block the actual pin/star/archive/done toggle.
  try { syncMetaFields(contactId, row); } catch (e) { console.error("[sqlite_inbox] meta sync failed:", e.message); }
  return row;
}
