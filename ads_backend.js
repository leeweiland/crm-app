import { readJson, writeJson, readJsonBody, sendJson, getSessionUser, isAdmin } from "./auth_backend.js";
import { getConversionSettings, getGoogleAdsAccessToken } from "./conversions_backend.js";
import { FLOWS_FILE, RUNS_FILE } from "./flows_backend.js";

export const INTEGRATIONS_FILE = "crm_integrations.json";

// Same real local-time-to-UTC conversion as scheduling_backend.js's
// localTimeToUTC (copied, not imported -- small and self-contained).
// resolveRange's own start/end already anchor to Anchorage's CALENDAR
// DATE for whole-day sheet-row matching, but reuse UTC-midnight-of-that-
// date-string as the instant, not true Anchorage midnight -- harmless for
// day-granularity sheet rows, but wrong by Anchorage's 8-9hr UTC offset
// for the millisecond-precision flow-run/contact timestamps this file
// also needs to bucket by day. Confirmed live: a 2026-09-13T03:10Z run
// (7:10pm Anchorage on the 12th) was being excluded from "today" (the
// 12th) entirely because of this gap.
function tzOffsetHours(atMs, timezone) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, timeZoneName: "shortOffset" }).formatToParts(new Date(atMs));
  const m = (parts.find(p => p.type === "timeZoneName")?.value || "GMT-8").match(/GMT([+-]\d+)/);
  return m ? parseInt(m[1], 10) : -8;
}
export function anchorageMidnightUTC(dateStr) {
  const offset = tzOffsetHours(Date.parse(dateStr + "T20:00:00Z"), "America/Anchorage");
  const [y, mo, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, mo - 1, d, -offset, 0));
}

// Spend/impressions/clicks come straight from Meta's and Google's own ad
// APIs (see fetchLiveMetaCampaigns/fetchLiveGoogleCampaigns below), using
// the same access token + ad account already configured for Conversions
// API push (Settings -> Tracking -> Meta box). This used to go through a
// Google Sheet fed by a third-party sync tool (Coupler.io) -- that tool's
// trial expired and silently stopped pulling data, which is what actually
// broke this, not the sheet-reading code itself. Direct API calls remove
// that whole dependency for the numbers that matter most (spend). Leads/
// bookings/closes/collected still come from the sheet below -- those are
// business data (opt-ins, sales), not something Meta/Google's ad APIs
// know about.
const DEFAULT_SHEET_ID = "17lYaad5YG0vAVX1Mj4hKkQspAgSxBAMWuASmOPKOXLU";

// Same "which program does this belong to" split as everywhere else in
// the app (contact.programType, sheet tab prefixes) -- but here it's a
// substring match against the actual campaign/ad-set NAME in Meta/Google's
// own account, since that's the only signal the ad platforms themselves
// expose. Confirmed live against this account's real campaign names
// (GYM, ONLINE, ONLINE RETARGETING, ...) -- anything not matching "gym"
// defaults to online rather than getting silently dropped.
function categorizeCampaign(name) {
  return /gym/i.test(name || "") ? "gym" : "online";
}

async function fetchLiveMetaCampaigns(startStr, endStr) {
  const { metaAccessToken, metaAdAccountId } = getConversionSettings();
  if (!metaAccessToken || !metaAdAccountId) return null;
  const acctPath = metaAdAccountId.startsWith("act_") ? metaAdAccountId : `act_${metaAdAccountId}`;
  const timeRange = encodeURIComponent(JSON.stringify({ since: startStr, until: endStr }));
  const r = await fetch(`https://graph.facebook.com/v21.0/${acctPath}/insights?level=campaign&fields=campaign_name,spend,impressions,clicks&time_range=${timeRange}&limit=500&access_token=${encodeURIComponent(metaAccessToken)}`);
  const d = await r.json();
  if (!r.ok) throw new Error(d?.error?.message || `meta_http_${r.status}`);
  return (d.data || []).map(row => ({ name: row.campaign_name, spend: Number(row.spend) || 0, impressions: Number(row.impressions) || 0, clicks: Number(row.clicks) || 0 }));
}

async function fetchLiveGoogleCampaigns(startStr, endStr) {
  const { googleAdsCustomerId, googleAdsDeveloperToken, googleAdsRefreshToken } = getConversionSettings();
  if (!googleAdsCustomerId || !googleAdsDeveloperToken || !googleAdsRefreshToken) return null;
  const accessToken = await getGoogleAdsAccessToken(googleAdsRefreshToken);
  const customerId = googleAdsCustomerId.replace(/\D/g, "");
  const query = `SELECT campaign.name, metrics.cost_micros, metrics.impressions, metrics.clicks FROM campaign WHERE segments.date BETWEEN '${startStr}' AND '${endStr}'`;
  const r = await fetch(`https://googleads.googleapis.com/v25/customers/${customerId}/googleAds:search`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "developer-token": googleAdsDeveloperToken, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d?.error?.[0]?.message || d?.error?.message || `google_http_${r.status}`);
  return (d.results || []).map(row => ({ name: row.campaign.name, spend: (Number(row.metrics.costMicros) || 0) / 1e6, impressions: Number(row.metrics.impressions) || 0, clicks: Number(row.metrics.clicks) || 0 }));
}

