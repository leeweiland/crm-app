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
import { processSesNotificationMessage } from "./email_backend.js";
import { loadContactsCache } from "./contacts_db.js";

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
parentPort.on("message", (msg) => {
  try {
    if (msg?.type === "ses_notification") { processSesNotificationMessage(msg.raw); reply(msg); }
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
