// Copies ActiveCampaign's own per-contact "last opened" / "last clicked" dates
// onto our contacts' emailEngagement, so segments' "Opened Email in the last N
// days" matches what AC itself reports.
//
// Why this exists: AC's per-contact ACTIVITIES feed (what the historical
// import used) only contains sends and clicks -- never opens -- so imported
// history could only ever show clicks and 1:1-campaign opens. But every AC
// CONTACT record carries last_open_date / last_click_date, returned 100 per
// call by the plain contacts listing. Verified against AC's own "Has opened
// any email in the last 100 days" search: last_open_date reproduces its
// membership exactly (950/950, none missed). last_mpp_open_date (Apple Mail
// Privacy Protection prefetches) is deliberately NOT used -- AC's own "Has
// opened" doesn't count them either.
//
// Runs inside the live server, in the background, yielding to requests: a
// paged sweep of AC's contacts (3 at a time, with retry/backoff), then ONE
// in-place pass over our contacts file keyed by externalIds.acContactId, then
// a SQLite re-sync. Read-only against AC. Admin-triggered:
//   GET /api/contacts/admin/sync-ac-engagement   (?force=1 to run it again)
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { DATA_DIR, patchJsonArrayRecordsByKeyMap } from "./auth_backend.js";
import { CONTACTS_FILE } from "./segments_shared.js";
import { syncContactFields } from "./sqlite_inbox.js";
import { applyEngagement } from "./engagement_backfill.js";
import { AC_BASE, acConfigured } from "./import_backend.js";

const REPORT_FILE = join(DATA_DIR, "_ac_engagement_sync_report.json");
const PAGE = 100;
const CONCURRENCY = 3; // AC allows ~5 requests/sec per account
const yieldToLoop = () => new Promise(r => setImmediate(r));
const sleep = ms => new Promise(r => setTimeout(r, ms));

// AC returns "2026-07-13 15:07:39" (no zone) for last_open_date/last_click_date,
// in the account's timezone -- the same one its cdate offsets show (-05:00 in
// summer, -06:00 in winter: US Central). -> ISO UTC string, or null.
export function acLocalToIso(s, timeZone = "America/Chicago") {
  if (!s || String(s).startsWith("0000")) return null;
  const m = /^(\d{4})-(\d\d)-(\d\d)[ T](\d\d):(\d\d):(\d\d)/.exec(String(s));
  if (!m) { const t = new Date(s).getTime(); return isNaN(t) ? null : new Date(t).toISOString(); }
  const asUtc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  // Wall-clock -> instant: measure how far `timeZone` reads from UTC at that moment.
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(asUtc));
  const g = t => +parts.find(p => p.type === t).value;
  const shown = Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second"));
  return new Date(asUtc - (shown - asUtc)).toISOString();
}

// AC contact -> { openedAt, clickedAt } or null when it has neither.
export function engagementFromAcContact(c) {
  const openedAt = acLocalToIso(c.last_open_date);
  const clickedAt = acLocalToIso(c.last_click_date);
  return openedAt || clickedAt ? { openedAt, clickedAt } : null;
}

// The element's externalIds.acContactId straight from its bytes (no parse).
function acKeyOf(buf, start, end) {
  const needle = Buffer.from('"acContactId"');
  const i = buf.indexOf(needle, start);
  if (i === -1 || i >= end) return null;
  const m = /^\s*:\s*"?(\d+)"?/.exec(buf.toString("latin1", i + needle.length, Math.min(end, i + needle.length + 24)));
  return m ? m[1] : null;
}
const verifyAcKey = (obj, key) => String(obj.externalIds?.acContactId) === key;

async function fetchAcPage(offset) {
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 25000);
      const r = await fetch(`${AC_BASE}/api/3/contacts?limit=${PAGE}&offset=${offset}&orders[id]=ASC`, { headers: { "Api-Token": process.env.AC_API_KEY }, signal: ctl.signal });
      clearTimeout(timer);
      if (r.status === 429) { await sleep(Number(r.headers.get("retry-after") || 2) * 1000); continue; }
      const j = await r.json().catch(() => null);
      if (r.ok && j && Array.isArray(j.contacts)) return j;
    } catch { /* timeout / network: retry */ }
    await sleep(600 * (attempt + 1) ** 2);
  }
  throw new Error(`AC contacts page at offset ${offset} failed after retries`);
}