// Ad-level (not campaign-level) spend, WITH the adset/campaign names Meta's
// own Insights API already returns alongside it -- one call gets the full
// hierarchy + spend per ad, no separate Graph API object lookups needed.
// Keyed by ad_id, which is exactly the h_ad_id value this account's Meta
// URL Parameters template captures (Settings -> Tracking), so this maps
// 1:1 onto attributionKeyForVisit's meta-ad:<id> keys.
export async function fetchLiveMetaAdLevel(startStr, endStr) {
  const { metaAccessToken, metaAdAccountId } = getConversionSettings();
  if (!metaAccessToken || !metaAdAccountId) return null;
  const acctPath = metaAdAccountId.startsWith("act_") ? metaAdAccountId : `act_${metaAdAccountId}`;
  const timeRange = encodeURIComponent(JSON.stringify({ since: startStr, until: endStr }));
  const r = await fetch(`https://graph.facebook.com/v21.0/${acctPath}/insights?level=ad&fields=ad_id,ad_name,adset_name,campaign_name,spend,impressions,clicks&time_range=${timeRange}&limit=500&access_token=${encodeURIComponent(metaAccessToken)}`);
  const d = await r.json();
  if (!r.ok) throw new Error(d?.error?.message || `meta_http_${r.status}`);
  const byAdId = new Map();
  for (const row of d.data || []) {
    byAdId.set(String(row.ad_id), { name: row.ad_name || row.ad_id, adGroup: row.adset_name || "", campaign: row.campaign_name || "", spend: Number(row.spend) || 0, impressions: Number(row.impressions) || 0, clicks: Number(row.clicks) || 0 });
  }
  return byAdId;
}

// Same idea for Google -- ad_group_ad gives the ad's own id (matches this
// account's h_ad_id=creative template value), its ad group name (Google's
// "adset" equivalent), campaign name, and cost in one GAQL query.
export async function fetchLiveGoogleAdLevel(startStr, endStr) {
  const { googleAdsCustomerId, googleAdsDeveloperToken, googleAdsRefreshToken } = getConversionSettings();
  if (!googleAdsCustomerId || !googleAdsDeveloperToken || !googleAdsRefreshToken) return null;
  const accessToken = await getGoogleAdsAccessToken(googleAdsRefreshToken);
  const customerId = googleAdsCustomerId.replace(/\D/g, "");
  const query = `SELECT ad_group_ad.ad.id, ad_group_ad.ad.name, ad_group.name, campaign.name, metrics.cost_micros, metrics.impressions, metrics.clicks FROM ad_group_ad WHERE segments.date BETWEEN '${startStr}' AND '${endStr}'`;
  const r = await fetch(`https://googleads.googleapis.com/v25/customers/${customerId}/googleAds:search`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "developer-token": googleAdsDeveloperToken, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d?.error?.[0]?.message || d?.error?.message || `google_http_${r.status}`);
  const byAdId = new Map();
  for (const row of d.results || []) {
    const id = String(row.adGroupAd.ad.id);
    const existing = byAdId.get(id) || { name: row.adGroupAd.ad.name || id, adGroup: row.adGroup.name || "", campaign: row.campaign.name || "", spend: 0, impressions: 0, clicks: 0 };
    existing.spend += (Number(row.metrics.costMicros) || 0) / 1e6;
    existing.impressions += Number(row.metrics.impressions) || 0;
    existing.clicks += Number(row.metrics.clicks) || 0;
    byAdId.set(id, existing);
  }
  return byAdId;
}

