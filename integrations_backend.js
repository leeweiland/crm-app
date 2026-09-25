import twilio from "twilio";
import { readJson, writeJson, readJsonBody, sendJson, getSessionUser, isAdmin } from "./auth_backend.js";
import { DEFAULT_THEME } from "./block_editor_shared.js";
import { parseSheetUrl, checkBlacklistSheet } from "./blacklist_sheet.js";

export const INTEGRATIONS_FILE = "crm_integrations.json";

// In-app credential store, admin-only -- lets Lee manage SES/Twilio
// credentials from Settings instead of editing .env on the server directly.
// Values here take priority over process.env so a saved value always wins;
// process.env stays as the zero-config fallback (e.g. Railway env vars) for
// deployments where nobody has touched this UI yet.
function readSettings() {
  return readJson(INTEGRATIONS_FILE, { ses: {}, twilio: {}, site: {} });
}

export function getPublicBaseUrl() {
  return readSettings().site?.publicBaseUrl || process.env.PUBLIC_BASE_URL || "";
}

// Defaults to the real Pacific Rim Athletics logo until someone uploads a
// different one or explicitly clears it (an explicitly-saved "" is left
// alone -- that's "no logo", distinct from "never configured").
export function getLogoUrl() {
  const v = readSettings().site?.logoUrl;
  return v !== undefined ? v : "/assets/pra-logo.png";
}

// The org-wide starting point for a NEW campaign or automation email-step's
// theme -- copied in at creation time (not a live reference), same as every
// other per-entity settings object in this app, so editing the org default
// later never silently rewrites something someone already customized.
// "Reset to default" (per-email, in the editor) and "reset all" (bulk, from
// this settings page) are what re-copy it in deliberately.
export function getEmailTheme() {
  const stored = readSettings().emailTheme || {};
  return { ...DEFAULT_THEME, ...stored };
}

// Which transport the Inbox's reply/send path should prefer -- "gmail"
// (default, per-sender's own connected account, see gmail_backend.js) or
// "ses" (force the shared AWS pipeline even for a sender with Gmail
// connected -- useful once SES is out of sandbox and for testing it).
// Doesn't grant Gmail sending to anyone -- a sender still needs their own
// gmailRefreshToken+send scope (Settings > My Account) for "gmail" to
// actually apply to their sends; this only decides which transport is
// preferred when that's available.
export function getEmailSendPreference() {
  return readSettings().emailSendPreference === "ses" ? "ses" : "gmail";
}

export function getSesSettings() {
  const s = readSettings().ses || {};
  return {
    accessKeyId: s.accessKeyId || process.env.AWS_ACCESS_KEY_ID || "",
    secretAccessKey: s.secretAccessKey || process.env.AWS_SECRET_ACCESS_KEY || "",
    region: s.region || process.env.AWS_REGION || "us-east-2",
    fromAddress: s.fromAddress || process.env.SES_FROM_ADDRESS || "",
    configurationSet: s.configurationSet || process.env.SES_CONFIGURATION_SET || "",
  };
}

export function getTwilioSettings() {
  const t = readSettings().twilio || {};
  return {
    accountSid: t.accountSid || process.env.TWILIO_ACCOUNT_SID || "",
    authToken: t.authToken || process.env.TWILIO_AUTH_TOKEN || "",
    fromNumber: t.fromNumber || process.env.TWILIO_FROM_NUMBER || "",
    // Voice calling (calls_backend.js) -- apiKeySid/apiKeySecret + twimlAppSid
    // are what an Access Token needs to let the browser (Twilio Voice SDK)
    // place a call; accountSid/authToken alone (above) can't mint one. Both
    // are provisioned together by the "Set Up Voice Calling" button in
    // Settings > Twilio (provisionVoiceCalling below), not typed in by hand.
    apiKeySid: t.apiKeySid || "",
    apiKeySecret: t.apiKeySecret || "",
    twimlAppSid: t.twimlAppSid || "",
    // Google Drive folder ("Call From CRM"'s recordings land here) -- just the
    // folder id from its drive.google.com/drive/folders/<id> URL.
    recordingsFolderId: t.recordingsFolderId || "",
  };
}

