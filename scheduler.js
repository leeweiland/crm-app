import { readJson } from "./auth_backend.js";
import { CAMPAIGNS_FILE, sendCampaignNow } from "./campaigns_backend.js";
import { advanceDueEnrollments } from "./automations_backend.js";
import { advanceDueWorkflowEnrollments } from "./workflows_backend.js";
import { advanceDueFlowRuns, recoverStaleFlowRuns } from "./flows_backend.js";
import { runScheduledDuplicateScan } from "./duplicates_backend.js";
import { syncWritingCacheIfDue } from "./ai_agents_backend.js";
import { processAiActiveBatches } from "./ai_active_backend.js";
import { checkMeetingReminders } from "./meetings_backend.js";
import { sendDueBookingReminders } from "./scheduling_backend.js";
import { checkGmailInbox } from "./gmail_backend.js";
import { processCloseAltBackfillBatch, processStopStatusRecoveryBatch } from "./import_backend.js";
import { resyncStaleStopRows, resyncStaleLegacyLabelRows } from "./sqlite_inbox.js";
import { processAcRefFillBatch } from "./ac_sync.js";

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
async function timedPhase(name, fn) {
  console.log(`[scheduler] ${name} starting`);
  await fn();
  console.log(`[scheduler] ${name} done`);
}
async function tick() {
  try {
    await timedPhase("campaigns", async () => {
      const campaigns = readJson(CAMPAIGNS_FILE, []);
      const due = campaigns.filter(c => c.status === "scheduled" && c.scheduledAt && new Date(c.scheduledAt).getTime() <= Date.now());
      for (const campaign of due) {
        console.log(`[scheduler] sending due campaign ${campaign.id} (${campaign.name})`);
        await sendCampaignNow(campaign.id).catch(e => console.error("[scheduler] campaign send failed", campaign.id, e.message));
      }
    });
    await timedPhase("advanceDueEnrollments", advanceDueEnrollments);
    await timedPhase("advanceDueWorkflowEnrollments", advanceDueWorkflowEnrollments);
    await timedPhase("advanceDueFlowRuns", advanceDueFlowRuns);
    await timedPhase("recoverStaleFlowRuns", recoverStaleFlowRuns);
    await timedPhase("runScheduledDuplicateScan", async () => runScheduledDuplicateScan());
    await timedPhase("syncWritingCacheIfDue", syncWritingCacheIfDue);
    await timedPhase("processAiActiveBatches", processAiActiveBatches);
    await timedPhase("checkMeetingReminders", checkMeetingReminders);
    await timedPhase("sendDueBookingReminders", sendDueBookingReminders);
    await timedPhase("checkGmailInbox", checkGmailInbox);
    await timedPhase("processCloseAltBackfillBatch", processCloseAltBackfillBatch);
    await timedPhase("processStopStatusRecoveryBatch", processStopStatusRecoveryBatch);
    await timedPhase("resyncStaleStopRows", async () => resyncStaleStopRows());
    await timedPhase("resyncStaleLegacyLabelRows", async () => resyncStaleLegacyLabelRows());
    await timedPhase("processAcRefFillBatch", processAcRefFillBatch);
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
export function startScheduler() {
  setInterval(guardedTick, TICK_MS);
  console.log(`[scheduler] started, checking every ${TICK_MS / 1000}s`);
}
