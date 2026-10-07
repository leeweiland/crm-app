import { randomUUID } from "crypto";
import { readJson, writeJson, readJsonBody, sendJson, getSessionUser, appendToJsonObjectFast, USERS_FILE } from "./auth_backend.js";
import { renderEmailBody, renderBlocksInner, applyMergeTags, tagHtmlLinksWithSource, appendSourceTag } from "./block_editor_shared.js";
import { logMessage, updateMessageStatusByProviderId, updateMessageById, MESSAGE_LOG_FILE } from "./message_log.js";
import { fireTrigger, AUTOMATIONS_FILE } from "./automations_backend.js";
import { fireWorkflowTrigger } from "./workflows_backend.js";
import { CAMPAIGNS_FILE } from "./campaigns_backend.js";
import { markContactEmailEngagement, suppressContactEmail } from "./contacts_backend.js";
import { getSesSettings, getPublicBaseUrl, getComplianceSettings } from "./integrations_backend.js";
import { resolveSendSourceSlug } from "./source_names.js";
import { setConvoMeta } from "./conversation_meta.js";
import { queueBehavioralTrigger } from "./behavioral_triggers_backend.js";
import { getBackgroundWorker } from "./background_worker_handle.js";
import { getSendWorker } from "./send_worker_handle.js";
import { getSesNotificationWorker } from "./ses_notification_worker_handle.js";
import { getContactByIdFast } from "./sqlite_inbox.js";
import { getContactById, updateContactByField } from "./contacts_db.js";
import { recordSendTiming } from "./send_timing.js";

export const FOOTER_TEMPLATES_FILE = "crm_footer_templates.json";

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

  const contact = getContactById(row.contactId);
  if (!contact) return;
  if (!contact.tags) contact.tags = [];
  if (!contact.tags.includes(block.linkAction.tagId)) {
    updateContactByField("id", contact.id, c => {
      c.tags = c.tags || [];
      if (!c.tags.includes(block.linkAction.tagId)) c.tags.push(block.linkAction.tagId);
      c.updatedAt = new Date().toISOString();
      return c;
    });
    fireTrigger("tag_added", { contactId: contact.id, tagId: block.linkAction.tagId });
    fireWorkflowTrigger("tag_added", { contactId: contact.id, tagId: block.linkAction.tagId });
  }
}

let SESv2Client, SendEmailCommand, NodeHttpHandler;
async function loadSesSdk() {
  if (SESv2Client) return;
  const mod = await import("@aws-sdk/client-sesv2");
  SESv2Client = mod.SESv2Client;
  SendEmailCommand = mod.SendEmailCommand;
  NodeHttpHandler = (await import("@smithy/node-http-handler")).NodeHttpHandler;
}

// Hard timeouts on every SES call. The SDK's default handler has NO request
// timeout -- a single hung connection to SES waits forever. Confirmed live
// (2026-10-04) on a 19k-recipient campaign: the send loop awaits each
// batch of SENDING_CONCURRENCY sends via Promise.all, so ONE hung call
// stalls the entire batch indefinitely. A hung promise never rejects, so
// nothing logged and nothing caught -- the loop just went silent every few
// minutes until the scheduler's 3-minute stuck-campaign rescue restarted
// it, giving a stall/wait/burst/stall cycle that averaged ~0.5 sends/sec
// against a 13/sec target. Failing fast turns that one hung send into a
// logged per-recipient failure (already caught per-send in
// runCampaignSendLoop) and lets the batch and loop keep moving.
//
// throwOnRequestTimeout IS REQUIRED. Read @smithy/node-http-handler's own
// set-request-timeout.js (v4.12.0, installed): without it, hitting
// requestTimeout only LOGS A WARNING and the request is left to hang --
// the timeout number alone does nothing. Confirmed this was silently
// inert for the first several hours of tonight's incident: the
// connectionTimeout below (TCP handshake) does genuinely reject on its
// own, which is why the timeout appeared to "work" in isolated testing,
// but a connection that succeeds and then stalls mid-request was never
// actually cut off. socketTimeout is a second, independent backstop (idle
// socket, no bytes either direction) -- also unset before this, also
// silent until given a value.
const SES_CONNECT_TIMEOUT_MS = 10_000;
const SES_REQUEST_TIMEOUT_MS = 30_000;
const SES_SOCKET_TIMEOUT_MS = 30_000;

