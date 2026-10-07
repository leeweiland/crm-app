// Dedicated OS thread for SMS sequences' (workflows_backend.js) own
// 30-second enrollment check ONLY -- nothing else runs here. See server.js.
//
// Why this exists (2026-10-07): advanceDueWorkflowEnrollments was running
// as just one more phase inside background_worker.js's 17-phase scheduler
// tick, same gap as automation_send_worker.js's own comment describes for
// email automations -- never isolated because nothing had stressed it yet,
// not because it was judged safe to share a thread.
import { advanceDueWorkflowEnrollments } from "./workflows_backend.js";
import { loadContactsCache } from "./contacts_db.js";

// Same reasoning as every other worker file's own loadContactsCache() call
// -- this thread's copy of contacts_db.js has its own empty cache the main
// thread's load never populates. advanceDueWorkflowEnrollments resolves
// contacts via getContact()/sendSms(), so this must be loaded here too.
await loadContactsCache();

const CHECK_MS = 30 * 1000;
let running = false;
async function runCheck() {
  if (running) return;
  running = true;
  try { await advanceDueWorkflowEnrollments(); } catch (e) { console.error("[sequence-send-worker] advanceDueWorkflowEnrollments failed", e.message); } finally { running = false; }
}
setInterval(runCheck, CHECK_MS);

// No parentPort.on("message") handler -- self-driven, same shape as
// automation_send_worker.js/ai_active_worker.js.
process.on("uncaughtException", (err) => console.error("[sequence-send-worker] uncaughtException", err?.stack ?? err));
process.on("unhandledRejection", (reason) => console.error("[sequence-send-worker] unhandledRejection", reason instanceof Error ? reason.stack : reason));

console.log("[sequence-send-worker] started, checking every 30s");
