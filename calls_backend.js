import twilio from "twilio";
import { randomUUID } from "crypto";
import { readJson, writeJson, readJsonBody, sendJson, getSessionUser, isAdmin, USERS_FILE } from "./auth_backend.js";
import { getTwilioSettings, getPublicBaseUrl } from "./integrations_backend.js";
import { normalizePhoneToE164, FOREIGN_NANP_AREA_CODES } from "./sms_backend.js";
import { getContact } from "./email_backend.js";
import { logMessage, updateMessageById } from "./message_log.js";

// Two ways to dial a contact's number, both from the Contacts/Inbox phone-icon
// popup (call-popup.js):
//   "Call From Personal Phone"  -- Twilio rings the staff member's own cell
//     first (calls/click-to-call below); once they pick up, Twilio bridges
//     them straight to the contact. Not recorded.
//   "Call From CRM (and record)" -- a browser call (Twilio Voice JS SDK,
//     no ringing phone involved) that bridges to the contact and records the
//     bridge automatically, uploading the finished recording to a Google
//     Drive folder (Settings > Twilio) via calls/voice-token +
//     webhooks/twilio/voice-outbound below.
// Both bridges log a "call" channel message once the contact leg actually
// ends (webhooks/twilio/call-ended, the <Dial>'s own `action` callback) --
// never at dial time, so a call nobody answered doesn't show as a fake
// conversation entry.

// { [dialCallSid]: { messageId, contactId } } -- bridges the two independent
// recording callbacks (call-ended, which creates the log row and knows the
// contact/duration, and call-recording, which arrives separately once Twilio
// finishes processing the audio and only carries the call sid) so the second
// one knows which message row to attach the finished recording link to. Tiny
// and self-cleaning (each entry is deleted the moment its recording lands, or
// left for the /admin/prune-stale-call-pending sweep otherwise) -- never grows
// unbounded the way message logs elsewhere in this app had to be guarded against.
const CALL_PENDING_FILE = "crm_call_recording_pending.json";

function twilioConfigured() {
  const t = getTwilioSettings();
  return !!(t.accountSid && t.authToken && t.fromNumber);
}
function voiceConfigured() {
  const t = getTwilioSettings();
  return !!(t.accountSid && t.authToken && t.apiKeySid && t.apiKeySecret && t.twimlAppSid);
}
function getTwilioClient() {
  const t = getTwilioSettings();
  return twilio(t.accountSid, t.authToken);
}
// Same US/Canada-only restriction sms_backend.js's sendSms already enforces
// for this specific Twilio account (confirmed live there that a correctly-
// formatted international number still fails) -- applied here too rather
// than discovering it burns a real call attempt.
function validDialTarget(rawPhone) {
  const to = normalizePhoneToE164(rawPhone);
  if (!/^\+1\d{10}$/.test(to) || FOREIGN_NANP_AREA_CODES.has(to.slice(2, 5))) return null;
  return to;
}
function xmlEscape(s) { return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
function twimlResponse(res, inner) {
  res.writeHead(200, { "Content-Type": "text/xml" });
  res.end(`<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`);
}
// Twilio posts every webhook below as application/x-www-form-urlencoded, not
// JSON -- readJsonBody (auth_backend.js) would just return {} for these.
// A request body can only be read once; every webhook route calls this
// exactly once, never readJsonBody too.
function readFormBody(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", d => raw += d);
    req.on("end", () => { try { resolve(Object.fromEntries(new URLSearchParams(raw))); } catch { resolve({}); } });
  });
}

// ── Google Drive upload (recordings) ────────────────────────────────────
// Same refresh-token account flows_backend.js's Sheets calls already use
// (GOOGLE_REFRESH_TOKEN_LW carries the full drive scope -- see that file's
// own getSheetsAccessToken, copied rather than imported for the same reason
// it gives: this is a separate deployment, not worth a shared module for one
// token refresh call).
async function getGoogleAccessToken() {
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN_LW, grant_type: "refresh_token",
    }),
  });
  const d = await r.json();
  if (!d.access_token) throw new Error("Google token refresh failed: " + JSON.stringify(d));
  return d.access_token;
}
async function uploadRecordingToDrive(buffer, filename, folderId) {
  const accessToken = await getGoogleAccessToken();
  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify({ name: filename, parents: [folderId] })], { type: "application/json" }));
  form.append("file", new Blob([buffer], { type: "audio/mpeg" }));
  const r = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink", {
    method: "POST", headers: { Authorization: `Bearer ${accessToken}` }, body: form,
  });
  const d = await r.json();
  if (!r.ok) throw new Error("Drive upload failed: " + JSON.stringify(d));
  return d.webViewLink;
}

