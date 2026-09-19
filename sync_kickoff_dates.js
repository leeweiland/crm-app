// ONE-TIME (2026-09-20): fills the START DATE / END DATE contact custom fields
// for every contact that appears on the "ONLINE KICKOFF / BUYERS" or
// "GYM KICKOFF / BUYERS" sheet tabs -- the same tabs the kickoff flows now
// append to, and that the chat-app already reads for who's a student.
//
// Matching: email first (case-insensitive), then a UNIQUE phone (last 10
// digits) for rows whose email matches nobody. A contact on several rows
// (each renewal adds a row) gets the row with the LATEST end date, and an
// end date already on the contact is never replaced by an earlier one.
// Nothing else on the contact changes -- in particular NOT status.
//
// Safety, given this app's history with contacts-file writes:
// - runs a couple of minutes AFTER the server is listening (see server.js), so
//   an old container that overlaps a deploy is gone and can't race the write;
// - updates go through updateJsonArrayRecordsByIds (streams the CURRENT file,
//   never overwrites it from a stale in-memory copy), in small batches that
//   yield to live requests in between;
// - every change (contact, old -> new) plus everything skipped goes to
//   REPORT so it can be reviewed or reverted; MARKER makes it run once.
import { existsSync, writeFileSync } from "fs";
import { join } from "path";
import { readJson, updateJsonArrayRecordsByIds, DATA_DIR } from "./auth_backend.js";
import { CONTACTS_FILE } from "./segments_shared.js";
import { syncContactFields } from "./sqlite_inbox.js";

const SHEET_ID = "1SQPcRayDql4Fe4BJ5kcHUczMzJGCocy6jAblt3hPplI";
const TABS = ["ONLINE KICKOFF / BUYERS", "GYM KICKOFF / BUYERS"];
const MARKER = join(DATA_DIR, "_sync_kickoff_dates_2026-09-20.done");
const REPORT = join(DATA_DIR, "_sync_kickoff_dates_2026-09-20_report.json");
const BATCH = 120;

// The End/Start Date columns were filled by hand and by several tools over
// years: 2026-09-11, 9/11/26, 9/11/2026, "Sep 11, 2026", "11th Sep 2026"...
// Returns UTC-midnight ms, or null for anything ambiguous or partial ("8/16",
// "June 1", "6 months") -- those are reported, never guessed.
export function parseSheetDateMs(text) {
  const t = String(text ?? "").trim();
  if (!t) return null;
  let y, m, d, mt;
  if ((mt = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(t))) { y = +mt[1]; m = +mt[2]; d = +mt[3]; }
  else if ((mt = /^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2}|\d{4})$/.exec(t))) {
    y = +mt[3]; if (y < 100) y += 2000;
    m = +mt[1]; d = +mt[2];
    if (m > 12 && d <= 12) { const x = m; m = d; d = x; } // 25/12/2026 -> day-first
  } else {
    const dt = new Date(t.replace(/(\d)(st|nd|rd|th)\b/gi, "$1") + " 12:00 UTC");
    if (isNaN(dt) || !/\d{4}/.test(t)) return null; // no year -> don't guess one
    y = dt.getUTCFullYear(); m = dt.getUTCMonth() + 1; d = dt.getUTCDate();
  }
  if (y < 2015 || y > 2040) return null;
  const ms = Date.UTC(y, m - 1, d), chk = new Date(ms);
  return chk.getUTCFullYear() === y && chk.getUTCMonth() === m - 1 && chk.getUTCDate() === d ? ms : null;
}
const isoOf = ms => new Date(ms).toISOString().slice(0, 10);
const digits10 = p => String(p || "").replace(/\D/g, "").slice(-10);