// Name/ad set/campaign for ONE ad, by the ad ID a landing URL carried
// (h_ad_id) -- used to tell a lead which ad it came from. Reuses the two
// ad-level fetches above (last 30 days, which always includes an ad that
// just got a click) and caches every ad they return for 6 hours, so a burst
// of leads costs one API call, not one each. Returns null (never throws) if
// the platform isn't connected or the ad isn't in the window; a stale cached
// name is preferred over nothing when a refresh fails.
const AD_INFO_CACHE_FILE = "crm_ad_info_cache.json";
const AD_INFO_TTL_MS = 6 * 3600 * 1000;
const adInfoRefreshes = new Map();
export async function lookupAdInfo(platform, adId) {
  if (!adId || (platform !== "meta" && platform !== "google")) return null;
  const key = `${platform}:${adId}`;
  const hit = readJson(AD_INFO_CACHE_FILE, {})[key];
  if (hit && Date.now() - hit.at < AD_INFO_TTL_MS) return hit.info;
  if (!adInfoRefreshes.has(platform)) {
    adInfoRefreshes.set(platform, (async () => {
      const day = (ms) => new Date(ms).toISOString().slice(0, 10);
      const map = await (platform === "meta" ? fetchLiveMetaAdLevel : fetchLiveGoogleAdLevel)(day(Date.now() - 29 * 86400000), day(Date.now()));
      if (!map) return false;
      const cache = readJson(AD_INFO_CACHE_FILE, {});
      const now = Date.now();
      for (const [id, i] of map) cache[`${platform}:${id}`] = { at: now, info: { name: i.name, adGroup: i.adGroup, campaign: i.campaign } };
      writeJson(AD_INFO_CACHE_FILE, cache);
      return true;
    })().catch(e => { console.error(`[ads] ${platform} ad lookup failed:`, e.message); return false; }).finally(() => adInfoRefreshes.delete(platform)));
  }
  const refreshed = await adInfoRefreshes.get(platform);
  const cache = readJson(AD_INFO_CACHE_FILE, {});
  if (refreshed && !cache[key]) {
    // "Not found" is cached too, so an unknown/mistyped ad ID can't trigger an API call per lead.
    cache[key] = { at: Date.now(), info: null };
    writeJson(AD_INFO_CACHE_FILE, cache);
  }
  return cache[key]?.info ?? hit?.info ?? null;
}

// Diagnostic only -- the connected customer's own "AW-xxxxxxxxx" Google tag
// ID, so a gtag conversion snippet's send_to value (set once in Framer,
// years ago) can be checked against whichever Google Ads account is
// actually configured here right now. A brand-new account almost never
// shares its predecessor's AW- id, so a mismatch here means every
// conversion event on the site is still reporting into the OLD account,
// invisible to this one no matter how much real spend/clicks it gets.
export async function fetchGoogleAdsTagId() {
  const { googleAdsCustomerId, googleAdsDeveloperToken, googleAdsRefreshToken } = getConversionSettings();
  if (!googleAdsCustomerId || !googleAdsDeveloperToken || !googleAdsRefreshToken) return null;
  const accessToken = await getGoogleAdsAccessToken(googleAdsRefreshToken);
  const customerId = googleAdsCustomerId.replace(/\D/g, "");
  const query = `SELECT customer.id, customer.descriptive_name, customer.conversion_tracking_setting.conversion_tracking_id, customer.conversion_tracking_setting.google_ads_conversion_customer FROM customer LIMIT 1`;
  const r = await fetch(`https://googleads.googleapis.com/v25/customers/${customerId}/googleAds:search`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "developer-token": googleAdsDeveloperToken, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d?.error?.[0]?.message || d?.error?.message || `google_http_${r.status}`);
  const row = d.results?.[0]?.customer;
  return row ? { id: row.id, name: row.descriptiveName, awTagId: row.conversionTrackingSetting?.conversionTrackingId, googleAdsConversionCustomer: row.conversionTrackingSetting?.googleAdsConversionCustomer } : null;
}

// Merges Meta + Google campaign rows into the Online/Gym buckets the rest
// of this file already works in. Returns null (not thrown) when neither
// platform is configured, so fetchAdsReport can cleanly fall back to the
// sheet's own spend numbers instead of failing the whole report.
async function fetchLiveAdSpend(startStr, endStr) {
  // Caught independently -- one platform's failure (bad token, wrong ad
  // account, API error) shouldn't hide the other's real status, and
  // shouldn't silently zero out a platform that's actually configured
  // and working.
  const [metaSettled, googleSettled] = await Promise.allSettled([
    fetchLiveMetaCampaigns(startStr, endStr),
    fetchLiveGoogleCampaigns(startStr, endStr),
  ]);
  const metaRows = metaSettled.status === "fulfilled" ? metaSettled.value : null;
  const googleRows = googleSettled.status === "fulfilled" ? googleSettled.value : null;
  const metaError = metaSettled.status === "rejected" ? metaSettled.reason.message : null;
  const googleError = googleSettled.status === "rejected" ? googleSettled.reason.message : null;
  if (metaRows === null && googleRows === null) {
    throw new Error([metaError, googleError].filter(Boolean).join(" | ") || "neither platform configured");
  }
  const buckets = { online: { metaSpend: 0, googleSpend: 0, spend: 0, impressions: 0, clicks: 0 }, gym: { metaSpend: 0, googleSpend: 0, spend: 0, impressions: 0, clicks: 0 } };
  (metaRows || []).forEach(row => {
    const b = buckets[categorizeCampaign(row.name)];
    b.metaSpend += row.spend; b.spend += row.spend; b.impressions += row.impressions; b.clicks += row.clicks;
  });
  (googleRows || []).forEach(row => {
    const b = buckets[categorizeCampaign(row.name)];
    b.googleSpend += row.spend; b.spend += row.spend; b.impressions += row.impressions; b.clicks += row.clicks;
  });
  // Partial errors (one platform worked, the other threw) surface here
  // instead of vanishing -- a wrong number silently missing one platform
  // is worse than an ugly-but-honest error string next to real data.
  buckets.partialError = metaRows === null ? metaError : googleRows === null ? googleError : null;
  return buckets;
}

