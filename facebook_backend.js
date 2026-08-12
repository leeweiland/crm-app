import { createHash } from "crypto";
import { sendJson, getSessionUser } from "./auth_backend.js";

// Facebook Marketing API Custom Audiences integration -- Lee hasn't created
// the Facebook app/access token yet, so this degrades gracefully exactly
// like email_backend.js's SES client and sms_backend.js's Twilio client:
// automations can still add an "Add to Custom Audience" step and save it,
// the step just no-ops (and is visible as such) until FACEBOOK_ACCESS_TOKEN
// is set in .env.
export function facebookConfigured() {
  return !!(process.env.FACEBOOK_ACCESS_TOKEN && process.env.FACEBOOK_AD_ACCOUNT_ID);
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

  const url = `https://graph.facebook.com/v19.0/${audienceId}/users?access_token=${encodeURIComponent(process.env.FACEBOOK_ACCESS_TOKEN)}`;
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

export async function handleFacebookRequest(req, res, url) {
  const p = url.pathname;
  if (p !== "/api/facebook/config-status") return false;
  const me = getSessionUser(req);
  if (!me) return sendJson(res, 401, { error: "Not logged in" });
  return sendJson(res, 200, { configured: facebookConfigured() });
}
