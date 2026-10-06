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
import { processSesNotificationMessage } from "./email_backend.js";
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
// Temporary diagnostic (2026-10-06) -- a real campaign showed send calls
// with near-zero AWS retry delay still taking 10-29+ seconds, in recurring
// clusters landing roughly every 30 seconds, matching this function's own
// interval (confirmed after moving AI Active's batch check to its own
// thread didn't fix it). send_timing.js's duration measurement only wraps
// the raw client.send(cmd) call, before any file writes -- so whatever's
// causing the delay is happening DURING that AWS call specifically, most
// likely this thread's event loop being too busy with something else to
// get back to an already-answered response. Logs how long this function
// itself actually takes each run, to find out directly instead of
// guessing again. Remove once the real cause is confirmed.
function checkCampaigns() {
  const _t0 = Date.now();
  console.log(`[send-worker] checkCampaigns starting at ${new Date(_t0).toISOString()}`);
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
  } finally {
    const elapsed = Date.now() - _t0;
    console.log(`[send-worker] checkCampaigns took ${elapsed}ms`);
  }
}
setInterval(checkCampaigns, CAMPAIGN_CHECK_MS);

// AI Active's own 30s batch check moved OUT to ai_active_worker.js
// (2026-10-06) -- it was here briefly (added 2026-10-05 to get it off the
// background-worker thread, see that commit) purely because "this is
// where sends happen," but it never actually needed to share THIS thread
// specifically the way checkCampaigns above does (checkCampaigns relies on
// running on the SAME thread as the send loop for its getSendWorker()/
// getBackgroundWorker() null-fallback to resolve correctly -- see its own
// comment). processAiActiveBatches has no such requirement; it just calls
// sendEmail/sendSms like any other caller. Confirmed live on a real
// campaign ("ALL STUDENTS test this"): send calls with near-zero AWS
// retry delay still took 10-29+ seconds in recurring clusters roughly
// every 20-30 seconds -- the exact cadence of a 30-second interval
// sharing this thread with the sends themselves.

// replyId handling mirrors background_worker.js's own reply() exactly --
// webhook_relay_backend.js's dispatchToWorker() round-trips a correlated
// reply regardless of which worker it dispatched to, so ses_notification
// needs the identical ack shape now that it's routed here instead (see
// that file's own comment on why: a 60k+ SES notification backlog was
// sharing the background-worker thread with live inbound SMS processing,
// and one thread processing dispatches one at a time meant a slow SES
// notification call could still stall a newer, correctly-prioritized
// twilio_inbound message behind it).
function reply(msg, err) {
  if (msg?.replyId) parentPort.postMessage({ type: "relay_result", replyId: msg.replyId, ok: !err, error: err?.message });
}
parentPort.on("message", (msg) => {
  try {
    if (msg?.type === "send_campaign") {
      // Fire-and-forget, same as background_worker.js's own handling of
      // this message type -- runCampaignSendLoop tracks its own progress
      // by writing crm_campaigns.json directly, nothing to report back.
      runCampaignSendLoop(msg.campaignId).catch((e) => console.error("[send-worker] campaign send failed", msg.campaignId, e.message));
    } else if (msg?.type === "ses_notification") {
      processSesNotificationMessage(msg.raw);
      reply(msg);
    } else {
      console.error("[send-worker] unknown message type", msg?.type);
    }
  } catch (e) {
    console.error("[send-worker] message handling failed", e.message);
    reply(msg, e);
  }
});

process.on("uncaughtException", (err) => console.error("[send-worker] uncaughtException", err?.stack ?? err));
process.on("unhandledRejection", (reason) => console.error("[send-worker] unhandledRejection", reason instanceof Error ? reason.stack : reason));

console.log("[send-worker] started");
