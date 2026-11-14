// CRM columns for the Ads Columns Chrome extension (chrome-ext/ in this repo):
// per ad / ad set / campaign counts of what the CRM saw -- opt-ins, bookings,
// gym applications, enrollments and cash -- plus that platform's own spend, so
// the extension can show Hyros-style columns inside Meta Ads Manager and
// Google Ads.
//
// Runs in report_worker.js's own process (job "extColumns", registered there),
// like every other heavy report -- it reads every recorded page visit.
// Platform API cost per (uncached) run: Meta = one insights call (+ one ad->ad set
// ->campaign map call at most every 6 hours); Google = two GAQL queries.
//
// Attribution: each conversion is credited to the contact's FIRST tracked touch
// (model=first, same rule as Reporting -> Ads) or their LAST touch before the
// conversion (model=last). A touch is any tracked visit key (ad click, email
// link, YouTube tag...), so a conversion whose credited touch isn't one of this
// platform's ads counts for nobody here. Contacts with no tracked visit fall
// back to the ad click ids stamped on them at sign-up (contact.clickIds).
import { readJson, writeJson } from "./auth_backend.js";
import { PAGE_VISITS_FILE } from "./tracking_backend.js";
import { crmEventRuns, anchorageMidnightUTC, googleAccessToken, getAdsSettings } from "./ads_backend.js";
import { getConversionSettings, getGoogleAdsAccessToken } from "./conversions_backend.js";
import { financialsDbAvailable, cashByContact } from "./financials_db.js";
import { findContactMatchDb, getContactsByIds } from "./contacts_db.js";
import { attributionKeyForVisit } from "./reporting_backend.js";

const MAP_TTL_MS = 6 * 3600 * 1000;
const MAP_FILE = { meta: "crm_ext_meta_ad_map.json", google: "crm_ext_google_ad_map.json" };

// ── Spend + ad -> ad set -> campaign, from the platform ──
async function metaSpendAndMap(startStr, endStr) {
  const { metaAccessToken, metaAdAccountId } = getConversionSettings();
  if (!metaAccessToken || !metaAdAccountId) throw new Error("Meta isn't connected");
  const act = metaAdAccountId.startsWith("act_") ? metaAdAccountId : `act_${metaAdAccountId}`;
  const tok = encodeURIComponent(metaAccessToken);
  const get = async (url) => {
    const r = await fetch(url, { signal: AbortSignal.timeout(60000) });
    const d = await r.json();
    if (!r.ok || d.error) throw new Error(d?.error?.message || `meta_http_${r.status}`);
    return d;
  };
  const spend = new Map(), parent = new Map();
  const tr = encodeURIComponent(JSON.stringify({ since: startStr, until: endStr }));
  let url = `https://graph.facebook.com/v21.0/${act}/insights?level=ad&fields=ad_id,adset_id,campaign_id,spend,impressions,clicks,inline_link_clicks&time_range=${tr}&limit=500&access_token=${tok}`;
  for (let page = 0; url && page < 20; page++) {
    const d = await get(url);
    for (const r of d.data || []) {
      spend.set(String(r.ad_id), { spend: Number(r.spend) || 0, impressions: Number(r.impressions) || 0, clicks: Number(r.clicks) || 0, linkClicks: Number(r.inline_link_clicks) || 0 });
      parent.set(String(r.ad_id), { adset: String(r.adset_id), campaign: String(r.campaign_id) });
    }
    url = d.paging?.next || null;
  }
  // Ads with a lead in range but no delivery in range still need their ad set/campaign.
  const cached = readJson(MAP_FILE.meta, null);
  let map = cached && Date.now() - cached.at < MAP_TTL_MS ? cached.map : null;
  if (!map) {
    map = {};
    let u = `https://graph.facebook.com/v21.0/${act}/ads?fields=id,adset_id,campaign_id&limit=500&access_token=${tok}`;
    for (let page = 0; u && page < 20; page++) {
      const d = await get(u);
      for (const a of d.data || []) map[a.id] = { adset: String(a.adset_id), campaign: String(a.campaign_id) };
      u = d.paging?.next || null;
    }
    writeJson(MAP_FILE.meta, { at: Date.now(), map });
  }
  for (const [id, p] of Object.entries(map)) if (!parent.has(id)) parent.set(id, p);
  return { spend, parent };
}

