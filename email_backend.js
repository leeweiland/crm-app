import { randomUUID } from "crypto";
import { readJson, writeJson, readJsonBody, sendJson, getSessionUser } from "./auth_backend.js";
import { renderEmailBody, renderBlocksInner, applyMergeTags, tagHtmlLinksWithSource, appendSourceTag } from "./block_editor_shared.js";
import { logMessage, updateMessageStatusByProviderId, updateMessageById, MESSAGE_LOG_FILE } from "./message_log.js";
import { fireTrigger, AUTOMATIONS_FILE } from "./automations_backend.js";
import { fireWorkflowTrigger } from "./workflows_backend.js";
import { CAMPAIGNS_FILE } from "./campaigns_backend.js";
import { markContactEmailEngagement } from "./contacts_backend.js";
import { getSesSettings, getPublicBaseUrl } from "./integrations_backend.js";
import { resolveSendSourceSlug } from "./source_names.js";
import { setConvoMeta } from "./conversation_meta.js";

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
  const s = getSesSettings();
  return !!(s.accessKeyId && s.secretAccessKey && s.fromAddress);
}
async function getSesClient() {
  const s = getSesSettings();
  if (!sesConfigured()) return null;
  await loadSesSdk();
  return new SESv2Client({
    region: s.region || "us-east-2",
    credentials: { accessKeyId: s.accessKeyId, secretAccessKey: s.secretAccessKey },
  });
}

function getContact(contactId) {
  return readJson(CONTACTS_FILE, []).find(c => c.id === contactId) || null;
}

function resolveFooterHtml(footerTemplateId, contactId) {
  const templates = readJson(FOOTER_TEMPLATES_FILE, []);
  const footer = templates.find(f => f.id === footerTemplateId) || templates.find(f => f.isDefault) || null;
  if (!footer) return "";
  const unsubscribeUrl = `${getPublicBaseUrl()}/api/email/unsubscribe?c=${encodeURIComponent(contactId || "")}`;
  const social = (footer.socialLinks || []).map(s => `<a href="${s.url}" style="margin:0 6px;color:#888">${s.platform}</a>`).join("");
  // footer.blocks is the current (BlockEditor) format; footer.html is a
  // fallback for footers created before the editor conversion. Uses
  // renderBlocksInner (not renderBlocksToHtml) -- the latter wraps its
  // output in its own full canvas div (background + 24px padding + a
  // max-width container), which was stacking a second nested copy of that
  // wrapper inside this one, on top of the body's own. Also dropped the
  // forced text-align:center/border-top this div used to carry -- footer
  // blocks now render with exactly the alignment/spacing set in the editor,
  // not overridden by an assumption that footers are short centered text.
  const content = (footer.blocks && footer.blocks.length) ? renderBlocksInner(footer.blocks) : (footer.html || "");
  // font-size/color used to live on the OUTER div here, so it inherited
  // down into the footer's own blocks too -- "Blessings! / Coach Lee" etc.
  // rendering small and gray in the actual email despite looking normal in
  // the editor, which never had that ancestor. Scoped to just the
  // auto-generated address/social/unsubscribe lines below, which are the
  // only part that was ever meant to look like small print.
  // Auto-appending this bottom unsubscribe line unconditionally meant a
  // footer whose own content already has one (typed directly, usually via
  // the %UNSUBSCRIBE% merge tag -- still literal at this point, resolved
  // later) ended up with two. Only added as a fallback when the content
  // doesn't already have its own.
  const hasOwnUnsubscribe = /%unsubscribe%/i.test(content) || content.includes("/api/email/unsubscribe");
  return `
    <div style="margin-top:24px">
      ${content}
      ${footer.physicalAddress ? `<div style="margin-top:8px;font-size:11px;color:#888">${footer.physicalAddress}</div>` : ""}
      ${social ? `<div style="margin-top:8px;font-size:11px;color:#888">${social}</div>` : ""}
      ${hasOwnUnsubscribe ? "" : `<div style="margin-top:8px;font-size:11px;color:#888"><a href="${unsubscribeUrl}" style="color:#888">${footer.unsubscribeLinkText || "Unsubscribe"}</a></div>`}
    </div>`;
}

