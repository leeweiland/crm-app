import { readJson, sendJson, getSessionUser } from "./auth_backend.js";
import { getMessagesForSource } from "./message_log.js";
import { getDailyStatsInRange } from "./message_index.js";
import { CAMPAIGNS_FILE } from "./campaigns_backend.js";
import { AUTOMATIONS_FILE } from "./automations_backend.js";
import { WORKFLOWS_FILE } from "./workflows_backend.js";
import { CONTACTS_FILE } from "./segments_shared.js";
import { PAGE_VISITS_FILE } from "./tracking_backend.js";
import { BOOKINGS_FILE } from "./scheduling_backend.js";

// Cross-channel dashboards -- these used to read crm_message_log.json
// directly (12+GB and growing; a full scan blocks the whole single-threaded
// server for however long it takes -- see message_log.js's postmortem
// comment). getDailyStatsInRange reads a small per-day running-count index
// instead (message_index.js), updated incrementally at send/webhook time --
// same "keep it small, update it as you go" pattern as msg_by_source below.
// These helpers turn a day-bucket's (or several summed together) CURRENT-
// status counts into the same {sent,delivered,opened,...} shape the old
// per-message fold produced -- e.g. "sent" = however many messages are
// currently sitting at sent-or-later, since status only ever moves forward.
// Still used by the per-source endpoints below (getMessagesForSource
// returns real slim message rows, not pre-aggregated counts).
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
function statsFromByStatus(byStatus) {
  const c = (statuses) => statuses.reduce((sum, s) => sum + (byStatus[s] || 0), 0);
  return {
    sent: c(["sent", "delivered", "opened", "clicked"]),
    delivered: c(["delivered", "opened", "clicked"]),
    opened: c(["opened", "clicked"]),
    clicked: c(["clicked"]),
    bounced: c(["bounced"]),
    complained: c(["complained"]),
    failed: c(["failed"]),
  };
}
function smsStatsFromByStatus(byStatus, receivedCount) {
  const c = (statuses) => statuses.reduce((sum, s) => sum + (byStatus[s] || 0), 0);
  return { sent: c(["queued", "sent", "delivered"]), delivered: c(["delivered"]), failed: c(["failed"]), received: receivedCount || 0 };
}
function sumByStatus(days, key) {
  return days.reduce((acc, d) => { for (const [s, n] of Object.entries(d[key] || {})) acc[s] = (acc[s] || 0) + n; return acc; }, {});
}

// Same testContact exclusion as message_index.js's daily-stats recording
// (see recordDailyStatsNew there) -- a contact flagged testContact
// (contact-detail.html's "Test Contact" checkbox) shouldn't skew these
// per-campaign/automation/workflow stats either, for the same reason.
function excludeTestContacts(messages) {
  const testIds = new Set(readJson(CONTACTS_FILE, []).filter(c => c.testContact).map(c => c.id));
  return messages.filter(m => !testIds.has(m.contactId));
}

