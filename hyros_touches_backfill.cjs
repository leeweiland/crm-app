// One-time backfill of Hyros history into ONE compact table, for Ad Attribution /
// Ads Report / Customer Journeys to read (see the Hyros-merge design).
//
// Runs as its OWN process (never inside the app's server): for every Hyros-
// imported contact it reads that contact's own small message file, pulls out
// the Hyros first/last click, booked calls and sales, and writes one row into
// a SEPARATE SQLite file (hyros_touches.db). It never writes to contacts, the
// message log, or the main crm_prototype.db (which it opens read-only).
//
// Throttled (DUTY = fraction of wall time spent working, the rest is sleep) and
// resumable (progress is saved after every batch; a redeploy that kills it just
// means re-running the same command). Re-running is idempotent (INSERT OR REPLACE).
//
//   node hyros_touches_backfill.cjs            run / resume
//   node hyros_touches_backfill.cjs --status   show progress
//   env: DATA_DIR (default /data)  DUTY (default 0.5)  BATCH (default 100)  LIMIT (test only)
const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const DATA = process.env.DATA_DIR || "/data";
const DUTY = Math.min(1, Math.max(0.05, Number(process.env.DUTY || 0.5)));
const BATCH = Number(process.env.BATCH || 100);
const LIMIT = process.env.LIMIT ? Number(process.env.LIMIT) : Infinity;
const IDS_FILE = path.join(DATA, "hyros_backfill_ids.json");
const PROGRESS_FILE = path.join(DATA, "hyros_backfill_progress.json");
const OUT_DB = path.join(DATA, "hyros_touches.db");
const MSG_DIR = path.join(DATA, "msg_by_contact");

const readJson = (p, fallback) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fallback; } };
const writeJsonAtomic = (p, obj) => { const t = p + ".tmp"; fs.writeFileSync(t, JSON.stringify(obj)); fs.renameSync(t, p); };
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

function openOut() {
  const db = new DatabaseSync(OUT_DB);
  db.exec(`
    CREATE TABLE IF NOT EXISTS touches (
      contact_id TEXT PRIMARY KEY,
      lead_at TEXT, lead_ms INTEGER,
      first_at TEXT, first_tag TEXT, first_platform TEXT,
      first_json TEXT, last_json TEXT, calls_json TEXT, sales_json TEXT,
      n_calls INTEGER DEFAULT 0, n_sales INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_touches_lead ON touches(lead_ms);
    CREATE INDEX IF NOT EXISTS idx_touches_first_tag ON touches(first_tag);
  `);
  return db;
}

// The Hyros import stored each lead's creationDate with a wrong "-09:00" offset
// appended to what is really a UTC clock reading (confirmed against the first-
// click timestamps, which are true "Z" times a few seconds earlier), and stamped
// createdAt with the Aug 21-22 import date -- so the true lead instant is
// firstSeenAt's digits read as UTC.
function leadAt(firstSeen) {
  const m = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)/.exec(String(firstSeen || ""));
  return m ? m[1] + "Z" : null;
}

const stripClickPrefix = (s) => String(s || "").replace(/^(First|Last) ad click:\s*/, "");
function compactSource(s) {
  if (!s) return null;
  return {
    name: s.name || null, tag: s.tag || null, platform: s.trafficSource?.name || null, category: s.category?.name || null,
    adPlatform: s.adSource?.platform || null, adSourceId: s.adSource?.adSourceId || null, adAccountId: s.adSource?.adAccountId || null,
    adId: s.sourceLinkAd?.adSourceId || null, adName: s.sourceLinkAd?.name || null, clickDate: s.clickDate || null,
    organic: !!s.organic, gclid: s.clickId || null,
  };
}

function deriveRow(id, firstSeen, msgs) {
  let first = null, last = null;
  const calls = [], sales = [];
  for (const m of msgs) {
    const hid = m && m.hyrosActivityId;
    if (!hid) continue;
    const at = m.createdAt || m.sentAt || null;
    if (hid.startsWith("hyros_sale:")) {
      const d = m.hyrosSaleData || {};
      sales.push({
        at, id: hid.slice(11), amount: d.amount ?? null, refunded: d.refunded || 0, refundDate: d.refundDate || null,
        orderId: d.orderId || null, product: d.product?.name || null, productTag: d.product?.tag || null,
        first: compactSource(d.firstSource), last: compactSource(d.lastSource),
      });
    } else if (hid.startsWith("hyros_call:")) {
      calls.push({ at, id: hid.slice(11), subject: m.subject || null, tag: m.bodyPreview || null, source: m.body || null });
    } else {
      // "<leadId>:first|last:<sourceLinkId>" -- first/last ad click. (The lead-level entry
      // only kept name, tag, platform/category and click time; ad IDs are on sales.)
      const slot = hid.split(":")[1];
      const [platform, category] = String(m.body || "").split(" · ");
      const src = { at, name: stripClickPrefix(m.subject), tag: m.bodyPreview || null, platform: platform || null, category: category || null };
      if (slot === "first") first = src; else if (slot === "last") last = src;
    }
  }
  if (!first && !last && !calls.length && !sales.length) return null;
  const lead = leadAt(firstSeen) || (first && first.at) || (last && last.at) || null;
  return {
    id, lead_at: lead, lead_ms: lead ? Date.parse(lead) : null,
    first_at: first ? first.at : null, first_tag: first ? first.tag : null, first_platform: first ? first.platform : null,
    first_json: first ? JSON.stringify(first) : null, last_json: last ? JSON.stringify(last) : null,
    calls_json: JSON.stringify(calls), sales_json: JSON.stringify(sales), n_calls: calls.length, n_sales: sales.length,
  };
}

