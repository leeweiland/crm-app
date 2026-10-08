// Dedicated OS thread for SES notification processing (open/click/delivery/
// bounce/complaint webhooks) ONLY -- nothing else runs here, not even the
// campaign/SMS sends that used to share send_worker.js with this. See
// server.js and ses_notification_worker_handle.js.
//
// Why this exists (2026-10-06): send_worker.js was built to give campaign/
// SMS sends their own thread, away from background_worker.js's scheduler
// tick. SES notification processing got added to THAT same thread later
// the same night, to get it away from the sms-worker thread instead --
// correct relative to SMS, but it quietly violated the actual principle
// (each concern on its OWN channel): email SENDING and email WEBHOOK
// PROCESSING ended up sharing a thread, the same mistake already fixed for
// SMS. Confirmed live on the "YOUTUBE Lighter is better" campaign: send
// calls with a near-zero AWS retry delay (so AWS itself wasn't the slow
// part) still took 20-66+ seconds end to end, and a batch of 12 concurrent
// sends would all resolve within the same ~100ms window after a stall --
// the signature of the event loop being starved by something else on the
// same thread, not an individual slow call. The SES-notification relay
// batch size was ALSO raised from 25 to 500 the same night (a92ac72), so a
// single relay cycle can dispatch 500 of these to whichever thread handles
// them -- exactly enough synchronous back-to-back work to delay an
// already-answered sendEmail() promise from actually getting to resolve,
// even though the real network call finished fast. Isolating this onto its
// own thread means a send call's resolution is never waiting behind
// anything but other send calls on its own thread, same guarantee SMS
// already has.
import { parentPort } from "worker_threads";
import pg from "pg";
import { processSesNotificationMessage } from "./email_backend.js";
import { loadContactsCache } from "./contacts_db.js";
import { setSuppressConversationRecompute } from "./message_index.js";

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });

// Same reasoning as every other worker file's own loadContactsCache() call
// -- worker_threads get their own independent module registry, so this
// thread's copy of contacts_db.js has its own empty cache the main thread's
// load never populates. processSesNotificationMessage resolves contacts
// via getContact()/markContactEmailEngagement(), so this must be loaded
// here too, independently, before any notification can be processed.
await loadContactsCache();

// replyId handling mirrors every other worker's own reply() exactly --
// webhook_relay_backend.js's dispatchToWorker() round-trips a correlated
// reply regardless of which worker it dispatched to.
function reply(msg, err) {
  if (msg?.replyId) parentPort.postMessage({ type: "relay_result", replyId: msg.replyId, ok: !err, error: err?.message });
}

// One-time bulk catchup for the ses_notification backlog (2026-10-08) --
// runs ON THIS EXISTING dedicated thread, using the SAME
// processSesNotificationMessage real-time notifications already go
// through, NOT a separate OS process. A standalone script doing this
// same work as its own process was confirmed live to cause real SQLite
// "database is locked" contention against the live app -- running it
// here instead means it shares this thread's own connections exactly
// the way real-time traffic already does correctly, nothing bypassed,
// nothing skipped. Pulls directly from Postgres (not through the
// webhook-receiver's HTTP relay) since that round-trip/10s-retry-
// cooldown pacing was built for steady real-time traffic, not a one-
// time backlog catchup. Fire-and-forget from the dispatcher's
// perspective -- progress logs here, the dispatcher gets one reply when
// the whole run finishes.
let bulkDrainRunning = false;
async function runBulkDrain(batchSize) {
  if (bulkDrainRunning) return { alreadyRunning: true };
  bulkDrainRunning = true;
  let totalProcessed = 0;
  const t0 = Date.now();
  // Suppressed for the ENTIRE drain, not just this batch -- see
  // setSuppressConversationRecompute's own comment in message_index.js.
  // Nothing about a contact's own message/status data is skipped by this;
  // only the Inbox sidebar's cosmetic summary cache stops refreshing from
  // these historical catch-up rows specifically, same as it would during
  // any other genuinely disk-starved stretch.
  setSuppressConversationRecompute(true);
  try {
    while (true) {
      // Oldest-first (2026-10-08, per explicit instruction -- not newest-
      // first). Confirmed live this was the actual reason the drain never
      // visibly progressed: new real-time SES events keep arriving
      // continuously (PAUSE_SES_NOTIFICATIONS only stops the relay's own
      // auto-dispatch, not webhook-receiver's own insert into
      // webhook_queue), and DESC always re-served those freshest rows
      // first on every single batch -- the drain was perpetually
      // reprocessing whatever just arrived instead of ever reaching the
      // actual ~53k historical backlog sitting behind it. ASC means the
      // real backlog drains in the order it actually queued, and new
      // real-time rows simply wait their turn at the back instead of
      // cutting in front of it forever.
      const { rows } = await pool.query(
        `SELECT id, payload FROM webhook_queue WHERE type='ses_notification' AND status IN ('pending','failed') ORDER BY created_at ASC LIMIT $1`,
        [batchSize]
      );
      if (!rows.length) break;
      const doneIds = [];
      for (const row of rows) {
        try { processSesNotificationMessage(row.payload.raw); doneIds.push(row.id); }
        catch (e) { console.error(`[ses-notification-worker] bulk-drain row ${row.id} failed:`, e.message); }
      }
      if (doneIds.length) await pool.query(`UPDATE webhook_queue SET status='delivered', delivered_at=now() WHERE id = ANY($1::uuid[])`, [doneIds]);
      totalProcessed += doneIds.length;
      const elapsed = (Date.now() - t0) / 1000;
      console.log(`[ses-notification-worker] bulk-drain: ${totalProcessed} total, rate ${(totalProcessed / elapsed).toFixed(1)}/sec`);
    }
  } finally { bulkDrainRunning = false; setSuppressConversationRecompute(false); }
  return { totalProcessed, elapsedSec: (Date.now() - t0) / 1000 };
}

parentPort.on("message", (msg) => {
  try {
    if (msg?.type === "ses_notification") { processSesNotificationMessage(msg.raw); reply(msg); }
    else if (msg?.type === "bulk_drain_backlog") {
      runBulkDrain(msg.batchSize || 2000)
        .then((result) => parentPort.postMessage({ type: "relay_result", replyId: msg.replyId, ok: true, result }))
        .catch((e) => reply(msg, e));
    }
    else { console.error("[ses-notification-worker] unknown message type", msg?.type); reply(msg, new Error("unknown message type")); }
  } catch (e) {
    // One bad webhook payload should never take this thread down -- same
    // isolation guarantee every other worker's own message handler gives.
    console.error("[ses-notification-worker] message handling failed", e.message);
    reply(msg, e);
  }
});

process.on("uncaughtException", (err) => console.error("[ses-notification-worker] uncaughtException", err?.stack ?? err));
process.on("unhandledRejection", (reason) => console.error("[ses-notification-worker] unhandledRejection", reason instanceof Error ? reason.stack : reason));

console.log("[ses-notification-worker] started");