// Graceful "not configured yet" path -- Lee is creating the AWS account
// separately, so every send call below degrades to a logged failure
// instead of throwing, keeping the rest of the app (composer, footer
// templates, campaign drafting) usable before those credentials land.
function sesConfigured() {
  const s = getSesSettings();
  return !!(s.accessKeyId && s.secretAccessKey && s.fromAddress);
}
// One shared client, not one per send. Previously this returned a brand-new
// SESv2Client on EVERY sendEmail() call -- a fresh connection pool and a
// full TCP+TLS handshake to AWS per email, with zero keep-alive reuse
// across the SENDING_CONCURRENCY sends in a batch or across batches.
// Confirmed live (2026-10-04): with the scheduler tick measured near-idle
// (~3s total over 3.7 minutes), a 19k-recipient campaign still took ~17s
// per batch of 12 against a ~1s design floor -- each "concurrent" send was
// paying its own cold connection setup, and the batch runs as slow as its
// slowest one. Keyed on the credential tuple + region so a change in
// Settings > SES invalidates it instead of sending from stale keys.
let _sesClient = null;
let _sesClientKey = null;
async function getSesClient() {
  const s = getSesSettings();
  if (!sesConfigured()) return null;
  await loadSesSdk();
  const region = s.region || "us-east-2";
  const key = `${region}|${s.accessKeyId}|${s.secretAccessKey}`;
  if (_sesClient && _sesClientKey === key) return _sesClient;
  _sesClient = new SESv2Client({
    region,
    credentials: { accessKeyId: s.accessKeyId, secretAccessKey: s.secretAccessKey },
    requestHandler: new NodeHttpHandler({
      connectionTimeout: SES_CONNECT_TIMEOUT_MS, requestTimeout: SES_REQUEST_TIMEOUT_MS, socketTimeout: SES_SOCKET_TIMEOUT_MS, throwOnRequestTimeout: true,
      // Read node-http-handler.js's own source directly: maxSockets
      // defaults to a hardcoded 50, and connectionTimeout's own timer (see
      // set-connection-timeout.js) starts the instant a request is made,
      // clearing only once a socket is actually assigned AND connected --
      // a request queued waiting for a free pool slot pays that same
      // timer with no real network activity happening at all. Confirmed
      // live (2026-10-04): hundreds of real failures during a 23k-send
      // campaign all carrying the exact message "the request socket did
      // not establish a connection... within the configured timeout of
      // 10000 ms" -- not a real AWS-side problem (GetAccount confirmed
      // the account HEALTHY, 11,235 of 50,000 daily quota used, nowhere
      // near any real limit) -- these were queued behind pool exhaustion,
      // not actually failing to connect. SENDING_CONCURRENCY batches run
      // continuously back-to-back during a large send, and 50 sockets is
      // tight once keep-alive connections from recent batches haven't all
      // cycled back yet.
      httpsAgent: { maxSockets: 200 },
    }),
  });
  _sesClientKey = key;
  return _sesClient;
}

// getContactByIdFast (sqlite_inbox.js) instead of the full readJson
// (CONTACTS_FILE, []).find() every other file already migrated off of --
// this was the one copy left behind. Confirmed live as a real contributor
// to the Inbox chat panel's slowness: reconstructEmailBody calls this once
// per email in a contact's history that needs its body rebuilt (see its own
// comment), so a contact with several such messages paid the full ~181MB
// stream that many times over, just to open their conversation.
export function getContact(contactId) {
  return getContactByIdFast(contactId);
}