async function googleSpendAndMap(startStr, endStr) {
  const { googleAdsCustomerId, googleAdsDeveloperToken, googleAdsRefreshToken } = getConversionSettings();
  if (!googleAdsCustomerId || !googleAdsDeveloperToken || !googleAdsRefreshToken) throw new Error("Google Ads isn't connected");
  const accessToken = await getGoogleAdsAccessToken(googleAdsRefreshToken);
  const cid = googleAdsCustomerId.replace(/\D/g, "");
  const search = async (query) => {
    const out = [];
    let pageToken = null;
    for (let i = 0; i < 20; i++) {
      const r = await fetch(`https://googleads.googleapis.com/v25/customers/${cid}/googleAds:search`, {
        method: "POST", signal: AbortSignal.timeout(60000),
        headers: { Authorization: `Bearer ${accessToken}`, "developer-token": googleAdsDeveloperToken, "Content-Type": "application/json" },
        body: JSON.stringify(pageToken ? { query, pageToken } : { query }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d?.error?.message || d?.[0]?.error?.message || `google_http_${r.status}`);
      out.push(...(d.results || []));
      pageToken = d.nextPageToken;
      if (!pageToken) break;
    }
    return out;
  };
  const spend = new Map(), parent = new Map(), campSpend = new Map();
  for (const row of await search(`SELECT ad_group_ad.ad.id, ad_group.id, campaign.id, metrics.cost_micros, metrics.impressions, metrics.clicks FROM ad_group_ad WHERE segments.date BETWEEN '${startStr}' AND '${endStr}'`)) {
    const id = String(row.adGroupAd.ad.id);
    const s = spend.get(id) || { spend: 0, impressions: 0, clicks: 0, linkClicks: 0 };
    s.spend += (Number(row.metrics.costMicros) || 0) / 1e6;
    s.impressions += Number(row.metrics.impressions) || 0;
    s.clicks += Number(row.metrics.clicks) || 0;
    s.linkClicks = s.clicks;
    spend.set(id, s);
    parent.set(id, { adset: String(row.adGroup.id), campaign: String(row.campaign.id) });
  }
  // Campaign-level spend too: Performance Max and some Demand Gen spend never shows on an ad row.
  for (const row of await search(`SELECT campaign.id, metrics.cost_micros, metrics.impressions, metrics.clicks FROM campaign WHERE segments.date BETWEEN '${startStr}' AND '${endStr}'`)) {
    campSpend.set(String(row.campaign.id), { spend: (Number(row.metrics.costMicros) || 0) / 1e6, impressions: Number(row.metrics.impressions) || 0, clicks: Number(row.metrics.clicks) || 0, linkClicks: Number(row.metrics.clicks) || 0 });
  }
  // Google Ads' table has no IDs in the page, so the extension matches campaign and
  // ad group rows by name (campaign names are unique per account) -- hence the names.
  const cached = readJson(MAP_FILE.google, null);
  let map = cached && cached.names && Date.now() - cached.at < MAP_TTL_MS ? cached.map : null;
  let names = map ? cached.names : null;
  if (!map) {
    map = {};
    names = { campaign: {}, adset: {} };
    for (const row of await search(`SELECT ad_group_ad.ad.id, ad_group.id, campaign.id FROM ad_group_ad`)) map[String(row.adGroupAd.ad.id)] = { adset: String(row.adGroup.id), campaign: String(row.campaign.id) };
    for (const row of await search(`SELECT campaign.id, campaign.name FROM campaign WHERE campaign.status != 'REMOVED'`)) names.campaign[String(row.campaign.id)] = row.campaign.name;
    for (const row of await search(`SELECT ad_group.id, ad_group.name FROM ad_group WHERE ad_group.status != 'REMOVED'`)) names.adset[String(row.adGroup.id)] = row.adGroup.name;
    writeJson(MAP_FILE.google, { at: Date.now(), map, names });
  }
  for (const [id, p] of Object.entries(map)) if (!parent.has(id)) parent.set(id, p);
  return { spend, parent, campSpend, names };
}

// ── Enrollments, straight from CALLS TRACKING ("Result" = Enrolled, dated by "Date Of Enrollment") ──
const SHEET_MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
function sheetDate(raw) {
  const s = String(raw || "").trim();
  let m;
  const ymd = (y, mo, d) => (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) ? `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}` : null;
  if ((m = /(\d{4})-(\d\d)-(\d\d)/.exec(s))) return ymd(m[1], +m[2], +m[3]);
  if ((m = /([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})/.exec(s)) && SHEET_MONTHS[m[1].toLowerCase()]) return ymd(m[3], SHEET_MONTHS[m[1].toLowerCase()], +m[2]);
  if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/.exec(s))) { let y = +m[3]; if (y < 100) y += 2000; return ymd(y, +m[1], +m[2]); }
  return null;
}
const money = (v) => { const n = Number(String(v ?? "").replace(/[$,\s]/g, "")); return Number.isFinite(n) ? n : 0; };
async function enrollmentsInRange(startStr, endStr) {
  const tok = await googleAccessToken();
  const id = getAdsSettings().callsSheetId;
  const ranges = ["'ONLINE'!A1:P6000", "'GYM'!A1:P6000"];
  const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${id}/values:batchGet?valueRenderOption=FORMATTED_VALUE&${ranges.map(x => "ranges=" + encodeURIComponent(x)).join("&")}`, { headers: { Authorization: `Bearer ${tok}` }, signal: AbortSignal.timeout(30000) });
  const d = await r.json();
  if (!r.ok) throw new Error(d?.error?.message || `sheets_http_${r.status}`);
  const out = [];
  (d.valueRanges || []).forEach((vr, i) => {
    const rows = vr.values || [];
    const hdr = (rows[0] || []).map(c => String(c).trim().toLowerCase());
    const col = (n) => hdr.indexOf(n);
    const ri = col("result"), ei = col("email"), pi = col("phone"), di = col("date of enrollment"), ai = col("amount paid");
    const fallback = col(i === 0 ? "date of call" : "applied date");
    if (ri < 0 || di < 0) return;
    for (let k = 1; k < rows.length; k++) {
      const row = rows[k];
      if (!/^enrolled/i.test(String(row[ri] || "").trim())) continue;
      const day = sheetDate(row[di]) || (fallback >= 0 ? sheetDate(row[fallback]) : null);
      if (!day || day < startStr || day > endStr) continue;
      out.push({ program: i === 0 ? "online" : "gym", day, email: row[ei], phone: row[pi], amount: ai >= 0 ? money(row[ai]) : 0 });
    }
  });
  return out;
}

// ── Touches ──
function buildTouches() {
  const byContact = new Map(); // contactId -> [{key, atMs}]
  for (const v of readJson(PAGE_VISITS_FILE, [])) {
    if (!v.contactId) continue;
    const key = attributionKeyForVisit(v);
    if (!key) continue;
    const atMs = new Date(v.at).getTime();
    if (!Number.isFinite(atMs)) continue;
    if (!byContact.has(v.contactId)) byContact.set(v.contactId, []);
    byContact.get(v.contactId).push({ key, atMs });
  }
  for (const list of byContact.values()) list.sort((a, b) => a.atMs - b.atMs);
  return byContact;
}
function clickIdKey(contact) {
  const ids = contact?.clickIds;
  if (!ids) return null;
  if (ids.ads?.meta?.id) return `meta-ad:${ids.ads.meta.id}`;
  if (ids.ads?.google?.id) return `google-ad:${ids.ads.google.id}`;
  if (ids.fbclid) return "meta-ad:unknown";
  if (ids.gclid || ids.gbraid || ids.wbraid) return "google-ad:unknown";
  return null;
}
function creditKey(touches, contact, atMs, model) {
  if (touches?.length) {
    if (model === "last") {
      let pick = touches[0];
      for (const t of touches) { if (t.atMs <= atMs + 5 * 60000) pick = t; else break; }
      return pick.key;
    }
    return touches[0].key;
  }
  return clickIdKey(contact);
}

const METRICS = ["leads", "emailsOnline", "emailsGym", "bookings", "applications", "calls", "enrollments", "revenue", "cash", "customers"];
const blank = () => ({ spend: 0, impressions: 0, clicks: 0, linkClicks: 0, ...Object.fromEntries(METRICS.map(m => [m, 0])), c: { leads: [], calls: [], enrollments: [], cash: [] } });

export async function reportExtColumns(params = {}) {
  const platform = params.platform === "google" ? "google" : "meta";
  const model = params.model === "last" ? "last" : "first";
  const today = new Date().toISOString().slice(0, 10);
  const endStr = /^\d{4}-\d\d-\d\d$/.test(params.end || "") ? params.end : today;
  const startStr = /^\d{4}-\d\d-\d\d$/.test(params.start || "") ? params.start : endStr;
  const startMs = anchorageMidnightUTC(startStr).getTime();
  const endMs = anchorageMidnightUTC(endStr).getTime() + 86400000 - 1;
  const prefix = platform === "meta" ? "meta-ad:" : "google-ad:";

  // Conversions: [{contactId, atMs, add: {metric: n}, list, amount}]
  const conv = [];
  for (const e of crmEventRuns(startMs, endMs)) {
    if (!e.contactId) continue;
    const add = { leads: 0 };
    if (e.kind === "emails") { add.leads = 1; add[e.program === "gym" ? "emailsGym" : "emailsOnline"] = 1; conv.push({ contactId: e.contactId, atMs: e.atMs, add, list: "leads" }); }
    else { add[e.program === "gym" ? "applications" : "bookings"] = 1; add.calls = 1; delete add.leads; conv.push({ contactId: e.contactId, atMs: e.atMs, add, list: "calls" }); }
  }
  let enrollError = null;
  try {
    for (const en of await enrollmentsInRange(startStr, endStr)) {
      const c = findContactMatchDb(en.email, en.phone);
      if (!c) continue;
      conv.push({ contactId: c.id, atMs: anchorageMidnightUTC(en.day).getTime() + 12 * 3600000, add: { enrollments: 1, revenue: en.amount }, list: "enrollments" });
    }
  } catch (e) { enrollError = e.message; }
  if (financialsDbAvailable()) {
    try {
      for (const [contactId, amount] of await cashByContact(startMs, endMs)) {
        if (!contactId || !amount) continue;
        conv.push({ contactId, atMs: endMs, add: { cash: amount, customers: amount > 0 ? 1 : 0 }, list: "cash" });
      }
    } catch (e) { console.error("[ext-columns] cash:", e.message); }
  }

  const touches = buildTouches();
  const needContacts = [...new Set(conv.map(x => x.contactId))];
  const contacts = new Map();
  for (let i = 0; i < needContacts.length; i += 2000) for (const c of getContactsByIds(needContacts.slice(i, i + 2000))) if (c) contacts.set(c.id, c);

  const ads = new Map();
  const totals = blank();
  let unknownAd = 0;
  const people = {};
  for (const x of conv) {
    const contact = contacts.get(x.contactId);
    if (!contact || contact.testContact) continue;
    const key = creditKey(touches.get(x.contactId), contact, x.atMs, model);
    if (!key || !key.startsWith(prefix)) continue;
    const adId = key.slice(prefix.length);
    const targets = [totals];
    if (adId === "unknown") unknownAd++;
    else { if (!ads.has(adId)) ads.set(adId, blank()); targets.push(ads.get(adId)); }
    for (const t of targets) {
      for (const [m, n] of Object.entries(x.add)) t[m] += n;
      if (!t.c[x.list].includes(x.contactId)) t.c[x.list].push(x.contactId);
    }
    people[x.contactId] ||= { n: [contact.first, contact.last].filter(Boolean).join(" ") || contact.email || contact.phone || "(no name)", e: contact.email || "", p: contact.programType || "" };
  }

  let spendError = null, spend = new Map(), parent = new Map(), campSpend = new Map();
  let names = null;
  try { ({ spend, parent, campSpend = new Map(), names = null } = platform === "meta" ? await metaSpendAndMap(startStr, endStr) : await googleSpendAndMap(startStr, endStr)); }
  catch (e) { spendError = e.message; }

  for (const [id, s] of spend) { if (!ads.has(id)) ads.set(id, blank()); Object.assign(ads.get(id), s); }
  // Roll ads up into ad sets/ad groups and campaigns.
  const adsets = new Map(), campaigns = new Map();
  const roll = (into, id, a) => {
    if (!into.has(id)) into.set(id, blank());
    const t = into.get(id);
    for (const m of ["spend", "impressions", "clicks", "linkClicks", ...METRICS]) t[m] += a[m];
    for (const l of Object.keys(t.c)) for (const cid of a.c[l]) if (!t.c[l].includes(cid)) t.c[l].push(cid);
  };
  for (const [id, a] of ads) {
    const p = parent.get(id);
    if (!p) continue;
    roll(adsets, p.adset, a);
    roll(campaigns, p.campaign, a);
  }
  for (const [id, s] of campSpend) { if (!campaigns.has(id)) campaigns.set(id, blank()); Object.assign(campaigns.get(id), s); }
  totals.spend = 0; totals.impressions = 0; totals.clicks = 0; totals.linkClicks = 0;
  for (const s of (campSpend.size ? campSpend : spend).values()) { totals.spend += s.spend; totals.impressions += s.impressions; totals.clicks += s.clicks; totals.linkClicks += s.linkClicks; }

  const round = (o) => { for (const k of ["spend", "revenue", "cash"]) o[k] = Math.round(o[k] * 100) / 100; return o; };
  const obj = (m) => Object.fromEntries([...m].map(([id, v]) => [id, round(v)]));
  // Parents of every object returned, so the extension's totals row can follow
  // a campaign/ad set selection in Ads Manager.
  const parents = { ad: {}, adset: {} };
  for (const id of ads.keys()) { const p = parent.get(id); if (p) { parents.ad[id] = [p.adset, p.campaign]; parents.adset[p.adset] = p.campaign; } }
  return {
    platform, model, start: startStr, end: endStr, generatedAt: new Date().toISOString(),
    ad: obj(ads), adset: obj(adsets), campaign: obj(campaigns), totals: round(totals), parents,
    people, unknownAd, spendError, enrollError, names,
  };
}
