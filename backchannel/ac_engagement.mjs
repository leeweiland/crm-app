// BACK CHANNEL: copies ActiveCampaign's own per-contact last-OPEN / last-CLICK
// dates onto our contacts' emailEngagement, so segments' "Opened Email in the
// last N days" matches what AC itself reports (950/950 against AC's own
// "Has opened any email in the last 100 days" search).
//
// Runs as its OWN process (via `railway ssh`), never inside the web server --
// the server is one Node thread, and doing this from inside it (rewriting ~100K
// contacts + a SQLite write per contact) froze every request. Here the server
// keeps serving; this process also lowers its own CPU priority.
//
//   node --no-warnings ac_engagement.mjs --sweep            read AC (read-only) -> saves a small patch file, touches nothing else
//   node --no-warnings ac_engagement.mjs --apply            DRY RUN: prints what would change, writes nothing
//   node --no-warnings ac_engagement.mjs --apply --write    applies it
//
// Why AC's contact records and not the imported history: the import used AC's
// per-contact activities feed, which only carries sends and clicks -- never
// opens. Every AC contact record carries last_open_date / last_click_date
// (100 contacts per call). last_mpp_open_date (Apple Mail prefetch) is NOT
// used: AC's own "Has opened" search doesn't count it either.
//
// Safe alongside the live server:
// - the sweep only READS AC and writes one small side file;
// - the apply reads the contacts file into a Buffer and writes a NEW file next
//   to it, structurally checks it, then renames it into place (never edits in
//   place); if the live file changed meanwhile the new file is discarded and
//   the pass repeats, so no write is lost;
// - it only ever sets emailEngagement.opened/clicked = true and moves
//   openedAt/clickedAt LATER; nothing else on a contact is touched;
// - the SQLite mirror is deliberately left alone (no second SQLite writer):
//   nothing reads emailEngagement from it for decisions, and the next edit of a
//   contact re-syncs that contact.
import fs from "fs";
import os from "os";
import path from "path";
import { randomBytes } from "crypto";

const args = new Set(process.argv.slice(2));
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || process.cwd();
const CONTACTS = path.join(DATA_DIR, "crm_contacts.json");
const PATCH_FILE = path.join(DATA_DIR, "_ac_engagement_patch.json");
const REPORT = path.join(DATA_DIR, "_ac_engagement_backchannel_report.json");
const AC_BASE = "https://pacificrimathletics.api-us1.com";
const PAGE = 100, CONCURRENCY = 2;
const sleep = ms => new Promise(r => setTimeout(r, ms));
try { os.setPriority(0, 19); } catch { /* best effort: lowest CPU priority so the web server always wins */ }

// AC's last_open_date/last_click_date are "2026-07-13 15:07:39" wall-clock in the
// account's timezone (US Central, same as its cdate offsets) -> ISO UTC or null.
export function acLocalToIso(s, timeZone = "America/Chicago") {
  if (!s || String(s).startsWith("0000")) return null;
  const m = /^(\d{4})-(\d\d)-(\d\d)[ T](\d\d):(\d\d):(\d\d)/.exec(String(s));
  if (!m) { const t = new Date(s).getTime(); return isNaN(t) ? null : new Date(t).toISOString(); }
  const asUtc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(asUtc));
  const g = t => +parts.find(p => p.type === t).value;
  const shown = Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second"));
  return new Date(asUtc - (shown - asUtc)).toISOString();
}

// ── sweep: AC contacts -> { acId: [openedIso|null, clickedIso|null] } ───────────
async function fetchAcPage(offset) {
  for (let attempt = 0; attempt < 7; attempt++) {
    try {
      const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 25000);
      const r = await fetch(`${AC_BASE}/api/3/contacts?limit=${PAGE}&offset=${offset}&orders[id]=ASC`, { headers: { "Api-Token": process.env.AC_API_KEY }, signal: ctl.signal });
      clearTimeout(timer);
      if (r.status === 429) { await sleep(Number(r.headers.get("retry-after") || 2) * 1000); continue; }
      const j = await r.json().catch(() => null);
      if (r.ok && j && Array.isArray(j.contacts)) return j;
    } catch { /* timeout / network: retry */ }
    await sleep(700 * (attempt + 1) ** 2);
  }
  throw new Error(`AC page at offset ${offset} failed after retries`);
}

