import { randomUUID } from "crypto";
import { readJson, writeJson, readJsonBody, sendJson, getSessionUser } from "./auth_backend.js";
import { renderBlocksToHtml, applyMergeTags, rewriteLinksForTracking } from "./block_editor_shared.js";
import { logMessage, updateMessageStatusByProviderId, updateMessageById, MESSAGE_LOG_FILE } from "./message_log.js";
import { fireTrigger, AUTOMATIONS_FILE } from "./automations_backend.js";
import { fireWorkflowTrigger } from "./workflows_backend.js";
import { CAMPAIGNS_FILE } from "./campaigns_backend.js";

export const FOOTER_TEMPLATES_FILE = "crm_footer_templates.json";
export const CONTACTS_FILE = "crm_contacts.json";

// Resolves a clicked tracked link back to the source block that produced it
// (matched by exact destination URL, same source campaign/automation-step the
// message log row already points to) and executes its linkAction, if any.
// Currently only "add_tag" is supported -- mirrors the automations engine's
// own add_tag step so a tag added this way can itself re-trigger automations.
function executeLinkClickAction(row, destUrl) {
  if (!row?.contactId || !row?.sourceType || !row?.sourceId) return;
  let blocks = null;
  if (row.sourceType === "campaign") {
    const campaign = readJson(CAMPAIGNS_FILE, []).find(c => c.id === row.sourceId);
    blocks = campaign?.blocks || null;
  } else if (row.sourceType === "automation_step") {
    const [automationId, stepId] = String(row.sourceId).split(":");
    const automation = readJson(AUTOMATIONS_FILE, []).find(a => a.id === automationId);
    blocks = automation?.steps?.[stepId]?.config?.blocks || null;
  }
  if (!blocks) return;
  const block = blocks.find(b => (b.type === "image" || b.type === "button") && b.link === destUrl);
  if (!block?.linkAction || block.linkAction.type !== "add_tag" || !block.linkAction.tagId) return;

  const contacts = readJson(CONTACTS_FILE, []);
  const contact = contacts.find(c => c.id === row.contactId);
  if (!contact) return;
  if (!contact.tags) contact.tags = [];
  if (!contact.tags.includes(block.linkAction.tagId)) {
    contact.tags.push(block.linkAction.tagId);
    contact.updatedAt = new Date().toISOString();
    writeJson(CONTACTS_FILE, contacts);
    fireTrigger("tag_added", { contactId: contact.id, tagId: block.linkAction.tagId });
    fireWorkflowTrigger("tag_added", { contactId: contact.id, tagId: block.linkAction.tagId });
  }
}

let SESv2Client, SendEmailCommand;
async function loadSesSdk() {
  if (SESv2Client) return;
  const mod = await import("@aws-sdk/client-sesv2");
  SESv2Client = mod.SESv2Client;
  SendEmailCommand = mod.SendEmailCommand;
}

// Graceful "not configured yet" path -- Lee is creating the AWS account
// separately, so every send call below degrades to a logged failure
// instead of throwing, keeping the rest of the app (composer, footer
// templates, campaign drafting) usable before those credentials land.
function sesConfigured() {
  return !!(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY && process.env.SES_FROM_ADDRESS);
}
async function getSesClient() {
  if (!sesConfigured()) return null;
  await loadSesSdk();
  return new SESv2Client({
    region: process.env.AWS_REGION || "us-west-2",
    credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY },
  });
}

function getContact(contactId) {
  return readJson(CONTACTS_FILE, []).find(c => c.id === contactId) || null;
}

function resolveFooterHtml(footerTemplateId, contactId) {
  const templates = readJson(FOOTER_TEMPLATES_FILE, []);
  const footer = templates.find(f => f.id === footerTemplateId) || templates.find(f => f.isDefault) || null;
  if (!footer) return "";
  const unsubscribeUrl = `${process.env.PUBLIC_BASE_URL || ""}/api/email/unsubscribe?c=${encodeURIComponent(contactId || "")}`;
  const social = (footer.socialLinks || []).map(s => `<a href="${s.url}" style="margin:0 6px;color:#888">${s.platform}</a>`).join("");
  return `
    <div style="margin-top:24px;padding-top:16px;border-top:1px solid #e5e5e5;font-size:11px;color:#888;text-align:center">
      ${footer.html || ""}
      ${footer.physicalAddress ? `<div style="margin-top:8px">${footer.physicalAddress}</div>` : ""}
      ${social ? `<div style="margin-top:8px">${social}</div>` : ""}
      <div style="margin-top:8px"><a href="${unsubscribeUrl}" style="color:#888">${footer.unsubscribeLinkText || "Unsubscribe"}</a></div>
    </div>`;
}

