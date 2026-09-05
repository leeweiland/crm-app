import { randomUUID } from "crypto";
import twilio from "twilio";
import { readJson, writeJson, readJsonBody, sendJson, getSessionUser } from "./auth_backend.js";
import { CONTACTS_FILE } from "./segments_shared.js";
import { logMessage, updateMessageStatusByProviderId } from "./message_log.js";
import { checkConversionGoal } from "./workflows_backend.js";
import { getTwilioSettings, getPublicBaseUrl } from "./integrations_backend.js";
import { recheckStopStatus, checkAutoTriggers } from "./compliance_backend.js";
import { appendSourceTagToSmsBody } from "./block_editor_shared.js";
import { resolveSendSourceSlug } from "./source_names.js";

export const SMS_TEMPLATES_FILE = "crm_sms_templates.json";

function twilioConfigured() {
  const t = getTwilioSettings();
  return !!(t.accountSid && t.authToken && t.fromNumber);
}
function getTwilioClient() {
  const t = getTwilioSettings();
  if (!twilioConfigured()) return null;
  return twilio(t.accountSid, t.authToken);
}

// Contact phone numbers in this CRM are stored in whatever format they
// arrived in (bulk imports, manual entry, form submits) -- confirmed live,
// ~68% of contacts have no "+" prefix at all. Twilio requires E.164
// ("to" must start with "+" and a country code) and rejects anything else
// outright, so an unformatted number failed every time regardless of
// whether the number itself was actually valid/reachable. Assumes NANP
// (+1) for bare 10-digit numbers and 11-digit numbers already starting
// with "1" -- matching the same US-centric assumption findContactByPhone
// below already makes when matching by last-10-digits. A number that's
// already "+"-prefixed is trusted as-is and passed through untouched.
export function normalizePhoneToE164(phone) {
  const raw = String(phone || "").trim();
  if (raw.startsWith("+")) return raw;
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return "+1" + digits;
  if (digits.length === 11 && digits.startsWith("1")) return "+" + digits;
  return digits ? "+" + digits : raw;
}

function getContact(id) { return readJson(CONTACTS_FILE, []).find(c => c.id === id) || null; }
function findContactByPhone(phone) {
  const digits = String(phone || "").replace(/\D/g, "").slice(-10);
  return readJson(CONTACTS_FILE, []).find(c =>
    String(c.phone || "").replace(/\D/g, "").slice(-10) === digits ||
    (c.altPhones || []).some(p => String(p || "").replace(/\D/g, "").slice(-10) === digits) ||
    (c.hyrosPhones || []).some(p => String(p || "").replace(/\D/g, "").slice(-10) === digits)
  ) || null;
}

// Shared send primitive, same shape/convention as email_backend.js's
// sendEmail() -- imported directly by workflows_backend.js and (later)
// automations_backend.js's future SMS step, not called over HTTP.
export async function sendSms({ to, body, contactId, sourceType, sourceId }) {
  const contact = contactId ? getContact(contactId) : null;
  if (contact?.smsOptOut) return { ok: false, reason: "opted_out" };

  const client = getTwilioClient();
  const twilioSettings = getTwilioSettings();
  // Tagged before both logging and sending, so the stored body matches
  // exactly what the recipient received (same convention email_backend.js
  // uses). "el=sms-<slug>" resolved from THIS send's own sourceType/sourceId
  // (source_names.js), matching the el= convention already used everywhere
  // else -- links stay real, direct, recognizable URLs.
  const taggedBody = appendSourceTagToSmsBody(body, `sms-${resolveSendSourceSlug(sourceType, sourceId)}`);
  const toFormatted = normalizePhoneToE164(to);
  const baseRow = {
    channel: "sms", direction: "outbound", contactId, sourceType, sourceId,
    to: toFormatted, from: twilioSettings.fromNumber || null, body: taggedBody || "", bodyPreview: (taggedBody || "").slice(0, 140),
  };

  if (!client) { logMessage({ ...baseRow, status: "failed", failReason: "twilio_not_configured" }); return { ok: false, reason: "twilio_not_configured" }; }

  try {
    // Without this, Twilio has no per-message destination for delivery
    // status -- /api/webhooks/twilio/status exists and is fully wired
    // (see below), but was never actually being told about, so every
    // outbound SMS sat at "queued" forever in our own records no matter
    // what actually happened on the wire.
    const msg = await client.messages.create({
      to: toFormatted, from: twilioSettings.fromNumber, body: taggedBody,
      statusCallback: `${getPublicBaseUrl()}/api/webhooks/twilio/status`,
    });
    // Logged once with the final status/sid already known, same reasoning
    // as email_backend.js's sendEmail -- see message_log.js's comment.
    logMessage({ ...baseRow, status: msg.status || "sent", providerMessageId: msg.sid });
    return { ok: true, sid: msg.sid };
  } catch (e) {
    // e.message from Twilio's SDK already includes their error code/text
    // (e.g. "The 'To' number ... is not a valid phone number." or a geo-
    // permissions message for international sends) -- stored now instead
    // of discarded, so a failure is diagnosable from the log alone.
    logMessage({ ...baseRow, status: "failed", failReason: e.message });
    return { ok: false, reason: e.message };
  }
}

function readRawBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", d => body += d);
    req.on("end", () => resolve(body));
  });
}

