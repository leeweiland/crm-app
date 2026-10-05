// Dedicated OS thread for Twilio webhook processing (inbound SMS + status
// callbacks) ONLY -- nothing else runs here. Separate from both
// background_worker.js (the scheduler tick + SES webhook processing) and
// send_worker.js (campaign/AI-Active sends) -- see server.js and
// sms_worker_handle.js.
//
// Why this exists (2026-10-05): background_worker.js already carried
// twilio_inbound/twilio_status alongside the scheduler's full 17-phase
// tick, and separately alongside SES webhook processing before that was
// moved to send_worker.js. Confirmed live, repeatedly, the same night:
// a real back-and-forth with an AI Coverage agent sat stalled minutes at
// a time behind whichever OTHER thing happened to be sharing that thread
// at the time -- AI Active's batch backlog, a 60k+ SES notification
// backlog, a slow Gmail-poll phase. Fixing the one thing that was sharing
// the thread on any given attempt never fixed the actual problem, because
// the problem was the sharing itself, not any one specific competitor for
// it. A thread that does ONLY Twilio webhook processing has nothing left
// to share with, structurally, not just "nothing that's caused a problem
// yet."
import { parentPort } from "worker_threads";
import { processTwilioStatusUpdate, processTwilioInboundMessage } from "./sms_backend.js";
import { loadContactsCache } from "./contacts_db.js";

// Same reasoning as background_worker.js/send_worker.js's own call --
// worker_threads get their own independent module registry, so this
// thread's copy of contacts_db.js has its own empty cache the main
// thread's load never populates. processTwilioInboundMessage resolves the
// sender via findContactByPhone (getAllContacts()), so this must be loaded
// here too, independently, before any inbound message can be matched.
await loadContactsCache();

// replyId handling mirrors background_worker.js's own reply() exactly --
// webhook_relay_backend.js's dispatchToWorker() round-trips a correlated
// reply regardless of which worker it dispatched to.
function reply(msg, err) {
  if (msg?.replyId) parentPort.postMessage({ type: "relay_result", replyId: msg.replyId, ok: !err, error: err?.message });
}
parentPort.on("message", (msg) => {
  try {
    if (msg?.type === "twilio_status") { processTwilioStatusUpdate(msg.sid, msg.status); reply(msg); }
    else if (msg?.type === "twilio_inbound") { processTwilioInboundMessage(msg.from, msg.body || ""); reply(msg); }
    else { console.error("[sms-worker] unknown message type", msg?.type); reply(msg, new Error("unknown message type")); }
  } catch (e) {
    // One bad webhook payload should never take this thread down -- same
    // isolation guarantee background_worker.js's own message handler gives.
    console.error("[sms-worker] message handling failed", e.message);
    reply(msg, e);
  }
});

process.on("uncaughtException", (err) => console.error("[sms-worker] uncaughtException", err?.stack ?? err));
process.on("unhandledRejection", (reason) => console.error("[sms-worker] unhandledRejection", reason instanceof Error ? reason.stack : reason));

console.log("[sms-worker] started");
