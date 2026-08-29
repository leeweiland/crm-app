import { mkdirSync, existsSync, unlinkSync } from "fs";
import { join } from "path";
import { DATA_DIR, readJson, writeJson, appendJsonRecords, updateJsonArrayRecordByField } from "./auth_backend.js";

// The Inbox's two hottest reads -- "everything said with contact X" and
// "one summary row per contact, most-recently-active first" -- both used to
// require a full scan of the message log (readJsonArrayFiltered/
// reduceJsonArray). Those are memory-SAFE, but a full scan of a 12GB file
// still takes 100+ seconds of real disk I/O no matter how little memory it
// holds along the way -- confirmed live: the conversations sidebar request
// was still in flight 25+ seconds in, and the per-contact endpoint is what
// the user reported as "convo isn't loading". Splitting the log into one
// small file per contact turns "scan everything" into "read this one
// contact's own few dozen-to-hundred messages", and a small persisted
// per-contact SUMMARY row turns the sidebar's full-log fold into a plain
// array read+sort -- both O(this contact) or O(distinct contacts), never
// O(total messages ever sent).
const CONTACT_MSG_DIR = "msg_by_contact";
export const CONVERSATION_INDEX_FILE = "crm_conversation_index.json";

let dirReady = false;
function ensureDir() {
  if (dirReady) return;
  const p = join(DATA_DIR, CONTACT_MSG_DIR);
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
  dirReady = true;
}
// contactId is always one of OUR OWN randomUUID() values (see
// newContactRecord/confirm-potential) -- never taken verbatim from an
// external system's id -- but a filesystem path is unforgiving, so guard
// against anything unexpected reaching it as a path segment.
function safeId(contactId) {
  return String(contactId).replace(/[^a-zA-Z0-9_-]/g, "");
}
function contactFile(contactId) { return `${CONTACT_MSG_DIR}/${safeId(contactId)}.json`; }

export function getContactMessages(contactId) {
  if (!contactId) return [];
  return readJson(contactFile(contactId), []);
}
export function appendContactMessage(message) {
  if (!message.contactId) return;
  ensureDir();
  appendJsonRecords(contactFile(message.contactId), [message]);
}
export function updateContactMessage(contactId, field, value, updater) {
  if (!contactId) return null;
  ensureDir();
  return updateJsonArrayRecordByField(contactFile(contactId), field, value, updater);
}
export function deleteContactMessageFile(contactId) {
  if (!contactId) return;
  const p = join(DATA_DIR, contactFile(contactId));
  if (existsSync(p)) unlinkSync(p);
}
export function markContactMessagesDone(contactId) {
  if (!contactId) return;
  const messages = getContactMessages(contactId);
  let changed = false;
  messages.forEach(m => { if (m.direction === "inbound" && !m.inboxDone) { m.inboxDone = true; changed = true; } });
  if (changed) writeJson(contactFile(contactId), messages);
}
// Per-contact files are small (one contact's own history, not millions of
// records), so a bulk update within one is just a plain read+forEach+write
// -- no need for the main log's byte-level tricks at this size.
export function updateContactMessagesByIds(contactId, idSet, updater) {
  if (!contactId) return;
  const messages = getContactMessages(contactId);
  let changed = false;
  messages.forEach(m => { if (idSet.has(m.id)) { updater(m); changed = true; } });
  if (changed) writeJson(contactFile(contactId), messages);
}

function slimMessage(m) {
  return { id: m.id, channel: m.channel, direction: m.direction, createdAt: m.createdAt, subject: m.subject, bodyPreview: m.bodyPreview, from: m.from, to: m.to, status: m.status, opened: !!m.statusHistory?.some(h => h.status === "opened") };
}
export function conversationKey(m) {
  return m.contactId || `unmatched:${m.channel}:${m.direction === "inbound" ? m.from : m.to}`;
}
// Same fold reduceJsonArray used to do per-request, applied to ONE new
// message at a time against the persisted summary array instead. The
// summary file stays small (one row per distinct contact/unmatched-address,
// a few hundred bytes each -- tens of MB total, not gigabytes) so a plain
// readJson+writeJson round trip on every send/receive is the same order of
// cost as the contacts.json writes this app has always done, not the
// 12GB-message-log cost this replaces.
// A contact's row mixes every channel together for the "all" view, but the
// Inbox also supports filtering the sidebar to just Email or just SMS --
// the old reduceJsonArray fold handled that by filtering messages BEFORE
// grouping, so "last" meant "last email" when that filter was active. A
// single combined `last` can't answer both questions at once, so each
// channel that actually shows up in the sidebar keeps its own slim ref
// alongside the combined one.
const SIDEBAR_CHANNELS = ["email", "sms", "form", "booking", "activity"];
function emptyGroup(key, contactId) {
  const g = { key, contactId: contactId || null, last: null, lastMine: null, lastInboundAt: null, unreadCount: 0, lastByChannel: {} };
  SIDEBAR_CHANNELS.forEach(c => { g.lastByChannel[c] = null; });
  return g;
}
function foldMessageIntoGroup(g, m) {
  const slim = slimMessage(m);
  if (!g.last || new Date(m.createdAt) > new Date(g.last.createdAt)) g.last = slim;
  if (!g.lastByChannel[m.channel] || new Date(m.createdAt) > new Date(g.lastByChannel[m.channel].createdAt)) g.lastByChannel[m.channel] = slim;
  if (m.direction === "outbound" && (!g.lastMine || new Date(m.createdAt) > new Date(g.lastMine.createdAt))) g.lastMine = slim;
  if (m.direction === "inbound") {
    if (!g.lastInboundAt || new Date(m.createdAt) > new Date(g.lastInboundAt)) g.lastInboundAt = m.createdAt;
    if (!m.inboxDone) g.unreadCount++;
  }
}
export function upsertConversationSummary(m) {
  if (!SIDEBAR_CHANNELS.includes(m.channel)) return;
  const key = conversationKey(m);
  const rows = readJson(CONVERSATION_INDEX_FILE, []);
  let g = rows.find(r => r.key === key);
  if (!g) { g = emptyGroup(key, m.contactId); rows.push(g); }
  foldMessageIntoGroup(g, m);
  writeJson(CONVERSATION_INDEX_FILE, rows);
}
// Recomputes one contact's summary row from scratch from its own (small)
// message file -- used after a status/inboxDone mutation, where relative
// order matters (e.g. "last" needs to still be genuinely last after an
// update) more than the incremental fold above can cheaply express.
export function recomputeConversationSummary(contactId) {
  const messages = getContactMessages(contactId).filter(m => SIDEBAR_CHANNELS.includes(m.channel));
  const rows = readJson(CONVERSATION_INDEX_FILE, []);
  const idx = rows.findIndex(r => r.contactId === contactId);
  if (!messages.length) { if (idx >= 0) { rows.splice(idx, 1); writeJson(CONVERSATION_INDEX_FILE, rows); } return; }
  const g = emptyGroup(contactId, contactId);
  for (const m of messages) foldMessageIntoGroup(g, m);
  if (idx >= 0) rows[idx] = g; else rows.push(g);
  writeJson(CONVERSATION_INDEX_FILE, rows);
}
export function removeConversationSummary(key) {
  const rows = readJson(CONVERSATION_INDEX_FILE, []);
  const next = rows.filter(r => r.key !== key);
  if (next.length !== rows.length) writeJson(CONVERSATION_INDEX_FILE, next);
}