// Campaigns/automations/workflows send the exact same block-rendered
// content to every recipient (merge tags aside) -- storing a full
// independent copy of it on each recipient's own message record
// multiplies the same bytes by however many people received it. At real
// automation volume (discussed live: 1M+ sends/month) that's ongoing,
// unbounded disk growth, not a one-time historical accident the way AC's
// import turned out to be (see ac_sync.js's own header comment for that
// story -- same root cause, different source).
//
// The actual SEND in sendEmail() below is completely unaffected by any of
// this -- `html` is built and transmitted exactly as it always was. This
// only changes what gets PERSISTED: the template (merge-tag shortcodes
// still literal, not yet expanded -- see block_editor_shared.js, that's
// what they're FOR) is cached once per sourceType+sourceId, and
// reconstructEmailBody re-expands it for one specific message on demand
// instead of a full copy being stored per recipient. Caching is
// best-effort and never allowed to affect a real send or lose a body:
// sendEmail only empties what it stores when the cache write is
// CONFIRMED to have succeeded (or already existed) -- any failure just
// falls back to storing that one recipient's full body the old way.
export const EMAIL_TEMPLATE_CACHE_FILE = "crm_email_template_cache.json";
const REPEATABLE_EMAIL_SOURCE_TYPES = new Set(["campaign", "automation_step", "workflow_step"]);
// Not a real contactId (those are UUIDs) -- stands in for "whoever ends up
// reading this" wherever resolveFooterHtml would otherwise bake one
// specific contact's unsubscribe link into the template. reconstructEmail
// Body swaps the real id back in before re-deriving that link, so the
// final output is identical to what a real per-contact render produces.
const EMAIL_TEMPLATE_SENTINEL_CID = "__EMAIL_TEMPLATE_SENTINEL__";
function emailTemplateCacheKey(sourceType, sourceId) { return `${sourceType}:${sourceId}`; }

function ensureEmailTemplateCached({ sourceType, sourceId, blocks, theme, footerTemplateId, previewText }) {
  if (!REPEATABLE_EMAIL_SOURCE_TYPES.has(sourceType) || !sourceId) return false;
  try {
    const key = emailTemplateCacheKey(sourceType, sourceId);
    if (readJson(EMAIL_TEMPLATE_CACHE_FILE, {})[key] !== undefined) return true; // already cached by an earlier recipient's send
    let html = buildPreheaderHtml(previewText) + renderEmailBody(blocks, resolveFooterHtml(footerTemplateId, EMAIL_TEMPLATE_SENTINEL_CID), theme);
    html = absolutizeUploadUrls(html, getPublicBaseUrl());
    appendToJsonObjectFast(EMAIL_TEMPLATE_CACHE_FILE, key, html);
    return true;
  } catch (e) {
    console.error("[email] template cache write failed (non-fatal, this recipient's body stores in full instead):", e.message);
    return false;
  }
}

// Recreates exactly what one specific recipient's email actually looked
// like, from the shared cached template plus that message's own stored
// fields -- the identical final transform chain sendEmail's real send
// already applies (merge tags, source-link tagging, click-tracking wrap,
// unsubscribe substitution), just run here at display time instead of at
// send time. Returns null if nothing's cached for this message's source
// (a non-repeatable source, or a row written before this existed) --
// callers fall back to message.body in that case.
export function reconstructEmailBody(message) {
  if (!message?.sourceType || !message?.sourceId) return null;
  const cached = readJson(EMAIL_TEMPLATE_CACHE_FILE, {})[emailTemplateCacheKey(message.sourceType, message.sourceId)];
  if (cached === undefined) return null;
  let html = cached.replaceAll(EMAIL_TEMPLATE_SENTINEL_CID, encodeURIComponent(message.contactId || ""));
  const contact = message.contactId ? getContact(message.contactId) : null;
  if (contact) html = applyMergeTags(html, contact);
  html = tagHtmlLinksWithSource(html, `email-${resolveSendSourceSlug(message.sourceType, message.sourceId)}`, "e");
  html = wrapLinksForClickTracking(html, message.id);
  html = html.replace(/%UNSUBSCRIBE%/gi, `${getPublicBaseUrl()}/api/email/unsubscribe?c=${encodeURIComponent(message.contactId || "")}`);
  return html;
}

