import { randomUUID } from "crypto";
import { statSync, existsSync, openSync, readSync, closeSync } from "fs";
import { join } from "path";
import { appendJsonRecordFast, appendJsonRecordsFast, appendToJsonObjectFast, readJson, DATA_DIR } from "./auth_backend.js";
import { appendContactMessage, updateContactMessage, upsertConversationSummary, recomputeConversationSummary, appendSourceMessage, appendSourceMessagesBatch, updateSourceMessageStatus, getSourceMessages, recordDailyStatsNew, recordDailyStatsTransition, NOTIFY_CHANNELS } from "./message_index.js";
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
  if (row.providerMessageId) appendToJsonObjectFast(PROVIDER_ID_INDEX_FILE, row.providerMessageId, { id: row.id, contactId: row.contactId, sourceType: row.sourceType || null });
  // bodyOffset/bodyLength (2026-10-08) -- the exact byte range row's own
  // JSON text landed at in MESSAGE_LOG_FILE, captured by logMessage/
  // logMessagesBatch from appendJsonRecordFast's/appendJsonRecordsFast's
  // own return value. Lets getMessageBodyById fetch a message's full body
  // by seeking straight to it, without reading or scanning the rest of
  // this file (12GB+ and growing). Only ever set going forward -- never
  // backfilled here; see backfill_message_body_offsets.mjs for existing
  // history.
  appendToJsonObjectFast(MESSAGE_ID_INDEX_FILE, row.id, { contactId: row.contactId, bodyOffset: bodyOffset?.offset ?? null, bodyLength: bodyOffset?.length ?? null });
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
const PROVIDER_INDEX_PATH = join(DATA_DIR, PROVIDER_ID_INDEX_FILE);
let _providerIndexCache = null;
let _providerIndexMtimeMs = null;
let _providerIndexSize = null;
// Incremental on growth (2026-10-08) -- confirmed live, caught directly
// via per-row timing: this file (20MB+) is append-only (every new send
// adds one key, never rewrites existing ones), but the live app keeps
// appending to it continuously from its own sends while something else
// (a bulk backlog drain, in this case) is also calling this function --
// the OLD mtime-only check meant ANY concurrent append invalidated the
// WHOLE cache, forcing a full 20MB+ re-read+re-parse on the very next
// call, repeatedly, throughout a long-running batch (measured: one call
// in ten took 22.6s, the other nine took 0-1ms -- the 22.6s ones were
// exactly these full reloads). Since appendToJsonObjectFast only ever
// grows the file by replacing its trailing "}" with new entries + "}",
// a size increase means everything before the OLD size is still byte-
// identical -- reading just the NEW tail and merging it into the
// existing in-memory object is enough, no need to discard and reparse
// bytes already correctly cached. Falls back to a full reload for
// anything unexpected (file shrank, truncated oddly, etc.) -- safety
// over speed when the fast path's own assumption doesn't hold.
function getProviderIndexCached() {
  let mtimeMs = null, size = null;
  try { const st = statSync(PROVIDER_INDEX_PATH); mtimeMs = st.mtimeMs; size = st.size; } catch { /* file not created yet */ }
  if (_providerIndexCache === null) {
    _providerIndexCache = readJson(PROVIDER_ID_INDEX_FILE, {});
    _providerIndexMtimeMs = mtimeMs;
    _providerIndexSize = size;
    return _providerIndexCache;
  }
  if (mtimeMs !== _providerIndexMtimeMs) {
    let appliedIncremental = false;
    if (size != null && _providerIndexSize != null && size > _providerIndexSize && _providerIndexSize > 0) {
      try {
        const fd = openSync(PROVIDER_INDEX_PATH, "r");
        try {
          const startOffset = _providerIndexSize - 1; // the OLD "}" byte, which the new write started by replacing
          const newLen = size - startOffset;
          const buf = Buffer.alloc(newLen);
          readSync(fd, buf, 0, newLen, startOffset);
          const text = buf.toString("utf8");
          const added = JSON.parse("{" + (text.startsWith(",") ? text.slice(1) : text));
          Object.assign(_providerIndexCache, added);
          appliedIncremental = true;
        } finally { closeSync(fd); }
      } catch { /* fall through to full reload below */ }
    }
    if (!appliedIncremental) _providerIndexCache = readJson(PROVIDER_ID_INDEX_FILE, {});
    _providerIndexMtimeMs = mtimeMs;
    _providerIndexSize = size;
  }
  return _providerIndexCache;
}

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

export function updateMessageStatusByProviderId(providerMessageId, status, extra) {
  if (!providerMessageId) return null;
  const entry = getProviderIndexCached()[providerMessageId];
  if (!entry) return null;
  let oldStatus = null;
  const found = updateContactMessage(entry.contactId, "id", entry.id, row => {
    oldStatus = row.status;
    row.status = status;
    row.statusHistory.push({ status, at: new Date().toISOString(), ...(extra || {}) });
    return row;
  });
  if (found) {
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
  }
  return found;
}
// Used by /api/email/click (marking a message "clicked" by our own row id).
// Same fix as updateMessageStatusByProviderId above: was a full scan of the
// main log to find the row by id, which is exactly the class of bug that
// caused the 2026-08-29 outage -- now O(1) via MESSAGE_ID_INDEX_FILE.
export function updateMessageById(id, patch) {
  const entry = readJson(MESSAGE_ID_INDEX_FILE, {})[id];
  if (!entry) return null;
  let oldStatus = null;
  const found = updateContactMessage(entry.contactId, "id", id, row => {
    oldStatus = row.status;
    Object.assign(row, patch);
    if (patch.status) row.statusHistory.push({ status: patch.status, at: new Date().toISOString() });
    return row;
  });
  if (found) {
    recomputeConversationSummary(entry.contactId);
    if (found.sourceType && found.sourceId) updateSourceMessageStatus(found.sourceType, found.sourceId, id, patch);
    if (patch.status) recordDailyStatsTransition(found, oldStatus, patch.status);
  }
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
  const entry = readJson(MESSAGE_ID_INDEX_FILE, {})[id];
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