// Leads/bookings/applications used to come from the sheet's "NEW CRM"
// columns, which literally meant this app (vehosted.com is a custom
// domain pointing at this same crm-app) -- so this reads this app's own
// data directly instead of a spreadsheet snapshot of itself.
//
// Counting new contacts (by createdAt) badly undercounted leads: confirmed
// live against real lead-notification emails that most "new leads" are
// actually EXISTING contacts re-matched by email/phone (repeat form
// fills, already-imported people) -- their createdAt is from whenever
// they first appeared, not today, even though a real lead event happened
// today. The dedicated intake flows ("1 ONLINE LEAD", "1 GYM LEAD", "2
// GYM APPLICATION", "2 ONLINE BOOKING" -- confirmed live, these are this
// account's actual flow names) log a run with its own enteredAt on EVERY
// trigger firing, new-contact-or-not, so counting runs is the accurate
// "how many lead/application/booking events happened today" signal.
// Matched by name substring, not hardcoded flow IDs, so this doesn't
// silently go stale if a flow gets rebuilt with a new ID.
// The four conversion events, one entry per flow run (each run IS one event,
// with the contact it happened to). Both fetchCrmLeadsAndBookings' totals and
// the Ads Report's per-ad credit are built from this one list, so they can
// never disagree about what counts.
//   ONLINE EMAIL  = "ONLINE LEAD" flow    GYM EMAIL        = "GYM LEAD" flow
//   ONLINE BOOKING = "ONLINE BOOKING"     GYM APPLICATION  = "GYM APPLICATION"
// The emails are the ad platforms' "Registrations completed"; the booking/
// application events are their "Leads".
export const CRM_EVENTS = [
  { needle: "ONLINE LEAD", event: "ONLINE EMAIL", program: "online", kind: "emails" },
  { needle: "GYM LEAD", event: "GYM EMAIL", program: "gym", kind: "emails" },
  { needle: "ONLINE BOOKING", event: "ONLINE BOOKING", program: "online", kind: "bookM" },
  { needle: "GYM APPLICATION", event: "GYM APPLICATION", program: "gym", kind: "bookM" },
];
export function crmEventRuns(startMs, endMs) {
  const flows = readJson(FLOWS_FILE, []);
  const runs = readJson(RUNS_FILE, []);
  const findFlowId = (needle) => flows.find(f => (f.name || "").toUpperCase().includes(needle))?.id || null;
  const defs = CRM_EVENTS.map(d => ({ ...d, flowId: findFlowId(d.needle) })).filter(d => d.flowId);
  const out = [];
  for (const run of runs) {
    const enteredMs = new Date(run.enteredAt).getTime();
    if (enteredMs < startMs || enteredMs > endMs) continue;
    for (const d of defs) if (run.flowId === d.flowId) out.push({ contactId: run.contactId || null, event: d.event, program: d.program, kind: d.kind, atMs: enteredMs });
  }
  return out;
}
export function fetchCrmLeadsAndBookings(startMs, endMs) {
  const buckets = { online: { emails: 0, bookM: 0 }, gym: { emails: 0, bookM: 0 } };
  for (const e of crmEventRuns(startMs, endMs)) buckets[e.program][e.kind]++;
  return buckets;
}

