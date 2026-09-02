import { readJson, writeJson, readJsonBody, sendJson, getSessionUser, isAdmin } from "./auth_backend.js";
import { DEFAULT_THEME } from "./block_editor_shared.js";

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

// Reminder timing/copy for Inbox-scheduled meetings (see meetings_backend.js,
// which polls these on the shared scheduler tick) -- one shared org-wide
// config, not per-user, same reasoning as every other integrations setting
// here: an admin sets the cadence/wording once for the whole team.
const DEFAULT_MEETING_REMINDERS = {
  timezone: "America/Anchorage",
  emailRemindersEnabled: true,
  emailReminderMinutesBefore: [1440, 60],
  emailReminderSubjectTemplate: "Reminder: your meeting with {{coachName}} is coming up",
  emailReminderBodyTemplate: "Hi {{firstName}},<br><br>Just a reminder — your meeting with {{coachName}} is <strong>{{date}} at {{time}}</strong> ({{duration}} min).",
  smsRemindersEnabled: true,
  smsReminderMinutesBefore: [60],
  smsReminderTemplate: "Reminder: your meeting with {{coachName}} is {{date}} at {{time}} ({{duration}} min).",
};
export function getMeetingReminderSettings() {
  const stored = readSettings().meetingReminders || {};
  return {
    ...DEFAULT_MEETING_REMINDERS, ...stored,
    emailReminderMinutesBefore: Array.isArray(stored.emailReminderMinutesBefore) ? stored.emailReminderMinutesBefore : DEFAULT_MEETING_REMINDERS.emailReminderMinutesBefore,
    smsReminderMinutesBefore: Array.isArray(stored.smsReminderMinutesBefore) ? stored.smsReminderMinutesBefore : DEFAULT_MEETING_REMINDERS.smsReminderMinutesBefore,
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
    });
  }
  if (p === "/api/integrations/twilio" && req.method === "POST") {
    const body = await readJsonBody(req);
    const all = readSettings();
    all.twilio = all.twilio || {};
    for (const k of ["accountSid", "authToken", "fromNumber"]) {
      if (k in body && !String(body[k]).startsWith("****")) all.twilio[k] = body[k];
    }
    writeJson(INTEGRATIONS_FILE, all);
    return sendJson(res, 200, { ok: true });
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
    writeJson(INTEGRATIONS_FILE, all);
    return sendJson(res, 200, { ok: true });
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
    all.meetingReminders = all.meetingReminders || {};
    for (const k of ["timezone", "emailReminderSubjectTemplate", "emailReminderBodyTemplate", "smsReminderTemplate"]) {
      if (k in body) all.meetingReminders[k] = String(body[k]);
    }
    if ("emailRemindersEnabled" in body) all.meetingReminders.emailRemindersEnabled = !!body.emailRemindersEnabled;
    if ("smsRemindersEnabled" in body) all.meetingReminders.smsRemindersEnabled = !!body.smsRemindersEnabled;
    if (Array.isArray(body.emailReminderMinutesBefore)) all.meetingReminders.emailReminderMinutesBefore = body.emailReminderMinutesBefore.map(Number).filter(n => Number.isFinite(n) && n >= 0);
    if (Array.isArray(body.smsReminderMinutesBefore)) all.meetingReminders.smsReminderMinutesBefore = body.smsReminderMinutesBefore.map(Number).filter(n => Number.isFinite(n) && n >= 0);
    writeJson(INTEGRATIONS_FILE, all);
    return sendJson(res, 200, { ok: true, ...getMeetingReminderSettings() });
  }

  return false;
}