// ── Call-ended / recording completion: shared by both bridge modes ─────
// `mode`/`contactId`/`fromUserId`/`record` travel as query params on the
// action/voiceUrl Twilio was given (never trusted for anything but logging
// and the recording-folder decision -- the actual dial target always came
// from OUR OWN earlier validated `to`, baked into that same TwiML, never
// re-read from Twilio's callback body).
function logCompletedCall({ contactId, fromUserId, to, direction, status, duration, dialCallSid, recorded }) {
  const users = readJson(USERS_FILE, []);
  const staff = users.find(u => u.id === fromUserId);
  const mins = duration ? Math.round(duration / 60 * 10) / 10 : 0;
  const label = { completed: "Call completed", "no-answer": "No answer", busy: "Line busy", failed: "Call failed", canceled: "Call canceled" }[status] || status;
  const row = logMessage({
    channel: "call", direction: direction || "outbound", contactId, sourceType: "crm_call", sourceId: fromUserId || null,
    to, from: staff ? `${staff.first} ${staff.last}`.trim() : null,
    subject: `${label}${staff ? ` -- ${staff.first}` : ""}`,
    body: recorded ? "Recording is processing..." : "",
    bodyPreview: status === "completed" ? `${mins} min call` : label,
    status: status === "completed" ? "sent" : "failed",
    failReason: status === "completed" ? null : label,
  });
  if (recorded && dialCallSid) {
    const pending = readJson(CALL_PENDING_FILE, {});
    pending[dialCallSid] = { messageId: row.id, contactId };
    writeJson(CALL_PENDING_FILE, pending);
  }
  return row;
}

