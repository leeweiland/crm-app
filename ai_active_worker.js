// Dedicated OS thread for AI Active's own 30-second batch check ONLY --
// nothing else runs here, not even the campaign/SMS sends that used to
// share send_worker.js with this. See server.js.
//
// Why this exists (2026-10-06): runAiActiveBatches got added to
// send_worker.js (b17e... same night as everything else) purely because
// "that's where sends happen" -- but it never actually needed to be on
// that specific thread the way checkCampaigns does (checkCampaigns relies
// on running on the SAME thread as the send loop itself, so
// sendCampaignNow's getSendWorker()/getBackgroundWorker() null-fallback
// resolves correctly -- see send_worker.js's own comment on that).
// processAiActiveBatches has no such requirement: it just calls
// sendEmail/sendSms like any other caller, which work fine from any
// thread. Confirmed live on a real campaign ("ALL STUDENTS test this",
// 2026-10-06): send calls with near-zero AWS retry delay still took
// 10-29+ seconds end to end, in recurring clusters roughly every 20-30
// seconds -- the exact cadence of a 30-second interval sharing the
// sending thread. Isolating this here removes one of the two candidates
// for that contention outright, without touching checkCampaigns (which
// has a real reason to stay where it is).
//
// No parentPort.on("message") handler at all -- unlike every other
// worker in this file set, nothing ever dispatches a message TO this
// thread. It's purely self-driven, the same shape as background_worker.js's
// own scheduler-tick interval, just isolated onto its own thread instead
// of sharing one.
import { processAiActiveBatches } from "./ai_active_backend.js";
import { loadContactsCache } from "./contacts_db.js";

// Same reasoning as every other worker file's own loadContactsCache() call
// -- worker_threads get their own independent module registry, so this
// thread's copy of contacts_db.js has its own empty cache the main
// thread's load never populates. processAiActiveBatches resolves contacts
// via getAllContacts()/getContactByIdFast(), so this must be loaded here
// too, independently, before any batch can run.
await loadContactsCache();

const AI_ACTIVE_CHECK_MS = 30 * 1000;
let aiActiveRunning = false;
async function runAiActiveBatches() {
  if (aiActiveRunning) return;
  aiActiveRunning = true;
  try { await processAiActiveBatches(); } catch (e) { console.error("[ai-active-worker] processAiActiveBatches failed", e.message); } finally { aiActiveRunning = false; }
}
setInterval(runAiActiveBatches, AI_ACTIVE_CHECK_MS);

process.on("uncaughtException", (err) => console.error("[ai-active-worker] uncaughtException", err?.stack ?? err));
process.on("unhandledRejection", (reason) => console.error("[ai-active-worker] unhandledRejection", reason instanceof Error ? reason.stack : reason));

console.log("[ai-active-worker] started, checking every 30s");
