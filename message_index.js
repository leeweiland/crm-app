import { mkdirSync, existsSync, unlinkSync } from "fs";
import { join } from "path";
import { DATA_DIR, readJson, writeJson, appendJsonRecordFast, appendJsonRecordsFast, updateJsonArrayRecordByField } from "./auth_backend.js";
import { syncMessageFields, deleteConversationRow } from "./sqlite_inbox.js";
import { getContactById } from "./contacts_db.js";

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
export const CONTACT_MSG_DIR = "msg_by_contact";
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

// Status overlay for per-contact messages, same shape and same reason as
// msg_by_source_status below (2026-10-07) -- updateContactMessage was
// doing a full read-and-rewrite of a contact's ENTIRE message file for
// EVERY notification (Delivery/Open/Click/Bounce, unconditionally, every
// single one -- never had the per-status skip Delivery's per-SOURCE
// write got, since this one has no safe-to-skip case). Most contacts'
// own files are small, but this runs on literally every notification
// system-wide, so the total I/O it generates competes for the same disk
// every other thread (including campaign/SMS sends) needs -- fixing it
// here reduces total disk demand app-wide, not just for this one path.
const CONTACT_STATUS_DIR = "msg_by_contact_status";
let contactStatusDirReady = false;
function ensureContactStatusDir() {
  if (contactStatusDirReady) return;
  const p = join(DATA_DIR, CONTACT_STATUS_DIR);
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
  contactStatusDirReady = true;
}
function contactStatusFile(contactId) { return `${CONTACT_STATUS_DIR}/${safeId(contactId)}.json`; }

export function getContactMessages(contactId) {
  if (!contactId) return [];
  const base = readJson(contactFile(contactId), []);
  const events = readJson(contactStatusFile(contactId), []);
  if (!events.length) return base;
  // Folded by the row's own `id`, not whatever field the original update
  // was looked up by -- `id` is the one field every message row actually
  // has and that uniquely identifies it, so keying events by it here
  // decouples "how a caller found the row" from "how its own updates
  // fold back onto it".
  const overlay = new Map();
  for (const e of events) {
    const prev = overlay.get(e.id) || { patch: {}, historyAdds: [] };
    overlay.set(e.id, { patch: { ...prev.patch, ...e.patch }, historyAdds: e.historyAdds?.length ? [...prev.historyAdds, ...e.historyAdds] : prev.historyAdds });
  }
  return base.map((m) => {
    if (!overlay.has(m.id)) return m;
    const o = overlay.get(m.id);
    return { ...m, ...o.patch, statusHistory: o.historyAdds.length ? [...(m.statusHistory || []), ...o.historyAdds] : m.statusHistory };
  });
}
export function appendContactMessage(message) {
  if (!message.contactId) return;
  ensureDir();
  // Was appendJsonRecords -- the full-file-copy-to-append version (see its
  // own comment: "fine for bulk imports, fatal for a per-send call"),
  // used here for EVERY message ever logged to ANY contact, system-wide
  // (2026-10-08). Harmless for a typical contact's small file, but
  // confirmed live some contacts' own files have grown to 20-30MB (old
  // import rows carrying full, never-deduped bodies) -- a NEW message to
  // one of those contacts was copying the entire 20-30MB file just to
  // append one record. appendJsonRecordFast is the same O(1) in-place
  // append already used everywhere else in this file; its tail-detection
  // already handles both compact and pretty-printed JSON, so this is a
  // pure swap, not a format change.
  appendJsonRecordFast(contactFile(message.contactId), message);
}
// Generic API UNCHANGED (field/value/updater) -- both existing callers
// (message_log.js's updateMessageStatusByProviderId/updateMessageById)
// need zero changes. Finds the row in the overlay-merged view (so a
// caller always sees its own prior updates), hands updater() a safe copy
// (statusHistory shallow-cloned so .push() inside updater never mutates
// anything cached), then DIFFS what changed instead of rewriting the
// file: any scalar field that changed becomes part of `patch`, any NEW
// statusHistory entries (beyond the original length) become `historyAdds`
// -- both appended as one tiny event (appendJsonRecordFast, O(1)) rather
// than a full read-and-rewrite of the whole file.
export function updateContactMessage(contactId, field, value, updater) {
  if (!contactId) return null;
  // Tried a byte-search-before-parse scan here first (2026-10-08) on the
  // theory that JSON.parse-ing a 20-30MB contact file was itself the CPU
  // cost. Measured directly before shipping it: on a realistic 21MB file,
  // it was NOT faster (61ms vs 51ms for plain JSON.parse) -- V8's native
  // parser is fast enough that a hand-rolled JS byte scan doesn't beat
  // it. Reverted that approach; see getContactMessages' own fold logic
  // below for how this and the merged read handle the overlay.
  const merged = getContactMessages(contactId);
  const idx = merged.findIndex((m) => m[field] === value);
  if (idx === -1) return null;
  const original = merged[idx];
  const updated = updater({ ...original, statusHistory: [...(original.statusHistory || [])] });
  if (!updated) return null;
  const patch = {};
  for (const k of Object.keys(updated)) {
    if (k === "statusHistory" || k === "id") continue;
    if (updated[k] !== original[k]) patch[k] = updated[k];
  }
  const oldHistoryLen = (original.statusHistory || []).length;
  const historyAdds = (updated.statusHistory || []).slice(oldHistoryLen);
  if (Object.keys(patch).length || historyAdds.length) {
    ensureContactStatusDir();
    appendJsonRecordFast(contactStatusFile(contactId), { id: original.id, patch, historyAdds, at: new Date().toISOString() });
  }
  return updated;
}

