// Dedicated OS thread for email automations' own 30-second enrollment
// check ONLY -- nothing else runs here. See server.js.
//
// Why this exists (2026-10-07): advanceDueEnrollments (automations_backend.js)
// was running as just one more phase inside background_worker.js's 17-phase
// scheduler tick, sharing a thread with Gmail polling, duplicate scans, AI
// batches, and everything else that tick does -- the same "reactive, not
// planned" gap already called out for campaign sends and SES notifications
// earlier the same night, just never caught here because nothing had
// stressed it yet. Isolating it here means a slow automation step (a real
// sendEmail call, a slow contact write) is never waiting behind an
// unrelated scheduler phase, and vice versa.
import { advanceDueEnrollments } from "./automations_backend.js";
import { loadContactsCache } from "./contacts_db.js";

// Same reasoning as every other worker file's own loadContactsCache() call
// -- worker_threads get their own independent module registry, so this
// thread's copy of contacts_db.js has its own empty cache the main
// thread's load never populates. advanceDueEnrollments resolves contacts
// via getContact()/sendEmail(), so this must be loaded here too,
// independently, before any enrollment can advance.
await loadContactsCache();

const CHECK_MS = 30 * 1000;
let running = false;
async function runCheck() {
  if (running) return;
  running = true;
  try { await advanceDueEnrollments(); } catch (e) { console.error("[automation-send-worker] advanceDueEnrollments failed", e.message); } finally { running = false; }
}
setInterval(runCheck, CHECK_MS);

// No parentPort.on("message") handler -- nothing ever dispatches a
// message TO this thread, same self-driven shape as ai_active_worker.js.
process.on("uncaughtException", (err) => console.error("[automation-send-worker] uncaughtException", err?.stack ?? err));
process.on("unhandledRejection", (reason) => console.error("[automation-send-worker] unhandledRejection", reason instanceof Error ? reason.stack : reason));

console.log("[automation-send-worker] started, checking every 30s");
