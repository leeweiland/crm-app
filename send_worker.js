// Runs campaign (and, when added, SMS) send loops on their OWN OS thread,
// separate from background_worker.js's scheduler-tick thread -- see
// server.js and send_worker_handle.js.
//
// Why this exists (2026-10-04): BACKGROUND_WORKER already moved sends off
// the main thread so the CRM's own pages never freeze, but it put sends on
// the SAME thread as the scheduler's full 17-phase tick (Gmail polling,
// automations, workflows, duplicate scans, etc.). Confirmed live: a Gmail
// inbox poll that took 2+ minutes in one tick (see gmail_backend.js's own
// fix for that specific bug) stalled an in-flight campaign send for that
// entire window, just because they happened to share a thread. Fixing the
// one slow phase that caused that incident doesn't prevent the next one
// -- any future slow scheduler phase could do the same thing again. A
// dedicated thread for sends makes that category of problem structurally
// impossible instead of merely unlikely: nothing non-send-related ever
// runs here.
//
// Deliberately NOT a rewrite of the actual sending logic -- runCampaignSendLoop
// (campaigns_backend.js) is called completely unchanged. sendEmail()'s real
// complexity (merge tags, click-tracking link rewriting, unsubscribe links,
// template caching) all stays exactly as it is; only WHICH THREAD calls it
// moves. Same reasoning as background_worker.js itself: same code, same
// files, same /data volume (worker_threads share the process's filesystem
// access, unlike a separate service would), just isolated onto a thread
// that only ever does this one thing.
import { parentPort } from "worker_threads";
import { runCampaignSendLoop, sendCampaignNow, CAMPAIGNS_FILE } from "./campaigns_backend.js";
import { processAiActiveBatches } from "./ai_active_backend.js";
import { loadContactsCache } from "./contacts_db.js";
import { readJson } from "./auth_backend.js";

// Same reasoning as background_worker.js's own loadContactsCache() call --
// worker_threads get their own independent module registry, so this
// thread's copy of contacts_db.js has its own empty cache the main
// thread's load never populates. runCampaignSendLoop resolves recipients
// via getAllContacts(), so this must happen before any send can run here.
await loadContactsCache();

// Self-sufficient due/stuck-campaign check -- NOT delegated to
// scheduler.js's tick (which deliberately skips this when SEND_WORKER=1;
// see its own comment). Confirmed live (2026-10-04) why it can't stay
// there: that phase runs on the background-worker thread, and
// sendCampaignNow's getSendWorker()/getBackgroundWorker() lookups resolve
// to null when called from a DIFFERENT thread than the one that holds the
// real references (only server.js, on the main thread, ever calls
// setSendWorker/setBackgroundWorker -- worker_threads have separate module
// registries). The silent fallback was running the send loop INLINE on
// the background-worker thread -- the exact thread this file exists to
// keep sends off of. Called from HERE instead, that same fallback
// resolves correctly: both lookups still return null (this thread never
// sets them either), but null-both IS correct in this one spot, since
// falling through to a plain, local runCampaignSendLoop call is exactly
// where the dedicated send thread wants this to run anyway.
const STUCK_SEND_THRESHOLD_MS = 3 * 60 * 1000;
const CAMPAIGN_CHECK_MS = 30 * 1000;
function checkCampaigns() {
  try {
    const campaigns = readJson(CAMPAIGNS_FILE, []);
    const due = campaigns.filter(c => c.status === "scheduled" && c.scheduledAt && new Date(c.scheduledAt).getTime() <= Date.now());
    for (const campaign of due) {
      console.log(`[send-worker] sending due campaign ${campaign.id} (${campaign.name})`);
      try { sendCampaignNow(campaign.id); } catch (e) { console.error("[send-worker] campaign send failed", campaign.id, e.message); }
    }
    const stuck = campaigns.filter(c => c.status === "sending" && c.updatedAt && Date.now() - new Date(c.updatedAt).getTime() > STUCK_SEND_THRESHOLD_MS);
    for (const campaign of stuck) {
      console.log(`[send-worker] resuming stuck campaign ${campaign.id} (${campaign.name}), progress was ${campaign.sendProgress?.sent}/${campaign.sendProgress?.total}`);
      try { sendCampaignNow(campaign.id); } catch (e) { console.error("[send-worker] campaign resume failed", campaign.id, e.message); }
    }
  } catch (e) {
    console.error("[send-worker] checkCampaigns failed", e.message);
  }
}
setInterval(checkCampaigns, CAMPAIGN_CHECK_MS);

// Moved here from scheduler.js's tick (which deliberately skips it when
// SEND_WORKER=1; see its own comment) for the identical reason campaign
// sends already live on this thread instead of background_worker.js's:
// confirmed live (2026-10-05), a backlog of queued AI Active cold-opens
// (each a real LLM call, processed one at a time) kept this phase running
// for minutes at a stretch on the background-worker thread, and because
// that thread ALSO handles every webhook relay dispatch
// (background_worker.js), a live inbound SMS reply -- including a real
// back-and-forth with an AI Coverage agent -- sat queued behind it the
// whole time. Same guard shape as checkCampaigns' own interval: an
// overlap guard since one pass can legitimately take longer than
// AI_ACTIVE_CHECK_MS under a real backlog, same reasoning as scheduler.js's
// own _tickRunning.
const AI_ACTIVE_CHECK_MS = 30 * 1000;
let aiActiveRunning = false;
async function runAiActiveBatches() {
  if (aiActiveRunning) return;
  aiActiveRunning = true;
  try { await processAiActiveBatches(); } catch (e) { console.error("[send-worker] processAiActiveBatches failed", e.message); } finally { aiActiveRunning = false; }
}
setInterval(runAiActiveBatches, AI_ACTIVE_CHECK_MS);

parentPort.on("message", (msg) => {
  try {
    if (msg?.type === "send_campaign") {
      // Fire-and-forget, same as background_worker.js's own handling of
      // this message type -- runCampaignSendLoop tracks its own progress
      // by writing crm_campaigns.json directly, nothing to report back.
      runCampaignSendLoop(msg.campaignId).catch((e) => console.error("[send-worker] campaign send failed", msg.campaignId, e.message));
    } else {
      console.error("[send-worker] unknown message type", msg?.type);
    }
  } catch (e) {
    console.error("[send-worker] message handling failed", e.message);
  }
});

process.on("uncaughtException", (err) => console.error("[send-worker] uncaughtException", err?.stack ?? err));
process.on("unhandledRejection", (reason) => console.error("[send-worker] unhandledRejection", reason instanceof Error ? reason.stack : reason));

console.log("[send-worker] started");
