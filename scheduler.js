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
import { processCloseAltBackfillBatch } from "./import_backend.js";

// One setInterval ticker for the whole app, started once from server.js.
// Phase 2 only checks scheduled campaigns; Phase 3 adds automation
// wait-step polling and Phase 4 adds workflow step timing to this same
// function, all reusing this one interval rather than each feature
// running its own.
const TICK_MS = 30 * 1000;

async function tick() {
  try {
    const campaigns = readJson(CAMPAIGNS_FILE, []);
    const due = campaigns.filter(c => c.status === "scheduled" && c.scheduledAt && new Date(c.scheduledAt).getTime() <= Date.now());
    for (const campaign of due) {
      console.log(`[scheduler] sending due campaign ${campaign.id} (${campaign.name})`);
      await sendCampaignNow(campaign.id).catch(e => console.error("[scheduler] campaign send failed", campaign.id, e.message));
    }
    await advanceDueEnrollments();
    await advanceDueWorkflowEnrollments();
    await advanceDueFlowRuns();
    await recoverStaleFlowRuns();
    runScheduledDuplicateScan();
    await syncWritingCacheIfDue();
    await processAiActiveBatches();
    await checkMeetingReminders();
    await sendDueBookingReminders();
    // TEMPORARILY DISABLED (2026-09-05) -- checkGmailInbox has frozen the
    // entire server multiple times tonight (a full-contacts-file cache
    // rebuild every tick, then a backlog of historical messages processed
    // in one go, then a repeat even after capping that batch and adding
    // fetch timeouts). Something about this poller is still wrong in a way
    // that live-patching under production pressure hasn't actually fixed.
    // Pulling it out of the scheduler entirely so the app stays stable
    // while it gets debugged properly, offline. Gmail-connected users will
    // stop seeing new replies auto-captured until this is re-enabled.
    // await checkGmailInbox();
    await processCloseAltBackfillBatch();
  } catch (e) {
    console.error("[scheduler] tick failed", e.message);
  }
}

export function startScheduler() {
  setInterval(tick, TICK_MS);
  console.log(`[scheduler] started, checking every ${TICK_MS / 1000}s`);
}
