import { readJson } from "./auth_backend.js";
import { CAMPAIGNS_FILE, sendCampaignNow } from "./campaigns_backend.js";
import { advanceDueEnrollments } from "./automations_backend.js";
import { advanceDueWorkflowEnrollments } from "./workflows_backend.js";
import { advanceDueFlowRuns, recoverStaleFlowRuns, pollYoutubeFlows } from "./flows_backend.js";
import { runScheduledDuplicateScan } from "./duplicates_backend.js";
import { syncWritingCacheIfDue } from "./ai_agents_backend.js";
import { processAiActiveBatches } from "./ai_active_backend.js";
import { checkMeetingReminders } from "./meetings_backend.js";
import { sendDueBookingReminders } from "./scheduling_backend.js";
import { sendDueScheduledMessages, checkDueTasks } from "./inbox_backend.js";
import { checkGmailInbox } from "./gmail_backend.js";
import { processCloseAltBackfillBatch, processStopStatusRecoveryBatch } from "./import_backend.js";
import { resyncStaleStopRows, resyncStaleLegacyLabelRows } from "./sqlite_inbox.js";
import { processAcRefFillBatch } from "./ac_sync.js";
import { processBehavioralTriggers } from "./behavioral_triggers_backend.js";
import { refreshCountsCacheIfDue } from "./contacts_backend.js";

// One setInterval ticker for the whole app, started once from server.js.
// Phase 2 only checks scheduled campaigns; Phase 3 adds automation
// wait-step polling and Phase 4 adds workflow step timing to this same
// function, all reusing this one interval rather than each feature
// running its own.
const TICK_MS = 30 * 1000;