export function resolveFooterHtml(footerTemplateId, contactId) {
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
// Mirrors gmail_backend.js's plainPreview -- strips tags AND decodes
// entities (not just &nbsp;/&amp;/&lt;/&gt;, since a sender's own HTML
// commonly encodes plain apostrophes/quotes as &#39;/&quot;/etc.).
function plainTextPreview(html, len) {
  return String(html || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&nbsp;/gi, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/\s+/g, " ").trim()
    .slice(0, len);
}

// Uploaded images are stored/rendered as root-relative paths ("/uploads/..")
// -- correct for the in-app editor preview (resolves against the CRM's own
// origin), but meaningless inside a sent email, which has no page origin to
// resolve against. An email client just can't load a relative image src at
// all, so it renders as a broken-image icon. Only rewrites the one path this
// app actually serves uploads from, not relative links generally (a block's
// own link field pointing at, say, "/some-page" on the marketing site is
// left alone -- that's a different domain than this CRM app's own).
export function absolutizeUploadUrls(html, baseUrl) {
  if (!baseUrl) return html;
  return html.replace(/src="\/uploads\//g, `src="${baseUrl}/uploads/`);
}

// Rewrites every real content link to route through /api/email/click first
// -- that handler marks the message row "clicked", fires email_clicked
// triggers, resolves the block's own linkAction (see block_editor_shared.js),
// and only then 302s on to the original destination. Without this, nothing
// in the rendered HTML ever pointed at that handler, so "clicked" stayed 0
// no matter what a recipient actually did.
// Skips mailto:/tel:/anchor links (nothing to click through to) and the
// %UNSUBSCRIBE% placeholder specifically -- this runs BEFORE that token is
// replaced with the real unsubscribe URL, so it's still the literal string
// at this point and would otherwise get mangled into a broken double-
// encoded link; the real unsubscribe URL is inserted after this step and
// deliberately stays a direct, unwrapped link.
function wrapLinksForClickTracking(html, rowId) {
  const base = getPublicBaseUrl();
  if (!base) return html;
  return String(html || "").replace(/href="([^"]+)"/g, (match, url) => {
    // Case-insensitive, matching the %UNSUBSCRIBE% replace's own /gi flag --
    // the footer template actually carries it lowercase.
    if (!url || /^%unsubscribe%/i.test(url) || /^(mailto:|tel:|#)/i.test(url)) return match;
    return `href="${base}/api/email/click?m=${encodeURIComponent(rowId)}&u=${encodeURIComponent(url)}"`;
  });
}

// `from` optionally overrides ses.fromAddress -- used by the Inbox so a
// reply goes out as the logged-in staff member's own address instead of the
// single shared sender every campaign/automation/booking email uses.
// Requires the sending domain (not just one address) to be SES-verified;
// SES rejects an unverified individual address the same way it already
// degrades when nothing is configured at all -- see the catch below.
// batchLog: optional array -- when passed (campaigns_backend.js's send
// loop, 2026-10-06), the row that would otherwise be logged immediately is
// pushed here instead, and the CALLER is responsible for flushing it via
// logMessagesBatch once the whole batch's sends have settled. Every other
// caller (automations, Inbox replies, AI agents, etc.) omits this and keeps
// logging immediately via logMessage, exactly as before.
export async function sendEmail({ to, subject, previewText, blocks, theme, footerTemplateId, contactId, sourceType, sourceId, from, trailingHtml, batchLog }) {
  const client = await getSesClient();
  const ses = getSesSettings();
  const contact = contactId ? getContact(contactId) : null;

  if (contact?.emailOptOut) {
    return { ok: false, reason: "opted_out" };
  }

  // Minted before the send (not left to logMessage) so it can be baked into
  // the click-tracking redirect below -- /api/email/click looks a click back
  // up by this exact id via MESSAGE_ID_INDEX_FILE.
  const rowId = randomUUID();

  let html = buildPreheaderHtml(previewText) + renderEmailBody(blocks, resolveFooterHtml(footerTemplateId, contactId), theme);
  html = absolutizeUploadUrls(html, getPublicBaseUrl());
  if (contact) html = applyMergeTags(html, contact);
  // Tagged before logging, so the stored body matches exactly what the
  // recipient received (same convention sms_backend.js's sendSms() uses).
  // "e=email-<slug>" resolved from THIS send's own sourceType/sourceId
  // (source_names.js) -- its own dedicated param, distinct from the el=
  // convention ads/social/YouTube links are hand-tagged with, so email
  // traffic can be filtered/reported on separately from everything else.
  html = tagHtmlLinksWithSource(html, `email-${resolveSendSourceSlug(sourceType, sourceId)}`, "e");
  // Every link now routes through /api/email/click first (real click
  // tracking -- the "clicked" stat was always 0 before this, since nothing
  // ever generated a link pointing there) -- done BEFORE the %UNSUBSCRIBE%
  // substitution below so the unsubscribe link itself is skipped and stays
  // a direct link to /api/email/unsubscribe, not routed through a second
  // redirect on top of the first.
  html = wrapLinksForClickTracking(html, rowId);
  // %UNSUBSCRIBE% resolves the same URL the footer's own auto-generated
  // unsubscribe link uses (see resolveFooterHtml above) -- always, not just
  // when a real contactId exists. That link already handles no contactId
  // gracefully (an empty c= param, /api/email/unsubscribe just won't find
  // a matching contact to opt out), so test sends get a working, clickable
  // link too instead of the literal, non-functional string "%unsubscribe%".
  html = html.replace(/%UNSUBSCRIBE%/gi, `${getPublicBaseUrl()}/api/email/unsubscribe?c=${encodeURIComponent(contactId || "")}`);
  // Appended after the footer, not folded into `blocks` by the caller (see
  // inbox_backend.js's Reply handling) -- a quoted older message shouldn't
  // be click-tracking-wrapped or %UNSUBSCRIBE%-substituted like the caller's
  // own new content, and the footer belongs right after that new content,
  // not after the whole quoted thread underneath it.
  if (trailingHtml) html += trailingHtml;
  const renderedSubject = contact ? applyMergeTags(subject, contact) : subject;
  const fromAddress = from || ses.fromAddress;

  // Stripped and entity-decoded now, not a raw HTML slice -- the inbox
  // reply path's own text block can carry a literal &#39; etc. (see
  // gmail_backend.js's plainPreview, fixed for the same reason), and a raw
  // slice also risked truncating mid-tag for anything with real markup.
  const bodyPreview = plainTextPreview((blocks || []).find(b => b.type === "text")?.html || "", 140);
  // Only ever empties the stored body when the shared template is
  // CONFIRMED cached (see ensureEmailTemplateCached's own comment) --
  // `html` itself (what's actually transmitted below) is never touched.
  const storedBody = ensureEmailTemplateCached({ sourceType, sourceId, blocks, theme, footerTemplateId, previewText }) ? "" : html;
  const baseRow = {
    id: rowId,
    channel: "email", direction: "outbound", contactId, sourceType, sourceId,
    to, from: fromAddress || null, subject: renderedSubject, body: storedBody, bodyPreview,
  };

  if (!client) {
    if (batchLog) batchLog.push({ ...baseRow, status: "failed" });
    else logMessage({ ...baseRow, status: "failed" });
    return { ok: false, reason: "ses_not_configured" };
  }

  const _t0 = Date.now();
  try {
    const cmd = new SendEmailCommand({
      FromEmailAddress: fromAddress,
      Destination: { ToAddresses: [to] },
      Content: { Simple: { Subject: { Data: renderedSubject }, Body: { Html: { Data: html } } } },
      ...(ses.configurationSet ? { ConfigurationSetName: ses.configurationSet } : {}),
    });
    const result = await client.send(cmd);
    // $metadata.attempts/totalRetryDelay come straight from the AWS SDK's
    // own retry middleware -- the only way to see whether THIS call got
    // silently throttled-and-retried internally (see send_timing.js).
    recordSendTiming({ channel: "email", ok: true, durationMs: Date.now() - _t0, attempts: result.$metadata?.attempts ?? null, retryDelayMs: result.$metadata?.totalRetryDelay ?? null, sourceType, sourceId });
    // Logged once with the FINAL status/providerMessageId already known,
    // rather than logging a placeholder row first and patching it after --
    // that follow-up patch used to mean a full pass over the whole message
    // log to find our own row again by id, which at 12GB+ hung every send
    // for 30-100+ seconds. One log call per send, either way it ends up,
    // still guarantees a row exists even when the send fails.
    if (batchLog) batchLog.push({ ...baseRow, status: "sent", providerMessageId: result.MessageId });
    else logMessage({ ...baseRow, status: "sent", providerMessageId: result.MessageId });
    return { ok: true, messageId: result.MessageId };
  } catch (e) {
    recordSendTiming({ channel: "email", ok: false, durationMs: Date.now() - _t0, attempts: e.$metadata?.attempts ?? null, retryDelayMs: e.$metadata?.totalRetryDelay ?? null, error: e.message, sourceType, sourceId });
    // failReason stored, same as sms_backend.js's sendSms -- previously the
    // SES error was returned to the caller and dropped on the floor there,
    // so a failed email was undiagnosable after the fact. Confirmed live
    // (2026-10-04): 23 failed sends with no recorded cause anywhere.
    if (batchLog) batchLog.push({ ...baseRow, status: "failed", failReason: e.message });
    else logMessage({ ...baseRow, status: "failed", failReason: e.message });
    return { ok: false, reason: e.message };
  }
}

// Split out of the webhook handler so background_worker.js can run the
// exact same processing from a postMessage instead of the main thread (see
// BACKGROUND_WORKER in server.js) -- same function either way, just which
// thread calls it changes. Takes the raw (still-JSON-string) SNS Message
// field, same shape both callers have it in.
export function processSesNotificationMessage(raw) {
  try {
    const msg = JSON.parse(raw);
    const providerMessageId = msg.mail?.messageId;
    const eventType = msg.eventType || msg.notificationType;
    const statusMap = { Delivery: "delivered", Open: "opened", Click: "clicked", Bounce: "bounced", Complaint: "complained" };
    if (providerMessageId && statusMap[eventType]) {
      const row = updateMessageStatusByProviderId(providerMessageId, statusMap[eventType]);
      // Skip the whole block (contact write + both trigger systems) when
      // THIS SPECIFIC MESSAGE was already marked opened/clicked before this
      // call -- confirmed live (2026-10-04) as a major, previously-unnoticed
      // cost: email clients send repeat Open pings for one human open
      // (Apple Mail's privacy proxy famously pre-fetches every image,
      // including tracking pixels, on receipt, independent of whether
      // anyone reads the email), so most of a large campaign's Open-event
      // volume is pure duplicates for the same send. Each one still paid
      // markContactEmailEngagement's full streaming copy of
      // crm_contacts.json (194MB, under the same cross-thread file lock the
      // send loop also needs) AND re-fired both trigger systems AND
      // re-queued a behavioral trigger, all for a value that was not going
      // to change.
      // Scoped to THIS message's own statusHistory, not
      // contact.emailEngagement (which is a lifetime, contact-level flag,
      // not per-send) -- a contact's FIRST open of a brand new campaign
      // must still fire every time, even though they opened some other
      // email months ago. statusHistory already gets an entry pushed on
      // every call, duplicate or not (see updateMessageStatusByProviderId),
      // so a 2nd+ entry of the same status on THIS row is the correct,
      // precise signal that this exact notification is a repeat.
      const isRepeatForThisMessage = row?.statusHistory?.filter(h => h.status === statusMap[eventType]).length > 1;
      if (row?.contactId && statusMap[eventType] === "opened" && !isRepeatForThisMessage) { markContactEmailEngagement(row.contactId, "opened"); fireTrigger("email_opened", { contactId: row.contactId }); fireWorkflowTrigger("email_opened", { contactId: row.contactId }); queueBehavioralTrigger({ contactId: row.contactId, source: "email_open", context: {} }); }
      if (row?.contactId && statusMap[eventType] === "clicked" && !isRepeatForThisMessage) { markContactEmailEngagement(row.contactId, "clicked"); fireTrigger("email_clicked", { contactId: row.contactId }); fireWorkflowTrigger("email_clicked", { contactId: row.contactId }); queueBehavioralTrigger({ contactId: row.contactId, source: "email_click", context: {} }); }
      if (row?.contactId && (statusMap[eventType] === "bounced" || statusMap[eventType] === "complained") && getComplianceSettings().autoOptOutOnBounceComplaint) suppressContactEmail(row.contactId, statusMap[eventType]);
    }
  } catch (e) { console.error("[SES webhook] parse failed", e.message); }
}

// Aborts and destroys the connection the instant the body exceeds
// maxBytes, instead of readJsonBody's unconditional accumulate-everything
// -- see the /api/webhooks/ses handler below for why this exists. Returns
// the parsed object, or null if the body was oversized or unparseable.
function readJsonBodyCapped(req, maxBytes) {
  return new Promise((resolve) => {
    let body = "";
    let bytes = 0;
    let done = false;
    req.on("data", (d) => {
      if (done) return;
      bytes += d.length;
      if (bytes > maxBytes) {
        done = true;
        req.destroy();
        resolve(null);
        return;
      }
      body += d;
    });
    req.on("end", () => {
      if (done) return;
      done = true;
      try { resolve(JSON.parse(body || "{}")); } catch { resolve(null); }
    });
    req.on("error", () => { if (!done) { done = true; resolve(null); } });
  });
}

export async function handleEmailRequest(req, res, url) {
  const p = url.pathname;

  // ── Public routes (no auth) -- SES itself and a recipient's own browser
  // hit these directly, they can't carry a session cookie. ─────────────
  if (p === "/api/webhooks/ses" && req.method === "POST") {
    // Size-capped, not the shared readJsonBody -- confirmed live a flood of
    // these requests carried a body 5.7+ MILLION characters long (a real
    // single SES notification envelope is a few KB at most), and buffering
    // + JSON.parse-ing a string that size, repeatedly, on the MAIN thread
    // pinned the whole event loop hard enough that even a static file
    // request took 13+ seconds. Whatever's producing an oversized body
    // here (SNS retry storm, a malformed delivery, request smuggling under
    // load -- still unconfirmed), the fix that matters right now is never
    // buffering past a sane size: destroy the connection instead of
    // reading further, so this can never choke the main thread again
    // regardless of the root cause.
    const body = await readJsonBodyCapped(req, 256 * 1024);
    if (body === null) { res.writeHead(413).end(); return true; }
    // SNS subscription confirmation handshake -- one-time, required before
    // SNS will actually start delivering real notifications.
    if (body.Type === "SubscriptionConfirmation" && body.SubscribeURL) {
      try { await fetch(body.SubscribeURL); } catch {}
      return sendJson(res, 200, { ok: true });
    }
    if (body.Type === "Notification") {
      // PAUSE_SES_NOTIFICATIONS (2026-10-07) -- this direct path was
      // missed entirely the first time this got paused tonight: SES has
      // TWO parallel SNS subscriptions (this route, and the
      // webhook-receiver's separately-queued relay copy -- see the
      // routing comment below), and only the relay side had a pause
      // switch. This route has no durable queue of its own (unlike the
      // relay's Postgres-backed one), so there's nothing to hold these in
      // while paused -- Delivery/Open/Click are acknowledged and dropped
      // outright for the duration (real, disclosed data loss, not a
      // delay), while Bounce/Complaint still process normally since
      // they're rare and compliance-relevant, never the volume driver.
      // Parsed once, reused for both the pause check and the sourceType
      // routing lookup below -- was two separate JSON.parse calls before
      // the routing split, no reason to pay for it twice.
      let parsedMessage = null;
      try { parsedMessage = JSON.parse(body.Message); } catch {}
      let skip = false;
      if (process.env.PAUSE_SES_NOTIFICATIONS === "1") {
        skip = parsedMessage?.eventType !== "Bounce" && parsedMessage?.eventType !== "Complaint";
      }
      if (!skip) {
        // REVERTED same day (2026-10-07) -- the sourceType classification
        // here read crm_provider_id_index.json (20MB+, written on nearly
        // every send) through getProviderIndexCached's mtime-based cache
        // on every single request, ON THE MAIN THREAD -- confirmed live
        // as a serious regression, stalling requests 90+ seconds. See
        // webhook_relay_backend.js's own revert comment for the full
        // explanation. Reverted to the plain fallback chain.
        const worker = getSesNotificationWorker() || getSendWorker() || getBackgroundWorker();
        if (worker) worker.postMessage({ type: "ses_notification", raw: body.Message });
        else processSesNotificationMessage(body.Message);
      }
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
        if (row.contactId) { fireTrigger("email_clicked", { contactId: row.contactId }); fireWorkflowTrigger("email_clicked", { contactId: row.contactId }); queueBehavioralTrigger({ contactId: row.contactId, source: "email_click", context: {} }); }
        if (dest) executeLinkClickAction(row, dest);
      }
    }
    // Tagged with "e=email-<slug>" resolved from THIS message's own
    // sourceType/sourceId (see source_names.js) rather than a static
    // setting, so the value always names whichever campaign/automation
    // actually sent it. Own dedicated param (not el=) -- see
    // tagHtmlLinksWithSource's own comment above.
    const elValue = row ? `email-${resolveSendSourceSlug(row.sourceType, row.sourceId)}` : null;
    let taggedDest = dest ? appendSourceTag(dest, elValue, "e") : dest;
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
    const contact = getContactById(contactId);
    if (contact) {
      // Only emailOptOut -- never contact.status. Same reasoning as
      // recheckStopStatus (compliance_backend.js): a genuinely ENROLLED or
      // BOOKED contact clicking an unsubscribe link must stop receiving
      // marketing email without their real pipeline stage being erased.
      updateContactByField("id", contact.id, c => {
        c.emailOptOut = true; c.updatedAt = new Date().toISOString();
        return c;
      });
      setConvoMeta(contact.id, { archived: true });
    }
    // Settings > Opt Out's "Unsubscribe Redirect" -- "" (the default) falls
    // back to this CRM's own plain confirmation page below instead of
    // sending them anywhere.
    const redirectUrl = getComplianceSettings().unsubscribeRedirectUrl;
    if (redirectUrl) {
      res.writeHead(302, { Location: redirectUrl });
      res.end();
      return true;
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
    const { name, blocks, theme, unsubscribeLinkText, physicalAddress, socialLinks, ownerUserId } = await readJsonBody(req);
    if (!name) return sendJson(res, 400, { error: "name is required" });
    const templates = readJson(FOOTER_TEMPLATES_FILE, []);
    const template = {
      id: randomUUID(), name, blocks: blocks || [], theme: theme || {}, unsubscribeLinkText: unsubscribeLinkText || "Unsubscribe",
      physicalAddress: physicalAddress || "", socialLinks: socialLinks || [], ownerUserId: ownerUserId || null,
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
      if (!template) return sendJson(res, 404, { error: "Not found" });
      const activeFor = readJson(USERS_FILE, []).find(u => u.footerTemplateId === footerMatch[1]);
      if (activeFor) return sendJson(res, 400, { error: `${activeFor.first} ${activeFor.last} is currently using this as their active footer -- switch them to a different one first.` });
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