const state = { state: "idle", startedAt: null, finishedAt: null, pagesTotal: 0, pagesDone: 0, acContactsSeen: 0, withOpen: 0, withClick: 0, contactsUpdated: 0, sqliteSynced: 0, error: null };
function loadReport() { try { return existsSync(REPORT_FILE) ? JSON.parse(readFileSync(REPORT_FILE, "utf8")) : null; } catch { return null; } }
export function getAcEngagementSyncStatus() {
  if (state.state !== "idle") return { ...state };
  const last = loadReport();
  return last ? { state: "done", ...last, note: "Already ran. Add ?force=1 to run it again (safe -- it only ever moves times later)." } : { ...state };
}

// `fetchPage` is injectable for tests; production uses the real AC API.
export async function runAcEngagementSync({ fetchPage = fetchAcPage, maxPages = Infinity } = {}) {
  const t0 = Date.now();
  Object.assign(state, { state: "sweeping AC", startedAt: new Date().toISOString(), finishedAt: null, pagesTotal: 0, pagesDone: 0, acContactsSeen: 0, withOpen: 0, withClick: 0, contactsUpdated: 0, sqliteSynced: 0, error: null });

  const patches = new Map(); // acContactId -> { openedAt, clickedAt }
  const absorb = (page) => {
    for (const c of page.contacts) {
      state.acContactsSeen++;
      const ev = engagementFromAcContact(c);
      if (!ev) continue;
      if (ev.openedAt) state.withOpen++;
      if (ev.clickedAt) state.withClick++;
      patches.set(String(c.id), ev);
    }
  };
  const first = await fetchPage(0);
  const total = Number(first.meta?.total || first.contacts.length);
  state.pagesTotal = Math.min(Math.ceil(total / PAGE), maxPages);
  absorb(first); state.pagesDone = 1;
  let next = 1;
  const worker = async () => {
    while (next < state.pagesTotal) {
      const idx = next++;
      absorb(await fetchPage(idx * PAGE));
      state.pagesDone++;
      await yieldToLoop();
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  state.state = "updating contacts file";
  await yieldToLoop();
  const changed = patchJsonArrayRecordsByKeyMap(CONTACTS_FILE, patches, applyEngagement, { keyOf: acKeyOf, verify: verifyAcKey });
  state.contactsUpdated = changed.length;

  state.state = "syncing sqlite";
  for (let k = 0; k < changed.length; k++) {
    try { syncContactFields(changed[k].id, changed[k]); state.sqliteSynced++; } catch (e) { console.error("[ac-engagement-sync] sqlite sync failed:", e.message); }
    if (k % 500 === 499) await yieldToLoop();
  }

  const report = { ranAt: state.startedAt, finishedAt: new Date().toISOString(), seconds: Math.round((Date.now() - t0) / 1000), acContactsSeen: state.acContactsSeen, withLastOpen: state.withOpen, withLastClick: state.withClick, contactsUpdated: state.contactsUpdated, sqliteSynced: state.sqliteSynced };
  try { writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2)); } catch (e) { console.error("[ac-engagement-sync] could not write report:", e.message); }
  console.log(`[ac-engagement-sync] done in ${report.seconds}s: ${report.acContactsSeen} AC contacts seen, ${report.withLastOpen} with a last-open date, ${report.contactsUpdated} CRM contacts updated`);
  state.finishedAt = report.finishedAt;
  state.state = "idle";
  return report;
}

export function startAcEngagementSync({ force = false } = {}) {
  if (state.state !== "idle") return { ...state, note: "Already running -- reload this URL to watch progress." };
  if (!acConfigured()) return { state: "error", error: "ActiveCampaign isn't configured (no AC_API_KEY)." };
  if (!force && loadReport()) return getAcEngagementSyncStatus();
  state.state = "starting";
  runAcEngagementSync().catch(e => { console.error("[ac-engagement-sync] failed:", e); state.error = e.message; state.state = "idle"; });
  return { ...state, note: "Started -- reload this URL to watch progress (takes several minutes)." };
}