export async function handleCallsRequest(req, res, url) {
  const p = url.pathname;

  // ── "Call From Personal Phone" -- ring me, then bridge to the contact ──
  if (p === "/api/calls/click-to-call" && req.method === "POST") {
    const me = getSessionUser(req);
    if (!me) return sendJson(res, 401, { error: "Not logged in" });
    if (!twilioConfigured()) return sendJson(res, 400, { error: "Twilio isn't configured yet (Settings > Twilio)." });
    if (!me.personalPhone) return sendJson(res, 400, { error: "No personal phone on file for you -- an admin can add one in Settings > Team Users." });
    const myPhone = validDialTarget(me.personalPhone);
    if (!myPhone) return sendJson(res, 400, { error: "Your personal phone number on file doesn't look like a valid US number." });
    const { contactId, phone } = await readJsonBody(req);
    const to = validDialTarget(phone);
    if (!to) return sendJson(res, 400, { error: "That doesn't look like a valid US phone number." });
    const base = getPublicBaseUrl();
    if (!base) return sendJson(res, 400, { error: "Set a Public Base URL first (Settings > General) -- Twilio needs a real URL to call back." });
    const t = getTwilioSettings();
    const bridgeUrl = `${base}/api/webhooks/twilio/bridge-twiml?to=${encodeURIComponent(to)}&contactId=${encodeURIComponent(contactId || "")}&fromUserId=${encodeURIComponent(me.id)}`;
    try {
      const call = await getTwilioClient().calls.create({ to: myPhone, from: t.fromNumber, url: bridgeUrl });
      return sendJson(res, 200, { ok: true, callSid: call.sid });
    } catch (e) {
      return sendJson(res, 502, { error: e.message });
    }
  }

  // Twilio requests this once the STAFF MEMBER answers their ringing personal
  // phone (never before) -- bridges them straight to the contact. No
  // recording (see this file's own top comment on why only the CRM/browser
  // mode records).
  if (p === "/api/webhooks/twilio/bridge-twiml" && req.method === "POST") {
    const to = url.searchParams.get("to"), contactId = url.searchParams.get("contactId"), fromUserId = url.searchParams.get("fromUserId");
    const t = getTwilioSettings();
    const base = getPublicBaseUrl();
    const action = `${base}/api/webhooks/twilio/call-ended?mode=bridge&contactId=${encodeURIComponent(contactId)}&fromUserId=${encodeURIComponent(fromUserId)}`;
    return twimlResponse(res, `<Dial callerId="${xmlEscape(t.fromNumber)}" action="${xmlEscape(action)}"><Number>${xmlEscape(to)}</Number></Dial>`);
  }

  // ── "Call From CRM" -- browser Voice SDK Access Token ──────────────────
  if (p === "/api/calls/voice-token" && req.method === "POST") {
    const me = getSessionUser(req);
    if (!me) return sendJson(res, 401, { error: "Not logged in" });
    if (!voiceConfigured()) return sendJson(res, 400, { error: "Voice calling isn't set up yet -- an admin needs to click \"Set Up Voice Calling\" in Settings > Twilio." });
    const t = getTwilioSettings();
    const AccessToken = twilio.jwt.AccessToken;
    const token = new AccessToken(t.accountSid, t.apiKeySid, t.apiKeySecret, { identity: me.id, ttl: 3600 });
    token.addGrant(new AccessToken.VoiceGrant({ outgoingApplicationSid: t.twimlAppSid, incomingAllow: false }));
    return sendJson(res, 200, { token: token.toJwt() });
  }

  // Twilio requests this the instant the browser's Device.connect() fires --
  // the client leg is already "answered" (it's an active tab, not a ringing
  // phone), so this dials the contact immediately and records the bridge.
  // `To`/`ContactId`/`FromUserId` are the custom params call-popup.js passed
  // into connect({params}) -- re-validated here exactly like click-to-call's
  // own body, never trusted just because they came back from Twilio.
  if (p === "/api/webhooks/twilio/voice-outbound" && req.method === "POST") {
    const form = await readFormBody(req);
    const to = validDialTarget(form.To);
    const contactId = form.ContactId || "", fromUserId = form.FromUserId || "";
    if (!to) return twimlResponse(res, `<Say>Sorry, that number could not be dialed.</Say>`);
    const t = getTwilioSettings();
    const base = getPublicBaseUrl();
    const action = `${base}/api/webhooks/twilio/call-ended?mode=crm&record=1&contactId=${encodeURIComponent(contactId)}&fromUserId=${encodeURIComponent(fromUserId)}`;
    const recordingStatusCallback = `${base}/api/webhooks/twilio/call-recording`;
    return twimlResponse(res, `<Dial callerId="${xmlEscape(t.fromNumber)}" record="record-from-answer" recordingStatusCallback="${xmlEscape(recordingStatusCallback)}" recordingStatusCallbackEvent="completed" action="${xmlEscape(action)}"><Number>${xmlEscape(to)}</Number></Dial>`);
  }

  // Fires once the <Dial> to the contact (either mode) finishes, however it
  // ended -- the one place both modes log the actual "call" message.
  if (p === "/api/webhooks/twilio/call-ended" && req.method === "POST") {
    const form = await readFormBody(req);
    const contactId = url.searchParams.get("contactId") || null;
    const fromUserId = url.searchParams.get("fromUserId") || null;
    const recorded = url.searchParams.get("record") === "1" && form.DialCallStatus === "completed";
    logCompletedCall({
      contactId, fromUserId, to: form.To || form.Called || null, direction: "outbound",
      status: form.DialCallStatus || "failed", duration: Number(form.DialCallDuration) || 0,
      dialCallSid: form.DialCallSid, recorded,
    });
    return twimlResponse(res, "");
  }

  // Fires separately, once Twilio finishes PROCESSING the audio (after the
  // call itself already ended and was logged above) -- downloads it and
  // uploads it to the configured Drive folder, then attaches the link to
  // the message row call-ended already created (matched by CallSid, which
  // for a <Dial>'s recording is the CHILD call -- the same id call-ended
  // received as DialCallSid).
  if (p === "/api/webhooks/twilio/call-recording" && req.method === "POST") {
    const form = await readFormBody(req);
    res.writeHead(200, { "Content-Type": "text/xml" }); res.end("<Response></Response>"); // ack immediately -- the upload below can take several seconds
    if (form.RecordingStatus !== "completed" || !form.RecordingUrl) return true;
    const pending = readJson(CALL_PENDING_FILE, {});
    const entry = pending[form.CallSid];
    (async () => {
      try {
        const t = getTwilioSettings();
        const auth = Buffer.from(`${t.accountSid}:${t.authToken}`).toString("base64");
        const audio = await fetch(`${form.RecordingUrl}.mp3`, { headers: { Authorization: `Basic ${auth}` } });
        const buffer = Buffer.from(await audio.arrayBuffer());
        const filename = `call-${new Date().toISOString().replace(/[:.]/g, "-")}-${form.CallSid}.mp3`;
        const link = t.recordingsFolderId ? await uploadRecordingToDrive(buffer, filename, t.recordingsFolderId) : null;
        if (entry) {
          updateMessageById(entry.messageId, { body: link ? `Recording: ${link}` : "Recording finished but no Drive folder is set (Settings > Twilio)." });
          delete pending[form.CallSid];
          writeJson(CALL_PENDING_FILE, pending);
        }
      } catch (e) {
        console.error("[calls_backend] recording upload failed:", e.message);
        if (entry) updateMessageById(entry.messageId, { body: `Recording finished but the Drive upload failed: ${e.message}` });
      }
    })();
    return true;
  }

  // "Are the two things call-popup.js needs (voice for the browser, a
  // personal phone for the bridge) ready?" -- read by that popup so it can
  // grey out/hide whichever half isn't configured instead of a call failing
  // silently after the click.
  if (p === "/api/calls/config" && req.method === "GET") {
    const me = getSessionUser(req);
    if (!me) return sendJson(res, 401, { error: "Not logged in" });
    return sendJson(res, 200, { personalPhoneConfigured: !!me.personalPhone, voiceConfigured: voiceConfigured(), myIdentity: me.id });
  }

  return false;
}