// Shared send primitive -- imported directly (function call, not HTTP) by
// campaigns_backend.js now and automations_backend.js in Phase 3, matching
// chat-app's convention of small reusable async helpers rather than a
// service-to-service HTTP layer.
export async function sendEmail({ to, subject, blocks, theme, footerTemplateId, contactId, sourceType, sourceId }) {
  const client = await getSesClient();
  const contact = contactId ? getContact(contactId) : null;

  if (contact?.emailOptOut) {
    return { ok: false, reason: "opted_out" };
  }

  let html = renderBlocksToHtml(blocks, theme) + resolveFooterHtml(footerTemplateId, contactId);
  if (contact) html = applyMergeTags(html, contact);
  const renderedSubject = contact ? applyMergeTags(subject, contact) : subject;

  const logRow = logMessage({
    channel: "email", direction: "outbound", contactId, sourceType, sourceId,
    to, from: process.env.SES_FROM_ADDRESS || null, subject: renderedSubject,
    bodyPreview: (blocks || []).find(b => b.type === "text")?.html?.slice(0, 140) || "",
    status: client ? "queued" : "failed",
  });

  if (!client) {
    return { ok: false, reason: "ses_not_configured" };
  }

  html = rewriteLinksForTracking(html, { messageLogId: logRow.id, baseUrl: process.env.PUBLIC_BASE_URL || "" });

  try {
    const cmd = new SendEmailCommand({
      FromEmailAddress: process.env.SES_FROM_ADDRESS,
      Destination: { ToAddresses: [to] },
      Content: { Simple: { Subject: { Data: renderedSubject }, Body: { Html: { Data: html } } } },
      ...(process.env.SES_CONFIGURATION_SET ? { ConfigurationSetName: process.env.SES_CONFIGURATION_SET } : {}),
    });
    const result = await client.send(cmd);
    // Store the real SES MessageId as the join key delivery/open/click
    // webhooks arrive with -- the log row was created before send()
    // returned, so this is a follow-up write by our own row id.
    updateMessageById(logRow.id, { providerMessageId: result.MessageId, status: "sent", sentAt: new Date().toISOString() });
    return { ok: true, messageId: result.MessageId };
  } catch (e) {
    updateMessageById(logRow.id, { status: "failed" });
    return { ok: false, reason: e.message };
  }
}

