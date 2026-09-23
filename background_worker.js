// Runs the entire scheduler tick (all 17 background phases -- campaigns,
// workflows, automations, flows, duplicate scans, AI batches, reminders,
// Gmail polling, etc., see scheduler.js) and all Twilio/SES delivery-status
// webhook processing on its OWN OS thread, spawned via worker_threads from
// server.js when BACKGROUND_WORKER is enabled -- see server.js and
// background_worker_handle.js.
//
// Why this exists (2026-09-16): a bulk push of ~600 SMS/email sends plus
// the resulting flood of delivery-status webhooks pinned the main thread
// for the better part of an hour, making the CRM itself feel like it had
// crashed for anyone using it -- every phase of the scheduler tick AND
// every single webhook does synchronous file I/O, and all of it ran
// in-line with normal page requests on the one thread serving them.
// worker_threads gives this its own real OS thread and its own V8 heap;
// however long a tick or a burst of webhooks takes here, the main thread's
// event loop never blocks for it. The underlying business logic (tick(),
// processTwilioStatusUpdate, processSesNotificationMessage) is completely
// unchanged -- this file only decides which thread calls it.
//
// Data safety: this worker and the main thread both end up touching the
// same JSON files on disk (enrollments, message log, contacts, etc.).
// That's the same last-write-wins file semantics this app has always run
// on for its low-volume, user-initiated writes (manual enroll, a single
// SMS reply) -- nothing new there. What moves here is specifically the
// HIGH-VOLUME, blocking work (the tick and webhook floods), which is
// exactly what was actually saturating the thread. The one shared resource
// that needs its own care is crm_prototype.db (SQLite): opening a second
// connection from this thread works safely because sqlite_inbox.js already
// sets PRAGMA busy_timeout for exactly this "another process/thread has
// the file open" case.
import { parentPort } from "worker_threads";
import { guardedTick } from "./scheduler.js";
import { processTwilioStatusUpdate } from "./sms_backend.js";
import { processSesNotificationMessage } from "./email_backend.js";
import { computeAndCacheAllCounts } from "./contacts_backend.js";

const TICK_MS = 30 * 1000;
setInterval(guardedTick, TICK_MS);
console.log(`[background-worker] started, ticking every ${TICK_MS / 1000}s`);

parentPort.on("message", (msg) => {
  try {
    if (msg?.type === "twilio_status") processTwilioStatusUpdate(msg.sid, msg.status);
    else if (msg?.type === "ses_notification") processSesNotificationMessage(msg.raw);
    else if (msg?.type === "recompute_counts") computeAndCacheAllCounts();
    else console.error("[background-worker] unknown message type", msg?.type);
  } catch (e) {
    // One bad webhook payload should never take this thread down -- it's
    // the same isolation guarantee guardedTick's own try/catch already
    // gives the scheduler side.
    console.error("[background-worker] message handling failed", e.message);
  }
});

process.on("uncaughtException", (err) => console.error("[background-worker] uncaughtException", err?.stack ?? err));
process.on("unhandledRejection", (reason) => console.error("[background-worker] unhandledRejection", reason instanceof Error ? reason.stack : reason));
