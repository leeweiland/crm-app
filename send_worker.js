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
import { runCampaignSendLoop } from "./campaigns_backend.js";
import { loadContactsCache } from "./contacts_db.js";

// Same reasoning as background_worker.js's own loadContactsCache() call --
// worker_threads get their own independent module registry, so this
// thread's copy of contacts_db.js has its own empty cache the main
// thread's load never populates. runCampaignSendLoop resolves recipients
// via getAllContacts(), so this must happen before any send can run here.
await loadContactsCache();

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