// Direct overlay append -- no read of the base (or overlay) file at all
// (2026-10-08). For a caller that already knows everything it needs
// from a fast index (see message_log.js's own updateMessageStatusByProviderId/
// updateMessageById, both rewritten to read MESSAGE_ID_INDEX_FILE/
// PROVIDER_ID_INDEX_FILE instead of this contact's own file) -- confirmed
// live that reading a contact's full message history just to append ONE
// status-change event could block for MINUTES on a contact whose file
// has grown large (caught directly via /proc: a thread in kernel state
// D, sustained, with zero other contention). The fold in getContactMessages
// above already concatenates historyAdds onto whatever the base row's
// OWN statusHistory turns out to be at READ time, regardless of how long
// it was when this event was WRITTEN -- so there was never an actual
// need to know the prior length in advance, only to assume it's correct,
// which this does by construction (one new entry, appended, every time).
export function appendContactMessageStatusEvent(contactId, id, patch, historyAdd) {
  if (!contactId) return;
  ensureContactStatusDir();
  appendJsonRecordFast(contactStatusFile(contactId), { id, patch, historyAdds: historyAdd ? [historyAdd] : [], at: new Date().toISOString() });
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
  return { id: m.id, contactId: m.contactId, to: m.to, status: m.status, sentAt: m.sentAt || m.createdAt, providerMessageId: m.providerMessageId || null };
}
// Status overlay, not a second copy of the messages themselves (2026-10-07)
// -- see updateSourceMessageStatus's own comment for why this exists.
// Tiny append-only records ({id, patch, at}), one per status change, NOT
// one file per message -- folded onto the base array at READ time here,
// which is the one place old and new code both already paid the "scan
// the whole source" cost (campaign reporting, dedup at a run's start),
// never on the hot per-notification WRITE path that used to rewrite the
// entire base file for a single status flip.
const SOURCE_STATUS_DIR = "msg_by_source_status";
let sourceStatusDirReady = false;
function ensureSourceStatusDir() {
  if (sourceStatusDirReady) return;
  const p = join(DATA_DIR, SOURCE_STATUS_DIR);
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
  sourceStatusDirReady = true;
}
function sourceStatusFile(sourceType, sourceId) { return `${SOURCE_STATUS_DIR}/${safeId(sourceType)}__${safeId(sourceId)}.json`; }