// Temporary diagnostic (2026-09-05) -- logs immediately before/after each
// phase so a stuck tick (holding a SQLite write lock other requests are
// waiting on, for instance) shows exactly which phase never returned,
// same reasoning as server.js's req-start log. Remove once the real cause
// of tonight's freezes is found.
// Temporary diagnostic (2026-09-07) -- logs heapUsed after every phase so a
// repeated production OOM (heap hit the 2560MB --max-old-space-size cap and
// the process aborted, three times today so far, at a fairly consistent
// ~200-250s after boot) shows exactly WHICH phase's completion the climb
// tracks, instead of guessing from code review alone -- two prior guesses
// (both real bugs, both fixed) didn't stop the crash, so this replaces
// guessing with an actual measurement on the next occurrence. Remove once
// the real cause is confirmed and fixed.
function heapMb() { return Math.round(process.memoryUsage().heapUsed / 1024 / 1024); }
async function timedPhase(name, fn) {
  console.log(`[scheduler] ${name} starting`);
  await fn();
  console.log(`[scheduler] ${name} done (heap ${heapMb()}MB)`);
}
async function tick() {
  try {
    await timedPhase("campaigns", async () => {
      // Skipped entirely when SEND_WORKER=1 -- see send_worker.js's own
      // checkCampaigns, which does this exact same due/stuck scan
      // independently. Confirmed live (2026-10-04) why this can't just stay
      // here: this phase runs ON the background-worker thread, and
      // sendCampaignNow's own getSendWorker()/getBackgroundWorker() lookups
      // resolve to null when called FROM that thread -- worker_threads have
      // separate module registries, so send_worker_handle.js's workerRef
      // here was never set (only server.js, on the MAIN thread, calls
      // setSendWorker). The silent fallback is runCampaignSendLoop INLINE,
      // on the background-worker thread, which is exactly the thread
      // SEND_WORKER=1 exists to keep sends off of -- a 23k-recipient
      // campaign kept stalling for minutes at a time because every resume
      // landed back on the same thread as the webhook flood it was meant
      // to be isolated from.
      if (process.env.SEND_WORKER === "1") return;
      const campaigns = readJson(CAMPAIGNS_FILE, []);
      const due = campaigns.filter(c => c.status === "scheduled" && c.scheduledAt && new Date(c.scheduledAt).getTime() <= Date.now());
      for (const campaign of due) {
        console.log(`[scheduler] sending due campaign ${campaign.id} (${campaign.name})`);
        // sendCampaignNow is synchronous now -- it kicks off the actual
        // send loop in the background and returns right away (see its own
        // comment in campaigns_backend.js), so no .catch()/await needed
        // here; a plain try/catch covers the rare synchronous throw before
        // the background loop even starts (e.g. a read failure).
        try { sendCampaignNow(campaign.id); } catch (e) { console.error("[scheduler] campaign send failed", campaign.id, e.message); }
      }
      // sendCampaignNow's loop runs in-process with zero persistence -- a
      // deploy restarting the container mid-send (this app redeploys many
      // times a day) silently kills it, no error, no retry, status stuck
      // at "sending" forever. Confirmed live: a real campaign froze at 605
      // of 1640 recipients for 2 days after an unrelated deploy landed
      // mid-flight, completely unnoticed until someone happened to look.
      // sendCampaignNow is resumable now (skips anyone already contacted),
      // so anything idle for STUCK_SEND_THRESHOLD_MS with no progress is
      // safe to just call again -- and campaignNow stamps updatedAt the
      // instant it (re)starts, so a genuinely-still-running send is never
      // mistaken for stuck and double-resumed by the next tick.
      const STUCK_SEND_THRESHOLD_MS = 3 * 60 * 1000;
      const stuck = campaigns.filter(c => c.status === "sending" && c.updatedAt && Date.now() - new Date(c.updatedAt).getTime() > STUCK_SEND_THRESHOLD_MS);
      for (const campaign of stuck) {
        console.log(`[scheduler] resuming stuck campaign ${campaign.id} (${campaign.name}), progress was ${campaign.sendProgress?.sent}/${campaign.sendProgress?.total}`);
        try { sendCampaignNow(campaign.id); } catch (e) { console.error("[scheduler] campaign resume failed", campaign.id, e.message); }
      }
    });
    // Skipped entirely when SEND_WORKER=1 -- see automation_send_worker.js's
    // own interval, same split as campaigns'/AI Active's send loops above.
    // Was sharing this thread with everything else the tick does (Gmail
    // polling, duplicate scans, webhook dispatch) purely because nobody had
    // isolated it yet, not because that was judged safe.
    await timedPhase("advanceDueEnrollments", async () => {
      if (process.env.SEND_WORKER === "1") return;
      await advanceDueEnrollments();
    });
    // Skipped entirely when SEND_WORKER=1 -- see sequence_send_worker.js's
    // own interval, same reasoning as advanceDueEnrollments just above.
    await timedPhase("advanceDueWorkflowEnrollments", async () => {
      if (process.env.SEND_WORKER === "1") return;
      await advanceDueWorkflowEnrollments();
    });
    await timedPhase("advanceDueFlowRuns", advanceDueFlowRuns);
    await timedPhase("recoverStaleFlowRuns", recoverStaleFlowRuns);
    await timedPhase("pollYoutubeFlows", pollYoutubeFlows);
    await timedPhase("runScheduledDuplicateScan", async () => runScheduledDuplicateScan());
    await timedPhase("syncWritingCacheIfDue", syncWritingCacheIfDue);
    await timedPhase("processAiActiveBatches", async () => {
      // Skipped entirely when SEND_WORKER=1 -- see send_worker.js's own
      // interval, same exact split as campaigns' send loop above. Confirmed
      // live (2026-10-05): this phase processing a backlog of queued AI
      // Active cold-opens (each a real LLM call) ran for minutes straight,
      // and because it shares this thread with webhook relay dispatch
      // (background_worker.js), every inbound SMS/email webhook -- including
      // a live back-and-forth with an AI Coverage agent -- sat queued behind
      // it the whole time, reading as random 20-100+ second reply lag with
      // no obvious cause. AI Active's own bulk LLM-bound work doesn't belong
      // sharing a thread with anything latency-sensitive, for the identical
      // reason campaign sends were already moved off it.
      if (process.env.SEND_WORKER === "1") return;
      await processAiActiveBatches();
    });
    await timedPhase("checkMeetingReminders", checkMeetingReminders);
    await timedPhase("sendDueBookingReminders", sendDueBookingReminders);
    await timedPhase("sendDueScheduledMessages", sendDueScheduledMessages);
    await timedPhase("checkDueTasks", checkDueTasks);
    await timedPhase("checkGmailInbox", checkGmailInbox);
    await timedPhase("processCloseAltBackfillBatch", processCloseAltBackfillBatch);
    await timedPhase("processStopStatusRecoveryBatch", processStopStatusRecoveryBatch);
    await timedPhase("resyncStaleStopRows", async () => resyncStaleStopRows());
    await timedPhase("resyncStaleLegacyLabelRows", async () => resyncStaleLegacyLabelRows());
    await timedPhase("processAcRefFillBatch", processAcRefFillBatch);
    // pollAcEngagementIfDue and processAcNightlySyncBatch REMOVED (2026-09-07)
    // -- both were unconditional background AC polling: the former caused
    // three production OOM crashes today re-reading the full ~180MB contacts
    // file, and even fixed, both are still a standing per-tick/per-contact
    // AC API load the user explicitly doesn't want running in the
    // background right now. Per direct instruction: engagement/campaign
    // data should only refresh when a contact's conversation is actually
    // opened (syncAcEngagementForContact, already wired to /opened in
    // inbox_backend.js -- unaffected by this), and any bulk AC import
    // happens as a deliberate one-off later, once AWS SES is live. Both
    // functions are still exported from ac_sync.js, just not scheduled.
    await timedPhase("processBehavioralTriggers", processBehavioralTriggers);
    await timedPhase("refreshCountsCacheIfDue", async () => refreshCountsCacheIfDue());
  } catch (e) {
    console.error("[scheduler] tick failed", e.message);
  }
}