async function fetchSheetRows() {
  const tr = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET, refresh_token: process.env.GOOGLE_REFRESH_TOKEN_LW, grant_type: "refresh_token" }),
  });
  const token = (await tr.json()).access_token;
  if (!token) throw new Error("Sheets token refresh failed");
  const rows = [];
  for (const tab of TABS) {
    const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(`'${tab}'!A1:T`)}`, { headers: { Authorization: `Bearer ${token}` } });
    const values = (await r.json()).values || [];
    if (!values.length) continue;
    const hdr = values[0].map(h => String(h).trim().toLowerCase());
    const col = name => hdr.indexOf(name);
    const ci = { first: col("first name"), last: col("last name"), start: col("start date"), end: col("end date"), email: col("email"), phone: col("phone") };
    for (const v of values.slice(1)) rows.push({ tab, first: v[ci.first] || "", last: v[ci.last] || "", startRaw: v[ci.start] || "", endRaw: v[ci.end] || "", email: String(v[ci.email] || "").trim().toLowerCase(), phone: digits10(v[ci.phone]) });
  }
  return rows;
}

// `rows` can be passed in (tests); otherwise read from the live sheet.
export async function syncKickoffDates({ rows: injectedRows } = {}) {
  if (existsSync(MARKER)) return;
  const t0 = Date.now();
  const rows = injectedRows || (process.env.GOOGLE_REFRESH_TOKEN_LW ? await fetchSheetRows() : null);
  if (!rows) { console.error("[kickoff-dates] Sheets not configured -- skipped"); return; }
  const defs = readJson("crm_custom_fields.json", []).filter(d => d.entityType === "contact");
  const startId = defs.find(d => String(d.label).trim().toUpperCase() === "START DATE")?.id;
  const endId = defs.find(d => String(d.label).trim().toUpperCase() === "END DATE")?.id;
  if (!startId || !endId) { console.error("[kickoff-dates] START DATE / END DATE fields not found -- skipped"); return; }

  const contacts = readJson(CONTACTS_FILE, []);
  const byEmail = new Map(), byPhone = new Map();
  for (const c of contacts) {
    const e = String(c.email || "").trim().toLowerCase();
    if (e) (byEmail.get(e) || byEmail.set(e, []).get(e)).push(c);
    const p = digits10(c.phone);
    if (p.length === 10) (byPhone.get(p) || byPhone.set(p, []).get(p)).push(c);
  }

  const best = new Map(); // contactId -> { startMs, endMs, matchedBy, row }
  const unmatched = [], unparseable = [];
  for (const r of rows) {
    if (!(r.first || r.last) || /^example$/i.test(r.first) || /acme\.inc|example\.com/.test(r.email)) continue; // header/sample rows
    const endMs = parseSheetDateMs(r.endRaw), startMs = parseSheetDateMs(r.startRaw);
    if (String(r.endRaw).trim() && endMs == null) unparseable.push({ name: `${r.first} ${r.last}`.trim(), email: r.email, endRaw: r.endRaw, tab: r.tab });
    if (endMs == null && startMs == null) continue;
    let hits = byEmail.get(r.email), matchedBy = "email";
    if (!hits?.length) { const ph = byPhone.get(r.phone); if (ph?.length === 1) { hits = ph; matchedBy = "phone"; } else hits = null; }
    if (!hits) { unmatched.push({ name: `${r.first} ${r.last}`.trim(), email: r.email, tab: r.tab }); continue; }
    for (const c of hits) {
      const cur = best.get(c.id);
      // latest end date wins; a row with only a start date only stands in when nothing has an end date
      const better = !cur || (endMs != null && (cur.endMs == null || endMs > cur.endMs)) || (endMs == null && cur.endMs == null && startMs > (cur.startMs ?? 0));
      if (better) best.set(c.id, { startMs, endMs, matchedBy, name: `${r.first} ${r.last}`.trim() });
    }
  }

  const byId = new Map(contacts.map(c => [c.id, c]));
  const plan = [];
  for (const [id, b] of best) {
    const c = byId.get(id), cf = c.customFields || {};
    const curEnd = parseSheetDateMs(cf[endId]);
    if (b.endMs != null && curEnd != null && curEnd >= b.endMs) continue; // contact already has an equal/later end date
    const newStart = b.startMs != null ? isoOf(b.startMs) : (cf[startId] || null);
    const newEnd = b.endMs != null ? isoOf(b.endMs) : (cf[endId] || null);
    if (newStart === (cf[startId] || null) && newEnd === (cf[endId] || null)) continue;
    plan.push({ id, email: c.email, name: b.name, matchedBy: b.matchedBy, from: { start: cf[startId] || null, end: cf[endId] || null }, to: { start: newStart, end: newEnd } });
  }

  // Small batches, yielding between them, so live requests keep being served.
  let applied = 0;
  for (let i = 0; i < plan.length; i += BATCH) {
    const chunk = plan.slice(i, i + BATCH), want = new Map(chunk.map(p => [p.id, p.to]));
    const updated = updateJsonArrayRecordsByIds(CONTACTS_FILE, [...want.keys()], c => {
      const to = want.get(c.id);
      c.customFields = c.customFields || {};
      if (to.start) c.customFields[startId] = to.start;
      if (to.end) c.customFields[endId] = to.end;
      c.updatedAt = new Date().toISOString();
      return c;
    });
    for (const c of updated) { try { syncContactFields(c.id, c); } catch (e) { console.error("[kickoff-dates] sqlite sync failed:", e.message); } }
    applied += updated.length;
    await new Promise(r => setImmediate(r));
  }

  writeFileSync(REPORT, JSON.stringify({ ranAt: new Date().toISOString(), sheetRows: rows.length, contactsMatched: best.size, updated: applied, alreadyUpToDate: best.size - plan.length, unmatchedRows: unmatched, unparseableEndDates: unparseable, changes: plan }, null, 2));
  writeFileSync(MARKER, new Date().toISOString());
  console.log(`[kickoff-dates] ${applied} contacts updated, ${best.size - plan.length} already current, ${unmatched.length} sheet rows matched no contact, ${unparseable.length} unusable end dates, in ${Date.now() - t0}ms (report: ${REPORT})`);
}
