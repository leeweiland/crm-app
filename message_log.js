import { randomUUID } from "crypto";
import { statSync, existsSync, openSync, readSync, closeSync } from "fs";
import { join } from "path";
import { appendJsonRecordFast, appendJsonRecordsFast, appendToJsonObjectFast, appendToJsonObjectsFast, readJson, DATA_DIR } from "./auth_backend.js";
import { appendContactMessage, appendContactMessageStatusEvent, appendContactMessageStatusEventsBatch, upsertConversationSummary, recomputeConversationSummary, appendSourceMessage, appendSourceMessagesBatch, updateSourceMessageStatus, getSourceMessages, recordDailyStatsNew, recordDailyStatsTransition, NOTIFY_CHANNELS } from "./message_index.js";
import { getConvoMeta, setConvoMeta } from "./conversation_meta.js";
import { broadcastInboxUpdate } from "./inbox_events.js";
import { noteStaffActivity } from "./staff_activity.js";

export const MESSAGE_LOG_FILE = "crm_message_log.json";
// Small persisted index so a delivery/open/click/bounce webhook (arriving
// with only the provider's own message id) can find "which of our rows is
// this" in O(1) instead of scanning the whole message log for it -- see
// updateMessageStatusByProviderId below. Only ever grows going forward from
// when this was added; historical messages sent before it existed simply
// aren't in it; a webhook for one of those is a no-op instead of falling
// back to the full scan that filled the disk and hung the server (2026-08-29
// incident -- see git history on this file for the postmortem comment).
export const PROVIDER_ID_INDEX_FILE = "crm_provider_id_index.json";
// Same idea, keyed by OUR OWN row id instead of the provider's -- lets
// something that only has a message's own id (e.g. /api/email/click's ?m=)
// find its contactId in O(1) too, instead of the same full-log scan.
export const MESSAGE_ID_INDEX_FILE = "crm_message_id_index.json";

