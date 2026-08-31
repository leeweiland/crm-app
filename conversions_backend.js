import { randomUUID, createHash } from "crypto";
import { readJson, writeJson, readJsonBody, sendJson, getSessionUser, isAdmin } from "./auth_backend.js";
import { CONTACTS_FILE } from "./segments_shared.js";
import { INTEGRATIONS_FILE } from "./integrations_backend.js";

// Server-side conversion push to Meta (Conversions API) and Google Ads
// (Enhanced Conversions for Leads) -- the piece Hyros used to handle.
// Matched by hashed email/phone only, no click id (fbclid/gclid) -- this
// business's real conversions (deposit, closed sale) often land days/weeks
// after the ad click, well past any click-id attribution window, so hashed
// PII match is the more reliable signal here, not a fallback.
//
// Values take priority over process.env, same "Settings wins, env is the
// zero-config fallback" convention as integrations_backend.js's SES/Twilio
// getters -- lets Lee paste in the tokens already sitting unused in the
// old attribution-app/.env (META_ACCESS_TOKEN, GOOGLE_ADS_DEVELOPER_TOKEN,
// GOOGLE_REFRESH_TOKEN_ADS, GOOGLE_ADS_CUSTOMER_ID) without editing files.
function readSettings() {
  return readJson(INTEGRATIONS_FILE, {});
}
export function getConversionSettings() {
  const c = readSettings().conversions || {};
  return {
    metaPixelId: c.metaPixelId || process.env.META_PIXEL_ID || "",
    metaAccessToken: c.metaAccessToken || process.env.META_ACCESS_TOKEN || "",
    // Same access token as above is used for both the Conversions API push
    // here and facebook_backend.js's Custom Audiences sync -- one Meta
    // System User token with ads_management scope covers both, so this is
    // the only place it's configured (facebook_backend.js reads it via
    // getConversionSettings() rather than having its own duplicate field).
    metaAdAccountId: c.metaAdAccountId || process.env.META_AD_ACCOUNT_ID || process.env.FACEBOOK_AD_ACCOUNT_ID || "",
    metaTestEventCode: c.metaTestEventCode || "",
    googleAdsCustomerId: c.googleAdsCustomerId || process.env.GOOGLE_ADS_CUSTOMER_ID || "",
    googleAdsDeveloperToken: c.googleAdsDeveloperToken || process.env.GOOGLE_ADS_DEVELOPER_TOKEN || "",
    googleAdsRefreshToken: c.googleAdsRefreshToken || process.env.GOOGLE_REFRESH_TOKEN_ADS || "",
    events: c.events || [],
  };
}
export function metaConfigured() {
  const s = getConversionSettings();
  return !!(s.metaPixelId && s.metaAccessToken);
}
export function googleAdsConfigured() {
  const s = getConversionSettings();
  return !!(s.googleAdsCustomerId && s.googleAdsDeveloperToken && s.googleAdsRefreshToken && process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

function hashPII(value) {
  const v = String(value || "").trim().toLowerCase();
  return v ? createHash("sha256").update(v).digest("hex") : null;
}
function getContact(id) {
  return readJson(CONTACTS_FILE, []).find(c => c.id === id) || null;
}

async function pushMetaConversion(eventDef, { email, phone }) {
  const s = getConversionSettings();
  if (!metaConfigured()) return { ok: false, reason: "meta_not_configured" };
  const userData = {};
  if (email) userData.em = [hashPII(email)];
  if (phone) userData.ph = [hashPII(String(phone).replace(/\D/g, ""))];
  if (!userData.em && !userData.ph) return { ok: false, reason: "no_identifiers" };

  const body = {
    data: [{
      event_name: eventDef.metaEventName || eventDef.label,
      event_time: Math.floor(Date.now() / 1000),
      action_source: "website",
      user_data: userData,
    }],
    ...(s.metaTestEventCode ? { test_event_code: s.metaTestEventCode } : {}),
  };
  try {
    const r = await fetch(`https://graph.facebook.com/v21.0/${s.metaPixelId}/events?access_token=${encodeURIComponent(s.metaAccessToken)}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, reason: d?.error?.message || `meta_http_${r.status}` };
    return { ok: true, result: d };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

async function getGoogleAdsAccessToken(refreshToken) {
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET, refresh_token: refreshToken, grant_type: "refresh_token" }),
  });
  const d = await r.json();
  if (!d.access_token) throw new Error("Google Ads token refresh failed: " + JSON.stringify(d));
  return d.access_token;
}

// Enhanced Conversions for Leads via ConversionUploadService, keyed by
// hashed email/phone -- no gclid needed. eventDef.googleConversionActionId
// must name a Conversion Action already created in Google Ads (Lee sets
// this up on Google's side once per event; this app has no way to create
// one via API).
async function pushGoogleConversion(eventDef, { email, phone }) {
  const s = getConversionSettings();
  if (!googleAdsConfigured()) return { ok: false, reason: "google_ads_not_configured" };
  if (!eventDef.googleConversionActionId) return { ok: false, reason: "no_conversion_action_configured" };
  if (!email && !phone) return { ok: false, reason: "no_identifiers" };

  const customerId = s.googleAdsCustomerId.replace(/\D/g, "");
  const userIdentifiers = [];
  if (email) userIdentifiers.push({ hashedEmail: hashPII(email) });
  if (phone) userIdentifiers.push({ hashedPhoneNumber: hashPII("+" + String(phone).replace(/\D/g, "")) });
  const now = new Date();
  const conversionDateTime = now.toISOString().slice(0, 19).replace("T", " ") + "+00:00";

  try {
    const accessToken = await getGoogleAdsAccessToken(s.googleAdsRefreshToken);
    const body = {
      conversions: [{
        conversionAction: `customers/${customerId}/conversionActions/${eventDef.googleConversionActionId}`,
        conversionDateTime,
        userIdentifiers,
      }],
      partialFailure: true,
    };
    const r = await fetch(`https://googleads.googleapis.com/v23/customers/${customerId}:uploadClickConversions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "developer-token": s.googleAdsDeveloperToken, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d.partialFailureError) return { ok: false, reason: d?.error?.message || d?.partialFailureError?.message || `google_http_${r.status}` };
    return { ok: true, result: d };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

// Public entry point -- called from anywhere a real conversion happens
// (currently: flows_backend.js's "send_conversion_event" step). Looks up
// the event definition by key, pushes to whichever platform(s) it's
// enabled for, degrades gracefully (returns ok:false, never throws) exactly
// like every other not-yet-configured integration in this app.
export async function pushConversionEvent(eventKey, contactId) {
  const s = getConversionSettings();
  const eventDef = s.events.find(e => e.key === eventKey);
  if (!eventDef) return { ok: false, reason: "unknown_event" };
  const contact = getContact(contactId);
  if (!contact) return { ok: false, reason: "contact_not_found" };
  const identifiers = { email: contact.email, phone: contact.phone };

  const results = {};
  if (eventDef.sendToMeta) results.meta = await pushMetaConversion(eventDef, identifiers);
  if (eventDef.sendToGoogle) results.google = await pushGoogleConversion(eventDef, identifiers);
  return { ok: true, results };
}

function slugifyKey(label) {
  return String(label || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "event";
}

export async function handleConversionsRequest(req, res, url) {
  const p = url.pathname;
  if (!p.startsWith("/api/conversions")) return false;
  const me = getSessionUser(req);
  if (!me) return sendJson(res, 401, { error: "Not logged in" });

  if (p === "/api/conversions/settings" && req.method === "GET") {
    const s = getConversionSettings();
    // Secrets come back as a "was it set" boolean, never the raw value --
    // the Settings form only overwrites a secret field when the admin
    // actually types a new one (see POST below), so this never needs to
    // round-trip the real token back into the browser.
    return sendJson(res, 200, {
      metaPixelId: s.metaPixelId, metaAccessTokenSet: !!s.metaAccessToken, metaTestEventCode: s.metaTestEventCode, metaAdAccountId: s.metaAdAccountId,
      googleAdsCustomerId: s.googleAdsCustomerId, googleAdsDeveloperTokenSet: !!s.googleAdsDeveloperToken, googleAdsRefreshTokenSet: !!s.googleAdsRefreshToken,
      events: s.events,
      metaConfigured: metaConfigured(), googleAdsConfigured: googleAdsConfigured(),
    });
  }

  if (p === "/api/conversions/settings" && req.method === "POST") {
    if (!isAdmin(me)) return sendJson(res, 403, { error: "Admins only" });
    const body = await readJsonBody(req);
    const all = readSettings();
    all.conversions = all.conversions || {};
    for (const k of ["metaPixelId", "metaTestEventCode", "googleAdsCustomerId", "metaAdAccountId"]) if (k in body) all.conversions[k] = String(body[k]).trim();
    // Secret fields only overwrite when a real (non-empty) value is sent --
    // an empty string means "left blank in the masked field", not "clear it".
    for (const k of ["metaAccessToken", "googleAdsDeveloperToken", "googleAdsRefreshToken"]) {
      if (k in body && String(body[k]).trim()) all.conversions[k] = String(body[k]).trim();
    }
    if (Array.isArray(body.events)) {
      all.conversions.events = body.events.map(e => ({
        id: e.id || randomUUID(),
        key: e.key || slugifyKey(e.label),
        label: e.label || "",
        metaEventName: e.metaEventName || "",
        sendToMeta: !!e.sendToMeta,
        googleConversionActionId: e.googleConversionActionId || "",
        sendToGoogle: !!e.sendToGoogle,
      }));
    }
    writeJson(INTEGRATIONS_FILE, all);
    return sendJson(res, 200, { ok: true });
  }

  if (p === "/api/conversions/test-send" && req.method === "POST") {
    if (!isAdmin(me)) return sendJson(res, 403, { error: "Admins only" });
    const { eventKey, email, phone } = await readJsonBody(req);
    const s = getConversionSettings();
    const eventDef = s.events.find(e => e.key === eventKey);
    if (!eventDef) return sendJson(res, 400, { error: "Unknown event" });
    if (!email && !phone) return sendJson(res, 400, { error: "email or phone is required" });
    // Fires both platforms regardless of the event's own enabled toggles --
    // this is a connectivity/payload check, not a real send.
    const results = {};
    results.meta = await pushMetaConversion(eventDef, { email, phone });
    results.google = await pushGoogleConversion(eventDef, { email, phone });
    return sendJson(res, 200, { ok: true, results });
  }

  return false;
}