export async function handleEmailRequest(req, res, url) {
  const p = url.pathname;

  // ── Public routes (no auth) -- SES itself and a recipient's own browser
  // hit these directly, they can't carry a session cookie. ─────────────
  if (p === "/api/webhooks/ses" && req.method === "POST") {
    const body = await readJsonBody(req);
    // SNS subscription confirmation handshake -- one-time, required before
    // SNS will actually start delivering real notifications.
    if (body.Type === "SubscriptionConfirmation" && body.SubscribeURL) {
      try { await fetch(body.SubscribeURL); } catch {}
      return sendJson(res, 200, { ok: true });
    }
    if (body.Type === "Notification") {
      try {
        const msg = JSON.parse(body.Message);
        const providerMessageId = msg.mail?.messageId;
        const eventType = msg.eventType || msg.notificationType;
        const statusMap = { Delivery: "delivered", Open: "opened", Click: "clicked", Bounce: "bounced", Complaint: "complained" };
        if (providerMessageId && statusMap[eventType]) {
          const row = updateMessageStatusByProviderId(providerMessageId, statusMap[eventType]);
          if (row?.contactId && statusMap[eventType] === "opened") { fireTrigger("email_opened", { contactId: row.contactId }); fireWorkflowTrigger("email_opened", { contactId: row.contactId }); }
          if (row?.contactId && statusMap[eventType] === "clicked") { fireTrigger("email_clicked", { contactId: row.contactId }); fireWorkflowTrigger("email_clicked", { contactId: row.contactId }); }
        }
      } catch (e) { console.error("[SES webhook] parse failed", e.message); }
    }
    return sendJson(res, 200, { ok: true });
  }

  if (p === "/api/email/click" && req.method === "GET") {
    const messageLogId = url.searchParams.get("m");
    const dest = url.searchParams.get("u");
    if (messageLogId) {
      const log = readJson(MESSAGE_LOG_FILE, []);
      const row = log.find(m => m.id === messageLogId);
      if (row) {
        row.status = "clicked"; row.statusHistory.push({ status: "clicked", at: new Date().toISOString() });
        writeJson(MESSAGE_LOG_FILE, log);
        if (row.contactId) { fireTrigger("email_clicked", { contactId: row.contactId }); fireWorkflowTrigger("email_clicked", { contactId: row.contactId }); }
        if (dest) executeLinkClickAction(row, dest);
      }
    }
    res.writeHead(302, { Location: dest || "/" });
    res.end();
    return true;
  }

  if (p === "/api/email/unsubscribe" && req.method === "GET") {
    const contactId = url.searchParams.get("c");
    const contacts = readJson(CONTACTS_FILE, []);
    const contact = contacts.find(c => c.id === contactId);
    if (contact) { contact.emailOptOut = true; contact.updatedAt = new Date().toISOString(); writeJson(CONTACTS_FILE, contacts); }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<!DOCTYPE html><html><body style="font-family:sans-serif;text-align:center;padding:60px 20px">
      <h2>You've been unsubscribed.</h2><p>You won't receive any more marketing emails from us.</p>
    </body></html>`);
    return true;
  }

  // ── Everything else requires a logged-in user ───────────────────────
  const owned = p.startsWith("/api/footer-templates") || p.startsWith("/api/email/");
  if (!owned) return false;
  const me = getSessionUser(req);
  if (!me) return sendJson(res, 401, { error: "Not logged in" });

  if (p === "/api/email/config-status" && req.method === "GET") {
    return sendJson(res, 200, { configured: sesConfigured() });
  }

  if (p === "/api/email/test-send" && req.method === "POST") {
    const { to, subject, blocks, footerTemplateId } = await readJsonBody(req);
    if (!to || !subject) return sendJson(res, 400, { error: "to and subject are required" });
    const result = await sendEmail({ to, subject, blocks: blocks || [], footerTemplateId, contactId: null, sourceType: "manual", sourceId: null });
    if (!result.ok) return sendJson(res, 400, { error: result.reason === "ses_not_configured" ? "Amazon SES isn't configured yet -- add AWS credentials to .env first." : result.reason });
    return sendJson(res, 200, { ok: true });
  }

  if (p === "/api/footer-templates" && req.method === "GET") {
    return sendJson(res, 200, { templates: readJson(FOOTER_TEMPLATES_FILE, []) });
  }
  if (p === "/api/footer-templates" && req.method === "POST") {
    const { name, html, unsubscribeLinkText, physicalAddress, socialLinks } = await readJsonBody(req);
    if (!name) return sendJson(res, 400, { error: "name is required" });
    const templates = readJson(FOOTER_TEMPLATES_FILE, []);
    const template = {
      id: randomUUID(), name, html: html || "", unsubscribeLinkText: unsubscribeLinkText || "Unsubscribe",
      physicalAddress: physicalAddress || "", socialLinks: socialLinks || [],
      isDefault: templates.length === 0, // first one created becomes the default automatically
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    templates.push(template);
    writeJson(FOOTER_TEMPLATES_FILE, templates);
    return sendJson(res, 200, { ok: true, template });
  }
  const footerMatch = p.match(/^\/api\/footer-templates\/([^/]+)$/);
  if (footerMatch) {
    const templates = readJson(FOOTER_TEMPLATES_FILE, []);
    const template = templates.find(t => t.id === footerMatch[1]);
    if (req.method === "PATCH") {
      if (!template) return sendJson(res, 404, { error: "Not found" });
      const body = await readJsonBody(req);
      for (const k of ["name", "html", "unsubscribeLinkText", "physicalAddress", "socialLinks"]) if (k in body) template[k] = body[k];
      template.updatedAt = new Date().toISOString();
      writeJson(FOOTER_TEMPLATES_FILE, templates);
      return sendJson(res, 200, { ok: true, template });
    }
    if (req.method === "DELETE") {
      writeJson(FOOTER_TEMPLATES_FILE, templates.filter(t => t.id !== footerMatch[1]));
      return sendJson(res, 200, { ok: true });
    }
  }
  const setDefaultMatch = p.match(/^\/api\/footer-templates\/([^/]+)\/set-default$/);
  if (setDefaultMatch && req.method === "POST") {
    const templates = readJson(FOOTER_TEMPLATES_FILE, []);
    templates.forEach(t => { t.isDefault = t.id === setDefaultMatch[1]; });
    writeJson(FOOTER_TEMPLATES_FILE, templates);
    return sendJson(res, 200, { ok: true });
  }

  return false;
}