// logMessage/updateMessage* used to do readJson(MESSAGE_LOG_FILE,
// [])+writeJson on every single send/webhook -- at 12GB+ (millions of
// records, many carrying full email bodies) that parses+restringifies the
// ENTIRE log for every new message or status update, which both risks OOM
// and made every send/webhook take 100+ seconds. Even after switching to
// appendJsonRecords/updateJsonArrayRecordByField (bounded memory, never
// hold the full parsed array), logMessage was STILL confirmed live to hang
// every single send for 30-100+ seconds: appendJsonRecords still copies the
// entire existing file to append even one record (fine for bulk imports,
// which batch thousands of records per call; fatal for a live per-message
// call). logMessage now uses appendJsonRecordFast, a true in-place append
// that never touches existing bytes. updateMessageById/
// updateMessageStatusByProviderId still do a full-file pass (needed --
// they look up an arbitrary EXISTING message by id, which could be
// anywhere in the file) -- see email_backend.js/sms_backend.js, which no
// longer call updateMessageById at all for their own just-created row on
// the send path, logging once with the final status instead.
// Pure row construction, no I/O -- split out of logMessage (2026-10-06) so
// logMessagesBatch below can build N rows up front and flush the two
// contended writes (MESSAGE_LOG_FILE, the per-source file) ONCE for the
// whole batch instead of once per row, while every other row still gets
// built exactly the same way logMessage always built it.
function buildMessageRow({ id, channel, direction, contactId, sourceType, sourceId, providerMessageId, to, from, subject, body, bodyPreview, mediaUrl, status, failReason, createdAt, extra }) {
  const row = {
    // Accepts a pre-generated id -- email_backend.js's click-tracking link
    // wrapping needs the row's id baked into the email body BEFORE the send
    // (and therefore before this log call) happens, so it can't wait for
    // logMessage to mint one itself.
    id: id || randomUUID(), channel, direction,
    contactId: contactId || null,
    sourceType: sourceType || "manual", sourceId: sourceId || null,
    providerMessageId: providerMessageId || null,
    to: to || null, from: from || null, subject: subject || null,
    body: body || "", bodyPreview: bodyPreview || "",
    // An MMS attachment (sms_backend.js's sendSms) -- was being passed in
    // but silently dropped here, since this function destructures a fixed
    // field list and mediaUrl wasn't on it. A real, successfully-delivered
    // MMS rendered as a permanently blank bubble with no record it ever
    // carried an image.
    ...(mediaUrl ? { mediaUrl } : {}),
    status: status || "queued",
    failReason: failReason || null,
    statusHistory: [{ status: status || "queued", at: createdAt || new Date().toISOString() }],
    sentAt: status === "sent" ? (createdAt || new Date().toISOString()) : null,
    // Real messages always log at the moment they happen, so `createdAt`
    // is never passed -- the override only exists for gmail_backend.js's
    // reconciliation path, which discovers a message well after Gmail
    // itself sent/received it and needs it to sort into its true place in
    // the thread instead of jumping to the top as if it just arrived.
    createdAt: createdAt || new Date().toISOString(),
    inboxDone: false,
    // Optional caller-specific fields merged in as-is (e.g. ac_sync.js's
    // acCampaignId, a reference into its own shared content store rather
    // than duplicating a campaign's full HTML onto every recipient's own
    // record -- confirmed live that duplicating it filled a 46GB volume
    // solid). Never read/interpreted by logMessage itself, purely a
    // passthrough so callers with their own bolt-on metadata don't need
    // logMessage's core shape to know about every one of them.
    ...(extra || {}),
  };
  return row;
}
// Everything logMessage does to a row AFTER the two writes that
// logMessagesBatch now does once for the whole batch (MESSAGE_LOG_FILE,
// the per-source file) -- split out so both logMessage and
// logMessagesBatch call the exact same side effects per row, rather than
// maintaining two copies that could drift.
function persistRowSideEffects(row, bodyOffset) {
  appendContactMessage(row);
  recordDailyStatsNew(row);
  upsertConversationSummary(row);
  // Which team member (if any) this message puts in conversation with the
  // contact -- feeds the "emailed/texted with <person>" segment condition.
  noteStaffActivity(row);
  // A conversation marked Done stays that way forever otherwise (done is a
  // sticky manual flag -- see conversation_meta.js -- never cleared just
  // because unread_count went back up). A genuinely new inbound message
  // means whatever was "done" about this conversation no longer covers it,
  // so the Mark Done button should read "Mark Done" again, not stay stuck
  // on "Mark Not Done" from whenever it was last closed out. Same
  // auto-reversal shape as compliance_backend.js's checkAutoTriggers
  // un-hiding a STOP'd conversation on a genuine reply, just channel-
  // agnostic here since logMessage is the one place every inbound message
  // (email, sms, form, etc.) already passes through.
  if (row.direction === "inbound" && row.contactId) {
    const meta = getConvoMeta(row.contactId);
    if (meta?.done) setConvoMeta(row.contactId, { done: false });
  }
  // Every OTHER live-sync broadcast here is for a status flip an open tab
  // already knows the row exists for (done/pin/etc) -- a genuinely new
  // inbound message is different: no open tab has any way to learn about
  // it at all otherwise, short of polling or a manual refresh (confirmed
  // live -- new replies just sat invisible in the sidebar until someone
  // happened to reload). NOTIFY_CHANNELS-gated (email/sms/form/booking
  // only) so a channel that doesn't drive Unresponded (activity/meeting
  // logs, etc.) doesn't trigger a pointless reload in every open tab.
  if (row.direction === "inbound" && row.contactId && NOTIFY_CHANNELS.includes(row.channel)) {
    broadcastInboxUpdate({ type: "new_message", contactId: row.contactId });
  }
  // sourceType included (2026-10-07) -- lets a webhook dispatcher classify
  // an incoming delivery/open/click/status notification by WHERE it came
  // from (campaign vs automation vs workflow) using this one already-
  // cached lookup, instead of needing a second read to find out. See
  // lookupNotificationSourceType below.
  // channel/direction/sourceType/sourceId/createdAt/status/openCount/
  // clickCount (2026-10-08) -- everything updateMessageStatusByProviderId
  // needs to process a status change WITHOUT reading this contact's own
  // message file at all. Confirmed live via /proc: a thread could block
  // for MINUTES in kernel state D reading a contact's file once it had
  // grown large (20-30MB, old import rows), with zero other contention --
  // a real, severe cost for a read that was only ever needed to learn
  // the message's OWN current status/repeat-count, both small enough to
  // just carry in this already-O(1)-cached index instead. openCount/
  // clickCount replace the old statusHistory-length scan (email_backend.js's
  // own isRepeatForThisMessage check) -- same signal ("has this exact
  // message already fired this status before"), computed from a counter
  // instead of re-deriving it from a full history array.
  if (row.providerMessageId) appendToJsonObjectFast(PROVIDER_ID_INDEX_FILE, row.providerMessageId, { id: row.id, contactId: row.contactId, sourceType: row.sourceType || null, sourceId: row.sourceId || null, channel: row.channel, direction: row.direction, createdAt: row.createdAt, status: row.status, openCount: 0, clickCount: 0 });
  // bodyOffset/bodyLength (2026-10-08) -- the exact byte range row's own
  // JSON text landed at in MESSAGE_LOG_FILE, captured by logMessage/
  // logMessagesBatch from appendJsonRecordFast's/appendJsonRecordsFast's
  // own return value. Lets getMessageBodyById fetch a message's full body
  // by seeking straight to it, without reading or scanning the rest of
  // this file (12GB+ and growing). Only ever set going forward -- never
  // backfilled here; see backfill_message_body_offsets.mjs for existing
  // history. Same extra fields as PROVIDER_ID_INDEX_FILE just above, for
  // updateMessageById's identical reasoning (keyed by our own row id
  // instead of the provider's).
  appendToJsonObjectFast(MESSAGE_ID_INDEX_FILE, row.id, { contactId: row.contactId, bodyOffset: bodyOffset?.offset ?? null, bodyLength: bodyOffset?.length ?? null, sourceType: row.sourceType || null, sourceId: row.sourceId || null, channel: row.channel, direction: row.direction, createdAt: row.createdAt, status: row.status });
  if (row.status === "failed" && row.direction === "outbound") notifyFailedSend(row.contactId, row.channel);
}
export function logMessage(fields) {
  const row = buildMessageRow(fields);
  const offset = appendJsonRecordFast(MESSAGE_LOG_FILE, row);
  appendSourceMessage(row);
  persistRowSideEffects(row, offset);
  return row;
}
// Built for campaigns_backend.js's send loop (2026-10-06): confirmed live
// via /proc/pressure/io that the production disk is under sustained I/O
// pressure, and SENDING_CONCURRENCY sends in a batch each calling
// logMessage separately meant each one's MESSAGE_LOG_FILE and per-source
// writes serialized through acquireFileLock's blocking retry wait against
// the SAME two files, one at a time. Collects the batch's rows and flushes
// those two writes ONCE for the whole batch instead of once per row --
// everything else each row needs (contact file, daily stats, conversation
// summary, the two lookup indexes, etc.) still happens per row via
// persistRowSideEffects, unchanged from what logMessage always did.
export function logMessagesBatch(fieldsList) {
  if (!fieldsList || !fieldsList.length) return [];
  const rows = fieldsList.map(buildMessageRow);
  const offsets = appendJsonRecordsFast(MESSAGE_LOG_FILE, rows);
  appendSourceMessagesBatch(rows);
  rows.forEach((row, i) => persistRowSideEffects(row, offsets[i]));
  return rows;
}
// compliance_backend.js already imports logMessage (for its own
// blacklist-sheet activity-log entry) -- a static top-level import back
// here would close a circular import, same reason source_names.js reads
// crm_flows.json directly instead of importing flows_backend.js. Resolved
// dynamically instead, at call time, well after both modules have finished
// loading. Never allowed to throw into a send/webhook path over this.
function notifyFailedSend(contactId, channel) {
  import("./compliance_backend.js")
    .then(m => m.maybeAutoOptOutOnFailedSend(contactId, channel))
    .catch(e => console.error("[message_log] auto-opt-out-on-failure check failed:", e.message));
}
// Was a full scan+rewrite of the entire main log to find one row by
// providerMessageId -- confirmed live (2026-08-29) that this filled the
// volume's remaining disk space (the copy needs roughly the file's own size
// in free space to complete) and blocked the whole single-threaded server
// for its duration, taking the app down. Now looks the row up in the small
// index instead (populated by logMessage above) and only touches the
// per-contact file, the per-source file, and the conversation summary, all
// cheap regardless of the main log's size. Deliberately does NOT also patch
// the main log's own copy of this message -- crm_message_log.json is
// write-once-append-only now; nothing reads it back for status (see
// getMessagesForSource below, which used to read stale status straight off
// it -- that staleness is exactly what routing status updates through the
// per-source file here fixes, not just the speed).
// mtime-cached read of the provider-id index (confirmed on disk at ~9MB
// and growing) -- updateMessageStatusByProviderId previously did a full
// readJson (parse the whole file) on EVERY delivery/open/click/bounce
// webhook. Confirmed live during a 23k-recipient campaign send as a real,
// if smaller, contributor alongside the much larger crm_contacts.json
// cost already fixed separately. Same exact staleness-detection shape as
// contacts_db.js's own syncFromJsonIfChanged: one cheap statSync, reload
// only if the file's mtime moved since this thread last saw it -- correct
// across threads (logMessage appends new entries from the send-worker
// thread; this cache lives on whichever thread calls
// updateMessageStatusByProviderId, i.e. background-worker, and picks up
// those appends the next time its own mtime check notices).
// Incremental on growth (2026-10-08) -- confirmed live, caught directly
// via per-row timing: these index files (20MB+) are append-only (every
// new send/status-write adds or extends one key, never rewrites existing
// bytes), but the live app keeps appending to them continuously from its
// own sends while something else (a bulk backlog drain, in this case) is
// also calling this function -- the OLD mtime-only check meant ANY
// concurrent append invalidated the WHOLE cache, forcing a full 20MB+
// re-read+re-parse on the very next call, repeatedly, throughout a long-
// running batch (measured: one call in ten took 22.6s, the other nine
// took 0-1ms -- the 22.6s ones were exactly these full reloads). Since
// appendToJsonObjectFast only ever grows the file by replacing its
// trailing "}" with new entries + "}", a size increase means everything
// before the OLD size is still byte-identical -- reading just the NEW
// tail and merging it into the existing in-memory object is enough, no
// need to discard and reparse bytes already correctly cached. Falls back
// to a full reload for anything unexpected (file shrank, truncated
// oddly, etc.) -- safety over speed when the fast path's own assumption
// doesn't hold. Factored into one function (2026-10-08) so both
// PROVIDER_ID_INDEX_FILE and MESSAGE_ID_INDEX_FILE -- the latter now hot
// on the same bulk-drain/status-update path -- get the identical
// incremental treatment instead of one of them staying on a plain
// readJson that re-parses the whole file on every single call.
function makeIncrementalJsonCache(filename) {
  const path = join(DATA_DIR, filename);
  let cache = null, mtimeMs = null, size = null;
  return function getCached() {
    let st = null;
    try { st = statSync(path); } catch { /* file not created yet */ }
    const newMtimeMs = st ? st.mtimeMs : null, newSize = st ? st.size : null;
    if (cache === null) {
      cache = readJson(filename, {});
      mtimeMs = newMtimeMs; size = newSize;
      return cache;
    }
    if (newMtimeMs !== mtimeMs) {
      let appliedIncremental = false;
      if (newSize != null && size != null && newSize > size && size > 0) {
        try {
          const fd = openSync(path, "r");
          try {
            const startOffset = size - 1; // the OLD "}" byte, which the new write started by replacing
            const newLen = newSize - startOffset;
            const buf = Buffer.alloc(newLen);
            readSync(fd, buf, 0, newLen, startOffset);
            const text = buf.toString("utf8");
            const added = JSON.parse("{" + (text.startsWith(",") ? text.slice(1) : text));
            Object.assign(cache, added);
            appliedIncremental = true;
          } finally { closeSync(fd); }
        } catch { /* fall through to full reload below */ }
      }
      if (!appliedIncremental) cache = readJson(filename, {});
      mtimeMs = newMtimeMs; size = newSize;
    }
    return cache;
  };
}
const getProviderIndexCached = makeIncrementalJsonCache(PROVIDER_ID_INDEX_FILE);
const getMessageIdIndexCached = makeIncrementalJsonCache(MESSAGE_ID_INDEX_FILE);