// SMS "STOP" is a carrier-compliance keyword (SMS opt-out only, never
// email); email opt-out only ever happens via an explicit unsubscribe-link
// click. BLACKLIST is a staff judgment call, not a legal
// requirement, so it's the one status that suppresses both channels.
const DEFAULT_STOP_KEYWORDS = ["stop", "stopall", "unsubscribe", "cancel", "end", "quit"];
// Reference values for attributing traffic back to a specific ad/link.
// metaUrlParams/googleTrackingTemplate are paste-into-the-ad-platform's-own-
// UI values (this CRM doesn't call Meta/Google's APIs with them). There's
// no separate "source tag" setting anymore -- every link this CRM sends in
// email/SMS gets an "el=<channel>-<slug>" tag applied automatically
// (source_names.js's resolveSendSourceSlug), matching the el= convention
// already used everywhere else (ads, social, YouTube), with the slug
// derived from whichever campaign/automation/workflow is actually sending
// it. Nothing to configure here for that part.
export function getTrackingSettings() {
  const t = readSettings().tracking || {};
  return {
    metaUrlParams: t.metaUrlParams || "",
    googleTrackingTemplate: t.googleTrackingTemplate || "",
  };
}

// Which sidebar tabs (crm-nav.js's NAV_ITEMS hrefs) each non-admin role can
// see and reach -- admin is deliberately never stored here, always full
// access, so an admin can't accidentally lock themselves out while editing
// this. Defaults to Inbox + Contacts only for user/superuser until an admin
// opens it up further from Settings > Users.
// Connect Email defaults to ON for both non-admin roles -- unlike the rest
// of Settings (Twilio/SES/Ads/Users, all admin-sensitive), there's nothing
// here a regular team member shouldn't reach: connecting their own Gmail
// is entirely self-service and only ever touches their own account.
const DEFAULT_NAV_PERMISSIONS = {
  user: ["/inbox.html", "/contacts.html", "/connect-email.html"],
  superuser: ["/inbox.html", "/contacts.html", "/connect-email.html"],
};
export function getNavPermissions() {
  const stored = readSettings().navPermissions || {};
  return {
    user: Array.isArray(stored.user) ? stored.user : DEFAULT_NAV_PERMISSIONS.user,
    superuser: Array.isArray(stored.superuser) ? stored.superuser : DEFAULT_NAV_PERMISSIONS.superuser,
  };
}

// Reminders for Inbox-scheduled meetings (see meetings_backend.js, which
// polls these on the shared scheduler tick) -- standalone, not tied to any
// event type or calendar: these meetings have neither. emailReminders/
// smsReminders are lists of {id, amount, unit}, same shape as an event
// type's own reminders.email/sms -- an empty list is what turns a channel
// off, no separate enabled/disabled flag to keep in sync with it. One
// shared org-wide config, not per-user, same reasoning as every other
// integrations setting here.
const DEFAULT_MEETING_REMINDERS = {
  timezone: "America/Anchorage",
  emailReminderSubjectTemplate: "Reminder: your meeting with {{coachName}} is coming up",
  emailReminderBodyTemplate: "Hi {{firstName}},<br><br>Just a reminder — your meeting with {{coachName}} is <strong>{{date}} at {{time}}</strong> ({{duration}} min).",
  smsReminderTemplate: "Reminder: your meeting with {{coachName}} is {{date}} at {{time}} ({{duration}} min).",
  emailReminders: [{ id: "default-email-1440", amount: 24, unit: "hours" }, { id: "default-email-60", amount: 60, unit: "minutes" }],
  smsReminders: [{ id: "default-sms-60", amount: 60, unit: "minutes" }],
};
export function getMeetingReminderSettings() {
  const stored = readSettings().meetingReminders || {};
  return {
    ...DEFAULT_MEETING_REMINDERS, ...stored,
    emailReminders: Array.isArray(stored.emailReminders) ? stored.emailReminders : DEFAULT_MEETING_REMINDERS.emailReminders,
    smsReminders: Array.isArray(stored.smsReminders) ? stored.smsReminders : DEFAULT_MEETING_REMINDERS.smsReminders,
  };
}

