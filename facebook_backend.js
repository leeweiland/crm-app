import { createHash } from "crypto";
import { sendJson, getSessionUser, readJson, writeJson } from "./auth_backend.js";
import { getConversionSettings } from "./conversions_backend.js";

const AUDIENCE_MEMBERS_FILE = "crm_fb_audience_members.json";
const GRAPH = "https://graph.facebook.com/v19.0";

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
// Meta matches phones as digits with country code ("19075551234"), so a
// formatted "(907) 555-1234" hashed as-is never matches anyone.
export function normPhone(phone) {
  const d = String(phone || "").replace(/\D/g, "");
  return d.length === 10 ? "1" + d : d;
}

export async function addToCustomAudience({ email, phone, audienceId }) {
  if (!facebookConfigured() || !audienceId) return { ok: false, reason: "facebook_not_configured" };
  const schema = [];
  const data = [];
  if (email) { schema.push("EMAIL"); }
  if (phone) { schema.push("PHONE"); }
  if (!schema.length) return { ok: false, reason: "no_identifiers" };
  data.push(schema.map(field => field === "EMAIL" ? hashPII(email) : hashPII(normPhone(phone))));

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

export async function createCustomAudience(name, description = "") {
  if (!facebookConfigured()) return { ok: false, reason: "facebook_not_configured" };
  const { metaAccessToken, metaAdAccountId } = getConversionSettings();
  const acctPath = String(metaAdAccountId).startsWith("act_") ? metaAdAccountId : `act_${metaAdAccountId}`;
  const res = await fetch(`${GRAPH}/${acctPath}/customaudiences?access_token=${encodeURIComponent(metaAccessToken)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, description, subtype: "CUSTOM", customer_file_source: "USER_PROVIDED_ONLY" }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, reason: body?.error?.message || `facebook_http_${res.status}` };
  return { ok: true, id: body.id };
}

// ── Rolling audiences ("add now, remove after N days, but never drop below a
// floor"). Meta only reports a fuzzy audience size, so who is in each
// audience is tracked here: one record per person per audience, removedAt
// set once they've actually been deleted from the Meta audience.
function memberKey({ email, phone }) {
  const e = String(email || "").trim().toLowerCase();
  if (e) return e;
  const p = normPhone(phone);
  return p ? `p:${p}` : "";
}
function audienceRows(people) {
  return people.map(p => [p.email ? hashPII(p.email) : "", p.phone ? hashPII(normPhone(p.phone)) : ""]);
}
async function audienceUsersCall(method, audienceId, people) {
  const { metaAccessToken } = getConversionSettings();
  for (let i = 0; i < people.length; i += 5000) {
    const res = await fetch(`${GRAPH}/${audienceId}/users?access_token=${encodeURIComponent(metaAccessToken)}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ payload: { schema: ["EMAIL", "PHONE"], data: audienceRows(people.slice(i, i + 5000)) } }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, reason: body?.error?.message || `facebook_http_${res.status}` };
  }
  return { ok: true };
}

// Every membership change for an audience runs one at a time, so two flow
// runs finishing together can't both read the same count and over-remove.
const audienceLocks = new Map();
function withAudienceLock(audienceId, fn) {
  const prev = audienceLocks.get(audienceId) || Promise.resolve();
  const result = prev.catch(() => {}).then(fn);
  audienceLocks.set(audienceId, result.catch(() => {}));
  return result;
}

export function getAudienceMembers(audienceId) {
  return (readJson(AUDIENCE_MEMBERS_FILE, {})[audienceId] || []);
}

// people: [{ email, phone, first, last, contactId, addedAt?, windowEndedAt? }].
// Someone already active in the audience is left as-is (no duplicate record).
// Returns the records newly added.
export function addPeopleToAudience(audienceId, people) {
  return withAudienceLock(audienceId, async () => {
    if (!facebookConfigured() || !audienceId) return { ok: false, reason: "facebook_not_configured", added: [] };
    const all = readJson(AUDIENCE_MEMBERS_FILE, {});
    const members = all[audienceId] || [];
    const activeKeys = new Set(members.filter(m => !m.removedAt).map(m => m.key));
    const fresh = [];
    for (const p of people) {
      const key = memberKey(p);
      if (!key || activeKeys.has(key)) continue;
      activeKeys.add(key);
      fresh.push({
        key, email: String(p.email || "").trim().toLowerCase(), phone: p.phone ? normPhone(p.phone) : "",
        first: p.first || "", last: p.last || "", contactId: p.contactId || null,
        addedAt: p.addedAt || new Date().toISOString(), windowEndedAt: p.windowEndedAt || null, removedAt: null,
      });
    }
    if (!fresh.length) return { ok: true, added: [] };
    const r = await audienceUsersCall("POST", audienceId, fresh);
    if (!r.ok) return { ...r, added: [] };
    const latest = readJson(AUDIENCE_MEMBERS_FILE, {});
    latest[audienceId] = [...(latest[audienceId] || []), ...fresh];
    writeJson(AUDIENCE_MEMBERS_FILE, latest);
    return { ok: true, added: fresh };
  });
}

// Marks this person's window as over, then removes the oldest people whose
// window is over -- but only as many as keeps at least keepAtLeast in the
// audience. Returns who was actually removed and whether this person stayed.
export function endWindowAndTrim(audienceId, person, keepAtLeast) {
  return withAudienceLock(audienceId, async () => {
    if (!facebookConfigured() || !audienceId) return { ok: false, reason: "facebook_not_configured", removed: [] };
    const all = readJson(AUDIENCE_MEMBERS_FILE, {});
    const members = all[audienceId] || [];
    const key = person ? memberKey(person) : "";
    const now = new Date().toISOString();
    for (const m of members) if (key && m.key === key && !m.removedAt && !m.windowEndedAt) m.windowEndedAt = now;
    writeJson(AUDIENCE_MEMBERS_FILE, all);

    // windowEndedAt can be in the future for a backfilled person (set to
    // their own date + 7 days) -- they're still in their window until then.
    const active = members.filter(m => !m.removedAt);
    const excess = active.length - Math.max(0, Number(keepAtLeast) || 0);
    const toRemove = excess > 0
      ? active.filter(m => m.windowEndedAt && m.windowEndedAt <= now).sort((a, b) => new Date(a.addedAt) - new Date(b.addedAt)).slice(0, excess)
      : [];
    if (toRemove.length) {
      const r = await audienceUsersCall("DELETE", audienceId, toRemove);
      if (!r.ok) return { ...r, removed: [] };
      const latest = readJson(AUDIENCE_MEMBERS_FILE, {});
      const removeKeys = new Set(toRemove.map(m => m.key));
      for (const m of latest[audienceId] || []) if (!m.removedAt && removeKeys.has(m.key)) m.removedAt = now;
      writeJson(AUDIENCE_MEMBERS_FILE, latest);
    }
    const removed = toRemove.map(m => ({ ...m, removedAt: now }));
    return { ok: true, removed, personKept: !!key && !removed.some(m => m.key === key), activeCount: active.length - removed.length };
  });
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