// Click-to-conversion attribution, grouped by the el= source tag every
// tracked link (email/SMS/ads/social, see source_names.js and the Ad
// Platform Link Tracking settings) already carries. Distinct from the
// existing "Ads" tab, which shows ad SPEND pulled from a Google Sheet --
// this is CONVERSION data derived entirely from this app's own
// crm_page_visits.json (see tracking_backend.js) and crm_contacts.json,
// no external source.
//
// First-touch attribution: each contact is credited to the el= value of
// their EARLIEST el=-tagged page visit (any time, not bounded by the
// selected date range -- their true first touch might predate it), then
// only counted if their OWN conversion event (opt-in = contact.createdAt,
// booking = an actual crm_bookings.json row, enrolled = current status)
// falls inside the selected range. Visit/unique-visitor counts, separately,
// are bounded by the range directly (how much traffic each source drove
// in this window, identified or not).
export function computeAttribution(startMs, endMs) {
  // Same testContact exclusion as excludeTestContacts above -- this
  // report's own numbers would otherwise get real click/opt-in counts
  // muddied by whoever's own test contact (e.g. sending themselves test
  // links while building/verifying this exact feature).
  const contacts = readJson(CONTACTS_FILE, []).filter(c => !c.testContact);
  const contactsById = new Map(contacts.map(c => [c.id, c]));
  const visits = readJson(PAGE_VISITS_FILE, []);
  const bookedContactIds = new Set(readJson(BOOKINGS_FILE, []).map(b => b.contactId));

  const visitStats = new Map(); // el -> {visits, visitorIds:Set}
  const firstTouchByContact = new Map(); // contactId -> {el, atMs}
  for (const v of visits) {
    if (!v.el) continue;
    const atMs = new Date(v.at).getTime();
    if (atMs >= startMs && atMs <= endMs) {
      if (!visitStats.has(v.el)) visitStats.set(v.el, { visits: 0, visitorIds: new Set() });
      const s = visitStats.get(v.el);
      s.visits++;
      if (v.visitorId) s.visitorIds.add(v.visitorId);
    }
    if (v.contactId) {
      const existing = firstTouchByContact.get(v.contactId);
      if (!existing || atMs < existing.atMs) firstTouchByContact.set(v.contactId, { el: v.el, atMs });
    }
  }

  // byElStage powers the drill-down endpoint -- "el|stage" -> Set(contactId).
  const byElStage = new Map();
  function addToStage(el, stage, contactId) {
    const key = `${el}|${stage}`;
    if (!byElStage.has(key)) byElStage.set(key, new Set());
    byElStage.get(key).add(contactId);
  }
  const conversionStats = new Map(); // el -> {optIns, bookings, enrolled}
  for (const [contactId, touch] of firstTouchByContact) {
    const contact = contactsById.get(contactId);
    if (!contact) continue;
    const createdMs = new Date(contact.createdAt).getTime();
    if (createdMs < startMs || createdMs > endMs) continue; // opt-in itself didn't happen in this window
    if (!conversionStats.has(touch.el)) conversionStats.set(touch.el, { optIns: 0, bookings: 0, enrolled: 0 });
    const c = conversionStats.get(touch.el);
    c.optIns++;
    addToStage(touch.el, "optIns", contactId);
    if (bookedContactIds.has(contactId)) { c.bookings++; addToStage(touch.el, "bookings", contactId); }
    if (contact.status === "ENROLLED") { c.enrolled++; addToStage(touch.el, "enrolled", contactId); }
  }

  const allEls = new Set([...visitStats.keys(), ...conversionStats.keys()]);
  const sources = [...allEls].map(el => {
    const vs = visitStats.get(el) || { visits: 0, visitorIds: new Set() };
    const cs = conversionStats.get(el) || { optIns: 0, bookings: 0, enrolled: 0 };
    return { el, visits: vs.visits, uniqueVisitors: vs.visitorIds.size, optIns: cs.optIns, bookings: cs.bookings, enrolled: cs.enrolled };
  }).sort((a, b) => b.visits - a.visits);

  return { sources, byElStage };
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
    const days = getDailyStatsInRange(startMs, endMs);
    const totalSmsIn = days.reduce((sum, d) => sum + (d.smsInCount || 0), 0);
    return sendJson(res, 200, {
      email: statsFromByStatus(sumByStatus(days, "emailOut")),
      sms: smsStatsFromByStatus(sumByStatus(days, "smsOut"), totalSmsIn),
      campaigns: { total: readJson(CAMPAIGNS_FILE, []).length },
      automations: statsFromByStatus(sumByStatus(days, "automationEmailOut")),
      workflows: smsStatsFromByStatus(sumByStatus(days, "workflowSmsOut"), 0),
    });
  }

  if (p === "/api/reporting/email-daily" && req.method === "GET") {
    const { startMs, endMs } = parseRangeParams(url);
    const days = getDailyStatsInRange(startMs, endMs);
    const dayRows = days.map(d => {
      const c = (statuses) => statuses.reduce((sum, s) => sum + (d.emailOut[s] || 0), 0);
      return { date: d.date, sent: c(["sent", "delivered", "opened", "clicked"]), opened: c(["opened", "clicked"]), clicked: c(["clicked"]), bounced: c(["bounced"]), failed: c(["failed"]) };
    });
    return sendJson(res, 200, { days: dayRows, totals: statsFromByStatus(sumByStatus(days, "emailOut")) });
  }
  if (p === "/api/reporting/sms-daily" && req.method === "GET") {
    const { startMs, endMs } = parseRangeParams(url);
    const days = getDailyStatsInRange(startMs, endMs);
    const dayRows = days.map(d => {
      const c = (statuses) => statuses.reduce((sum, s) => sum + (d.smsOut[s] || 0), 0);
      return { date: d.date, sent: c(["queued", "sent", "delivered"]), delivered: c(["delivered"]), received: d.smsInCount || 0, failed: c(["failed"]) };
    });
    const totalSmsIn = days.reduce((sum, d) => sum + (d.smsInCount || 0), 0);
    return sendJson(res, 200, { days: dayRows, totals: smsStatsFromByStatus(sumByStatus(days, "smsOut"), totalSmsIn) });
  }

  if ((p === "/api/reporting/attribution" || p === "/api/reporting/attribution/contacts") && req.method === "GET") {
    const { startMs, endMs } = parseRangeParams(url);
    const data = computeAttribution(startMs, endMs);
    if (p === "/api/reporting/attribution") {
      return sendJson(res, 200, { sources: data.sources, start: url.searchParams.get("start"), end: url.searchParams.get("end") });
    }
    // Drill-down: the exact contacts behind one source's one funnel stage.
    const el = url.searchParams.get("el");
    const stage = url.searchParams.get("stage"); // "optIns" | "bookings" | "enrolled"
    const bucket = data.byElStage.get(`${el}|${stage}`);
    if (!bucket) return sendJson(res, 200, { contacts: [] });
    const contacts = readJson(CONTACTS_FILE, []);
    const byId = new Map(contacts.map(c => [c.id, c]));
    return sendJson(res, 200, { contacts: [...bucket].map(id => byId.get(id)).filter(Boolean) });
  }

  const campaignMatch = p.match(/^\/api\/reporting\/campaigns\/([^/]+)$/);
  if (campaignMatch && req.method === "GET") {
    const messages = excludeTestContacts(getMessagesForSource("campaign", campaignMatch[1]));
    return sendJson(res, 200, { stats: statsFromMessages(messages), messages });
  }

  // Automation email steps log with sourceId "<automationId>:<stepId>" --
  // used to be a prefix-scan over crm_message_log.json (12+GB, blocks the
  // whole single-threaded server for however long that scan takes -- see
  // message_log.js's postmortem comment). The automation's own step list is
  // small and already known, so this just reads each step's own small
  // per-source file (see message_index.js's getSourceMessages) and merges
  // them -- O(this automation's steps), never O(every message ever sent).
  // stepStats is keyed by stepId directly -- getMessagesForSource's rows are
  // deliberately slim (id/contactId/to/status/sentAt, no sourceId; which
  // source they came from is already implicit in which per-source file was
  // read) so the per-step breakdown has to be computed here, server-side,
  // rather than the frontend trying to filter the flat list back apart by a
  // sourceId field that was never on these rows.
  const automationMatch = p.match(/^\/api\/reporting\/automations\/([^/]+)$/);
  if (automationMatch && req.method === "GET") {
    const automation = readJson(AUTOMATIONS_FILE, []).find(a => a.id === automationMatch[1]);
    const stepIds = automation ? Object.keys(automation.steps || {}) : [];
    const stepStats = {};
    const messages = stepIds.flatMap(stepId => {
      const stepMessages = excludeTestContacts(getMessagesForSource("automation_step", `${automationMatch[1]}:${stepId}`));
      stepStats[stepId] = statsFromMessages(stepMessages);
      return stepMessages;
    });
    return sendJson(res, 200, { stats: statsFromMessages(messages), stepStats, messages });
  }

  const workflowMatch = p.match(/^\/api\/reporting\/workflows\/([^/]+)$/);
  if (workflowMatch && req.method === "GET") {
    const workflow = readJson(WORKFLOWS_FILE, []).find(w => w.id === workflowMatch[1]);
    const stepIds = workflow ? (workflow.steps || []).map(s => s.id) : [];
    const messages = excludeTestContacts(stepIds.flatMap(stepId => getMessagesForSource("workflow_step", `${workflowMatch[1]}:${stepId}`)));
    return sendJson(res, 200, { stats: smsStatsFromMessages(messages), messages });
  }

  return false;
}
