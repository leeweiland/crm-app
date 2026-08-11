import { readJson, sendJson, getSessionUser } from "./auth_backend.js";
import { getMessagesForSource, MESSAGE_LOG_FILE } from "./message_log.js";
import { CAMPAIGNS_FILE } from "./campaigns_backend.js";
import { AUTOMATIONS_FILE, ENROLLMENTS_FILE } from "./automations_backend.js";
import { WORKFLOWS_FILE, WF_ENROLLMENTS_FILE } from "./workflows_backend.js";

// Cross-channel dashboards -- everything here reads crm_message_log.json,
// the one file every channel (email now, SMS since Phase 4) and every
// source (campaign, automation step, workflow step, manual, inbound)
// writes to, so adding a new channel later never means adding a new
// reporting data path, just a new filter over the same rows.
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
function smsStatsFromMessages(messages) {
  const stats = { sent: 0, delivered: 0, failed: 0, received: 0 };
  for (const m of messages) {
    if (m.direction === "inbound") { stats.received++; continue; }
    if (["queued", "sent", "delivered"].includes(m.status)) stats.sent++;
    if (m.status === "delivered") stats.delivered++;
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
    const email = messages.filter(m => m.channel === "email" && m.direction === "outbound");
    const sms = messages.filter(m => m.channel === "sms");
    const automations = readJson(AUTOMATIONS_FILE, []);
    const automationEnrollments = readJson(ENROLLMENTS_FILE, []);
    const workflows = readJson(WORKFLOWS_FILE, []);
    const workflowEnrollments = readJson(WF_ENROLLMENTS_FILE, []);
    return sendJson(res, 200, {
      email: statsFromMessages(email),
      sms: smsStatsFromMessages(sms),
      campaigns: { total: readJson(CAMPAIGNS_FILE, []).length },
      automations: { total: automations.length, active: automations.filter(a => a.active).length, currentlyEnrolled: automationEnrollments.filter(e => e.status === "active").length },
      workflows: { total: workflows.length, active: workflows.filter(w => w.active).length, currentlyEnrolled: workflowEnrollments.filter(e => e.status === "active").length },
    });
  }

  const campaignMatch = p.match(/^\/api\/reporting\/campaigns\/([^/]+)$/);
  if (campaignMatch && req.method === "GET") {
    const messages = getMessagesForSource("campaign", campaignMatch[1]);
    return sendJson(res, 200, { stats: statsFromMessages(messages), messages });
  }

  // Automation email steps log with sourceId "<automationId>:<stepId>" --
  // aggregate everything starting with this automation's id, then break
  // down per-step too for the builder's own per-step counts elsewhere.
  const automationMatch = p.match(/^\/api\/reporting\/automations\/([^/]+)$/);
  if (automationMatch && req.method === "GET") {
    const prefix = automationMatch[1] + ":";
    const messages = readJson(MESSAGE_LOG_FILE, []).filter(m => m.sourceType === "automation_step" && m.sourceId?.startsWith(prefix));
    return sendJson(res, 200, { stats: statsFromMessages(messages), messages });
  }

  const workflowMatch = p.match(/^\/api\/reporting\/workflows\/([^/]+)$/);
  if (workflowMatch && req.method === "GET") {
    const prefix = workflowMatch[1] + ":";
    const messages = readJson(MESSAGE_LOG_FILE, []).filter(m => m.sourceType === "workflow_step" && m.sourceId?.startsWith(prefix));
    return sendJson(res, 200, { stats: smsStatsFromMessages(messages), messages });
  }

  return false;
}
