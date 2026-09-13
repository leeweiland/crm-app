import { readJson, writeJson, readJsonBody, sendJson, getSessionUser, isAdmin } from "./auth_backend.js";
import { getConversionSettings, getGoogleAdsAccessToken } from "./conversions_backend.js";

export const INTEGRATIONS_FILE = "crm_integrations.json";

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
    // emails/bookM/closes/sales/coll/all (not ad-platform data) exactly as
    // the sheet reported, or at zero if the sheet itself isn't available.
    Object.assign(o, liveSpend.online);
    Object.assign(g, liveSpend.gym);
  }
  const combined = {
    spend: o.spend + g.spend, metaSpend: o.metaSpend + g.metaSpend, googleSpend: o.googleSpend + g.googleSpend,
    emails: o.emails + g.emails,
    bookM: o.bookM + g.emails, // matches ads-dashboard.html's GYM_KEYS quirk -- see comment there
    closes: o.closes + g.closes, sales: o.sales + g.sales, coll: o.coll + g.coll, all: o.all + g.all,
  };

  return {
    ok: true, period, start: startStr, end: endStr, monthLabels,
    onlineSheetExists: onlineResult.exists, gymSheetExists: gymResult.exists,
    liveSpendUsed: !!liveSpend, liveSpendError: liveSpend?.partialError || liveSpendError,
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
