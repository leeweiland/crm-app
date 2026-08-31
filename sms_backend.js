import { randomUUID } from "crypto";
import twilio from "twilio";
import { readJson, writeJson, readJsonBody, sendJson, getSessionUser } from "./auth_backend.js";
import { CONTACTS_FILE } from "./segments_shared.js";
import { logMessage, updateMessageStatusByProviderId } from "./message_log.js";
import { checkConversionGoal } from "./workflows_backend.js";
import { getTwilioSettings } from "./integrations_backend.js";
import { recheckStopStatus } from "./compliance_backend.js";
import { appendSourceTagToSmsBody } from "./block_editor_shared.js";
import { resolveSendSourceSlug } from "./source_names.js";
import { triggerAiAssist } from "./ai_agents_backend.js";

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

function getContact(id) { return readJson(CONTACTS_FILE, []).find(c => c.id === id) || null; }
function findContactByPhone(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  return readJson(CONTACTS_FILE, []).find(c => String(c.phone || "").replace(/\D/g, "").slice(-10) === digits.slice(-10)) || null;
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
  const baseRow = {
    channel: "sms", direction: "outbound", contactId, sourceType, sourceId,
    to, from: twilioSettings.fromNumber || null, body: taggedBody || "", bodyPreview: (taggedBody || "").slice(0, 140),
  };

  if (!client) { logMessage({ ...baseRow, status: "failed" }); return { ok: false, reason: "twilio_not_configured" }; }

  try {
    const msg = await client.messages.create({ to, from: twilioSettings.fromNumber, body: taggedBody });
    // Logged once with the final status/sid already known, same reasoning
    // as email_backend.js's sendEmail -- see message_log.js's comment.
    logMessage({ ...baseRow, status: msg.status || "sent", providerMessageId: msg.sid });
    return { ok: true, sid: msg.sid };
  } catch (e) {
    logMessage({ ...baseRow, status: "failed" });
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
      logMessage({ channel: "sms", direction: "inbound", contactId: contact.id, sourceType: "inbound", sourceId: null, to: twilioSettings.fromNumber || null, from, body, bodyPreview: body.slice(0, 140), status: "received" });
      checkConversionGoal("incoming_sms", contact.id);
      recheckStopStatus(contact.id);
      // Fire-and-forget: doesn't block the Twilio webhook response (which
      // must return fast) on an LLM call. Only actually does anything if an
      // active, AI-Assist-enabled agent's targeting matches this contact.
      triggerAiAssist({
        contact, channel: "sms", inboundText: body,
        sendFn: (replyText) => sendSms({ to: contact.phone, body: replyText, contactId: contact.id, sourceType: "ai_agent", sourceId: null }),
      }).catch((err) => console.error("triggerAiAssist error:", err.message));
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
