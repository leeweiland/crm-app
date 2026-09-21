// BACK CHANNEL: writes AI income estimates (income_estimate_core.js) onto our
// contacts' two custom fields -- ESTIMATED INCOME (USD/YR) and INCOME ESTIMATE
// BASIS -- in ONE pass over the contacts file.
//
// Runs as its OWN process (via `railway ssh`), never inside the web server: a
// bulk patch from inside the single Node thread froze the CRM for minutes (the
// same lesson as ac_engagement.mjs). The estimates themselves are produced off-
// server too (they're just Anthropic calls); this only stamps the results in.
//
//   node --no-warnings income_fill.mjs --apply           DRY RUN: prints what would change, writes nothing
//   node --no-warnings income_fill.mjs --apply --write   applies it
//
// Input: <data dir>/_income_estimates_patch.json
//   { "results": [ { "id": <contactId>, "income": 85000 | null, "confidence": "medium", "basis": "..." }, ... ] }
//
// Safe alongside the live server (same rules as ac_engagement.mjs):
// - reads the contacts file into a Buffer and writes a NEW file next to it,
//   structurally checks it, then renames it into place -- never edits in place;
// - if the live file changed while it worked, the new file is discarded and the
//   pass repeats, so no write from the server is ever lost;
// - only the two income custom fields of the listed contacts are touched;
// - lowers its own CPU priority so the web server always wins;
// - leaves the SQLite mirror alone (no second SQLite writer): segments read the
//   contacts file, and the next edit of a contact re-syncs that contact.
import fs from "fs";
import os from "os";
import path from "path";
import { randomBytes } from "crypto";

const args = new Set(process.argv.slice(2));
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || process.cwd();
const CONTACTS = path.join(DATA_DIR, "crm_contacts.json");
const FIELDS = path.join(DATA_DIR, "crm_custom_fields.json");
const PATCH_FILE = path.join(DATA_DIR, "_income_estimates_patch.json");
const REPORT = path.join(DATA_DIR, "_income_fill_report.json");
const INCOME_LABEL = "ESTIMATED INCOME (USD/YR)", BASIS_LABEL = "INCOME ESTIMATE BASIS";
const sleep = ms => new Promise(r => setTimeout(r, ms));
try { os.setPriority(0, 19); } catch { /* best effort */ }

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
const ID_RE = /^\s*\{\s*"id"\s*:\s*"([^"]+)"/;
const idOf = (buf, s, e) => ID_RE.exec(buf.toString("latin1", s, Math.min(e, s + 120)))?.[1] ?? null;

function loadPatch() {
  if (!fs.existsSync(PATCH_FILE)) { console.error("no patch file at " + PATCH_FILE); process.exit(1); }
  const P = JSON.parse(fs.readFileSync(PATCH_FILE, "utf8"));
  const fields = JSON.parse(fs.readFileSync(FIELDS, "utf8")).filter(f => f.entityType === "contact");
  const incomeId = fields.find(f => f.label === INCOME_LABEL)?.id, basisId = fields.find(f => f.label === BASIS_LABEL)?.id;
  if (!incomeId || !basisId) { console.error("the two income custom fields don't exist yet -- refusing"); process.exit(1); }
  return { byId: new Map(P.results.map(r => [r.id, r])), incomeId, basisId };
}

// One pass over `buf`. tmpPath null -> counts only (dry run).
function pass(buf, { byId, incomeId, basisId }, tmpPath) {
  const stats = { total: 0, matched: 0, changed: 0, alreadyCurrent: 0, withIncome: 0, noEstimate: 0 };
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
      const id = idOf(buf, s, e);
      const r = id && byId.get(id);
      if (r) {
        stats.matched++;
        const c = JSON.parse(buf.toString("utf8", s, e));
        c.customFields = c.customFields || {};
        const income = r.income != null ? String(r.income) : undefined;
        const basis = `${r.basis || "n/a"} [${r.income != null ? `${r.confidence} confidence, AI estimate` : "no estimate, AI"}]`;
        if (c.customFields[incomeId] === income && c.customFields[basisId] === basis) stats.alreadyCurrent++;
        else {
          if (income !== undefined) c.customFields[incomeId] = income; else delete c.customFields[incomeId];
          c.customFields[basisId] = basis;
          stats.changed++;
          if (write) out = Buffer.from(JSON.stringify(c), "utf8");
        }
        if (income !== undefined) stats.withIncome++; else stats.noEstimate++;
      }
      if (write) { if (!out) out = buf.subarray(s, e); push(first ? out : Buffer.concat([Buffer.from(","), out])); first = false; }
    }
    if (write) { push(Buffer.from("]")); flush(); }
  } finally { if (write) fs.closeSync(fd); }
  return stats;
}

async function apply() {
  const doWrite = args.has("--write");
  const P = loadPatch();
  console.log(`patch: ${P.byId.size} contacts`);
  const t0 = Date.now();
  for (let attempt = 1; attempt <= 6; attempt++) {
    const st0 = fs.statSync(CONTACTS);
    const buf = fs.readFileSync(CONTACTS);
    if (!doWrite) {
      const s = pass(buf, P, null);
      console.log(`DRY RUN (nothing written): contacts ${s.total} | matched ${s.matched} of ${P.byId.size} | would update ${s.changed} | already current ${s.alreadyCurrent} | with an income ${s.withIncome} | no estimate ${s.noEstimate} | ${Date.now() - t0}ms`);
      return;
    }
    const tmp = path.join(DATA_DIR, `crm_contacts.json.incomefill-${randomBytes(4).toString("hex")}`);
    const s = pass(buf, P, tmp);
    if (!s.changed) { fs.unlinkSync(tmp); console.log("nothing to update"); return; }
    const nb = fs.readFileSync(tmp);
    let count = 0; for (const _ of elementRanges(nb)) count++;
    if (count !== s.total || nb[0] !== 0x5b || nb[nb.length - 1] !== 0x5d) { fs.unlinkSync(tmp); throw new Error(`new file failed the check (${count} records vs ${s.total}); live file untouched`); }
    const st1 = fs.statSync(CONTACTS);
    if (st1.mtimeMs !== st0.mtimeMs || st1.size !== st0.size) { fs.unlinkSync(tmp); console.log(`attempt ${attempt}: live file changed while working -- retrying`); await sleep(1500); continue; }
    fs.renameSync(tmp, CONTACTS);
    console.log(`contacts file replaced: ${s.changed} contacts updated (of ${s.total}) in ${Date.now() - t0}ms`);
    fs.writeFileSync(REPORT, JSON.stringify({ ranAt: new Date().toISOString(), ...s }, null, 2));
    return;
  }
  console.error("gave up: the live contacts file kept changing"); process.exit(2);
}

if (args.has("--apply")) await apply();
else console.log("usage: --apply [--write]");
