import { createHash } from "crypto";
import { sendJson, getSessionUser } from "./auth_backend.js";
import { getConversionSettings } from "./conversions_backend.js";

// Facebook Marketing API Custom Audiences integration -- degrades
// gracefully exactly like email_backend.js's SES client and
// sms_backend.js's Twilio client: automations can still add an "Add to
// Custom Audience" step and save it, the step just no-ops (and is visible
// as such) until a Meta access token is configured. Reuses the same
// Settings -> Tracking -> Meta access token as conversions_backend.js
// (one System User token with ads_management scope covers both Conversions
// API and Custom Audiences) rather than a second, duplicate credential.
export function facebookConfigured() {
  const s = getConversionSettings();
  return !!(s.metaAccessToken && s.metaAdAccountId);
}

// Facebook requires PII (email/phone) to be lowercased, trimmed, and
// SHA-256 hashed before being sent -- never send raw PII to the Custom
// Audiences endpoint.
function hashPII(value) {
  return createHash("sha256").update(String(value || "").trim().toLowerCase()).digest("hex");
}

export async function addToCustomAudience({ email, phone, audienceId }) {
  if (!facebookConfigured() || !audienceId) return { ok: false, reason: "facebook_not_configured" };
  const schema = [];
  const data = [];
  if (email) { schema.push("EMAIL"); }
  if (phone) { schema.push("PHONE"); }
  if (!schema.length) return { ok: false, reason: "no_identifiers" };
  data.push(schema.map(field => field === "EMAIL" ? hashPII(email) : hashPII(phone)));

  const { metaAccessToken } = getConversionSettings();
  const url = `https://graph.facebook.com/v19.0/${audienceId}/users?access_token=${encodeURIComponent(metaAccessToken)}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ payload: { schema, data } }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, reason: body?.error?.message || `facebook_http_${res.status}` };
    return { ok: true, result: body };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

// Lets a step's "which audience?" field be filled in by name instead of
// hunting for the numeric Custom Audience ID in Ads Manager by hand.
export async function listCustomAudiences() {
  if (!facebookConfigured()) return { ok: false, reason: "facebook_not_configured" };
  const { metaAccessToken, metaAdAccountId } = getConversionSettings();
  const acctPath = String(metaAdAccountId).startsWith("act_") ? metaAdAccountId : `act_${metaAdAccountId}`;
  const url = `https://graph.facebook.com/v19.0/${acctPath}/customaudiences?fields=id,name&limit=200&access_token=${encodeURIComponent(metaAccessToken)}`;
  try {
    const res = await fetch(url);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, reason: body?.error?.message || `facebook_http_${res.status}` };
    return { ok: true, audiences: body.data || [] };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

export async function handleFacebookRequest(req, res, url) {
  const p = url.pathname;
  if (p !== "/api/facebook/config-status" && p !== "/api/facebook/audiences") return false;
  const me = getSessionUser(req);
  if (!me) return sendJson(res, 401, { error: "Not logged in" });
  if (p === "/api/facebook/config-status") {
    return sendJson(res, 200, { configured: facebookConfigured() });
  }
  const result = await listCustomAudiences();
  return sendJson(res, result.ok ? 200 : 400, result);
}
