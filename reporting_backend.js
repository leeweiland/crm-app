import { readJson, sendJson, getSessionUser } from "./auth_backend.js";
import { getMessagesForSource, MESSAGE_LOG_FILE } from "./message_log.js";
import { CAMPAIGNS_FILE } from "./campaigns_backend.js";

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

// Day-bucketed counts for the Email/SMS UX dashboards -- same source rows
// as everything else here (crm_message_log.json), just grouped by
// createdAt's date instead of aggregated into one lifetime total, so the
// dashboards can chart trend over the selected date range.
function emailDailyBreakdown(messages, startMs, endMs) {
  const byDate = {};
  for (const m of messages) {
    const t = new Date(m.createdAt).getTime();
    if (t < startMs || t > endMs) continue;
    const day = m.createdAt.slice(0, 10);
    const c = byDate[day] || (byDate[day] = { sent: 0, opened: 0, clicked: 0, bounced: 0, failed: 0 });
    if (["sent", "delivered", "opened", "clicked"].includes(m.status)) c.sent++;
    if (["opened", "clicked"].includes(m.status)) c.opened++;
    if (m.status === "clicked") c.clicked++;
    if (m.status === "bounced") c.bounced++;
    if (m.status === "failed") c.failed++;
  }
  return Object.entries(byDate).sort(([a], [b]) => a.localeCompare(b)).map(([date, counts]) => ({ date, ...counts }));
}
function smsDailyBreakdown(messages, startMs, endMs) {
  const byDate = {};
  for (const m of messages) {
    const t = new Date(m.createdAt).getTime();
    if (t < startMs || t > endMs) continue;
    const day = m.createdAt.slice(0, 10);
    const c = byDate[day] || (byDate[day] = { sent: 0, delivered: 0, received: 0, failed: 0 });
    if (m.direction === "inbound") { c.received++; continue; }
    if (["queued", "sent", "delivered"].includes(m.status)) c.sent++;
    if (m.status === "delivered") c.delivered++;
    if (m.status === "failed") c.failed++;
  }
  return Object.entries(byDate).sort(([a], [b]) => a.localeCompare(b)).map(([date, counts]) => ({ date, ...counts }));
}

// Shared with ads_backend.js's period presets on the frontend -- the
// frontend resolves a period to concrete start/end dates and passes them
// here directly, so this endpoint just needs a plain date range, not the
// preset logic itself.
function parseRangeParams(url) {
  const endStr = url.searchParams.get("end") || new Date().toISOString().slice(0, 10);
  const startStr = url.searchParams.get("start") || new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10);
  return { startMs: new Date(startStr + "T00:00:00Z").getTime(), endMs: new Date(endStr + "T23:59:59Z").getTime() };
}

export async function handleReportingRequest(req, res, url) {
  const p = url.pathname;
  if (!p.startsWith("/api/reporting")) return false;
  const me = getSessionUser(req);
  if (!me) return sendJson(res, 401, { error: "Not logged in" });

  if (p === "/api/reporting/overview" && req.method === "GET") {
    const { startMs, endMs } = parseRangeParams(url);
    const inRange = (m) => { const t = new Date(m.createdAt).getTime(); return t >= startMs && t <= endMs; };
    const messages = readJson(MESSAGE_LOG_FILE, []).filter(inRange);
    const email = messages.filter(m => m.channel === "email" && m.direction === "outbound");
    const sms = messages.filter(m => m.channel === "sms");
    const automationEmail = email.filter(m => m.sourceType === "automation_step");
    const workflowSms = sms.filter(m => m.sourceType === "workflow_step");
    return sendJson(res, 200, {
      email: statsFromMessages(email),
      sms: smsStatsFromMessages(sms),
      campaigns: { total: readJson(CAMPAIGNS_FILE, []).length },
      automations: statsFromMessages(automationEmail),
      workflows: smsStatsFromMessages(workflowSms),
    });
  }

  if (p === "/api/reporting/email-daily" && req.method === "GET") {
    const { startMs, endMs } = parseRangeParams(url);
    const inRange = readJson(MESSAGE_LOG_FILE, []).filter(m => m.channel === "email" && m.direction === "outbound");
    const totals = inRange.filter(m => { const t = new Date(m.createdAt).getTime(); return t >= startMs && t <= endMs; });
    return sendJson(res, 200, { days: emailDailyBreakdown(inRange, startMs, endMs), totals: statsFromMessages(totals) });
  }
  if (p === "/api/reporting/sms-daily" && req.method === "GET") {
    const { startMs, endMs } = parseRangeParams(url);
    const inRange = readJson(MESSAGE_LOG_FILE, []).filter(m => m.channel === "sms");
    const totals = inRange.filter(m => { const t = new Date(m.createdAt).getTime(); return t >= startMs && t <= endMs; });
    return sendJson(res, 200, { days: smsDailyBreakdown(inRange, startMs, endMs), totals: smsStatsFromMessages(totals) });
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
