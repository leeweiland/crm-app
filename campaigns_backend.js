import { randomUUID } from "crypto";
import { readJson, writeJson, readJsonBody, sendJson, getSessionUser } from "./auth_backend.js";
import { matchesSegment, CONTACTS_FILE, SEGMENTS_FILE } from "./contacts_backend.js";
import { sendEmail } from "./email_backend.js";
import { getMessagesForSource } from "./message_log.js";

export const CAMPAIGNS_FILE = "crm_campaigns.json";

function resolveRecipients({ listIds, tagIds, segmentId, excludeListIds }) {
  const contacts = readJson(CONTACTS_FILE, []);
  const segment = segmentId ? readJson(SEGMENTS_FILE, []).find(s => s.id === segmentId) : null;
  const hasFilters = (listIds?.length) || (tagIds?.length) || segment;
  return contacts.filter(c => {
    if (c.emailOptOut || !c.email) return false;
    if (excludeListIds?.length && (c.listIds || []).some(id => excludeListIds.includes(id))) return false;
    if (!hasFilters) return true; // no targeting = everyone (minus opt-outs/exclusions above)
    if (listIds?.length && (c.listIds || []).some(id => listIds.includes(id))) return true;
    if (tagIds?.length && (c.tags || []).some(id => tagIds.includes(id))) return true;
    if (segment && matchesSegment(c, segment.filter)) return true;
    return false;
  });
}

function rollupStats(campaignId) {
  const messages = getMessagesForSource("campaign", campaignId);
  const stats = { sent: 0, delivered: 0, opened: 0, clicked: 0, bounced: 0, unsubscribed: 0 };
  for (const m of messages) {
    if (["sent", "delivered", "opened", "clicked"].includes(m.status)) stats.sent++;
    if (["delivered", "opened", "clicked"].includes(m.status)) stats.delivered++;
    if (["opened", "clicked"].includes(m.status)) stats.opened++;
    if (m.status === "clicked") stats.clicked++;
    if (m.status === "bounced") stats.bounced++;
    if (m.status === "complained") stats.unsubscribed++;
  }
  return stats;
}

// Exported so scheduler.js can trigger a due scheduled campaign without an
// HTTP round-trip -- same "small reusable function, not internal HTTP"
// convention as sendEmail() itself.
export async function sendCampaignNow(campaignId) {
  const campaigns = readJson(CAMPAIGNS_FILE, []);
  const campaign = campaigns.find(c => c.id === campaignId);
  if (!campaign) return { ok: false, reason: "not_found" };
  campaign.status = "sending";
  writeJson(CAMPAIGNS_FILE, campaigns);

  const recipients = resolveRecipients(campaign.recipients || {});
  for (const contact of recipients) {
    await sendEmail({
      to: contact.email, subject: campaign.subject, blocks: campaign.blocks, theme: campaign.theme,
      footerTemplateId: campaign.footerTemplateId, contactId: contact.id,
      sourceType: "campaign", sourceId: campaign.id,
    });
  }

  campaign.status = "sent";
  campaign.sentAt = new Date().toISOString();
  campaign.stats = rollupStats(campaign.id);
  writeJson(CAMPAIGNS_FILE, campaigns);
  return { ok: true, recipientCount: recipients.length };
}