// ── Closes / Sales / collected cash, straight from the CALLS TRACKING sheet ──
// The ads sheet's CLOSES / RENEWALS / COLLECTED / ALL columns are typed in by hand each day
// (its own header says so) and had gone unfilled since Aug 8, so the Overview read zeros --
// while every enrollment, payoff/renewal and travel payment is already recorded in CALLS
// TRACKING. Same definitions the ads sheet uses (checked against its hand-entered days, to
// the dollar): closes = "Enrolled" rows (ONLINE by Date Of Call, GYM by Applied Date);
// collected = their Amount Paid; all cash = collected + RENEWALS & PAYOFFS + TRAVEL amounts;
// sales = closes + renewals/payoffs rows.
const DEFAULT_CALLS_SHEET_ID = "1ue2wI4Nm5StnRhOSCYvMCjwiDMgqnWOuifGWbUQB92w";
const CALLS_TTL_MS = 5 * 60 * 1000;
let callsCache = null; // { at, data }
const SHEET_MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
// The sheet's dates are typed in many shapes ("August 4, 2026", "Thursday, September 17, 2026 at
// 5:00 PM", "2026-08-23 6:24:31", "9/2/26", "8/22"). A year-less "8/22" means the most recent one.
function parseSheetDate(raw) {
  const s = String(raw || "").trim();
  let m;
  const ymd = (y, mo, d) => (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) ? `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}` : null;
  if ((m = /(\d{4})-(\d\d)-(\d\d)/.exec(s))) return ymd(m[1], +m[2], +m[3]);
  if ((m = /([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})/.exec(s)) && SHEET_MONTHS[m[1].toLowerCase()]) return ymd(m[3], SHEET_MONTHS[m[1].toLowerCase()], +m[2]);
  if ((m = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/.exec(s))) {
    let y = m[3] ? Number(m[3]) : null;
    if (y != null && y < 100) y += 2000;
    if (y == null) {
      const now = new Date();
      y = now.getUTCFullYear();
      if (Date.UTC(y, +m[1] - 1, +m[2]) > now.getTime() + 14 * 86400000) y--;
    }
    return ymd(y, +m[1], +m[2]);
  }
  return null;
}
const sheetNum = (v) => { const n = Number(String(v ?? "").replace(/[$,\s]/g, "")); return Number.isFinite(n) ? n : 0; };
function callsCloses(rows, dateHeader) {
  const hdr = (rows[0] || []).map(c => String(c).trim().toLowerCase());
  const di = hdr.indexOf(dateHeader), ri = hdr.indexOf("result"), ai = hdr.indexOf("amount paid");
  if (di < 0 || ri < 0 || ai < 0) throw new Error(`CALLS TRACKING tab is missing a "${dateHeader}", "Result" or "Amount Paid" column`);
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!/^enrolled/i.test(String(r[ri] || "").trim())) continue;
    const d = parseSheetDate(r[di]);
    if (d) out.push({ d, amt: sheetNum(r[ai]) });
  }
  return out;
}
// RENEWALS & PAYOFFS and TRAVEL tabs: FIRST | LAST | DATE | AMOUNT
function callsPayments(rows) {
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const d = parseSheetDate(rows[i][2]), amt = sheetNum(rows[i][3]);
    if (d && amt) out.push({ d, amt });
  }
  return out;
}
async function loadCallsTracking() {
  if (callsCache && Date.now() - callsCache.at < CALLS_TTL_MS) return callsCache.data;
  try {
    const { clientId, clientSecret, refreshToken } = googleCreds();
    if (!clientId || !clientSecret || !refreshToken) throw new Error("Google Sheets isn't configured");
    const tr = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: "refresh_token" }),
      signal: AbortSignal.timeout(15000),
    });
    const accessToken = (await tr.json()).access_token;
    if (!accessToken) throw new Error("Google token refresh failed");
    const id = readSettings().ads?.callsSheetId || DEFAULT_CALLS_SHEET_ID;
    const ranges = ["'ONLINE'!A1:P6000", "'GYM'!A1:P6000", "'ONLINE RENEWALS & PAYOFFS'!A1:D3000", "'ONLINE TRAVEL'!A1:D3000", "'GYM RENEWALS & PAYOFFS'!A1:D3000", "'GYM TRAVEL'!A1:D3000"];
    const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${id}/values:batchGet?valueRenderOption=FORMATTED_VALUE&${ranges.map(x => "ranges=" + encodeURIComponent(x)).join("&")}`, {
      headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(30000),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d?.error?.message || `sheets_http_${r.status}`);
    const v = (d.valueRanges || []).map(x => x.values || []);
    const data = {
      online: { closes: callsCloses(v[0] || [], "date of call"), renew: callsPayments(v[2] || []), travel: callsPayments(v[3] || []) },
      gym: { closes: callsCloses(v[1] || [], "applied date"), renew: callsPayments(v[4] || []), travel: callsPayments(v[5] || []) },
    };
    callsCache = { at: Date.now(), data };
    return data;
  } catch (e) {
    if (callsCache && Date.now() - callsCache.at < 3600000) return callsCache.data; // a brief Google/sheet hiccup shouldn't blank the cards
    throw e;
  }
}
export async function fetchCallsTrackingSales(startStr, endStr) {
  const data = await loadCallsTracking();
  const within = (a) => a.filter(x => x.d >= startStr && x.d <= endStr);
  const sum = (a) => a.reduce((s, x) => s + x.amt, 0);
  const build = (p) => {
    const c = within(p.closes), rn = within(p.renew), tv = within(p.travel), coll = sum(c);
    return { closes: c.length, sales: c.length + rn.length, coll, all: coll + sum(rn) + sum(tv) };
  };
  return { online: build(data.online), gym: build(data.gym) };
}

function readSettings() {
  return readJson(INTEGRATIONS_FILE, { ads: {} });
}
function getAdsSettings() {
  const a = readSettings().ads || {};
  return {
    sheetId: a.sheetId || DEFAULT_SHEET_ID,
    onlinePrefix: a.onlinePrefix || "ONLINE",
    gymPrefix: a.gymPrefix || "GYM",
    // One or more Coupler.io "incoming webhook" URLs (one per data flow --
    // e.g. separate Online/Gym or Meta/Google flows), newline or comma
    // separated. Coupler.io flows run on their own daily schedule already;
    // this just lets the Manual Update button ask for an out-of-schedule
    // run up to right now, without touching that schedule.
    couplerWebhookUrls: a.couplerWebhookUrls || "",
  };
}

// Fire-and-wait, not fire-and-forget -- the caller (the Manual Update
// button) needs the flows to have actually STARTED before it re-reads the
// sheet, but a Coupler.io flow run itself can take well past any request
// timeout, so this only confirms the trigger was accepted, never waits for
// the flow to finish. The frontend adds its own delay before re-fetching.
async function triggerCouplerRefresh() {
  const { couplerWebhookUrls } = getAdsSettings();
  const urls = couplerWebhookUrls.split(/[\n,]/).map(u => u.trim()).filter(Boolean);
  if (!urls.length) return { ok: false, reason: "no_webhooks_configured" };
  const results = await Promise.all(urls.map(async (url) => {
    try {
      const r = await fetch(url, { method: "POST" });
      return { url, ok: r.ok, status: r.status };
    } catch (e) {
      return { url, ok: false, reason: e.message };
    }
  }));
  return { ok: results.every(r => r.ok), triggered: results };
}

// Same in-app-settings pattern as SES/Twilio (Settings -> paste into a form
// field, stored here) -- GOOGLE_CLIENT_ID/SECRET are already in this app's
// own .env (added for the Scheduling feature); the Sheets refresh token
// gets added via Settings -> Ads.
function googleCreds() {
  const a = readSettings().ads || {};
  return {
    clientId: a.googleClientId || process.env.GOOGLE_CLIENT_ID || "",
    clientSecret: a.googleClientSecret || process.env.GOOGLE_CLIENT_SECRET || "",
    refreshToken: a.googleRefreshToken || process.env.GOOGLE_REFRESH_TOKEN_LW || "",
  };
}

// ── Date-range math -- exact same presets/logic as the existing
// ads-dashboard.html app, anchored to America/Anchorage wall-clock "today"
// (the business runs on Anchorage time; pure UTC "today" flips over while
// it's still afternoon in Anchorage). ─────────────────────────────────────
export const AD_PERIODS = [
  { value: "today", label: "Today" },
  { value: "yesterday", label: "Yesterday" },
  { value: "last7", label: "Last 7 Days" },
  { value: "week1", label: "1st Week of the Month" },
  { value: "week2", label: "2nd Week of the Month" },
  { value: "week3", label: "3rd Week of the Month" },
  { value: "week4", label: "4th Week of the Month" },
  { value: "week5", label: "5th Week of the Month" },
  { value: "month", label: "Current Month" },
  { value: "last30", label: "Last 30 Days" },
  { value: "last60", label: "Last 60 Days" },
  { value: "last90", label: "Last 90 Days" },
  { value: "last180", label: "Last 180 Days" },
  { value: "last365", label: "Last 365 Days" },
  { value: "lastyear", label: "Last Year (Year to Date)" },
  { value: "custom", label: "Custom Date Range..." },
];

function resolveRange(period, customStart, customEnd) {
  const now = new Date();
  const anchorageTodayStr = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Anchorage", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const todayUTC = new Date(anchorageTodayStr + "T00:00:00Z");
  const yesterday = new Date(todayUTC.getTime() - 86400000);
  const addDays = (d, n) => new Date(d.getTime() + n * 86400000);
  const y0 = yesterday.getUTCFullYear(), m0 = yesterday.getUTCMonth();
  const mk = (yy, mm, dd) => new Date(Date.UTC(yy, mm, dd));
  const eom = (yy, mm) => new Date(Date.UTC(yy, mm + 1, 0));

  if (period === "custom") {
    return [
      new Date((customStart || yesterday.toISOString().slice(0, 10)) + "T00:00:00Z"),
      new Date((customEnd || yesterday.toISOString().slice(0, 10)) + "T00:00:00Z"),
    ];
  }
  const RANGES = {
    today: () => [todayUTC, todayUTC],
    yesterday: () => [yesterday, yesterday],
    last7: () => [addDays(yesterday, -6), yesterday],
    week1: () => [mk(y0, m0, 1), mk(y0, m0, 7)],
    week2: () => [mk(y0, m0, 8), mk(y0, m0, 14)],
    week3: () => [mk(y0, m0, 15), mk(y0, m0, 21)],
    week4: () => [mk(y0, m0, 22), mk(y0, m0, 28)],
    week5: () => [mk(y0, m0, 29), eom(y0, m0)],
    month: () => [mk(y0, m0, 1), eom(y0, m0)],
    last30: () => [addDays(yesterday, -29), yesterday],
    last60: () => [addDays(yesterday, -59), yesterday],
    last90: () => [addDays(yesterday, -89), yesterday],
    last180: () => [addDays(yesterday, -179), yesterday],
    last365: () => [addDays(yesterday, -364), yesterday],
    lastyear: () => [mk(y0, 0, 1), yesterday],
  };
  if (!RANGES[period]) throw new Error("Unknown period: " + period);
  return RANGES[period]();
}

const COLS = { spend: 1, metaSpend: 2, googleSpend: 3, emails: 9, bookM: 14, closes: 20, renewals: 21, coll: 23, all: 24 };
function serialToDate(serial) { return new Date(Date.UTC(1899, 11, 30) + Math.round(serial) * 86400000); }
function zero() { return { spend: 0, metaSpend: 0, googleSpend: 0, emails: 0, bookM: 0, closes: 0, sales: 0, coll: 0, all: 0 }; }

async function fetchAdsReport(period, customStart, customEnd) {
  const { sheetId, onlinePrefix, gymPrefix } = getAdsSettings();
  const [start, end] = resolveRange(period, customStart, customEnd);
  const startStr = start.toISOString().slice(0, 10), endStr = end.toISOString().slice(0, 10);

  const monthLabels = [];
  { let cur = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
    const last = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));
    while (cur <= last) {
      monthLabels.push(cur.toLocaleString("en-US", { month: "long", timeZone: "UTC" }).toUpperCase() + " " + cur.getUTCFullYear());
      cur = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() + 1, 1));
    }
  }

  // Live spend runs alongside the sheet fetch below, not instead of it --
  // leads/bookings/closes/collected aren't ad-platform data, so the sheet
  // (or whatever eventually replaces it for those fields) still supplies
  // those. If this fails or isn't configured, spend below just falls back
  // to whatever's in the sheet, same as before.
  let liveSpendError = null;
  const liveSpendPromise = fetchLiveAdSpend(startStr, endStr).catch(e => { liveSpendError = e.message; return null; });

  const { clientId, clientSecret, refreshToken } = googleCreds();
  const sheetConfigured = !!(clientId && clientSecret && refreshToken);
  let onlineResult = { exists: false, data: zero() }, gymResult = { exists: false, data: zero() }, sheetError = null;

  if (sheetConfigured) {
    try {
      const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: "refresh_token" }),
      });
      const tokenData = await tokenRes.json();
      if (!tokenData.access_token) throw new Error("Google token refresh failed");
      const accessToken = tokenData.access_token;

      const fetchMonthTab = async (prefix, monthLabel) => {
        const sheetName = `${prefix} ${monthLabel}`;
        const range = encodeURIComponent(`'${sheetName}'!A10:AB41`);
        const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}?valueRenderOption=UNFORMATTED_VALUE`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        const data = await r.json();
        return data.values || null;
      };

      const aggregate = async (prefix) => {
        const tabResults = await Promise.all(monthLabels.map(label => fetchMonthTab(prefix, label)));
        const out = zero();
        let anyExists = false;
        tabResults.forEach(rows => {
          if (!rows) return;
          anyExists = true;
          for (const row of rows) {
            const dateSerial = row[0];
            if (dateSerial == null || typeof dateSerial !== "number") continue;
            const d = serialToDate(dateSerial);
            if (d < start || d > end) continue;
            const closes = Number(row[COLS.closes]) || 0;
            const renewals = Number(row[COLS.renewals]) || 0;
            out.spend += Number(row[COLS.spend]) || 0;
            out.metaSpend += Number(row[COLS.metaSpend]) || 0;
            out.googleSpend += Number(row[COLS.googleSpend]) || 0;
            out.emails += Number(row[COLS.emails]) || 0;
            out.bookM += Number(row[COLS.bookM]) || 0;
            out.closes += closes;
            out.sales += closes + renewals;
            out.coll += Number(row[COLS.coll]) || 0;
            out.all += Number(row[COLS.all]) || 0;
          }
        });
        return { exists: anyExists, data: out };
      };

      [onlineResult, gymResult] = await Promise.all([aggregate(onlinePrefix), aggregate(gymPrefix)]);
    } catch (e) {
      sheetError = e;
    }
  }

  const liveSpend = await liveSpendPromise;
  if (!liveSpend && (!sheetConfigured || sheetError)) {
    throw sheetError || new Error("Neither Meta/Google Ads API access (Settings -> Tracking) nor the Ads Google Sheet (Settings -> Ads) is configured.");
  }

  const o = onlineResult.data, g = gymResult.data;
  if (liveSpend) {
    // Overwrites spend/metaSpend/googleSpend with live numbers; leaves
    // closes/sales/coll/all (not ad-platform, not yet migrated off the
    // sheet) exactly as the sheet reported, or at zero if unavailable.
    Object.assign(o, liveSpend.online);
    Object.assign(g, liveSpend.gym);
  }
  // True Anchorage-midnight-to-UTC boundaries (see anchorageMidnightUTC),
  // not start/end's own UTC-midnight-of-the-date-string shortcut -- that
  // shortcut is fine for the sheet's whole-day rows above, but wrong by
  // Anchorage's UTC offset for these millisecond-precision timestamps.
  const crmStartMs = anchorageMidnightUTC(startStr).getTime();
  const crmEndMs = anchorageMidnightUTC(endStr).getTime() + 86400000 - 1;
  const crmData = fetchCrmLeadsAndBookings(crmStartMs, crmEndMs);
  Object.assign(o, crmData.online);
  Object.assign(g, crmData.gym);
  // Closes/Sales/collected cash come from CALLS TRACKING (see above); if it can't be read, the ads
  // sheet's hand-entered columns already loaded above stay in place.
  let salesSource = "ads-sheet", salesError = null;
  try {
    const calls = await fetchCallsTrackingSales(startStr, endStr);
    Object.assign(o, calls.online);
    Object.assign(g, calls.gym);
    salesSource = "calls-tracking";
  } catch (e) { salesError = e.message; }
  const combined = {
    spend: o.spend + g.spend, metaSpend: o.metaSpend + g.metaSpend, googleSpend: o.googleSpend + g.googleSpend,
    emails: o.emails + g.emails,
    bookM: o.bookM + g.bookM,
    closes: o.closes + g.closes, sales: o.sales + g.sales, coll: o.coll + g.coll, all: o.all + g.all,
  };

  return {
    ok: true, period, start: startStr, end: endStr, monthLabels,
    onlineSheetExists: onlineResult.exists, gymSheetExists: gymResult.exists,
    liveSpendUsed: !!liveSpend, liveSpendError: liveSpend?.partialError || liveSpendError,
    salesSource, salesError,
    online: o, gym: g, combined,
  };
}

