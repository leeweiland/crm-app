// Dedicated OS thread for SMS status callbacks that belong to a workflow
// (sequence) step specifically (sourceType "workflow_step") -- nothing
// else runs here. Twilio inbound messages (real replies/opt-outs) are
// NEVER routed here -- those stay on sms_worker.js regardless of source,
// since a reply isn't "from" any particular outbound send the way a
// status callback is. See server.js and webhook_relay_backend.js's own
// routing.
//
// Why this exists (2026-10-07): sms_worker.js's single thread handled
// twilio_status for every source combined -- a sequence's own delivery-
// status volume could starve a manual/other SMS send's status updates,
// and vice versa, same gap as the email side just split out above.
import { parentPort } from "worker_threads";
import { processTwilioStatusUpdate } from "./sms_backend.js";
import { loadContactsCache } from "./contacts_db.js";

await loadContactsCache();

function reply(msg, err) {
  if (msg?.replyId) parentPort.postMessage({ type: "relay_result", replyId: msg.replyId, ok: !err, error: err?.message });
}
parentPort.on("message", (msg) => {
  try {
    if (msg?.type === "twilio_status") { processTwilioStatusUpdate(msg.sid, msg.status); reply(msg); }
    else { console.error("[sequence-notification-worker] unknown message type", msg?.type); reply(msg, new Error("unknown message type")); }
  } catch (e) {
    console.error("[sequence-notification-worker] message handling failed", e.message);
    reply(msg, e);
  }
});

process.on("uncaughtException", (err) => console.error("[sequence-notification-worker] uncaughtException", err?.stack ?? err));
process.on("unhandledRejection", (reason) => console.error("[sequence-notification-worker] unhandledRejection", reason instanceof Error ? reason.stack : reason));

console.log("[sequence-notification-worker] started");