// A reply CONTAINING (not being exactly) one of these words moves the
// contact straight to the blacklist status -- see compliance_backend.js's
// checkAutoTriggers/containsTriggerWord, deliberately separate from the
// stopKeywords/blacklistAutoOptOut settings above rather than folded into
// them, since those are carrier-compliance whole-message-only opt-out and
// this is a content-based moderation action.
//
// Used to be two separate lists (a reversible "hide" action plus its own
// reOptInKeywords, and a permanent "blacklist" action) -- merged into one
// always-permanent list. triggerKeywords reads back the union of whatever
// was stored under either old field the first time this loads after the
// merge, so nobody's existing configured words silently vanish.
export function getComplianceSettings() {
  const c = readSettings().compliance || {};
  const triggerKeywords = Array.isArray(c.triggerKeywords) ? c.triggerKeywords
    : [...new Set([...(Array.isArray(c.hideKeywords) ? c.hideKeywords : []), ...(Array.isArray(c.blacklistKeywords) ? c.blacklistKeywords : [])])];
  const triggerKeywordsEnabled = "triggerKeywordsEnabled" in c ? !!c.triggerKeywordsEnabled : (!!c.hideKeywordsEnabled || !!c.blacklistKeywordsEnabled);
  return {
    stopKeywordsEnabled: c.stopKeywordsEnabled !== false,
    stopKeywords: Array.isArray(c.stopKeywords) && c.stopKeywords.length ? c.stopKeywords : DEFAULT_STOP_KEYWORDS,
    blacklistAutoOptOut: c.blacklistAutoOptOut !== false,
    triggerKeywordsEnabled,
    triggerKeywords,
    // Link to the team's Blacklist Google Sheet -- every contact marked
    // Blacklist gets appended to it (see blacklist_sheet.js). "" = off.
    blacklistSheetUrl: typeof c.blacklistSheetUrl === "string" ? c.blacklistSheetUrl : "",
    // Off by default -- a failed send is often transient (a full inbox, a
    // temporary carrier issue), not proof the address/number is genuinely
    // bad, so this is an opt-in automation rather than always-on. See
    // compliance_backend.js's maybeAutoOptOutOnFailedSend.
    autoOptOutFailedEmail: !!c.autoOptOutFailedEmail,
    autoOptOutFailedSms: !!c.autoOptOutFailedSms,
  };
}

function mask(value) {
  if (!value) return "";
  if (value.length <= 4) return "****";
  return "****" + value.slice(-4);
}

