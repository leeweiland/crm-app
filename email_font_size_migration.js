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
// Campaigns already sent/sending are left alone (historical record).
const FLAG = "emailFontSize16Migrated";

function bump(theme) {
  if (theme && Number(theme.fontSize) === 15) { theme.fontSize = 16; return 1; }
  return 0;
}

export function runEmailFontSize16Migration() {
  const settings = readJson(INTEGRATIONS_FILE, { ses: {}, twilio: {}, site: {} });
  if (settings[FLAG]) return;
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