export async function handleAdsRequest(req, res, url) {
  const p = url.pathname;
  if (!p.startsWith("/api/ads")) return false;
  const me = getSessionUser(req);
  if (!me) return sendJson(res, 401, { error: "Not logged in" });

  if (p === "/api/ads/periods" && req.method === "GET") {
    return sendJson(res, 200, { periods: AD_PERIODS });
  }

  if (p === "/api/ads/config-status" && req.method === "GET") {
    const { clientId, clientSecret, refreshToken } = googleCreds();
    // couplerWebhookUrls holds live trigger URLs -- kept out of this
    // any-logged-in-user endpoint the same way googleRefreshToken already
    // is (a "was it set" boolean only, not the value itself).
    const { couplerWebhookUrls, ...adsSettings } = getAdsSettings();
    return sendJson(res, 200, { configured: !!(clientId && clientSecret && refreshToken), tokenSaved: !!refreshToken, couplerWebhookUrlsSet: !!couplerWebhookUrls, ...adsSettings });
  }

  if (p === "/api/ads/settings" && req.method === "POST") {
    if (!isAdmin(me)) return sendJson(res, 403, { error: "Admins only" });
    const body = await readJsonBody(req);
    const all = readSettings();
    all.ads = all.ads || {};
    for (const k of ["sheetId", "onlinePrefix", "gymPrefix", "googleRefreshToken"]) if (k in body) all.ads[k] = String(body[k]).trim();
    // Not returned by config-status (see that handler) -- only overwrite
    // when the admin actually typed something, same "blank means untouched"
    // rule as every masked secret field in this app.
    if ("couplerWebhookUrls" in body && String(body.couplerWebhookUrls).trim()) all.ads.couplerWebhookUrls = String(body.couplerWebhookUrls).trim();
    writeJson(INTEGRATIONS_FILE, all);
    return sendJson(res, 200, { ok: true });
  }

  if (p === "/api/ads/manual-update" && req.method === "POST") {
    if (!isAdmin(me)) return sendJson(res, 403, { error: "Admins only" });
    const result = await triggerCouplerRefresh();
    return sendJson(res, 200, result);
  }

  if (p === "/api/ads/google-tag-id" && req.method === "GET") {
    if (!isAdmin(me)) return sendJson(res, 403, { error: "Admins only" });
    try {
      const info = await fetchGoogleAdsTagId();
      return sendJson(res, 200, { ok: true, info });
    } catch (e) {
      return sendJson(res, 200, { ok: false, error: e.message });
    }
  }

  if (p === "/api/ads/report" && req.method === "GET") {
    try {
      const period = url.searchParams.get("period") || "yesterday";
      const start = url.searchParams.get("start");
      const end = url.searchParams.get("end");
      const report = await fetchAdsReport(period, start, end);
      return sendJson(res, 200, report);
    } catch (e) {
      return sendJson(res, 200, { ok: false, error: e.message });
    }
  }

  return false;
}