async function sweep() {
  if (!process.env.AC_API_KEY) { console.error("AC_API_KEY missing"); process.exit(1); }
  const t0 = Date.now();
  const first = await fetchAcPage(0);
  const total = Number(first.meta?.total || first.contacts.length);
  const pagesTotal = Math.ceil(total / PAGE);
  console.log(`AC contacts: ${total} (${pagesTotal} pages)`);
  const patch = {}; let seen = 0, withOpen = 0, withClick = 0, pagesDone = 0;
  const absorb = page => {
    for (const c of page.contacts) {
      seen++;
      const o = acLocalToIso(c.last_open_date), k = acLocalToIso(c.last_click_date);
      if (!o && !k) continue;
      if (o) withOpen++;
      if (k) withClick++;
      patch[String(c.id)] = [o, k];
    }
    pagesDone++;
  };
  absorb(first);
  let next = 1;
  const worker = async () => {
    while (next < pagesTotal) {
      const idx = next++;
      absorb(await fetchAcPage(idx * PAGE));
      if (pagesDone % 100 === 0) console.log(`  ${pagesDone}/${pagesTotal} pages | ${withOpen} with last-open | ${Math.round((Date.now() - t0) / 1000)}s`);
      await sleep(120); // gentle: well under AC's ~5 req/s limit
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  const out = { sweptAt: new Date().toISOString(), pagesTotal, pagesDone, acContactsSeen: seen, withOpen, withClick, complete: pagesDone === pagesTotal, patch };
  const tmp = PATCH_FILE + ".tmp" + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(out));
  fs.renameSync(tmp, PATCH_FILE);
  console.log(`sweep done in ${Math.round((Date.now() - t0) / 1000)}s: ${seen} AC contacts, ${withOpen} with a last-open date, ${withClick} with a last-click date -> ${PATCH_FILE}`);
}

// ── apply ───────────────────────────────────────────────────────────────
function* elementRanges(buf) {
  let i = buf.indexOf(0x5b);
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
const NEEDLE = Buffer.from('"acContactId"');
function acKeyOf(buf, s, e) {
  const i = buf.indexOf(NEEDLE, s);
  if (i === -1 || i >= e) return null;
  return /^\s*:\s*"?(\d+)"?/.exec(buf.toString("latin1", i + NEEDLE.length, Math.min(e, i + NEEDLE.length + 24)))?.[1] ?? null;
}
// Only ever sets flags true and moves times later.
function applyEng(c, [o, k]) {
  const eng = c.emailEngagement || (c.emailEngagement = {});
  const later = (a, b) => !a || Date.parse(b) > Date.parse(a);
  let ch = false;
  if (o) { if (later(eng.openedAt, o)) { eng.openedAt = o; ch = true; } if (!eng.opened) { eng.opened = true; ch = true; } }
  if (k) { if (later(eng.clickedAt, k)) { eng.clickedAt = k; ch = true; } if (!eng.clicked) { eng.clicked = true; ch = true; } if (!eng.opened) { eng.opened = true; ch = true; } }
  return ch;
}

// One pass over `buf`. write=false -> counts only. write=true -> writes tmpPath.
function pass(buf, patch, tmpPath) {
  const stats = { total: 0, linked: 0, matched: 0, changed: 0, alreadyCurrent: 0, opened100d: 0 };
  const cutoff = Date.now() - 100 * 86400e3;
  const write = !!tmpPath;
  const fd = write ? fs.openSync(tmpPath, "w") : null;
  let first = true, pending = [], pendingLen = 0;
  const flush = () => { if (pending.length) { fs.writeSync(fd, Buffer.concat(pending)); pending = []; pendingLen = 0; } };
  const push = b => { pending.push(b); pendingLen += b.length; if (pendingLen > 8 << 20) flush(); };
  try {
    if (write) fs.writeSync(fd, "[");
    for (const [s, e] of elementRanges(buf)) {
      stats.total++;
      let out = null;
      const key = acKeyOf(buf, s, e);
      if (key != null) {
        stats.linked++;
        const p = patch[key];
        if (p) {
          stats.matched++;
          const c = JSON.parse(buf.toString("utf8", s, e));
          if (String(c.externalIds?.acContactId) === key) {
            if (applyEng(c, p)) { stats.changed++; if (write) out = Buffer.from(JSON.stringify(c), "utf8"); } else stats.alreadyCurrent++;
            const t = Math.max(Date.parse(c.emailEngagement?.openedAt || 0) || 0, Date.parse(c.emailEngagement?.clickedAt || 0) || 0);
            if (t >= cutoff) stats.opened100d++;
          }
        }
      }
      if (write) { if (!out) out = buf.subarray(s, e); push(first ? out : Buffer.concat([Buffer.from(","), out])); first = false; }
    }
    if (write) { push(Buffer.from("]")); flush(); }
  } finally { if (write) fs.closeSync(fd); }
  return stats;
}

async function apply() {
  const doWrite = args.has("--write");
  if (!fs.existsSync(PATCH_FILE)) { console.error("no patch file -- run --sweep first"); process.exit(1); }
  const P = JSON.parse(fs.readFileSync(PATCH_FILE, "utf8"));
  const ageH = (Date.now() - Date.parse(P.sweptAt)) / 3600e3;
  console.log(`patch: ${Object.keys(P.patch).length} AC contacts with dates | swept ${P.sweptAt} (${ageH.toFixed(1)}h ago) | complete=${P.complete}`);
  if (!P.complete) { console.error("sweep was incomplete -- refusing"); process.exit(1); }
  if (doWrite && ageH > 12) { console.error("patch is over 12h old -- re-run --sweep"); process.exit(1); }
  const t0 = Date.now();
  for (let attempt = 1; attempt <= 6; attempt++) {
    const st0 = fs.statSync(CONTACTS);
    const buf = fs.readFileSync(CONTACTS);
    if (!doWrite) {
      const s = pass(buf, P.patch, null);
      console.log(`DRY RUN (nothing written): contacts ${s.total} | AC-linked ${s.linked} | matched to an AC record with dates ${s.matched} | would update ${s.changed} | already current ${s.alreadyCurrent} | of those, opened/clicked in the last 100 days: ${s.opened100d} | ${Date.now() - t0}ms`);
      return;
    }
    const tmp = path.join(DATA_DIR, `crm_contacts.json.acbackchannel-${randomBytes(4).toString("hex")}`);
    const s = pass(buf, P.patch, tmp);
    if (!s.changed) { fs.unlinkSync(tmp); console.log("nothing to update"); return; }
    const nb = fs.readFileSync(tmp);
    let count = 0; for (const _ of elementRanges(nb)) count++;
    if (count !== s.total || nb[0] !== 0x5b || nb[nb.length - 1] !== 0x5d) { fs.unlinkSync(tmp); throw new Error(`new file failed the check (${count} records vs ${s.total}); live file untouched`); }
    const st1 = fs.statSync(CONTACTS);
    if (st1.mtimeMs !== st0.mtimeMs || st1.size !== st0.size) { fs.unlinkSync(tmp); console.log(`attempt ${attempt}: live file changed while working -- retrying`); await sleep(1500); continue; }
    fs.renameSync(tmp, CONTACTS);
    console.log(`contacts file replaced: ${s.changed} contacts updated (of ${s.total}) in ${Date.now() - t0}ms`);
    fs.writeFileSync(REPORT, JSON.stringify({ ranAt: new Date().toISOString(), sweptAt: P.sweptAt, ...s }, null, 2));
    return;
  }
  console.error("gave up: the live contacts file kept changing"); process.exit(2);
}

if (args.has("--sweep")) await sweep();
else if (args.has("--apply")) await apply();
else console.log("usage: --sweep | --apply [--write]");
