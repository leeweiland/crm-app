import { readJson, sendJson, getSessionUser } from "./auth_backend.js";
import { getMessagesForSource, MESSAGE_LOG_FILE } from "./message_log.js";
import { CAMPAIGNS_FILE } from "./campaigns_backend.js";

// Phase 2 "lite" version -- per-campaign email stats only. Full
// cross-channel dashboards (Phase 4) sit on the same crm_message_log.json
// this already reads, so this module just grows more endpoints later
// rather than being replaced.
function statsFromMessages(messages) {
  const stats = { sent: 0, delivered: 0, opened: 0, clicked: 0, bounced: 0, complained: 0, failed: 0 };
  for (const m of messages) {
    if (["sent", "delivered", "opened", "clicked"].includes(m.status)) stats.sent++;
    if (["delivered", "opened", "clicked"].includes(m.status)) stats.delivered++;
    if (["opened", "clicked"].includes(m.status)) stats.opened++;
    if (m.status === "clicked") stats.clicked++;
    if (m.status === "bounced") stats.bounced++;
    if (m.status === "complained") stats.complained++;
    if (m.status === "failed") stats.failed++;
  }
  return stats;
}

export async function handleReportingRequest(req, res, url) {
  const p = url.pathname;
  if (!p.startsWith("/api/reporting")) return false;
  const me = getSessionUser(req);
  if (!me) return sendJson(res, 401, { error: "Not logged in" });

  if (p === "/api/reporting/overview" && req.method === "GET") {
    const messages = readJson(MESSAGE_LOG_FILE, []);
    const email = messages.filter(m => m.channel === "email");
    return sendJson(res, 200, { email: statsFromMessages(email), totalCampaigns: readJson(CAMPAIGNS_FILE, []).length });
  }

  const campaignMatch = p.match(/^\/api\/reporting\/campaigns\/([^/]+)$/);
  if (campaignMatch && req.method === "GET") {
    const messages = getMessagesForSource("campaign", campaignMatch[1]);
    return sendJson(res, 200, { stats: statsFromMessages(messages), messages });
  }

  return false;
}
