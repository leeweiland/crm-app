import { mkdirSync, existsSync, unlinkSync } from "fs";
import { join } from "path";
import { DATA_DIR, readJson, writeJson, appendJsonRecords, updateJsonArrayRecordByField } from "./auth_backend.js";
import { syncMessageFields, deleteConversationRow } from "./sqlite_inbox.js";

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

// Same split as msg_by_contact above, but keyed by (sourceType, sourceId)
// instead of contactId -- this is what lets a campaign/automation-step/
// workflow-step reporting query read "just this source's own messages"
// instead of scanning crm_message_log.json (12+GB and growing; see
// message_log.js's postmortem comment). sourceId is sometimes compound
// ("<automationId>:<stepId>") -- the ":" becomes "_" below, which is fine
// since callers always know the exact sourceType+sourceId pair up front
// (from the automation/workflow's own step list) rather than needing to
// parse it back out of the filename.
const SOURCE_MSG_DIR = "msg_by_source";
let sourceDirReady = false;
function ensureSourceDir() {
  if (sourceDirReady) return;
  const p = join(DATA_DIR, SOURCE_MSG_DIR);
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
  sourceDirReady = true;
}
function sourceFile(sourceType, sourceId) {
  return `${SOURCE_MSG_DIR}/${safeId(sourceType)}__${safeId(sourceId)}.json`;
}
// Slim rows only -- these can hold every message a busy campaign or
// automation step ever sent, so the same "keep it small" reasoning as
// slimMessage() above applies: enough for stats and a recipient-list table
// (campaign-report.html), not full bodies.
function slimSourceMessage(m) {
  return { id: m.id, contactId: m.contactId, to: m.to, status: m.status, sentAt: m.sentAt || m.createdAt };
}
export function getSourceMessages(sourceType, sourceId) {
  if (!sourceType || !sourceId) return [];
  return readJson(sourceFile(sourceType, sourceId), []);
}
export function appendSourceMessage(message) {
  if (!message.sourceType || !message.sourceId) return;
  ensureSourceDir();
  appendJsonRecords(sourceFile(message.sourceType, message.sourceId), [slimSourceMessage(message)]);
}
export function updateSourceMessageStatus(sourceType, sourceId, id, patch) {
  if (!sourceType || !sourceId) return;
  ensureSourceDir();
  updateJsonArrayRecordByField(sourceFile(sourceType, sourceId), "id", id, m => ({ ...m, ...patch }));
}

