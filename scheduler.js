import { readJson } from "./auth_backend.js";
import { CAMPAIGNS_FILE, sendCampaignNow } from "./campaigns_backend.js";

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
  } catch (e) {
    console.error("[scheduler] tick failed", e.message);
  }
}

export function startScheduler() {
  setInterval(tick, TICK_MS);
  console.log(`[scheduler] started, checking every ${TICK_MS / 1000}s`);
}