// Shared send primitive -- imported directly (function call, not HTTP) by
// campaigns_backend.js now and automations_backend.js in Phase 3, matching
// chat-app's convention of small reusable async helpers rather than a
// service-to-service HTTP layer.
// The inbox-list snippet next to the subject line -- without this, most
// clients fall back to showing the first visible text in the body (often
// "%FIRSTNAME%" or a stray leading space). Hidden in the rendered email
// itself; padded with invisible filler characters so real body text can't
// leak into the reserved preview space once the actual preview text ends.
function buildPreheaderHtml(previewText) {
  if (!previewText) return "";
  const padding = "&#8199;&zwnj;".repeat(120);
  // Typing the literal entity "&zwnj;" is a shorthand for "no visible
  // preview at all" -- render the actual zero-width character instead of
  // escaping it to literal on-screen text, so inbox list snippets show
  // nothing next to the subject rather than the string "&zwnj;".
  const content = previewText.trim() === "&zwnj;" ? "&zwnj;" : escapeHtml(previewText);
  return `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:#fff;opacity:0">${content}${padding}</div>`;
}
function escapeHtml(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Uploaded images are stored/rendered as root-relative paths ("/uploads/..")
// -- correct for the in-app editor preview (resolves against the CRM's own
// origin), but meaningless inside a sent email, which has no page origin to
// resolve against. An email client just can't load a relative image src at
// all, so it renders as a broken-image icon. Only rewrites the one path this
// app actually serves uploads from, not relative links generally (a block's
// own link field pointing at, say, "/some-page" on the marketing site is
// left alone -- that's a different domain than this CRM app's own).
function absolutizeUploadUrls(html, baseUrl) {
  if (!baseUrl) return html;
  return html.replace(/src="\/uploads\//g, `src="${baseUrl}/uploads/`);
}

// `from` optionally overrides ses.fromAddress -- used by the Inbox so a
// reply goes out as the logged-in staff member's own address instead of the
// single shared sender every campaign/automation/booking email uses.
// Requires the sending domain (not just one address) to be SES-verified;
// SES rejects an unverified individual address the same way it already
// degrades when nothing is configured at all -- see the catch below.
export async function sendEmail({ to, subject, previewText, blocks, theme, footerTemplateId, contactId, sourceType, sourceId, from }) {
  const client = await getSesClient();
  const ses = getSesSettings();
  const contact = contactId ? getContact(contactId) : null;

  if (contact?.emailOptOut) {
    return { ok: false, reason: "opted_out" };
  }

  let html = buildPreheaderHtml(previewText) + renderEmailBody(blocks, resolveFooterHtml(footerTemplateId, contactId), theme);
  html = absolutizeUploadUrls(html, getPublicBaseUrl());
  if (contact) html = applyMergeTags(html, contact);
  // %UNSUBSCRIBE% resolves the same URL the footer's own auto-generated
  // unsubscribe link uses (see resolveFooterHtml above) -- always, not just
  // when a real contactId exists. That link already handles no contactId
  // gracefully (an empty c= param, /api/email/unsubscribe just won't find
  // a matching contact to opt out), so test sends get a working, clickable
  // link too instead of the literal, non-functional string "%unsubscribe%".
  html = html.replace(/%UNSUBSCRIBE%/gi, `${getPublicBaseUrl()}/api/email/unsubscribe?c=${encodeURIComponent(contactId || "")}`);
  // Tagged before logging, so the stored body matches exactly what the
  // recipient received (same convention sms_backend.js's sendSms() uses).
  // "el=email-<slug>" resolved from THIS send's own sourceType/sourceId
  // (source_names.js), matching the el= convention already used on ads,
  // social, and YouTube links -- links stay real, direct, recognizable
  // URLs, not routed through a redirect on this CRM's own domain.
  html = tagHtmlLinksWithSource(html, `email-${resolveSendSourceSlug(sourceType, sourceId)}`);
  const renderedSubject = contact ? applyMergeTags(subject, contact) : subject;
  const fromAddress = from || ses.fromAddress;

  const bodyPreview = (blocks || []).find(b => b.type === "text")?.html?.slice(0, 140) || "";
  const baseRow = {
    channel: "email", direction: "outbound", contactId, sourceType, sourceId,
    to, from: fromAddress || null, subject: renderedSubject, body: html, bodyPreview,
  };

  if (!client) {
    logMessage({ ...baseRow, status: "failed" });
    return { ok: false, reason: "ses_not_configured" };
  }

  try {
    const cmd = new SendEmailCommand({
      FromEmailAddress: fromAddress,
      Destination: { ToAddresses: [to] },
      Content: { Simple: { Subject: { Data: renderedSubject }, Body: { Html: { Data: html } } } },
      ...(ses.configurationSet ? { ConfigurationSetName: ses.configurationSet } : {}),
    });
    const result = await client.send(cmd);
    // Logged once with the FINAL status/providerMessageId already known,
    // rather than logging a placeholder row first and patching it after --
    // that follow-up patch used to mean a full pass over the whole message
    // log to find our own row again by id, which at 12GB+ hung every send
    // for 30-100+ seconds. One log call per send, either way it ends up,
    // still guarantees a row exists even when the send fails.
    logMessage({ ...baseRow, status: "sent", providerMessageId: result.MessageId });
    return { ok: true, messageId: result.MessageId };
  } catch (e) {
    logMessage({ ...baseRow, status: "failed" });
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
          if (row?.contactId && statusMap[eventType] === "opened") { markContactEmailEngagement(row.contactId, "opened"); fireTrigger("email_opened", { contactId: row.contactId }); fireWorkflowTrigger("email_opened", { contactId: row.contactId }); }
          if (row?.contactId && statusMap[eventType] === "clicked") { markContactEmailEngagement(row.contactId, "clicked"); fireTrigger("email_clicked", { contactId: row.contactId }); fireWorkflowTrigger("email_clicked", { contactId: row.contactId }); }
        }
      } catch (e) { console.error("[SES webhook] parse failed", e.message); }
    }
    return sendJson(res, 200, { ok: true });
  }

  if (p === "/api/email/click" && req.method === "GET") {
    const messageLogId = url.searchParams.get("m");
    const dest = url.searchParams.get("u");
    let row = null;
    if (messageLogId) {
      // O(1) via MESSAGE_ID_INDEX_FILE -- was a full readJson+writeJson of
      // the whole message log on every single click, the exact class of bug
      // that filled the disk and hung the server on 2026-08-29 (see
      // message_log.js). Every real click was paying that cost.
      row = updateMessageById(messageLogId, { status: "clicked" });
      if (row) {
        if (row.contactId) { fireTrigger("email_clicked", { contactId: row.contactId }); fireWorkflowTrigger("email_clicked", { contactId: row.contactId }); }
        if (dest) executeLinkClickAction(row, dest);
      }
    }
    // Tagged with "el=email-<slug>" resolved from THIS message's own
    // sourceType/sourceId (see source_names.js) rather than a static
    // setting, so the value always names whichever campaign/automation
    // actually sent it.
    const elValue = row ? `email-${resolveSendSourceSlug(row.sourceType, row.sourceId)}` : null;
    let taggedDest = dest ? appendSourceTag(dest, elValue) : dest;
    // Identifies this browser for page-visit tracking (tracking_backend.js's
    // /track.js snippet, embedded on the Framer site) -- passed as a query
    // param on the DESTINATION url rather than (or in addition to) a
    // Set-Cookie header here, because this response is from the CRM's own
    // origin and the Framer site is a different origin entirely; a cookie
    // set here would never be visible to document.cookie once the browser
    // lands on the Framer page. track.js (running ON that page) reads this
    // param and sets the cookie itself. 30 days, matching the click-
    // tracking window a marketer would actually care about.
    if (row?.contactId && taggedDest) {
      try {
        const u = new URL(taggedDest);
        u.searchParams.set("crm_cid", row.contactId);
        taggedDest = u.toString();
      } catch {
        taggedDest += `${taggedDest.includes("?") ? "&" : "?"}crm_cid=${encodeURIComponent(row.contactId)}`;
      }
    }
    res.writeHead(302, { Location: taggedDest || "/" });
    res.end();
    return true;
  }

  if (p === "/api/email/unsubscribe" && req.method === "GET") {
    const contactId = url.searchParams.get("c");
    const contacts = readJson(CONTACTS_FILE, []);
    const contact = contacts.find(c => c.id === contactId);
    if (contact) {
      // Only emailOptOut -- never contact.status. Same reasoning as
      // recheckStopStatus (compliance_backend.js): a genuinely ENROLLED or
      // BOOKED contact clicking an unsubscribe link must stop receiving
      // marketing email without their real pipeline stage being erased.
      contact.emailOptOut = true; contact.updatedAt = new Date().toISOString();
      writeJson(CONTACTS_FILE, contacts);
      setConvoMeta(contact.id, { archived: true });
    }
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
    const { to, subject, previewText, blocks, theme, footerTemplateId } = await readJsonBody(req);
    if (!to || !subject) return sendJson(res, 400, { error: "to and subject are required" });
    const result = await sendEmail({ to, subject, previewText, blocks: blocks || [], theme, footerTemplateId, contactId: null, sourceType: "manual", sourceId: null });
    if (!result.ok) return sendJson(res, 400, { error: result.reason === "ses_not_configured" ? "Amazon SES isn't configured yet -- add AWS credentials to .env first." : result.reason });
    return sendJson(res, 200, { ok: true });
  }

  if (p === "/api/footer-templates" && req.method === "GET") {
    return sendJson(res, 200, { templates: readJson(FOOTER_TEMPLATES_FILE, []) });
  }
  if (p === "/api/footer-templates" && req.method === "POST") {
    const { name, blocks, theme, unsubscribeLinkText, physicalAddress, socialLinks } = await readJsonBody(req);
    if (!name) return sendJson(res, 400, { error: "name is required" });
    const templates = readJson(FOOTER_TEMPLATES_FILE, []);
    const template = {
      id: randomUUID(), name, blocks: blocks || [], theme: theme || {}, unsubscribeLinkText: unsubscribeLinkText || "Unsubscribe",
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
      for (const k of ["name", "blocks", "theme", "unsubscribeLinkText", "physicalAddress", "socialLinks"]) if (k in body) template[k] = body[k];
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
