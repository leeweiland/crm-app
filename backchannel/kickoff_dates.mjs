// BACK CHANNEL: fills the START DATE / END DATE contact custom fields from the
// "ONLINE KICKOFF / BUYERS" and "GYM KICKOFF / BUYERS" sheet tabs.
//
// Runs as its OWN process (via `railway ssh`), never inside the web server: the
// server is a single Node thread, and streaming the ~180MB contacts file from
// inside it froze every request (2026-09-20 outage). Here the server keeps
// serving while this works on its own CPU core.
//
//   node --no-warnings kickoff_dates.mjs            dry run: prints the plan, writes nothing
//   node --no-warnings kickoff_dates.mjs --apply    writes the changes
//
// How it's safe alongside the live server:
// - reads the file into a Buffer and rewrites it as a NEW file next to it
//   (unique name), then renames it into place -- never edits in place;
// - if the live file changed while it was working (a contact was added/edited),
//   the new file is discarded and the whole pass repeats, so no write is lost;
// - only touches customFields START DATE / END DATE (+ updatedAt) on matched
//   contacts; status and everything else is left alone;
// - a per-contact report (old -> new) is written for review/revert.
//
// Matching: email first (case-insensitive), then a UNIQUE phone (last 10
// digits) when the sheet email matches nobody. A contact on several rows (each
// renewal adds a row) gets the row with the LATEST end date; an end date the
// contact already has is never replaced by an earlier one. Partial/ambiguous
// dates ("8/16", "June 1", "6 months") are reported, never guessed.
import fs from "fs";
import path from "path";
import { randomBytes } from "crypto";
import { pathToFileURL } from "url";

const APPLY = process.argv.includes("--apply");
const SHEET_ID = "1SQPcRayDql4Fe4BJ5kcHUczMzJGCocy6jAblt3hPplI";
const TABS = ["ONLINE KICKOFF / BUYERS", "GYM KICKOFF / BUYERS"];
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || process.cwd();
const CONTACTS = path.join(DATA_DIR, "crm_contacts.json");
const REPORT = path.join(DATA_DIR, "_kickoff_dates_backchannel_report.json");
const APP_DIR = process.env.APP_DIR || "/app";

// ── date parsing ─────────────────────────────────────────────────────────
export function parseSheetDateMs(text) {
  const t = String(text ?? "").trim();
  if (!t) return null;
  let y, m, d, mt;
  if ((mt = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(t))) { y = +mt[1]; m = +mt[2]; d = +mt[3]; }
  else if ((mt = /^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2}|\d{4})$/.exec(t))) {
    y = +mt[3]; if (y < 100) y += 2000;
    m = +mt[1]; d = +mt[2];
    if (m > 12 && d <= 12) { const x = m; m = d; d = x; }
  } else {
    const dt = new Date(t.replace(/(\d)(st|nd|rd|th)\b/gi, "$1") + " 12:00 UTC");
    if (isNaN(dt) || !/\d{4}/.test(t)) return null;
    y = dt.getUTCFullYear(); m = dt.getUTCMonth() + 1; d = dt.getUTCDate();
  }
  if (y < 2015 || y > 2040) return null;
  const ms = Date.UTC(y, m - 1, d), chk = new Date(ms);
  return chk.getUTCFullYear() === y && chk.getUTCMonth() === m - 1 && chk.getUTCDate() === d ? ms : null;
}
const isoOf = ms => new Date(ms).toISOString().slice(0, 10);
const digits10 = p => String(p || "").replace(/\D/g, "").slice(-10);

// ── sheet ────────────────────────────────────────────────────────────────
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
    const col = n => hdr.indexOf(n);
    const ci = { first: col("first name"), last: col("last name"), start: col("start date"), end: col("end date"), email: col("email"), phone: col("phone") };
    for (const v of values.slice(1)) rows.push({ tab, first: v[ci.first] || "", last: v[ci.last] || "", startRaw: v[ci.start] || "", endRaw: v[ci.end] || "", email: String(v[ci.email] || "").trim().toLowerCase(), phone: digits10(v[ci.phone]) });
  }
  return rows;
}

// ── streaming the contacts array out of a Buffer ─────────────────────────
function* elementRanges(buf) {
  let i = buf.indexOf(0x5b); // outer '['
  if (i < 0) return;
  let depth = 1, inStr = false, esc = false, start = -1;
  for (i++; i < buf.length; i++) {
    const b = buf[i];
    if (inStr) { if (esc) esc = false; else if (b === 0x5c) esc = true; else if (b === 0x22) inStr = false; continue; }
    if (b === 0x22) { inStr = true; continue; }
    if (b === 0x7b || b === 0x5b) { if (depth === 1 && b === 0x7b) start = i; depth++; }
    else if (b === 0x7d || b === 0x5d) { depth--; if (depth === 1 && b === 0x7d) yield [start, i + 1]; if (depth === 0) return; }
  }
}