// Built for webhook_relay_backend.js/email_backend.js's own dispatch
// routing (2026-10-07) -- lets a notification be classified by source
// (campaign vs automation vs workflow) BEFORE deciding which worker pool
// handles it, using the same cached index updateMessageStatusByProviderId
// already reads, not a second file. Returns null for an unknown id (same
// "no match, caller decides the fallback" shape as that function).
export function lookupNotificationSourceType(providerMessageId) {
  if (!providerMessageId) return null;
  return getProviderIndexCached()[providerMessageId]?.sourceType ?? null;
}

// Rewritten (2026-10-08) to never read this contact's own per-contact
// file at all -- see persistRowSideEffects' comment on why that read, by
// itself, was confirmed live (via /proc, thread stuck in kernel state D
// for MINUTES) to be the real remaining cost on the bulk-drain's known-
// bloated legacy-import contacts (238 of them, up to 30.9MB each), with
// zero other contention. Everything this function needs (contactId,
// sourceType/sourceId, channel, direction, createdAt, and now the prior
// status + repeat counts) already lives in PROVIDER_ID_INDEX_FILE, kept
// current by the appendToJsonObjectFast call below -- so every webhook
// after the first only ever touches two small, already-incrementally-
// cached index files plus a tiny append-only overlay event
// (appendContactMessageStatusEvent), never the big per-contact file.
// Nothing is skipped -- every row still gets its status recorded, its
// conversation summary recomputed, its source/daily-stats updated,
// exactly as before, just without the large read.
export function updateMessageStatusByProviderId(providerMessageId, status, extra) {
  if (!providerMessageId) return null;
  const entry = getProviderIndexCached()[providerMessageId];
  if (!entry) return null;
  const oldStatus = entry.status;
  // Same signal email_backend.js's old isRepeatForThisMessage check used
  // (statusHistory.filter(...).length), now a counter instead of a
  // history scan -- true only once this exact status has already fired
  // for this exact message before.
  const isRepeat = status === "opened" ? (entry.openCount || 0) > 0 : status === "clicked" ? (entry.clickCount || 0) > 0 : false;
  const openCount = (entry.openCount || 0) + (status === "opened" ? 1 : 0);
  const clickCount = (entry.clickCount || 0) + (status === "clicked" ? 1 : 0);
  appendContactMessageStatusEvent(entry.contactId, entry.id, { status }, { status, at: new Date().toISOString(), ...(extra || {}) });
  // Keep the index current -- the NEXT webhook for this same provider id
  // (a repeat open/click, or any later status) reads this same entry, so
  // it must reflect what this call just recorded, not what was there
  // before.
  appendToJsonObjectFast(PROVIDER_ID_INDEX_FILE, providerMessageId, { ...entry, status, openCount, clickCount });
  const found = { ...entry, id: entry.id, status, isRepeat };
  recomputeConversationSummary(entry.contactId);
  // Skipped specifically for "delivered" (2026-10-06) -- confirmed live
  // this is the actual cause of the SES-notification worker timing out on
  // every single dispatch: updateSourceMessageStatus's
  // updateJsonArrayRecordByField does a full read-and-rewrite of the
  // ENTIRE per-campaign source file (never given the same O(1) fix
  // appendSourceMessage got, see that function's own comment), and a
  // live 17k-recipient send generates one Delivery notification per
  // recipient -- a full rewrite of an ever-growing, multi-thousand-row
  // file, once per send, from a DIFFERENT thread than the one actively
  // appending new sends to that same file under the same lock. Confirmed
  // via /proc this was the dominant disk-I/O consumer in the whole app,
  // climbing as the file grew, eventually exceeding the 45s relay
  // timeout on every call. "Delivered" is the highest-volume, lowest-
  // value status of the five (SES confirmed receipt, nothing a human
  // reads this campaign's own report for distinctly from "sent" --
  // unlike opened/clicked/bounced/complained, which stay exactly as
  // before). The contact's own message record (above) and daily stats
  // (below) still update either way -- only the campaign-report's own
  // per-row "delivered" status on this one shared file is skipped, so
  // rollupStats' delivered count will undercount for messages that never
  // separately opened/clicked -- a real, disclosed tradeoff, not a
  // silent one.
  if (found.sourceType && found.sourceId && status !== "delivered") updateSourceMessageStatus(found.sourceType, found.sourceId, found.id, { status });
  recordDailyStatsTransition(found, oldStatus, status);
  if (status === "failed" && oldStatus !== "failed" && found.direction === "outbound") notifyFailedSend(entry.contactId, found.channel);
  return found;
}
// Batched sibling for a bulk-drain-sized run (2026-10-08) -- updates is an
// array of { providerMessageId, status, extra? }. The per-row version
// above already stopped reading any big file per call; the remaining
// cost at tens of thousands of rows is simply that EVERY row still pays
// its own full disk write (one lock cycle each) to PROVIDER_ID_INDEX_FILE
// and to its contact's own overlay file -- real, measured, not fixable by
// more caching since each write genuinely is new data. This collapses
// the PROVIDER_ID_INDEX_FILE side to ONE write for the whole batch
// (appendToJsonObjectsFast) and the contact-overlay side to one write
// PER DISTINCT CONTACT in the batch (appendContactMessageStatusEventsBatch)
// instead of one write per row -- same total data persisted, same
// guarantees, just far fewer separate disk operations to get there.
// Returns results in the SAME order as `updates`, null for any id this
// index doesn't know about, so the caller can still run the exact same
// per-row side effects (recompute, source-status, daily-stats, trigger
// firing) it always has -- nothing about those changes here.
export function updateMessageStatusesByProviderIdBatch(updates) {
  const index = getProviderIndexCached();
  const indexPatch = {};
  const overlayEvents = [];
  const results = new Array(updates.length).fill(null);
  for (let i = 0; i < updates.length; i++) {
    const { providerMessageId, status, extra } = updates[i];
    if (!providerMessageId) continue;
    const entry = indexPatch[providerMessageId] || index[providerMessageId];
    if (!entry) continue;
    const oldStatus = entry.status;
    const isRepeat = status === "opened" ? (entry.openCount || 0) > 0 : status === "clicked" ? (entry.clickCount || 0) > 0 : false;
    const openCount = (entry.openCount || 0) + (status === "opened" ? 1 : 0);
    const clickCount = (entry.clickCount || 0) + (status === "clicked" ? 1 : 0);
    const updatedEntry = { ...entry, status, openCount, clickCount };
    indexPatch[providerMessageId] = updatedEntry; // repeats of the SAME id within one batch see their own prior update
    overlayEvents.push({ contactId: entry.contactId, id: entry.id, patch: { status }, historyAdd: { status, at: new Date().toISOString(), ...(extra || {}) } });
    results[i] = { ...entry, id: entry.id, status, isRepeat, _oldStatus: oldStatus };
  }
  if (Object.keys(indexPatch).length) appendToJsonObjectsFast(PROVIDER_ID_INDEX_FILE, indexPatch);
  if (overlayEvents.length) appendContactMessageStatusEventsBatch(overlayEvents);
  // Same remaining bookkeeping updateMessageStatusByProviderId does per
  // call, just looped here instead -- none of these do a big-file read
  // (recomputeConversationSummary is an in-memory Set.add + debounced
  // timer, updateSourceMessageStatus/recordDailyStatsTransition are
  // already O(1) overlay/bucket writes), so there's no equivalent batch
  // win available for them the way there was for the two disk writes
  // above -- only reason to loop them here instead of leaving this to
  // the caller is so this function stays a complete drop-in replacement
  // for calling updateMessageStatusByProviderId once per update.
  for (let i = 0; i < updates.length; i++) {
    const found = results[i];
    if (!found) continue;
    const { status } = updates[i];
    const oldStatus = found._oldStatus;
    recomputeConversationSummary(found.contactId);
    if (found.sourceType && found.sourceId && status !== "delivered") updateSourceMessageStatus(found.sourceType, found.sourceId, found.id, { status });
    recordDailyStatsTransition(found, oldStatus, status);
    if (status === "failed" && oldStatus !== "failed" && found.direction === "outbound") notifyFailedSend(found.contactId, found.channel);
  }
  return results;
}
// Used by /api/email/click (marking a message "clicked" by our own row id).
// Same fix as updateMessageStatusByProviderId above: was a full scan of the
// main log to find the row by id, which is exactly the class of bug that
// caused the 2026-08-29 outage -- now O(1) via MESSAGE_ID_INDEX_FILE, and
// (2026-10-08) no longer reads the big per-contact file either, for the
// identical reason/fix as updateMessageStatusByProviderId above.
export function updateMessageById(id, patch) {
  const entry = getMessageIdIndexCached()[id];
  if (!entry) return null;
  const oldStatus = entry.status;
  const historyAdd = patch.status ? { status: patch.status, at: new Date().toISOString() } : null;
  appendContactMessageStatusEvent(entry.contactId, id, patch, historyAdd);
  // Only `status` ever gets written back into the index -- a caller like
  // calls_backend.js's recording-upload patch (`{ body: ... }`) still
  // lands correctly in the contact's own message thread via the overlay
  // append just above, but body TEXT has no business living in this
  // index: it exists specifically to stay small enough to keep in memory
  // (see makeIncrementalJsonCache above), and arbitrary patch content
  // (recording links, etc.) would defeat that on every such call.
  if (patch.status && patch.status !== entry.status) appendToJsonObjectFast(MESSAGE_ID_INDEX_FILE, id, { ...entry, status: patch.status });
  const found = { ...entry, id, ...patch };
  recomputeConversationSummary(entry.contactId);
  if (found.sourceType && found.sourceId) updateSourceMessageStatus(found.sourceType, found.sourceId, id, patch);
  if (patch.status) recordDailyStatsTransition(found, oldStatus, patch.status);
  return found;
}
export function getMessagesForSource(sourceType, sourceId) {
  return getSourceMessages(sourceType, sourceId);
}

// O(1) body fetch by message id, regardless of how large MESSAGE_LOG_FILE
// has grown (12GB+) -- seeks straight to the exact byte range recorded in
// MESSAGE_ID_INDEX_FILE at write time (see persistRowSideEffects's own
// comment), never reads or scans anything else in the file. Returns null
// when there's no recorded offset -- either an id that predates this
// (2026-10-08) or one the backfill script hasn't reached yet -- so
// callers (inbox_backend.js's conversation rendering) can fall through to
// whatever they were already doing for that case.
export function getMessageBodyById(id) {
  const entry = getMessageIdIndexCached()[id];
  if (!entry || entry.bodyOffset == null || entry.bodyLength == null) return null;
  const p = join(DATA_DIR, MESSAGE_LOG_FILE);
  if (!existsSync(p)) return null;
  const fd = openSync(p, "r");
  try {
    const buf = Buffer.alloc(entry.bodyLength);
    readSync(fd, buf, 0, entry.bodyLength, entry.bodyOffset);
    try { return JSON.parse(buf.toString("utf8")); } catch { return null; }
  } finally { closeSync(fd); }
}