function buildIdList() {
  if (fs.existsSync(IDS_FILE)) return readJson(IDS_FILE, []);
  log("building the Hyros contact list from the contacts index (read-only, one pass)...");
  const src = new DatabaseSync(path.join(DATA, "crm_prototype.db"), { readOnly: true });
  const rows = src.prepare(`SELECT id, first_seen_at FROM contacts_idx WHERE raw_json LIKE '%"hyrosLeadId":"%' ORDER BY id`).all();
  src.close();
  const ids = rows.map(r => [r.id, r.first_seen_at || null]);
  writeJsonAtomic(IDS_FILE, ids);
  log(`found ${ids.length} Hyros-linked contacts`);
  return ids;
}

function status() {
  const ids = readJson(IDS_FILE, null), p = readJson(PROGRESS_FILE, null);
  const out = { totalContacts: ids ? ids.length : null, progress: p };
  if (fs.existsSync(OUT_DB)) {
    const db = new DatabaseSync(OUT_DB, { readOnly: true });
    out.rows = db.prepare("SELECT COUNT(*) n FROM touches").get().n;
    out.withFirstClick = db.prepare("SELECT COUNT(*) n FROM touches WHERE first_json IS NOT NULL").get().n;
    out.withSales = db.prepare("SELECT COUNT(*) n FROM touches WHERE n_sales > 0").get().n;
    out.withCalls = db.prepare("SELECT COUNT(*) n FROM touches WHERE n_calls > 0").get().n;
    db.close();
  }
  console.log(JSON.stringify(out, null, 1));
}

async function main() {
  if (process.argv.includes("--status")) return status();
  const ids = buildIdList();
  const total = Math.min(ids.length, LIMIT);
  const prog = readJson(PROGRESS_FILE, { next: 0, rows: 0, noHyros: 0, missingFile: 0, errors: 0, startedAt: new Date().toISOString() });
  const db = openOut();
  const upsert = db.prepare(`INSERT OR REPLACE INTO touches
    (contact_id, lead_at, lead_ms, first_at, first_tag, first_platform, first_json, last_json, calls_json, sales_json, n_calls, n_sales)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  let stop = false;
  process.on("SIGTERM", () => { stop = true; });
  process.on("SIGINT", () => { stop = true; });
  log(`resuming at ${prog.next}/${total} (duty ${DUTY}, batch ${BATCH})`);
  const t0 = Date.now(), startNext = prog.next;
  while (prog.next < total && !stop) {
    const bStart = Date.now();
    const end = Math.min(prog.next + BATCH, total);
    const rows = [];
    for (let i = prog.next; i < end; i++) {
      const [id, firstSeen] = ids[i];
      let txt;
      try { txt = fs.readFileSync(path.join(MSG_DIR, String(id).replace(/[^a-zA-Z0-9_-]/g, "") + ".json"), "utf8"); }
      catch { prog.missingFile++; continue; }
      let msgs;
      try { msgs = JSON.parse(txt); } catch { prog.errors++; continue; }
      const row = deriveRow(id, firstSeen, Array.isArray(msgs) ? msgs : []);
      if (row) rows.push(row); else prog.noHyros++;
    }
    db.exec("BEGIN");
    for (const r of rows) upsert.run(r.id, r.lead_at, r.lead_ms, r.first_at, r.first_tag, r.first_platform, r.first_json, r.last_json, r.calls_json, r.sales_json, r.n_calls, r.n_sales);
    db.exec("COMMIT");
    prog.rows += rows.length;
    prog.next = end;
    prog.updatedAt = new Date().toISOString();
    writeJsonAtomic(PROGRESS_FILE, prog);
    if (Math.floor(end / 5000) !== Math.floor((end - BATCH) / 5000) || end === total) {
      const per = (Date.now() - t0) / Math.max(1, end - startNext);
      log(`${end}/${total} (${Math.round(end / total * 100)}%)  rows=${prog.rows} noHyros=${prog.noHyros} missing=${prog.missingFile} errors=${prog.errors}  ~${Math.round((total - end) * per / 60000)} min left`);
    }
    // sleep so the process only works DUTY of the time
    const worked = Date.now() - bStart;
    await new Promise(r => setTimeout(r, Math.round(worked * (1 - DUTY) / DUTY)));
  }
  db.close();
  log(prog.next >= total ? "DONE" : "stopped (resume by running the same command again)");
}
main().catch(e => { console.error("FAILED:", e); process.exit(1); });
