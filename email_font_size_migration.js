import { readJson, writeJson } from "./auth_backend.js";
import { INTEGRATIONS_FILE } from "./integrations_backend.js";
import { CAMPAIGNS_FILE } from "./campaigns_backend.js";
import { AUTOMATIONS_FILE } from "./automations_backend.js";
import { FOOTER_TEMPLATES_FILE } from "./email_backend.js";
import { EVENT_TYPES_FILE } from "./scheduling_backend.js";

// ONE-TIME migration (2026-09-20): the email designer's default font size was
// raised from 15 to 16 in code (block_editor_shared.js / block-editor-client.js),
// but every theme is stored as a full copy at creation/save time -- the org
// theme in Settings, and each campaign, automation email step, footer template
// and booking confirmation email -- so all of those kept carrying the old 15
// and kept overriding the new default. This bumps exactly those stored 15s to
// 16 and touches nothing else in a theme. Gated by a flag in the integrations
// file so it only runs once: someone choosing 15 on purpose afterwards stays 15.
const FLAG = "emailFontSize16Migrated";
// FOLLOW-UP (2026-09-23): the first pass deliberately skipped sent/sending
// campaigns as "historical record", but a sent campaign's theme field isn't
// actually a historical record of anything -- sendEmail() reads it once, at
// send time, to render and cache the HTML that's actually shown for that send
// (see email_backend.js's ensureEmailTemplateCached); nothing re-reads
// campaign.theme afterward. What it DOES feed is Copy (duplicate), which
// clones source.theme verbatim -- so copying an old sent campaign to start a
// new one silently dragged the stale 15 back in, which is exactly what
// happened here. Separate flag so this can ship without re-running the pass above.
const SENT_FLAG = "emailFontSize16SentCampaignsMigrated";

function bump(theme) {
  if (theme && Number(theme.fontSize) === 15) { theme.fontSize = 16; return 1; }
  return 0;
}

export function runEmailFontSize16Migration() {
  const settings = readJson(INTEGRATIONS_FILE, { ses: {}, twilio: {}, site: {} });
  if (!settings[FLAG]) {
    const counts = { org: bump(settings.emailTheme), campaigns: 0, automations: 0, footers: 0, bookings: 0 };

    const campaigns = readJson(CAMPAIGNS_FILE, []);
    campaigns.forEach(c => { if (c.status !== "sent" && c.status !== "sending") counts.campaigns += bump(c.theme); });
    if (counts.campaigns) writeJson(CAMPAIGNS_FILE, campaigns);

    const automations = readJson(AUTOMATIONS_FILE, []);
    automations.forEach(a => Object.values(a.steps || {}).forEach(step => {
      if (step.type === "send_email") counts.automations += bump(step.config?.theme);
    }));
    if (counts.automations) writeJson(AUTOMATIONS_FILE, automations);

    const footers = readJson(FOOTER_TEMPLATES_FILE, []);
    footers.forEach(f => { counts.footers += bump(f.theme); });
    if (counts.footers) writeJson(FOOTER_TEMPLATES_FILE, footers);

    const eventTypes = readJson(EVENT_TYPES_FILE, []);
    eventTypes.forEach(e => { counts.bookings += bump(e.confirmation?.email?.theme); });
    if (counts.bookings) writeJson(EVENT_TYPES_FILE, eventTypes);

    settings[FLAG] = true;
    writeJson(INTEGRATIONS_FILE, settings);
    console.log(`[migration] email default font size 15 -> 16: ${JSON.stringify(counts)}`);
  }

  if (!settings[SENT_FLAG]) {
    const campaigns = readJson(CAMPAIGNS_FILE, []);
    let count = 0;
    campaigns.forEach(c => { count += bump(c.theme); });
    if (count) writeJson(CAMPAIGNS_FILE, campaigns);
    settings[SENT_FLAG] = true;
    writeJson(INTEGRATIONS_FILE, settings);
    console.log(`[migration] email default font size 15 -> 16 (sent campaigns, for future Copy): ${count}`);
  }
}