// Per-day running counts (by CURRENT status, same classification
// statsFromMessages/smsStatsFromMessages in reporting_backend.js already
// use) so the overview/email-daily/sms-daily dashboards never scan
// crm_message_log.json either -- same reasoning as msg_by_source above,
// bucketed by day+category instead of by source. Small regardless of
// message volume: bounded by (distinct days) x (a handful of status
// counters), not by messages ever sent.
// Bucketed by the message's own createdAt date, not whenever a later
// status update lands -- a message sent on day X that's opened on day X+2
// still counts toward day X's "opened" bucket, matching how these
// dashboards have always grouped (by send day, not by event day).
export const DAILY_STATS_FILE = "crm_daily_message_stats.json";
function dayKey(iso) { return String(iso || "").slice(0, 10); }
function emptyDayBucket() { return { emailOut: {}, smsOut: {}, smsInCount: 0, automationEmailOut: {}, workflowSmsOut: {} }; }
function bumpStatus(obj, status, delta) {
  const next = (obj[status] || 0) + delta;
  if (next > 0) obj[status] = next; else delete obj[status];
}
function applyDailyDelta(bucket, row, status, delta) {
  if (row.channel === "email" && row.direction === "outbound") {
    bumpStatus(bucket.emailOut, status, delta);
    if (row.sourceType === "automation_step") bumpStatus(bucket.automationEmailOut, status, delta);
  } else if (row.channel === "sms" && row.direction === "inbound") {
    bucket.smsInCount = Math.max(0, (bucket.smsInCount || 0) + delta);
  } else if (row.channel === "sms") {
    bumpStatus(bucket.smsOut, status, delta);
    if (row.sourceType === "workflow_step") bumpStatus(bucket.workflowSmsOut, status, delta);
  }
  // Other channels (form/booking/activity/manual) don't feed these
  // dashboards -- no bucket to touch.
}
export function recordDailyStatsNew(row) {
  const all = readJson(DAILY_STATS_FILE, {});
  const bucket = all[dayKey(row.createdAt)] || (all[dayKey(row.createdAt)] = emptyDayBucket());
  applyDailyDelta(bucket, row, row.status, 1);
  writeJson(DAILY_STATS_FILE, all);
}
export function recordDailyStatsTransition(row, oldStatus, newStatus) {
  if (oldStatus === newStatus) return;
  const all = readJson(DAILY_STATS_FILE, {});
  const bucket = all[dayKey(row.createdAt)] || (all[dayKey(row.createdAt)] = emptyDayBucket());
  applyDailyDelta(bucket, row, oldStatus, -1);
  applyDailyDelta(bucket, row, newStatus, 1);
  writeJson(DAILY_STATS_FILE, all);
}
export function getDailyStatsInRange(startMs, endMs) {
  const all = readJson(DAILY_STATS_FILE, {});
  return Object.entries(all)
    .filter(([date]) => { const t = new Date(date + "T00:00:00Z").getTime(); return t >= startMs && t <= endMs; })
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, bucket]) => ({ date, ...bucket }));
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
  // A click can't happen without an open first -- pixel-based open tracking
  // is unreliable on its own (many mail clients block the tracking image by
  // default), so a recorded click is treated as proof of an open too, same
  // convention already used by campaigns_backend.js/reporting_backend.js.
  const opened = !!m.statusHistory?.some(h => h.status === "opened" || h.status === "clicked");
  return { id: m.id, channel: m.channel, direction: m.direction, createdAt: m.createdAt, subject: m.subject, bodyPreview: m.bodyPreview, from: m.from, to: m.to, status: m.status, opened };
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
const SIDEBAR_CHANNELS = ["email", "sms", "form", "booking", "activity", "meeting"];
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
// SQLite sync is best-effort -- never let a bug in the new/less-proven path
// take down the actual message send/receive it's piggybacking on. Worst
// case a row goes stale until the next thing touches it, not a lost
// message. (JSON index writes above have no equivalent guard because
// they're the original, load-bearing path -- a failure there SHOULD
// surface.)
function safeSqliteSync(fn) { try { fn(); } catch (e) { console.error("[sqlite_inbox] sync failed:", e.message); } }

// crm_conversation_index.json has grown to 270MB+ (one row per distinct
// contact/conversation) -- confirmed live (2026-09-02) that a full
// readJson+Array.find+writeJson of it takes ~10-12 SECONDS, and
// /api/inbox/conversations no longer even reads this file by default
// (queryConversationsSqlite is the real path -- see inbox_backend.js;
// JSON is now only the `_sqlite=0` fallback/recovery view, per its own
// comment there). Blocking a live send or a recipient's link click on
// that is pure waste. Two escalating attempts before this one:
//   1. Deferred the write via setImmediate, one per call -- confirmed
//      live minutes later that a burst of calls for the SAME contact
//      queued that many full 10-12s passes back to back, monopolizing
//      the event loop long enough that Railway's health check seems to
//      have decided the process was dead and restarted it.
//   2. Coalesced multiple calls for the same key into one pass -- fixed
//      the crash, but a single flush STILL blocks the entire
//      single-threaded process for ~10-12s, and different contacts
//      messaging within the same short window each still triggered
//      their own separate ~12s block back to back (confirmed live:
//      8 concurrent clicks against the same file all had to wait out
//      the one blocking flush together).
// This version batches ALL pending upserts/recomputes/removes -- across
// every contact, not just repeats of the same one -- into a single
// timer-driven flush every FLUSH_DELAY_MS, doing exactly one read+write
// of the whole file regardless of how much activity happened in that
// window. This does NOT eliminate the ~10-12s cost (nothing short of
// sharding this file the way msg_by_contact already is would) -- it
// bounds how OFTEN the app pays it to at most once per window, instead
// of once per distinct contact-event. Sharding crm_conversation_index.json
// itself (one small file per contact, mirroring msg_by_contact) is the
// real fix and still needs doing; this is the safe interim mitigation.
const _pendingUpsertMessages = new Map(); // key -> queued messages to fold in on the next flush
const _pendingRecomputeIds = new Set(); // contactIds needing a from-scratch recompute
const _pendingRemoveKeys = new Set(); // keys to delete
let _flushTimer = null;
const FLUSH_DELAY_MS = 5000;

