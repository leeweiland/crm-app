import { createHash } from "crypto";
import { sendJson, getSessionUser, readJson } from "./auth_backend.js";
import { getConversionSettings, getGoogleAdsAccessToken } from "./conversions_backend.js";

// Google Ads Customer Match lists -- the Google twin of facebook_backend.js's
// addToCustomAudience, used by the automation step "add_to_google_audience"
// (e.g. "1 ONLINE LEAD" adds every online opt-in to the Google list
// ONLINE EMAILS, next to its Meta ONLINE EMAILS step).
//
// Since 2026 Google refuses Customer Match uploads through the Google Ads API
// for this developer token ("Use the Data Manager API for Customer Match"),
// so members go in through datamanager.googleapis.com. That needs its own
// OAuth scope, so the refresh token is a separate one (Google Ads + Data
// Manager scopes, same GOOGLE_CLIENT_ID app), kept in
// crm_google_datamanager.json on the data volume (or the env var below).
// Listing the lists still uses the normal Google Ads API token.
const TOKEN_FILE = "crm_google_datamanager.json";
let cachedToken = null; // { token, exp }

function dataManagerRefreshToken() {
  return process.env.GOOGLE_DATAMANAGER_REFRESH_TOKEN || readJson(TOKEN_FILE, {}).refreshToken || "";
}
export function googleAudiencesConfigured() {
  const s = getConversionSettings();
  return !!(dataManagerRefreshToken() && s.googleAdsCustomerId && process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}
async function dataManagerAccessToken() {
  if (cachedToken && cachedToken.exp > Date.now() + 60000) return cachedToken.token;
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET, refresh_token: dataManagerRefreshToken(), grant_type: "refresh_token" }),
    signal: AbortSignal.timeout(15000),
  });
  const d = await r.json();
  if (!d.access_token) throw new Error("Google Data Manager token refresh failed: " + (d.error_description || d.error || r.status));
  cachedToken = { token: d.access_token, exp: Date.now() + (d.expires_in || 3600) * 1000 };
  return cachedToken.token;
}

// Google's Customer Match formatting: trimmed lowercase email (gmail.com /
// googlemail.com without dots or +suffix in the local part), phone in E.164,
// each SHA-256 hex.
const sha = (v) => createHash("sha256").update(v).digest("hex");
export function normGoogleEmail(email) {
  let e = String(email || "").trim().toLowerCase();
  if (!e.includes("@")) return "";
  const [local, domain] = e.split("@");
  if (domain === "gmail.com" || domain === "googlemail.com") e = local.split("+")[0].replace(/\./g, "") + "@" + domain;
  return e;
}
export function normGooglePhone(phone) {
  const d = String(phone || "").replace(/\D/g, "");
  if (d.length === 10) return "+1" + d;
  return d.length >= 11 ? "+" + d : "";
}
export function googleMember({ email, phone }) {
  const ids = [];
  const e = normGoogleEmail(email), p = normGooglePhone(phone);
  if (e) ids.push({ emailAddress: sha(e) });
  if (p) ids.push({ phoneNumber: sha(p) });
  return ids.length ? { userData: { userIdentifiers: ids } } : null;
}

// Adds people (up to 10,000 per call) to a Customer Match list by its numeric
// user list id.
export async function addToGoogleCustomerList(userListId, people) {
  if (!googleAudiencesConfigured() || !userListId) return { ok: false, reason: "google_audiences_not_configured" };
  const members = people.map(googleMember).filter(Boolean);
  if (!members.length) return { ok: false, reason: "no_identifiers" };
  const accountId = getConversionSettings().googleAdsCustomerId.replace(/\D/g, "");
  const token = await dataManagerAccessToken();
  let received = 0;
  for (let i = 0; i < members.length; i += 10000) {
    const r = await fetch("https://datamanager.googleapis.com/v1/audienceMembers:ingest", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        destinations: [{ operatingAccount: { accountType: "GOOGLE_ADS", accountId }, productDestinationId: String(userListId) }],
        audienceMembers: members.slice(i, i + 10000),
        consent: { adUserData: "CONSENT_GRANTED", adPersonalization: "CONSENT_GRANTED" },
        encoding: "HEX",
        termsOfService: { customerMatchTermsOfServiceStatus: "ACCEPTED" },
      }),
      signal: AbortSignal.timeout(60000),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, reason: body?.error?.message || `datamanager_http_${r.status}`, received };
    received += members.slice(i, i + 10000).length;
  }
  return { ok: true, received };
}

// Customer Match lists in the Google Ads account, for the builder's picker.
export async function listGoogleCustomerLists() {
  const s = getConversionSettings();
  if (!s.googleAdsCustomerId || !s.googleAdsDeveloperToken || !s.googleAdsRefreshToken) return { ok: false, reason: "google_ads_not_configured" };
  try {
    const token = await getGoogleAdsAccessToken(s.googleAdsRefreshToken);
    const cid = s.googleAdsCustomerId.replace(/\D/g, "");
    const r = await fetch(`https://googleads.googleapis.com/v25/customers/${cid}/googleAds:search`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "developer-token": s.googleAdsDeveloperToken, "Content-Type": "application/json" },
      body: JSON.stringify({ query: "SELECT user_list.id, user_list.name FROM user_list WHERE user_list.type = 'CRM_BASED' AND user_list.membership_status = 'OPEN'" }),
      signal: AbortSignal.timeout(20000),
    });
    const d = await r.json();
    if (!r.ok) return { ok: false, reason: d?.error?.message || `google_ads_http_${r.status}` };
    return { ok: true, lists: (d.results || []).map(x => ({ id: String(x.userList.id), name: x.userList.name })) };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

export async function handleGoogleAudienceRequest(req, res, url) {
  if (url.pathname !== "/api/google/customer-lists") return false;
  if (!getSessionUser(req)) return sendJson(res, 401, { error: "Not logged in" });
  const result = await listGoogleCustomerLists();
  return sendJson(res, result.ok ? 200 : 400, { ...result, configured: googleAudiencesConfigured() });
}