export function getSourceMessages(sourceType, sourceId) {
  if (!sourceType || !sourceId) return [];
  const base = readJson(sourceFile(sourceType, sourceId), []);
  const events = readJson(sourceStatusFile(sourceType, sourceId), []);
  // Fast path, by far the common case (a source with no open/click/bounce
  // activity recorded yet) -- skip building a Map just to find nothing.
  if (!events.length) return base;
  // Last event per id wins, same semantic the old in-place
  // `{...m, ...patch}` mutation always had (newest write overwrites the
  // field) -- events are appended in the order they happened, so a plain
  // forward fold already gives "latest patch per id" without needing to
  // sort by a timestamp.
  const overlay = new Map();
  for (const e of events) overlay.set(e.id, { ...(overlay.get(e.id) || {}), ...e.patch });
  return base.map((m) => (overlay.has(m.id) ? { ...m, ...overlay.get(m.id) } : m));
}
export function appendSourceMessage(message) {
  if (!message.sourceType || !message.sourceId) return;
  ensureSourceDir();
  // appendJsonRecords copies the ENTIRE existing file to append even one
  // record (see logMessage's own comment in message_log.js, which already
  // moved the main 12GB log off this same pattern for the same reason) --
  // fine for bulk imports, fatal for a per-send call against a file that
  // grows across a single large campaign. Confirmed live: a 5,190-
  // recipient send's real throughput dropped as this per-campaign file
  // grew past ~1,300 entries, and a real per-batch lock (withFileLock)
  // meant every OTHER concurrent send in the same batch queued up behind
  // whichever one was mid-copy. appendJsonRecordFast is a true in-place
  // append (seeks to the tail, never touches existing bytes) -- O(1)
  // regardless of how large this file has grown.
  appendJsonRecordFast(sourceFile(message.sourceType, message.sourceId), slimSourceMessage(message));
}
// Batched sibling of appendSourceMessage -- one lock cycle for the whole
// group instead of one per message (see logMessagesBatch in message_log.js,
// the actual caller: a campaign send batch's own sends all share the SAME
// sourceType/sourceId, so they'd otherwise all serialize through
// acquireFileLock's blocking retry wait against this one file, one at a
// time, for no reason other than each insisting on its own lock cycle).
// Still grouped by (sourceType, sourceId) rather than assuming the whole
// array shares one, since callers outside the campaign send loop could
// pass a mixed batch.
export function appendSourceMessagesBatch(messages) {
  const groups = new Map();
  for (const m of messages) {
    if (!m.sourceType || !m.sourceId) continue;
    const key = `${m.sourceType}\u0000${m.sourceId}`;
    if (!groups.has(key)) groups.set(key, { sourceType: m.sourceType, sourceId: m.sourceId, rows: [] });
    groups.get(key).rows.push(slimSourceMessage(m));
  }
  if (!groups.size) return;
  ensureSourceDir();
  for (const { sourceType, sourceId, rows } of groups.values()) {
    appendJsonRecordsFast(sourceFile(sourceType, sourceId), rows);
  }
}
// Was a full read-and-rewrite of the ENTIRE per-source file for every
// single status flip (updateJsonArrayRecordByField) -- confirmed live
// (2026-10-07) via /proc this was causing genuine disk-I/O blocking,
// caught directly mid-hang (a worker thread in kernel state D,
// "submit_bio_wait"/"folio_wait_bit_common") on a live production
// campaign, not inferred. A campaign's per-source file only grows across
// its life (4.5MB+ confirmed on a 17k-recipient send) and every Open/
// Click notification was paying a full rewrite of it -- the one case
// Delivery already got fixed for (see message_log.js's own comment) but
// Open/Click couldn't skip the same way, since those numbers are real,
// reported, and not optional to keep accurate. appendJsonRecordFast is
// the same O(1) in-place append already proven safe for the base file's
// own appends -- just appending the STATUS CHANGE as its own tiny event
// instead of mutating the base row in place.
export function updateSourceMessageStatus(sourceType, sourceId, id, patch) {
  if (!sourceType || !sourceId) return;
  ensureSourceStatusDir();
  appendJsonRecordFast(sourceStatusFile(sourceType, sourceId), { id, patch, at: new Date().toISOString() });
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
function emptyDayBucket() { return { emailOut: {}, smsOut: {}, smsInCount: 0, emailInCount: 0, automationEmailOut: {}, workflowSmsOut: {} }; }
function bumpStatus(obj, status, delta) {
  const next = (obj[status] || 0) + delta;
  if (next > 0) obj[status] = next; else delete obj[status];
}
function applyDailyDelta(bucket, row, status, delta) {
  if (row.channel === "email" && row.direction === "outbound") {
    bumpStatus(bucket.emailOut, status, delta);
    if (row.sourceType === "automation_step") bumpStatus(bucket.automationEmailOut, status, delta);
  } else if (row.channel === "email" && row.direction === "inbound") {
    bucket.emailInCount = Math.max(0, (bucket.emailInCount || 0) + delta);
  } else if (row.channel === "sms" && row.direction === "inbound") {
    bucket.smsInCount = Math.max(0, (bucket.smsInCount || 0) + delta);
  } else if (row.channel === "sms") {
    bumpStatus(bucket.smsOut, status, delta);
    if (row.sourceType === "workflow_step") bumpStatus(bucket.workflowSmsOut, status, delta);
  }
  // Other channels (form/booking/activity/manual) don't feed these
  // dashboards -- no bucket to touch.
}
// A contact flagged testContact (contact-detail.html's "Test Contact"
// checkbox) never contributes to these dashboards -- lets a real send/SMS
// round-trip get tested against a real phone/inbox without permanently
// skewing the business's own reporting numbers. Still fully logged
// everywhere else (main log, per-contact, per-source) -- this only skips
// the aggregate daily-stats delta.
function isTestContact(contactId) {
  if (!contactId) return false;
  const c = getContactById(contactId);
  return !!c?.testContact;
}
export function recordDailyStatsNew(row) {
  if (isTestContact(row.contactId)) return;
  const all = readJson(DAILY_STATS_FILE, {});
  const bucket = all[dayKey(row.createdAt)] || (all[dayKey(row.createdAt)] = emptyDayBucket());
  applyDailyDelta(bucket, row, row.status, 1);
  writeJson(DAILY_STATS_FILE, all);
}
export function recordDailyStatsTransition(row, oldStatus, newStatus) {
  if (oldStatus === newStatus || isTestContact(row.contactId)) return;
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
// Pixel/link-based open tracking (SES's own, same as a self-hosted pixel
// would be) can only ever prove a positive -- it physically cannot fire
// if the client never fetches the tracking image, which plenty of real
// clients (confirmed live: Yahoo Mail's iPhone app) don't do by default
// regardless of whether a human actually read the email. A reply is
// unambiguous proof they did, so when one arrives, retroactively credit
// whatever prior outbound emails in this conversation never got a real
// open/click event -- otherwise the badge stays wrong forever even though
// the conversation itself disproves it. `inferred: true` on the synthetic
// entry keeps this distinguishable from a real tracked open if that ever
// matters later.
export function markPriorOutboundEmailsOpenedByReply(contactId, replyAt) {
  if (!contactId) return;
  const messages = getContactMessages(contactId);
  let changed = false;
  const replyMs = new Date(replyAt).getTime();
  messages.forEach(m => {
    if (m.channel !== "email" || m.direction !== "outbound") return;
    if (new Date(m.createdAt).getTime() >= replyMs) return;
    const alreadyOpened = (m.statusHistory || []).some(h => h.status === "opened" || h.status === "clicked");
    if (alreadyOpened) return;
    m.statusHistory = [...(m.statusHistory || []), { status: "opened", at: replyAt, inferred: true }];
    changed = true;
  });
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
// Removes SPECIFIC messages from a contact's own shard by id -- unlike
// deleteContactMessageFile (which wipes the contact's ENTIRE history), this
// is for a caller that already knows exactly which of a contact's messages
// it wants gone (e.g. ai_agents_backend.js's test-batch-reset scoping the
// deletion to just one AI agent's own test conversation) without touching
// unrelated history -- an old campaign, a different agent, a human rep's
// own outreach -- that happens to live in the same per-contact file.
export function removeContactMessagesByIds(contactId, idSet) {
  if (!contactId || !idSet?.size) return 0;
  const messages = getContactMessages(contactId);
  const kept = messages.filter(m => !idSet.has(m.id));
  const removed = messages.length - kept.length;
  if (removed) writeJson(contactFile(contactId), kept);
  return removed;
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
export const SIDEBAR_CHANNELS = ["email", "sms", "form", "booking", "activity", "meeting", "task_due", "buying_signal"];
// Narrower than SIDEBAR_CHANNELS on purpose: SIDEBAR_CHANNELS controls what
// renders in a conversation thread and what counts toward per-channel
// preview text (lastByChannel below) -- activity/meeting logs belong there.
// NOTIFY_CHANNELS controls what's allowed to increment unreadCount / flip a
// conversation into the Inbox's Unresponded bucket / fire the SSE
// new_message broadcast (message_log.js) -- an activity/meeting log should
// never do any of those three things, even though today's SIDEBAR_CHANNELS
// already (correctly, by accident) never carries one inbound. This makes
// that exclusion structural instead of "nothing happens to violate it yet."
// "task_due" is the deliberate exception: a due task/reminder
// (inbox_backend.js's checkDueTasks) is meant to notify exactly like a real
// inbound message, per explicit request -- not an accidental carry-over of
// the activity/meeting exclusion above. Named distinctly from the raw task
// record's own itemType ("task"/"reminder", see inbox_backend.js's /timeline
// endpoint) so the two are never confused for the same kind of item -- this
// is a NOTIFICATION that a task came due, not the task record itself, and
// both can legitimately appear in the same contact's history at once.
// "buying_signal" is the same idea, for ai_agents_backend.js's
// generateAgentReply -- a detected [[BUYING_SIGNAL]] on an autonomous send
// (AI Active/Coverage/Behavioral Triggers), gated per-agent by
// notifyOnBuyingSignal, off by default only if an admin explicitly turns it
// off for that agent.
export const NOTIFY_CHANNELS = ["email", "sms", "form", "booking", "task_due", "buying_signal"];
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
    // Gated to NOTIFY_CHANNELS (narrower than SIDEBAR_CHANNELS) -- an
    // inbound activity/meeting log still updates lastByChannel/preview text
    // above, it just never counts toward Unresponded.
    if (!m.inboxDone && NOTIFY_CHANNELS.includes(m.channel)) g.unreadCount++;
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
// Chunked (2026-10-08) -- confirmed live via /proc (three worker threads
// stuck in kernel state D for minutes, zero other contention) that the
// recompute loop below -- unchanged in WHAT it does, only in how it's
// paced -- was the real remaining stall once the status-write path
// itself stopped reading the big per-contact file (see message_log.js's
// own 2026-10-08 comments). A bulk-drain batch can queue up to 2000
// distinct contactIds into _pendingRecomputeIds before one 5s-debounced
// flush fires, and getContactMessages() for ANY of the ~238 legacy-
// import contacts whose file has grown large (up to 30.9MB) is a
// genuinely slow disk read -- running all 2000 back to back in one
// unbroken synchronous loop meant a single flush could monopolize this
// thread's event loop for minutes, during which nothing else on it
// (including the bulk-drain's own next DB query and its progress log)
// could run at all. Yielding every RECOMPUTE_CHUNK contacts via
// setImmediate does not skip or defer a single one of them -- the exact
// same work, for the exact same contacts, still happens -- it just lets
// the event loop breathe between chunks instead of holding it hostage
// for the whole batch in one atomic block.
const RECOMPUTE_CHUNK = 25;
function flushConversationIndex() {
  _flushTimer = null;
  if (!_pendingUpsertMessages.size && !_pendingRecomputeIds.size && !_pendingRemoveKeys.size) return;
  const upserts = new Map(_pendingUpsertMessages); _pendingUpsertMessages.clear();
  const recomputes = Array.from(_pendingRecomputeIds); _pendingRecomputeIds.clear();
  const removes = new Set(_pendingRemoveKeys); _pendingRemoveKeys.clear();

  // Recomputes and removes never need the slow legacy JSON below -- a
  // recompute's group is built entirely from getContactMessages() (that
  // contact's own small file), and a remove just deletes a row. Both used
  // to sit AFTER the ~10-12s readJson(CONVERSATION_INDEX_FILE) further
  // down, so the Inbox's real read path (SQLite -- queryConversationsSqlite,
  // see inbox_backend.js) sat blocked behind that slow legacy read on every
  // mark-done/reply, even though this file is otherwise only the `_sqlite=0`
  // fallback view. Confirmed live: the sidebar's "Unresponded" filter kept
  // showing a just-answered conversation as still unread for 10+ seconds
  // past a client-side reconcile that assumed this whole flush landed in
  // ~5s. Syncing these first means the row a human is actually watching
  // (Mark Done, a reply going out) updates in the time the recompute
  // itself takes -- milliseconds -- not whenever the legacy file's turn
  // comes up. Upserts still fold into the slow read below unchanged (they
  // need the prior row's state to fold a new message into, unlike a
  // from-scratch recompute).
  const recomputedGroups = new Map(); // contactId -> group, reused below for the legacy JSON write
  const deletedRecomputeIds = new Set();
  let i = 0;
  function runRecomputeChunk() {
    const end = Math.min(i + RECOMPUTE_CHUNK, recomputes.length);
    for (; i < end; i++) {
      const contactId = recomputes[i];
      const messages = getContactMessages(contactId).filter(m => SIDEBAR_CHANNELS.includes(m.channel));
      if (!messages.length) { deletedRecomputeIds.add(contactId); safeSqliteSync(() => deleteConversationRow(contactId)); continue; }
      const g = emptyGroup(contactId, contactId);
      for (const m of messages) foldMessageIntoGroup(g, m);
      recomputedGroups.set(contactId, g);
      safeSqliteSync(() => syncMessageFields(g));
    }
    if (i < recomputes.length) { setImmediate(runRecomputeChunk); return; }
    finishFlush();
  }
  function finishFlush() {
    for (const key of removes) safeSqliteSync(() => deleteConversationRow(key));

    // Everything SQLite-facing (the real, live Inbox path) is already done
    // above -- only the legacy 285MB JSON file's own read+write is left,
    // which is the actual expensive part SKIP_CONVERSATION_INDEX_FLUSH=1
    // exists to skip. Checked here, not just at each exported function's
    // entry, because upserts are never queued while the switch is on (see
    // upsertConversationSummary's own redirect), but a flush triggered by
    // recomputes/removes ALONE would otherwise still reach this unconditionally
    // and pay the full cost on every single one regardless.
    if (!conversationFlushEnabled()) return;

    const rows = readJson(CONVERSATION_INDEX_FILE, []);
    const byKey = new Map(rows.map(r => [r.key, r]));

    for (const [key, messages] of upserts) {
      let g = byKey.get(key);
      if (!g) { g = emptyGroup(key, messages[0].contactId); byKey.set(key, g); }
      for (const m of messages) foldMessageIntoGroup(g, m);
      safeSqliteSync(() => syncMessageFields(g));
    }
    for (const [contactId, g] of recomputedGroups) byKey.set(contactId, g);
    for (const contactId of deletedRecomputeIds) byKey.delete(contactId);
    for (const key of removes) byKey.delete(key);
    writeJson(CONVERSATION_INDEX_FILE, [...byKey.values()]);
  }
  if (recomputes.length) runRecomputeChunk(); else finishFlush();
}
// Interim kill switch (2026-10-04, off by default -- set
// SKIP_CONVERSATION_INDEX_FLUSH=1 to enable). Confirmed live: this file is
// read ONLY by inbox_backend.js's explicit ?_sqlite=0 fallback/recovery
// path -- queryConversationsSqlite (SQLite) is the actual live path for
// every normal Inbox load, confirmed by reading that file directly. During
// a high-volume campaign send, EVERY send and EVERY delivery/open/click
// webhook calls into here, and the flush this schedules does a full
// synchronous read+write of a 285MB+ file at a measured ~10-12s each (see
// flushConversationIndex's own history comment above) -- sustained traffic
// means the flush is effectively always "due," permanently starving
// whatever thread it runs on. Since nothing user-facing depends on this
// file staying fresh in real time, skipping the schedule (not the
// recovery capability itself -- flushConversationIndex and the file are
// both untouched, just not auto-triggered) costs nothing live and removes
// the single largest confirmed bottleneck. Revert by unsetting the var;
// nothing about this is destructive or hard to undo.
function conversationFlushEnabled() { return process.env.SKIP_CONVERSATION_INDEX_FLUSH !== "1"; }

export function upsertConversationSummary(m) {
  if (!SIDEBAR_CHANNELS.includes(m.channel)) return;
  if (!conversationFlushEnabled()) {
    // The legacy 285MB JSON path stays off (the actual expensive part
    // this kill switch exists for -- see its own comment above), but the
    // REAL, live Inbox table (SQLite, via queryConversationsSqlite) still
    // needs this contact's row kept current. recomputeConversationSummary
    // already does exactly that cheaply, from this contact's own small
    // per-contact message file, with zero dependency on the giant shared
    // JSON index -- confirmed live (2026-10-05): without this redirect, a
    // brand-new conversation started while the switch was on was
    // permanently invisible to Inbox search, because syncMessageFields
    // (the only thing that writes the SQLite row the live Inbox actually
    // reads) only ever ran from inside the SAME gated flush this function
    // used to just return out of.
    if (m.contactId) recomputeConversationSummary(m.contactId);
    return;
  }
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
// No conversationFlushEnabled() guard here (or on removeConversationSummary
// below) -- unlike upsertConversationSummary's legacy-JSON path, both of
// these only ever touch SQLite directly (see flushConversationIndex's own
// early-return before the slow legacy block), so they stay unconditional
// regardless of the kill switch.
// Suppressed during the SES bulk-drain (2026-10-08) -- set/cleared only by
// ses_notification_worker.js's own runBulkDrain, around that one call,
// nothing else. Confirmed live via /proc (a thread genuinely blocked in
// kernel state D on folio_wait_bit_common, plus /proc/pressure/io
// reading avg10 ~24-27% -- real, system-wide disk contention right now,
// not something any amount of JS-side batching/chunking fixes, since a
// single bloated contact's own read still takes however long the disk
// takes) that THIS call -- not the status write itself, which no longer
// touches the per-contact file at all (see message_log.js) -- was the
// actual remaining block. Recomputing the sidebar conversation summary
// is purely cosmetic (Inbox list's last-message preview/unread count);
// it has zero bearing on whether a notification gets recorded, on
// open/click % reporting, or on any contact's own data -- nothing about
// a contact or its message HISTORY is skipped, only the Inbox sidebar's
// own derived cache staying exactly as current as it already was until
// the next REAL message (send/reply) for that contact recomputes it
// normally, same as always. Off by default (suppressed=false) for every
// other caller/path.
let _suppressRecompute = false;
export function setSuppressConversationRecompute(v) { _suppressRecompute = !!v; }
export function recomputeConversationSummary(contactId) {
  if (_suppressRecompute) return;
  _pendingRecomputeIds.add(contactId);
  scheduleConversationFlush();
}
export function removeConversationSummary(key) {
  _pendingRemoveKeys.add(key);
  scheduleConversationFlush();
}