// setInterval fires every TICK_MS regardless of whether the previous tick()
// call has returned yet -- confirmed live (2026-09-05) via the phase logs
// above printing wildly out of order (one tick's "X starting" appearing,
// then several OTHER phases from a DIFFERENT tick starting and finishing,
// before that same "X done" ever showed up): any tick that happens to run
// long lets a second tick start on top of it, doubling up every full-file
// read/write and SQLite access every phase makes. That's a real
// architectural gap this whole file had, not something any one slow phase
// (the Gmail poller earlier tonight, or whatever else runs long some other
// day) should have to individually defend against. A tick that's still
// running when the next one would fire just skips that firing entirely --
// the one after picks up on schedule once the current tick finishes.
let _tickRunning = false;
async function guardedTick() {
  if (_tickRunning) { console.error("[scheduler] previous tick still running -- skipping this firing"); return; }
  _tickRunning = true;
  try { await tick(); } finally { _tickRunning = false; }
}
// RE-ENABLED (2026-09-05) -- the scheduler was disabled for a few hours
// tonight on suspicion of causing the Inbox's repeated freezes, but the
// real cause turned out to be unrelated to this file entirely:
// compliance_backend.js's recheckStopStatus() loading the 12GB+ main
// message log into memory on every single inbound SMS, now fixed. The
// interleaved phase-timing logs that looked like an impossible overlap
// were a symptom of that same memory pressure (timers fire unreliably
// under heavy GC/swap load), not a real bug in the guard below, which
// stays in place as legitimate protection regardless.
//
// Exported separately from startScheduler (2026-09-16) so background_worker.js
// can run the exact same tick logic on its own setInterval, off the main
// thread -- see BACKGROUND_WORKER in server.js. Both paths call this one
// function; nothing about the tick itself changes based on which thread
// runs it.
export { guardedTick };
export function startScheduler() {
  setInterval(guardedTick, TICK_MS);
  console.log(`[scheduler] started, checking every ${TICK_MS / 1000}s`);
}