function scheduleConversationFlush() {
  if (_flushTimer) return;
  _flushTimer = setTimeout(flushConversationIndex, FLUSH_DELAY_MS);
  if (_flushTimer.unref) _flushTimer.unref(); // never keep the process alive just for this
}
function flushConversationIndex() {
  _flushTimer = null;
  if (!_pendingUpsertMessages.size && !_pendingRecomputeIds.size && !_pendingRemoveKeys.size) return;
  const upserts = new Map(_pendingUpsertMessages); _pendingUpsertMessages.clear();
  const recomputes = new Set(_pendingRecomputeIds); _pendingRecomputeIds.clear();
  const removes = new Set(_pendingRemoveKeys); _pendingRemoveKeys.clear();

  const rows = readJson(CONVERSATION_INDEX_FILE, []);
  const byKey = new Map(rows.map(r => [r.key, r]));

  for (const [key, messages] of upserts) {
    let g = byKey.get(key);
    if (!g) { g = emptyGroup(key, messages[0].contactId); byKey.set(key, g); }
    for (const m of messages) foldMessageIntoGroup(g, m);
    safeSqliteSync(() => syncMessageFields(g));
  }
  for (const contactId of recomputes) {
    const messages = getContactMessages(contactId).filter(m => SIDEBAR_CHANNELS.includes(m.channel));
    if (!messages.length) { byKey.delete(contactId); safeSqliteSync(() => deleteConversationRow(contactId)); continue; }
    const g = emptyGroup(contactId, contactId);
    for (const m of messages) foldMessageIntoGroup(g, m);
    byKey.set(contactId, g);
    safeSqliteSync(() => syncMessageFields(g));
  }
  for (const key of removes) {
    byKey.delete(key);
    safeSqliteSync(() => deleteConversationRow(key));
  }
  writeJson(CONVERSATION_INDEX_FILE, [...byKey.values()]);
}
export function upsertConversationSummary(m) {
  if (!SIDEBAR_CHANNELS.includes(m.channel)) return;
  const key = conversationKey(m);
  if (!_pendingUpsertMessages.has(key)) _pendingUpsertMessages.set(key, []);
  _pendingUpsertMessages.get(key).push(m);
  scheduleConversationFlush();
}
// Recomputes one contact's summary row from scratch from its own (small)
// message file -- used after a status/inboxDone mutation, where relative
// order matters (e.g. "last" needs to still be genuinely last after an
// update) more than the incremental fold above can cheaply express. Safe
// to batch/collapse repeats because it always reads the CURRENT
// per-contact message file (itself written synchronously) whenever the
// batched flush actually runs, not whatever was current when called.
export function recomputeConversationSummary(contactId) {
  _pendingRecomputeIds.add(contactId);
  scheduleConversationFlush();
}
export function removeConversationSummary(key) {
  _pendingRemoveKeys.add(key);
  scheduleConversationFlush();
}
