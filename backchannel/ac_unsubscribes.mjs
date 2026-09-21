// BACK CHANNEL: makes sure contacts who UNSUBSCRIBED in ActiveCampaign recently
// are opted out of email in the CRM too.
//
// Same rule the original AC import used (import_backend.js: "unsubscribed from
// ANY list => emailOptOut = true"), applied to unsubscribes that happened after
// that import. Input is a small JSON file { "<acContactId>": "<latest unsubscribe ISO>" }
// built from AC's contactLists (status 2) by a read-only sweep run elsewhere.
//
// Runs as its OWN process (via `railway ssh`), never inside the web server:
//   node --no-warnings ac_unsubscribes.mjs --check            dry run: counts only, writes nothing
//   node --no-warnings ac_unsubscribes.mjs --write            applies it
// env: IDS_FILE (default $DATA_DIR/_ac_unsub_ids.json)
//
// Safe alongside the live server:
// - reads the contacts file into a Buffer and writes a NEW file next to it,
//   structurally checks it, then renames it into place (never edits in place); if
//   the live file changed meanwhile it discards the new file and repeats;
// - only ever sets emailOptOut = true (+ emailUnsubscribedAt, an audit stamp) on a
//   contact that isn't already opted out; never opts anyone back IN;
// - the SQLite copy (Contacts list badge) is updated with plain UPDATEs in small
//   paced transactions under the app's own busy_timeout -- no app modules loaded.
import fs from "fs";
import os from "os";
import path from "path";
import { randomBytes } from "crypto";
import { DatabaseSync } from "node:sqlite";

const args = new Set(process.argv.slice(2));
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || process.cwd();
const CONTACTS = path.join(DATA_DIR, "crm_contacts.json");
const DB_PATH = path.join(DATA_DIR, "crm_prototype.db");
const IDS_FILE = process.env.IDS_FILE || path.join(DATA_DIR, "_ac_unsub_ids.json");
const REPORT = path.join(DATA_DIR, "_ac_unsubscribes_backchannel_report.json");
const sleep = ms => new Promise(r => setTimeout(r, ms));
try { os.setPriority(0, 19); } catch { /* lowest CPU priority so the web server always wins */ }

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

// One pass. tmpPath=null -> counts only. Returns stats + ids of contacts changed.
function pass(buf, ids, tmpPath) {
  const stats = { total: 0, linked: 0, foundInCrm: 0, alreadyOptedOut: 0, toUpdate: 0 };
  const foundKeys = new Set(), changedCrmIds = [];
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
        if (ids[key]) {
          const c = JSON.parse(buf.toString("utf8", s, e));
          if (String(c.externalIds?.acContactId) === key) {
            stats.foundInCrm++; foundKeys.add(key);
            if (c.emailOptOut === true) stats.alreadyOptedOut++;
            else { stats.toUpdate++; changedCrmIds.push(c.id); if (write) { c.emailOptOut = true; c.emailUnsubscribedAt = ids[key]; out = Buffer.from(JSON.stringify(c), "utf8"); } }
          }
        }
      }
      if (write) { if (!out) out = buf.subarray(s, e); push(first ? out : Buffer.concat([Buffer.from(","), out])); first = false; }
    }
    if (write) { push(Buffer.from("]")); flush(); }
  } finally { if (write) fs.closeSync(fd); }
  return { stats, foundKeys, changedCrmIds };
}

async function syncSqlite(crmIds) {
  if (!fs.existsSync(DB_PATH)) { console.log("no sqlite file -- skipped"); return { updated: 0, failed: 0 }; }
  const db = new DatabaseSync(DB_PATH);
  db.exec("PRAGMA busy_timeout = 8000;");
  const upd = db.prepare("UPDATE contacts_idx SET email_opt_out = 1, raw_json = json_set(raw_json, '$.emailOptOut', json('true')) WHERE id = ?");
  let updated = 0, failed = 0;
  for (let i = 0; i < crmIds.length; i += 100) {
    const chunk = crmIds.slice(i, i + 100);
    try { db.exec("BEGIN IMMEDIATE"); for (const id of chunk) updated += Number(upd.run(id).changes); db.exec("COMMIT"); }
    catch (e) { try { db.exec("ROLLBACK"); } catch {} failed += chunk.length; console.error("sqlite batch failed:", e.message); }
    await sleep(80); // pace: never hold the write lock back to back
  }
  db.close();
  return { updated, failed };
}

async function main() {
  if (!fs.existsSync(IDS_FILE)) { console.error("no ids file:", IDS_FILE); process.exit(1); }
  const ids = JSON.parse(fs.readFileSync(IDS_FILE, "utf8"));
  const given = Object.keys(ids).length;
  const doWrite = args.has("--write");
  console.log(`unsubscribed AC contacts given: ${given}`);
  const t0 = Date.now();
  for (let attempt = 1; attempt <= 6; attempt++) {
    const st0 = fs.statSync(CONTACTS);
    const buf = fs.readFileSync(CONTACTS);
    if (!doWrite) {
      const { stats, foundKeys } = pass(buf, ids, null);
      console.log(`DRY RUN (nothing written): CRM contacts ${stats.total} | matched to an unsubscribed AC contact ${stats.foundInCrm} of ${given} (${given - foundKeys.size} not in the CRM) | already opted out in CRM ${stats.alreadyOptedOut} | would opt out now ${stats.toUpdate} | ${Date.now() - t0}ms`);
      return;
    }
    const tmp = path.join(DATA_DIR, `crm_contacts.json.acunsub-${randomBytes(4).toString("hex")}`);
    const { stats, foundKeys, changedCrmIds } = pass(buf, ids, tmp);
    if (!stats.toUpdate) { fs.unlinkSync(tmp); console.log("nothing to update -- everyone is already opted out"); return; }
    const nb = fs.readFileSync(tmp);
    let count = 0; for (const _ of elementRanges(nb)) count++;
    if (count !== stats.total || nb[0] !== 0x5b || nb[nb.length - 1] !== 0x5d) { fs.unlinkSync(tmp); throw new Error(`new file failed the check (${count} records vs ${stats.total}); live file untouched`); }
    const st1 = fs.statSync(CONTACTS);
    if (st1.mtimeMs !== st0.mtimeMs || st1.size !== st0.size) { fs.unlinkSync(tmp); console.log(`attempt ${attempt}: live file changed while working -- retrying`); await sleep(1500); continue; }
    fs.renameSync(tmp, CONTACTS);
    console.log(`contacts file replaced: ${stats.toUpdate} contacts opted out (of ${given} unsubscribed in AC; ${stats.alreadyOptedOut} were already opted out; ${given - foundKeys.size} not in the CRM)`);
    const sq = await syncSqlite(changedCrmIds);
    console.log(`sqlite copy updated: ${sq.updated} rows (${sq.failed} failed)`);
    fs.writeFileSync(REPORT, JSON.stringify({ ranAt: new Date().toISOString(), unsubscribedInAc: given, ...stats, notInCrm: given - foundKeys.size, sqlite: sq }, null, 2));
    return;
  }
  console.error("gave up: the live contacts file kept changing"); process.exit(2);
}
await main();