function buildPlan(buf, rows, ids) {
  const sheetEmails = new Set(rows.map(r => r.email).filter(Boolean));
  const sheetPhones = new Set(rows.map(r => r.phone).filter(p => p.length === 10));
  const byEmail = new Map(), byPhone = new Map();
  let total = 0;
  for (const [s, e] of elementRanges(buf)) {
    total++;
    const c = JSON.parse(buf.toString("utf8", s, e));
    const em = String(c.email || "").trim().toLowerCase(), ph = digits10(c.phone);
    const slim = { id: c.id, email: c.email, name: `${c.first || ""} ${c.last || ""}`.trim(), curStart: c.customFields?.[ids.start] || null, curEnd: c.customFields?.[ids.end] || null };
    if (em && sheetEmails.has(em)) (byEmail.get(em) || byEmail.set(em, []).get(em)).push(slim);
    if (ph.length === 10 && sheetPhones.has(ph)) (byPhone.get(ph) || byPhone.set(ph, []).get(ph)).push(slim);
  }
  const best = new Map(), unmatched = [], unparseable = [];
  for (const r of rows) {
    if (!(r.first || r.last) || /^example$/i.test(r.first) || /acme\.inc|example\.com/.test(r.email)) continue;
    const endMs = parseSheetDateMs(r.endRaw), startMs = parseSheetDateMs(r.startRaw);
    if (String(r.endRaw).trim() && endMs == null) unparseable.push({ name: `${r.first} ${r.last}`.trim(), email: r.email, endRaw: r.endRaw, tab: r.tab });
    if (endMs == null && startMs == null) continue;
    let hits = byEmail.get(r.email), matchedBy = "email";
    if (!hits?.length) { const ph = byPhone.get(r.phone); if (ph?.length === 1) { hits = ph; matchedBy = "phone"; } else hits = null; }
    if (!hits) { unmatched.push({ name: `${r.first} ${r.last}`.trim(), email: r.email, tab: r.tab }); continue; }
    for (const c of hits) {
      const cur = best.get(c.id);
      const better = !cur || (endMs != null && (cur.endMs == null || endMs > cur.endMs)) || (endMs == null && cur.endMs == null && startMs > (cur.startMs ?? 0));
      if (better) best.set(c.id, { startMs, endMs, matchedBy, c });
    }
  }
  const changes = [];
  for (const [id, b] of best) {
    const curEndMs = parseSheetDateMs(b.c.curEnd);
    if (b.endMs != null && curEndMs != null && curEndMs >= b.endMs) continue;
    const newStart = b.startMs != null ? isoOf(b.startMs) : b.c.curStart;
    const newEnd = b.endMs != null ? isoOf(b.endMs) : b.c.curEnd;
    if (newStart === b.c.curStart && newEnd === b.c.curEnd) continue;
    changes.push({ id, email: b.c.email, name: b.c.name, matchedBy: b.matchedBy, from: { start: b.c.curStart, end: b.c.curEnd }, to: { start: newStart, end: newEnd } });
  }
  return { total, matched: best.size, changes, unmatched, unparseable };
}

// Rewrites the file with the planned edits applied; returns the edited contacts.
function writeNewFile(buf, changes, ids, tmpPath) {
  const want = new Map(changes.map(c => [c.id, c.to]));
  const fd = fs.openSync(tmpPath, "w");
  const edited = [];
  try {
    fs.writeSync(fd, "[");
    let first = true, pending = [], pendingLen = 0;
    const flush = () => { if (pending.length) { fs.writeSync(fd, Buffer.concat(pending)); pending = []; pendingLen = 0; } };
    const push = b => { pending.push(b); pendingLen += b.length; if (pendingLen > 8 << 20) flush(); };
    const now = new Date().toISOString();
    for (const [s, e] of elementRanges(buf)) {
      let out = buf.subarray(s, e);
      const head = buf.toString("latin1", s, Math.min(e, s + 80));
      const m = /"id"\s*:\s*"([^"]+)"/.exec(head);
      if (m && want.has(m[1])) {
        const c = JSON.parse(buf.toString("utf8", s, e)), to = want.get(m[1]);
        c.customFields = c.customFields || {};
        if (to.start) c.customFields[ids.start] = to.start;
        if (to.end) c.customFields[ids.end] = to.end;
        c.updatedAt = now;
        out = Buffer.from(JSON.stringify(c), "utf8");
        edited.push(c);
      }
      push(first ? out : Buffer.concat([Buffer.from(","), out]));
      first = false;
    }
    push(Buffer.from("]"));
    flush();
  } finally { fs.closeSync(fd); }
  return edited;
}

