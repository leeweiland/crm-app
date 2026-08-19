import { readJson, writeJson, readJsonBody, sendJson, getSessionUser, isAdmin } from "./auth_backend.js";

export const INTEGRATIONS_FILE = "crm_integrations.json";

// The ad-spend numbers live in a Google Sheet. This module reads it
// natively (same sheet, same math another internal tool already uses) so
// the CRM's Ads tab is self-contained.
const DEFAULT_SHEET_ID = "17lYaad5YG0vAVX1Mj4hKkQspAgSxBAMWuASmOPKOXLU";

function readSettings() {
  return readJson(INTEGRATIONS_FILE, { ads: {} });
}
function getAdsSettings() {
  const a = readSettings().ads || {};
  return {
    sheetId: a.sheetId || DEFAULT_SHEET_ID,
    onlinePrefix: a.onlinePrefix || "ONLINE",
    gymPrefix: a.gymPrefix || "GYM",
  };
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

  const monthLabels = [];
  { let cur = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
    const last = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));
    while (cur <= last) {
      monthLabels.push(cur.toLocaleString("en-US", { month: "long", timeZone: "UTC" }).toUpperCase() + " " + cur.getUTCFullYear());
      cur = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() + 1, 1));
    }
  }

  const { clientId, clientSecret, refreshToken } = googleCreds();
  if (!clientId || !clientSecret || !refreshToken) throw new Error("Google Sheets isn't connected yet -- add the refresh token in Settings -> Ads.");

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: "refresh_token" }),
  });
  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) throw new Error("Google token refresh failed");
  const accessToken = tokenData.access_token;

  async function fetchMonthTab(prefix, monthLabel) {
    const sheetName = `${prefix} ${monthLabel}`;
    const range = encodeURIComponent(`'${sheetName}'!A10:AB41`);
    const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}?valueRenderOption=UNFORMATTED_VALUE`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const data = await r.json();
    return data.values || null;
  }

  async function aggregate(prefix) {
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
  }

  const [onlineResult, gymResult] = await Promise.all([aggregate(onlinePrefix), aggregate(gymPrefix)]);
  const o = onlineResult.data, g = gymResult.data;
  const combined = {
    spend: o.spend + g.spend, metaSpend: o.metaSpend + g.metaSpend, googleSpend: o.googleSpend + g.googleSpend,
    emails: o.emails + g.emails,
    bookM: o.bookM + g.emails, // matches ads-dashboard.html's GYM_KEYS quirk -- see comment there
    closes: o.closes + g.closes, sales: o.sales + g.sales, coll: o.coll + g.coll, all: o.all + g.all,
  };

  return {
    ok: true, period, start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10), monthLabels,
    onlineSheetExists: onlineResult.exists, gymSheetExists: gymResult.exists,
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
    return sendJson(res, 200, { configured: !!(clientId && clientSecret && refreshToken), tokenSaved: !!refreshToken, ...getAdsSettings() });
  }

  if (p === "/api/ads/settings" && req.method === "POST") {
    if (!isAdmin(me)) return sendJson(res, 403, { error: "Admins only" });
    const body = await readJsonBody(req);
    const all = readSettings();
    all.ads = all.ads || {};
    for (const k of ["sheetId", "onlinePrefix", "gymPrefix", "googleRefreshToken"]) if (k in body) all.ads[k] = String(body[k]).trim();
    writeJson(INTEGRATIONS_FILE, all);
    return sendJson(res, 200, { ok: true });
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