export async function handleCampaignsRequest(req, res, url) {
  const p = url.pathname;
  if (!p.startsWith("/api/campaigns")) return false;
  const me = getSessionUser(req);
  if (!me) return sendJson(res, 401, { error: "Not logged in" });

  if (p === "/api/campaigns" && req.method === "GET") {
    const campaigns = readJson(CAMPAIGNS_FILE, []).sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    return sendJson(res, 200, { campaigns });
  }
  if (p === "/api/campaigns" && req.method === "POST") {
    const { name } = await readJsonBody(req);
    const campaigns = readJson(CAMPAIGNS_FILE, []);
    const campaign = {
      id: randomUUID(), name: name || "Untitled Campaign", status: "draft",
      subject: "", blocks: [], theme: { background: "#f4f4f4", maxWidth: 650 }, footerTemplateId: null,
      recipients: { listIds: [], tagIds: [], segmentId: null, excludeListIds: [] },
      scheduledAt: null, sentAt: null,
      stats: { sent: 0, delivered: 0, opened: 0, clicked: 0, bounced: 0, unsubscribed: 0 },
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    campaigns.push(campaign);
    writeJson(CAMPAIGNS_FILE, campaigns);
    return sendJson(res, 200, { ok: true, campaign });
  }

  const duplicateMatch = p.match(/^\/api\/campaigns\/([^/]+)\/duplicate$/);
  if (duplicateMatch && req.method === "POST") {
    const campaigns = readJson(CAMPAIGNS_FILE, []);
    const source = campaigns.find(c => c.id === duplicateMatch[1]);
    if (!source) return sendJson(res, 404, { error: "Not found" });
    const copy = {
      id: randomUUID(), name: `Copy of ${source.name}`, status: "draft",
      subject: source.subject, blocks: JSON.parse(JSON.stringify(source.blocks)),
      theme: JSON.parse(JSON.stringify(source.theme || { background: "#f4f4f4", maxWidth: 650 })),
      footerTemplateId: source.footerTemplateId,
      recipients: JSON.parse(JSON.stringify(source.recipients)),
      scheduledAt: null, sentAt: null,
      stats: { sent: 0, delivered: 0, opened: 0, clicked: 0, bounced: 0, unsubscribed: 0 },
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    campaigns.push(copy);
    writeJson(CAMPAIGNS_FILE, campaigns);
    return sendJson(res, 200, { ok: true, campaign: copy });
  }

  const campaignMatch = p.match(/^\/api\/campaigns\/([^/]+)$/);
  if (campaignMatch) {
    const campaigns = readJson(CAMPAIGNS_FILE, []);
    const campaign = campaigns.find(c => c.id === campaignMatch[1]);
    if (req.method === "GET") {
      if (!campaign) return sendJson(res, 404, { error: "Not found" });
      return sendJson(res, 200, { campaign });
    }
    if (req.method === "PATCH") {
      if (!campaign) return sendJson(res, 404, { error: "Not found" });
      if (campaign.status === "sent" || campaign.status === "sending") return sendJson(res, 400, { error: "Can't edit a campaign that's already sending or sent" });
      const body = await readJsonBody(req);
      for (const k of ["name", "subject", "blocks", "theme", "footerTemplateId", "recipients"]) if (k in body) campaign[k] = body[k];
      campaign.updatedAt = new Date().toISOString();
      writeJson(CAMPAIGNS_FILE, campaigns);
      return sendJson(res, 200, { ok: true, campaign });
    }
    if (req.method === "DELETE") {
      writeJson(CAMPAIGNS_FILE, campaigns.filter(c => c.id !== campaignMatch[1]));
      return sendJson(res, 200, { ok: true });
    }
  }

  const previewMatch = p.match(/^\/api\/campaigns\/([^/]+)\/preview-recipients$/);
  if (previewMatch && req.method === "GET") {
    const campaigns = readJson(CAMPAIGNS_FILE, []);
    const campaign = campaigns.find(c => c.id === previewMatch[1]);
    if (!campaign) return sendJson(res, 404, { error: "Not found" });
    const recipients = resolveRecipients(campaign.recipients || {});
    return sendJson(res, 200, { count: recipients.length });
  }

  const sendMatch = p.match(/^\/api\/campaigns\/([^/]+)\/send$/);
  if (sendMatch && req.method === "POST") {
    const campaigns = readJson(CAMPAIGNS_FILE, []);
    const campaign = campaigns.find(c => c.id === sendMatch[1]);
    if (!campaign) return sendJson(res, 404, { error: "Not found" });
    if (!campaign.subject || !campaign.blocks?.length) return sendJson(res, 400, { error: "Add a subject and at least one block before sending" });
    const result = await sendCampaignNow(campaign.id);
    return sendJson(res, 200, result);
  }

  const scheduleMatch = p.match(/^\/api\/campaigns\/([^/]+)\/schedule$/);
  if (scheduleMatch && req.method === "POST") {
    const { scheduledAt } = await readJsonBody(req);
    if (!scheduledAt || new Date(scheduledAt).getTime() <= Date.now()) return sendJson(res, 400, { error: "scheduledAt must be a valid future date/time" });
    const campaigns = readJson(CAMPAIGNS_FILE, []);
    const campaign = campaigns.find(c => c.id === scheduleMatch[1]);
    if (!campaign) return sendJson(res, 404, { error: "Not found" });
    if (!campaign.subject || !campaign.blocks?.length) return sendJson(res, 400, { error: "Add a subject and at least one block before scheduling" });
    campaign.status = "scheduled";
    campaign.scheduledAt = scheduledAt;
    campaign.updatedAt = new Date().toISOString();
    writeJson(CAMPAIGNS_FILE, campaigns);
    return sendJson(res, 200, { ok: true, campaign });
  }

  const unscheduleMatch = p.match(/^\/api\/campaigns\/([^/]+)\/unschedule$/);
  if (unscheduleMatch && req.method === "POST") {
    const campaigns = readJson(CAMPAIGNS_FILE, []);
    const campaign = campaigns.find(c => c.id === unscheduleMatch[1]);
    if (!campaign) return sendJson(res, 404, { error: "Not found" });
    campaign.status = "draft";
    campaign.scheduledAt = null;
    writeJson(CAMPAIGNS_FILE, campaigns);
    return sendJson(res, 200, { ok: true, campaign });
  }

  return false;
}
