// Dedicated OS thread for EMAIL delivery/open/click/bounce notifications
// that belong to an automation step specifically (sourceType
// "automation_step") -- nothing else runs here. See server.js and
// webhook_relay_backend.js's own routing (which decides, by looking up
// each notification's sourceType, whether it lands here or on the
// existing campaign-notification pool).
//
// Why this exists (2026-10-07): every email notification (campaign or
// automation) shared the SAME worker pool, undifferentiated -- a large
// campaign's own notification flood could still starve an automation's
// delivery/open/click processing, and vice versa, even after that pool
// was isolated from campaign SENDS. Same principle as every other split
// tonight: each concern gets its own channel, not just "whichever is
// busiest gets moved first."
import { parentPort } from "worker_threads";
import { processSesNotificationMessage } from "./email_backend.js";
import { loadContactsCache } from "./contacts_db.js";

await loadContactsCache();

function reply(msg, err) {
  if (msg?.replyId) parentPort.postMessage({ type: "relay_result", replyId: msg.replyId, ok: !err, error: err?.message });
}
parentPort.on("message", (msg) => {
  try {
    if (msg?.type === "ses_notification") { processSesNotificationMessage(msg.raw); reply(msg); }
    else { console.error("[automation-notification-worker] unknown message type", msg?.type); reply(msg, new Error("unknown message type")); }
  } catch (e) {
    console.error("[automation-notification-worker] message handling failed", e.message);
    reply(msg, e);
  }
});

process.on("uncaughtException", (err) => console.error("[automation-notification-worker] uncaughtException", err?.stack ?? err));
process.on("unhandledRejection", (reason) => console.error("[automation-notification-worker] unhandledRejection", reason instanceof Error ? reason.stack : reason));

console.log("[automation-notification-worker] started");