export async function handleSmsRequest(req, res, url) {
  const p = url.pathname;

  // ── Public: Twilio hits these directly, no session cookie possible.
  // Every payload is signature-validated before anything else happens --
  // this endpoint is unauthenticated by design (Twilio calls it), so
  // signature validation is the only thing standing between it and a
  // spoofed inbound message. ─────────────────────────────────────────
  if (p === "/api/webhooks/twilio/inbound" && req.method === "POST") {
    const raw = await readRawBody(req);
    const params = Object.fromEntries(new URLSearchParams(raw));
    const signature = req.headers["x-twilio-signature"];
    const fullUrl = (process.env.PUBLIC_BASE_URL || "") + p;
    const twilioSettings = getTwilioSettings();
    if (twilioConfigured() && !twilio.validateRequest(twilioSettings.authToken, signature, fullUrl, params)) {
      res.writeHead(403); res.end(); return true;
    }
    const from = params.From, body = params.Body || "";
    const contact = findContactByPhone(from);
    if (contact) {
      // AI Assist drafts are generated on demand (when a human opens this
      // contact's conversation in the Inbox), not reactively here -- see
      // ai_agents_backend.js's maybeGenerateAiAssistDraft.
      logMessage({ channel: "sms", direction: "inbound", contactId: contact.id, sourceType: "inbound", sourceId: null, to: twilioSettings.fromNumber || null, from, body, bodyPreview: body.slice(0, 140), status: "received" });
      checkConversionGoal("incoming_sms", contact.id);
      recheckStopStatus(contact.id);
      checkAutoTriggers(contact.id);
    } else {
      // Message from a number with no matching contact -- still logged
      // (contactId: null) so it's visible in the Inbox, just unattributed.
      logMessage({ channel: "sms", direction: "inbound", contactId: null, sourceType: "inbound", sourceId: null, to: twilioSettings.fromNumber || null, from, body, bodyPreview: body.slice(0, 140), status: "received" });
    }
    res.writeHead(200, { "Content-Type": "text/xml" });
    res.end("<Response></Response>"); // empty TwiML -- no auto-reply
    return true;
  }

  if (p === "/api/webhooks/twilio/status" && req.method === "POST") {
    const raw = await readRawBody(req);
    const params = Object.fromEntries(new URLSearchParams(raw));
    const signature = req.headers["x-twilio-signature"];
    const fullUrl = (process.env.PUBLIC_BASE_URL || "") + p;
    if (twilioConfigured() && !twilio.validateRequest(getTwilioSettings().authToken, signature, fullUrl, params)) {
      res.writeHead(403); res.end(); return true;
    }
    const statusMap = { queued: "queued", sent: "sent", delivered: "delivered", undelivered: "failed", failed: "failed" };
    if (params.MessageSid && statusMap[params.MessageStatus]) {
      updateMessageStatusByProviderId(params.MessageSid, statusMap[params.MessageStatus]);
    }
    return sendJson(res, 200, { ok: true });
  }

  // ── Everything else requires a logged-in user ───────────────────────
  const owned = p.startsWith("/api/sms-templates") || p.startsWith("/api/sms/");
  if (!owned) return false;
  const me = getSessionUser(req);
  if (!me) return sendJson(res, 401, { error: "Not logged in" });

  if (p === "/api/sms/config-status" && req.method === "GET") {
    return sendJson(res, 200, { configured: twilioConfigured() });
  }

  if (p === "/api/sms/test-send" && req.method === "POST") {
    const { to, body } = await readJsonBody(req);
    if (!to || !body) return sendJson(res, 400, { error: "to and body are required" });
    const result = await sendSms({ to, body, contactId: null, sourceType: "manual", sourceId: null });
    if (!result.ok) return sendJson(res, 400, { error: result.reason === "twilio_not_configured" ? "Twilio isn't configured yet -- add credentials to .env first." : result.reason });
    return sendJson(res, 200, { ok: true });
  }

  if (p === "/api/sms-templates" && req.method === "GET") {
    return sendJson(res, 200, { templates: readJson(SMS_TEMPLATES_FILE, []) });
  }
  if (p === "/api/sms-templates" && req.method === "POST") {
    const { name, body } = await readJsonBody(req);
    if (!name || !body) return sendJson(res, 400, { error: "name and body are required" });
    const templates = readJson(SMS_TEMPLATES_FILE, []);
    const template = { id: randomUUID(), name, body, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), createdBy: me.id };
    templates.push(template);
    writeJson(SMS_TEMPLATES_FILE, templates);
    return sendJson(res, 200, { ok: true, template });
  }
  const smsTemplateMatch = p.match(/^\/api\/sms-templates\/([^/]+)$/);
  if (smsTemplateMatch) {
    const templates = readJson(SMS_TEMPLATES_FILE, []);
    const template = templates.find(t => t.id === smsTemplateMatch[1]);
    if (req.method === "PATCH") {
      if (!template) return sendJson(res, 404, { error: "Not found" });
      const body = await readJsonBody(req);
      if ("name" in body) template.name = body.name;
      if ("body" in body) template.body = body.body;
      template.updatedAt = new Date().toISOString();
      writeJson(SMS_TEMPLATES_FILE, templates);
      return sendJson(res, 200, { ok: true, template });
    }
    if (req.method === "DELETE") {
      writeJson(SMS_TEMPLATES_FILE, templates.filter(t => t.id !== smsTemplateMatch[1]));
      return sendJson(res, 200, { ok: true });
    }
  }

  return false;
}