export async function handleIntegrationsRequest(req, res, url) {
  const p = url.pathname;
  if (!p.startsWith("/api/integrations/")) return false;

  const me = getSessionUser(req);
  if (!me) return sendJson(res, 401, { error: "Not logged in" });

  // Site branding (logo/publicBaseUrl/websiteUrl) is readable by any
  // logged-in user, not just admins -- crm-nav.js needs it to render the
  // sidebar for every role. Everything else below (AWS/Twilio secrets,
  // and writing site settings) stays admin-only.
  if (p === "/api/integrations/site" && req.method === "GET") {
    return sendJson(res, 200, { publicBaseUrl: getPublicBaseUrl(), websiteUrl: readSettings().site?.websiteUrl || "", logoUrl: getLogoUrl() });
  }

  // Also readable by any logged-in user, not just admins -- every campaign/
  // automation-step editor page needs this to seed a brand-new email's
  // theme and to power its own "Reset to default" button.
  if (p === "/api/integrations/email-theme" && req.method === "GET") {
    return sendJson(res, 200, { theme: getEmailTheme() });
  }

  // Same reasoning as site/email-theme above -- crm-nav.js needs this for
  // EVERY user, on every page, to know which tabs to render/allow.
  if (p === "/api/integrations/nav-permissions" && req.method === "GET") {
    return sendJson(res, 200, getNavPermissions());
  }

  // Also readable by any logged-in user -- the Inbox toggle needs this for
  // whoever's viewing it, not just admins.
  if (p === "/api/integrations/email-provider" && req.method === "GET") {
    return sendJson(res, 200, { provider: getEmailSendPreference() });
  }

  if (!isAdmin(me)) return sendJson(res, 403, { error: "Admins only" });

  if (p === "/api/integrations/email-theme" && req.method === "POST") {
    const body = await readJsonBody(req);
    const all = readSettings();
    all.emailTheme = all.emailTheme || {};
    for (const k of Object.keys(DEFAULT_THEME)) {
      if (k in body) all.emailTheme[k] = body[k];
    }
    writeJson(INTEGRATIONS_FILE, all);
    return sendJson(res, 200, { ok: true, theme: getEmailTheme() });
  }

  if (p === "/api/integrations/ses" && req.method === "GET") {
    const s = getSesSettings();
    return sendJson(res, 200, {
      configured: !!(s.accessKeyId && s.secretAccessKey && s.fromAddress),
      accessKeyId: mask(s.accessKeyId),
      secretAccessKey: mask(s.secretAccessKey),
      region: s.region, fromAddress: s.fromAddress, configurationSet: s.configurationSet,
    });
  }
  if (p === "/api/integrations/ses" && req.method === "POST") {
    const body = await readJsonBody(req);
    const all = readSettings();
    all.ses = all.ses || {};
    // Masked placeholders (e.g. "****AB5P") are never written back over a
    // real stored value -- only overwrite a field when a genuinely new
    // value was typed in.
    for (const k of ["accessKeyId", "secretAccessKey", "region", "fromAddress", "configurationSet"]) {
      if (k in body && !String(body[k]).startsWith("****")) all.ses[k] = body[k];
    }
    writeJson(INTEGRATIONS_FILE, all);
    return sendJson(res, 200, { ok: true });
  }

  if (p === "/api/integrations/twilio" && req.method === "GET") {
    const t = getTwilioSettings();
    return sendJson(res, 200, {
      configured: !!(t.accountSid && t.authToken && t.fromNumber),
      accountSid: mask(t.accountSid), authToken: mask(t.authToken), fromNumber: t.fromNumber,
      voiceConfigured: !!(t.apiKeySid && t.apiKeySecret && t.twimlAppSid),
      apiKeySid: t.apiKeySid, apiKeySecret: mask(t.apiKeySecret),
      recordingsFolderId: t.recordingsFolderId,
    });
  }
  if (p === "/api/integrations/twilio" && req.method === "POST") {
    const body = await readJsonBody(req);
    const all = readSettings();
    all.twilio = all.twilio || {};
    for (const k of ["accountSid", "authToken", "fromNumber", "apiKeySid", "apiKeySecret", "twimlAppSid", "recordingsFolderId"]) {
      if (k in body && !String(body[k]).startsWith("****")) all.twilio[k] = body[k];
    }
    writeJson(INTEGRATIONS_FILE, all);
    return sendJson(res, 200, { ok: true });
  }
  // One-click provisioning for "Call From CRM": creates the Twilio API Key
  // (needed for a browser Voice SDK Access Token -- accountSid/authToken
  // alone can't mint one) and the TwiML Application (tells Twilio which
  // webhook to ask for instructions when the browser places a call) on this
  // Twilio account, then saves both straight into settings. Safe to click
  // more than once -- a no-op once voiceConfigured is already true.
  if (p === "/api/integrations/twilio/provision-voice" && req.method === "POST") {
    if (!isAdmin(getSessionUser(req))) return sendJson(res, 403, { error: "Admins only" });
    const t = getTwilioSettings();
    if (!t.accountSid || !t.authToken) return sendJson(res, 400, { error: "Save the Account SID and Auth Token first." });
    if (t.apiKeySid && t.apiKeySecret && t.twimlAppSid) return sendJson(res, 200, { ok: true, alreadyConfigured: true });
    const base = getPublicBaseUrl();
    if (!base) return sendJson(res, 400, { error: "Set a Public Base URL (General tab) first -- Twilio needs a real URL to call back." });
    try {
      const twilioClient = twilio(t.accountSid, t.authToken);
      const key = await twilioClient.newKeys.create({ friendlyName: "crm-voice-calling" });
      const app = await twilioClient.applications.create({
        friendlyName: "CRM Voice Calling", voiceUrl: `${base}/api/webhooks/twilio/voice-outbound`, voiceMethod: "POST",
      });
      const all = readSettings();
      all.twilio = { ...(all.twilio || {}), apiKeySid: key.sid, apiKeySecret: key.secret, twimlAppSid: app.sid };
      writeJson(INTEGRATIONS_FILE, all);
      return sendJson(res, 200, { ok: true });
    } catch (e) {
      return sendJson(res, 502, { error: e.message });
    }
  }

  if (p === "/api/integrations/compliance" && req.method === "GET") {
    return sendJson(res, 200, getComplianceSettings());
  }
  if (p === "/api/integrations/compliance" && req.method === "POST") {
    const body = await readJsonBody(req);
    const all = readSettings();
    all.compliance = all.compliance || {};
    if ("stopKeywordsEnabled" in body) all.compliance.stopKeywordsEnabled = !!body.stopKeywordsEnabled;
    if ("blacklistAutoOptOut" in body) all.compliance.blacklistAutoOptOut = !!body.blacklistAutoOptOut;
    if (Array.isArray(body.stopKeywords)) all.compliance.stopKeywords = body.stopKeywords.map(k => String(k).trim().toLowerCase()).filter(Boolean);
    if ("triggerKeywordsEnabled" in body) all.compliance.triggerKeywordsEnabled = !!body.triggerKeywordsEnabled;
    if (Array.isArray(body.triggerKeywords)) all.compliance.triggerKeywords = body.triggerKeywords.map(k => String(k).trim().toLowerCase()).filter(Boolean);
    // Same flag read from both Settings -> Opt Out and the Reporting page's
    // Failed-card toggle -- one POST from either place updates the other on
    // its next load, with no separate sync mechanism needed.
    if ("autoOptOutFailedEmail" in body) all.compliance.autoOptOutFailedEmail = !!body.autoOptOutFailedEmail;
    if ("autoOptOutFailedSms" in body) all.compliance.autoOptOutFailedSms = !!body.autoOptOutFailedSms;
    if ("blacklistSheetUrl" in body) {
      const url = String(body.blacklistSheetUrl || "").trim();
      if (url && !parseSheetUrl(url)) return sendJson(res, 400, { error: "That doesn't look like a Google Sheets link." });
      all.compliance.blacklistSheetUrl = url;
    }
    writeJson(INTEGRATIONS_FILE, all);
    return sendJson(res, 200, { ok: true });
  }
  // Settings' "Check" button: is the pasted link reachable and editable by
  // this CRM's Google account, and which tab/columns will rows land in.
  if (p === "/api/integrations/compliance/blacklist-sheet-check" && req.method === "POST") {
    const body = await readJsonBody(req);
    const url = String(body.url ?? getComplianceSettings().blacklistSheetUrl ?? "").trim();
    if (!url) return sendJson(res, 200, { ok: false, error: "Paste the Blacklist sheet link first." });
    return sendJson(res, 200, await checkBlacklistSheet(url));
  }

  if (p === "/api/integrations/email-provider" && req.method === "POST") {
    const body = await readJsonBody(req);
    if (body.provider !== "gmail" && body.provider !== "ses") return sendJson(res, 400, { error: "provider must be 'gmail' or 'ses'" });
    const all = readSettings();
    all.emailSendPreference = body.provider;
    writeJson(INTEGRATIONS_FILE, all);
    return sendJson(res, 200, { ok: true, provider: getEmailSendPreference() });
  }

  if (p === "/api/integrations/nav-permissions" && req.method === "POST") {
    const body = await readJsonBody(req);
    const all = readSettings();
    all.navPermissions = all.navPermissions || {};
    for (const role of ["user", "superuser"]) {
      if (Array.isArray(body[role])) all.navPermissions[role] = body[role].filter(h => typeof h === "string");
    }
    writeJson(INTEGRATIONS_FILE, all);
    return sendJson(res, 200, { ok: true, ...getNavPermissions() });
  }

  if (p === "/api/integrations/site" && req.method === "POST") {
    const body = await readJsonBody(req);
    const all = readSettings();
    all.site = all.site || {};
    for (const k of ["publicBaseUrl", "websiteUrl"]) if (k in body) all.site[k] = String(body[k]).trim().replace(/\/+$/, "");
    if ("logoUrl" in body) all.site.logoUrl = String(body.logoUrl).trim();
    writeJson(INTEGRATIONS_FILE, all);
    return sendJson(res, 200, { ok: true });
  }

  if (p === "/api/integrations/tracking" && req.method === "GET") {
    return sendJson(res, 200, getTrackingSettings());
  }
  if (p === "/api/integrations/tracking" && req.method === "POST") {
    const body = await readJsonBody(req);
    const all = readSettings();
    all.tracking = all.tracking || {};
    for (const k of ["metaUrlParams", "googleTrackingTemplate"]) {
      if (k in body) all.tracking[k] = String(body[k]).trim();
    }
    writeJson(INTEGRATIONS_FILE, all);
    return sendJson(res, 200, { ok: true });
  }

  if (p === "/api/integrations/meeting-reminders" && req.method === "GET") {
    return sendJson(res, 200, getMeetingReminderSettings());
  }
  if (p === "/api/integrations/meeting-reminders" && req.method === "POST") {
    const body = await readJsonBody(req);
    const all = readSettings();
    const cleanReminders = (arr) => (Array.isArray(arr) ? arr : [])
      .map(r => ({ id: String(r.id || ""), amount: Number(r.amount), unit: r.unit }))
      .filter(r => r.id && Number.isFinite(r.amount) && r.amount > 0 && ["minutes", "hours", "days"].includes(r.unit));
    // Written as a fresh object, not merged onto whatever's already stored --
    // this setting has changed shape a couple times; merging would leave old
    // now-unused keys (an earlier enabled/minutesBefore or linkedEventTypeId
    // design) sitting in the file forever even though nothing reads them.
    const current = getMeetingReminderSettings();
    all.meetingReminders = {
      timezone: "timezone" in body ? String(body.timezone) : current.timezone,
      emailReminderSubjectTemplate: "emailReminderSubjectTemplate" in body ? String(body.emailReminderSubjectTemplate) : current.emailReminderSubjectTemplate,
      emailReminderBodyTemplate: "emailReminderBodyTemplate" in body ? String(body.emailReminderBodyTemplate) : current.emailReminderBodyTemplate,
      smsReminderTemplate: "smsReminderTemplate" in body ? String(body.smsReminderTemplate) : current.smsReminderTemplate,
      emailReminders: "emailReminders" in body ? cleanReminders(body.emailReminders) : current.emailReminders,
      smsReminders: "smsReminders" in body ? cleanReminders(body.smsReminders) : current.smsReminders,
    };
    writeJson(INTEGRATIONS_FILE, all);
    return sendJson(res, 200, { ok: true, ...getMeetingReminderSettings() });
  }

  return false;
}