// ── main ─────────────────────────────────────────────────────────────────
const t0 = Date.now();
const defs = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "crm_custom_fields.json"), "utf8")).filter(d => d.entityType === "contact");
const ids = { start: defs.find(d => String(d.label).trim().toUpperCase() === "START DATE")?.id, end: defs.find(d => String(d.label).trim().toUpperCase() === "END DATE")?.id };
if (!ids.start || !ids.end) { console.error("START DATE / END DATE contact fields not found"); process.exit(1); }
const rows = process.env.KICKOFF_ROWS_JSON ? JSON.parse(fs.readFileSync(process.env.KICKOFF_ROWS_JSON, "utf8")) : await fetchSheetRows(); // KICKOFF_ROWS_JSON: test hook
console.log(`sheet rows read: ${rows.length}`);

for (let attempt = 1; attempt <= 5; attempt++) {
  const st0 = fs.statSync(CONTACTS);
  const buf = fs.readFileSync(CONTACTS);
  const plan = buildPlan(buf, rows, ids);
  console.log(`attempt ${attempt}: contacts scanned ${plan.total} | matched to a sheet row ${plan.matched} | to update ${plan.changes.length} | already current ${plan.matched - plan.changes.length} | sheet rows matching no contact ${plan.unmatched.length} | unusable end dates ${plan.unparseable.length}`);
  if (!APPLY) {
    console.log("DRY RUN -- nothing written. Sample changes:", JSON.stringify(plan.changes.slice(0, 5).map(c => `${c.name}: ${c.from.end || "-"} -> ${c.to.end || "-"} (${c.matchedBy})`)));
    console.log("unusable end dates (sample):", JSON.stringify(plan.unparseable.slice(0, 8).map(u => `${u.name}: "${u.endRaw}"`)));
    process.exit(0);
  }
  if (!plan.changes.length) { console.log("nothing to update"); fs.writeFileSync(REPORT, JSON.stringify({ ranAt: new Date().toISOString(), updated: 0, unmatchedRows: plan.unmatched, unparseableEndDates: plan.unparseable }, null, 2)); process.exit(0); }
  const tmp = path.join(DATA_DIR, `crm_contacts.json.backchannel-${randomBytes(4).toString("hex")}`);
  const edited = writeNewFile(buf, plan.changes, ids, tmp);
  // structural check of the NEW file before it can replace the live one (no full parse -- that would need >1GB next to the live server)
  const nb = fs.readFileSync(tmp);
  let count = 0; for (const _ of elementRanges(nb)) count++;
  if (count !== plan.total || nb[0] !== 0x5b || nb[nb.length - 1] !== 0x5d) { fs.unlinkSync(tmp); throw new Error(`new file failed the check (${count} records vs ${plan.total}); aborting, live file untouched`); }
  const st1 = fs.statSync(CONTACTS);
  if (st1.mtimeMs !== st0.mtimeMs || st1.size !== st0.size) { fs.unlinkSync(tmp); console.log("live file changed while working -- retrying"); continue; }
  fs.renameSync(tmp, CONTACTS);
  console.log(`contacts file replaced: ${edited.length} contacts edited`);
  // keep the app's sqlite copies (Contacts page + Inbox renewal alerts) in step, exactly as the server does
  try {
    const sq = await import(pathToFileURL(path.join(APP_DIR, "sqlite_inbox.js")).href);
    let n = 0; for (const c of edited) { sq.syncContactFields(c.id, c); n++; }
    console.log(`sqlite synced for ${n} contacts`);
  } catch (e) { console.error("sqlite sync failed (the Contacts/Inbox copies catch up on the next edit or boot):", e.message); }
  fs.writeFileSync(REPORT, JSON.stringify({ ranAt: new Date().toISOString(), sheetRows: rows.length, contactsMatched: plan.matched, updated: edited.length, alreadyUpToDate: plan.matched - plan.changes.length, unmatchedRows: plan.unmatched, unparseableEndDates: plan.unparseable, changes: plan.changes }, null, 2));
  console.log(`done in ${Date.now() - t0}ms -- report: ${REPORT}`);
  process.exit(0);
}
console.error("gave up: the live contacts file kept changing"); process.exit(2);
