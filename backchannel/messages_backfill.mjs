// Copies message history from the JSON files on the volume into Postgres
// (messages_db.js / messages_schema.js). Runs as its own low-priority
// process on the app container -- never inside the CRM -- and only READS
// the message files; nothing the live app uses is modified.
//
//   node backchannel/messages_backfill.mjs schema      create tables (no indexes yet)
//   node backchannel/messages_backfill.mjs contacts    msg_by_contact/ (+ status overlays) -> messages; resumable
//   node backchannel/messages_backfill.mjs missing     contacts with messages but no rows yet (damaged files salvaged)
//   node backchannel/messages_backfill.mjs unmatched   rows with no contact, from crm_message_log.json
//   node backchannel/messages_backfill.mjs finish      indexes, daily-stats rebuild + triggers, ANALYZE
//   node backchannel/messages_backfill.mjs catchup [--deploy=<iso>]
//        re-copies every contact whose message files changed since the
//        contacts pass started, plus unmatched rows appended to the main
//        log since the unmatched pass. Run once just before switching the
//        app to MESSAGES_STORE=pg and once right after; with --deploy, a
//        status event the app already applied in Postgres after that time
//        is kept, merged on top of the file's version.
//   node backchannel/messages_backfill.mjs verify [--sample=500]
//
// Progress and resume points: /data/_messages_backfill_state.json
import os from "os";
import path from "path";
import { readdirSync, readFileSync, statSync, existsSync, openSync, readSync, closeSync, writeFileSync } from "fs";
import { pathToFileURL } from "url";
import { createRequire } from "module";

const APP_DIR = process.env.APP_DIR || "/app";
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || "/data";
const imp = (f) => import(pathToFileURL(path.join(APP_DIR, f)).href);
const { messageToParams, MESSAGE_COLUMNS, rowToMessage } = await imp("messages_db.js");
const schema = await imp("messages_schema.js");
const { forEachJsonArrayElement } = await imp("auth_backend.js");
const pg = createRequire(path.join(APP_DIR, "package.json"))("pg");

try { os.setPriority(0, 19); } catch { /* best effort */ }

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const STATE_FILE = path.join(DATA_DIR, "_messages_backfill_state.json");
const CONTACT_DIR = path.join(DATA_DIR, "msg_by_contact");
const STATUS_DIR = path.join(DATA_DIR, "msg_by_contact_status");
const MAIN_LOG = path.join(DATA_DIR, "crm_message_log.json");
const BATCH_ROWS = 1000;
const PAUSE_MS = Number(process.env.BACKFILL_PAUSE_MS ?? 15); // between batches, so the database keeps answering the CRM first

const args = Object.fromEntries(process.argv.slice(3).map(a => a.replace(/^--/, "").split("=")));
const loadState = () => { try { return JSON.parse(readFileSync(STATE_FILE, "utf8")); } catch { return {}; } };
const saveState = (s) => writeFileSync(STATE_FILE, JSON.stringify(s, null, 1));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(`[messages-backfill ${new Date().toISOString()}]`, ...a);

// A file cut off mid-write (some contact files are) still holds every record
// before the cut: keep those instead of skipping the contact.
function readJsonFile(p, fallback) {
  try { return JSON.parse(readFileSync(p, "utf8")); }
  catch (e) {
    if (e.code === "ENOENT") return fallback;
    const out = [];
    try { forEachJsonArrayElement(p, (buf, s, en) => { try { out.push(JSON.parse(buf.toString("utf8", s, en))); } catch { /* the cut-off record */ } }); }
    catch { throw e; }
    log(`  salvaged ${out.length} complete records from damaged ${path.basename(path.dirname(p))}/${path.basename(p)} (${e.message})`);
    salvagedFiles++;
    return out;
  }
}
let salvagedFiles = 0;

// Backs off while the CRM itself is slow to answer, so the copy never
// competes with real users (checked every few batches, on this container).
const CRM_URL = `http://127.0.0.1:${process.env.PORT || 8080}/login.html`;
let batchesSinceCheck = 0;
async function yieldToCrm() {
  if (++batchesSinceCheck < 5) return;
  batchesSinceCheck = 0;
  for (let waited = 0; ; waited += 20) {
    const t = Date.now();
    try { await fetch(CRM_URL, { signal: AbortSignal.timeout(15000) }); }
    catch (e) { if (e.name !== "TimeoutError") return; /* no CRM listening here (e.g. a local test run) */ }
    const ms = Date.now() - t;
    if (ms < 800) return;
    if (waited % 120 === 0) log(`  CRM answered in ${ms}ms -- pausing the copy`);
    await sleep(20000);
  }
}
// Exactly message_index.js's getContactMessages fold (file mode): base rows
// with their status-overlay events applied in order.
function contactMessagesFromFiles(contactId) {
  const base = readJsonFile(path.join(CONTACT_DIR, `${contactId}.json`), []);
  const events = readJsonFile(path.join(STATUS_DIR, `${contactId}.json`), []);
  if (!events.length) return base;
  const overlay = new Map();
  for (const e of events) {
    const prev = overlay.get(e.id) || { patch: {}, historyAdds: [] };
    overlay.set(e.id, { patch: { ...prev.patch, ...e.patch }, historyAdds: e.historyAdds?.length ? [...prev.historyAdds, ...e.historyAdds] : prev.historyAdds });
  }
  return base.map((m) => {
    if (!overlay.has(m.id)) return m;
    const o = overlay.get(m.id);
    return { ...m, ...o.patch, statusHistory: o.historyAdds.length ? [...(m.statusHistory || []), ...o.historyAdds] : m.statusHistory };
  });
}

let _testIds = null;
async function testContactIds() {
  if (!_testIds) _testIds = new Set((await pool.query(`SELECT id FROM contacts WHERE extra->>'testContact' = 'true'`)).rows.map(r => r.id));
  return _testIds;
}
function placeholders(n) {
  const cols = MESSAGE_COLUMNS.length;
  const JSONB = new Set(["status_history", "extra"]);
  const out = [];
  for (let r = 0; r < n; r++) out.push("(" + MESSAGE_COLUMNS.map((c, i) => `$${r * cols + i + 1}${JSONB.has(c) ? "::jsonb" : ""}`).join(",") + ")");
  return out.join(",");
}
const UPSERT_SET = MESSAGE_COLUMNS.filter(c => c !== "id").map(c => `${c}=excluded.${c}`).join(", ");
async function writeRows(rows, { upsert = false } = {}) {
  if (!rows.length) return 0;
  const tests = await testContactIds();
  let written = 0;
  for (let i = 0; i < rows.length; i += BATCH_ROWS) {
    const chunk = rows.slice(i, i + BATCH_ROWS);
    const params = chunk.flatMap(m => messageToParams(m, tests.has(m.contactId)));
    const r = await pool.query(
      `INSERT INTO messages (${MESSAGE_COLUMNS.join(", ")}) VALUES ${placeholders(chunk.length)} ON CONFLICT (id) DO ${upsert ? `UPDATE SET ${UPSERT_SET}` : "NOTHING"}`,
      params
    );
    written += r.rowCount;
    if (PAUSE_MS) await sleep(PAUSE_MS);
    await yieldToCrm();
  }
  return written;
}

async function phaseSchema() {
  await pool.query(schema.TABLES_SQL);
  log("tables ready");
}

async function phaseContacts() {
  const state = loadState();
  if (!state.contactsStartedAt) state.contactsStartedAt = new Date().toISOString();
  const files = readdirSync(CONTACT_DIR).filter(f => f.endsWith(".json")).sort();
  let i = state.contactsNext || 0;
  let rowsSeen = state.contactsRowsSeen || 0, rowsWritten = state.contactsRowsWritten || 0;
  log(`contacts: ${files.length} files, resuming at ${i}`);
  const t0 = Date.now();
  const rows0 = rowsSeen;
  let pending = [];
  for (; i < files.length; i++) {
    const contactId = files[i].slice(0, -5);
    let rows;
    try { rows = contactMessagesFromFiles(contactId); }
    catch (e) { log(`  skip ${files[i]}: ${e.message}`); state.contactsSkipped = (state.contactsSkipped || 0) + 1; continue; }
    for (const m of rows) { if (m && m.id) pending.push(m.contactId ? m : { ...m, contactId }); }
    rowsSeen += rows.length;
    if (pending.length >= BATCH_ROWS || i === files.length - 1) {
      rowsWritten += await writeRows(pending);
      pending = [];
      Object.assign(state, { contactsNext: i + 1, contactsRowsSeen: rowsSeen, contactsRowsWritten: rowsWritten });
      saveState(state);
    }
    if (i % 2000 === 0) {
      const rate = (rowsSeen - rows0) / Math.max(1, (Date.now() - t0) / 1000);
      log(`  ${i}/${files.length} files, ${rowsSeen} rows read, ${rowsWritten} written, ~${rate.toFixed(0)} rows/s, heap ${Math.round(process.memoryUsage().heapUsed / 1e6)}MB`);
    }
  }
  if (pending.length) rowsWritten += await writeRows(pending);
  Object.assign(state, { contactsNext: files.length, contactsRowsSeen: rowsSeen, contactsRowsWritten: rowsWritten, contactsDoneAt: new Date().toISOString() });
  saveState(state);
  log(`contacts done: ${rowsSeen} rows read, ${rowsWritten} inserted (${rowsSeen - rowsWritten} were duplicates of an id already copied), ${salvagedFiles} damaged files salvaged`);
}

// Rows with no contact live only in the main log (msg_by_contact is keyed
// by contact). Byte check first, so only those rows are ever parsed.
const NULL_CONTACT = Buffer.from('"contactId":null');
const ANY_CONTACT = Buffer.from('"contactId":');
function isUnmatchedElement(buf, start, end) {
  const el = buf.subarray(start, end);
  return el.indexOf(NULL_CONTACT) !== -1 || el.indexOf(ANY_CONTACT) === -1;
}
async function phaseUnmatched() {
  const state = loadState();
  const size = statSync(MAIN_LOG).size;
  log(`unmatched: scanning ${(size / 1e9).toFixed(2)}GB main log`);
  const found = [];
  let scanned = 0;
  const t0 = Date.now();
  forEachJsonArrayElement(MAIN_LOG, (buf, start, end) => {
    scanned++;
    if (scanned % 1000000 === 0) log(`  ${scanned} rows scanned, ${found.length} unmatched, ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    if (!isUnmatchedElement(buf, start, end)) return;
    try { const m = JSON.parse(buf.toString("utf8", start, end)); if (m?.id && !m.contactId) found.push(m); } catch { /* malformed row: skip */ }
  });
  const written = await writeRows(found);
  Object.assign(state, { unmatchedScanned: scanned, unmatchedFound: found.length, unmatchedWritten: written, unmatchedLogSize: size, unmatchedDoneAt: new Date().toISOString() });
  saveState(state);
  log(`unmatched done: ${scanned} rows scanned, ${found.length} with no contact, ${written} inserted`);
}

// Contacts whose file holds messages but who have no rows in Postgres (an
// earlier run skipped damaged files) -- copied now, salvaging what's readable.
async function phaseMissing() {
  const files = readdirSync(CONTACT_DIR).filter(f => f.endsWith(".json")).sort();
  let fixed = 0, rows = 0;
  for (let i = 0; i < files.length; i += 2000) {
    const ids = files.slice(i, i + 2000).map(f => f.slice(0, -5));
    const have = new Set((await pool.query(`SELECT DISTINCT contact_id FROM messages WHERE contact_id = ANY($1)`, [ids])).rows.map(r => r.contact_id));
    for (const id of ids) {
      if (have.has(id)) continue;
      let msgs;
      try { msgs = contactMessagesFromFiles(id).filter(m => m?.id).map(m => (m.contactId ? m : { ...m, contactId: id })); }
      catch (e) { log(`  still unreadable: ${id}: ${e.message}`); continue; }
      if (!msgs.length) continue;
      rows += await writeRows(msgs);
      fixed++;
    }
  }
  log(`missing done: ${fixed} contacts copied (${rows} rows), ${salvagedFiles} damaged files salvaged`);
}

async function phaseFinish() {
  for (const sql of schema.INDEXES_SQL) { const t = Date.now(); await pool.query(sql); log(`  ${sql.split(" ON ")[0]} (${((Date.now() - t) / 1000).toFixed(0)}s)`); }
  let t = Date.now();
  await pool.query(schema.REBUILD_DAILY_STATS_SQL);
  log(`  daily stats rebuilt (${((Date.now() - t) / 1000).toFixed(0)}s)`);
  await pool.query(schema.DAILY_STATS_SQL);
  log("  daily-stats triggers installed");
  t = Date.now();
  await pool.query("ANALYZE messages");
  log(`  analyzed (${((Date.now() - t) / 1000).toFixed(0)}s)`);
  const s = loadState(); s.finishedAt = new Date().toISOString(); saveState(s);
}

// Merge for a message the app may already have updated in Postgres after
// the switch: the file row is the truth up to deployMs; status events the
// app recorded after that (statusHistory entries stamped >= deployMs) are
// kept on top.
const ENGAGED = ["opened", "clicked", "bounced", "complained"];
function mergeAfterDeploy(fileRow, pgRow, deployMs) {
  if (!pgRow || !deployMs) return fileRow;
  const later = (pgRow.statusHistory || []).filter(h => Date.parse(h?.at) >= deployMs);
  const merged = { ...fileRow, inboxDone: !!(fileRow.inboxDone || pgRow.inboxDone) };
  if (!later.length) return merged;
  merged.statusHistory = [...(fileRow.statusHistory || []), ...later];
  for (const h of later) {
    if (h.status === "delivered" && ENGAGED.includes(merged.status)) continue;
    merged.status = h.status;
  }
  return merged;
}
async function phaseCatchup() {
  const state = loadState();
  const since = Date.parse(state.contactsStartedAt);
  if (!since) throw new Error("contacts pass never ran");
  const deployMs = args.deploy ? Date.parse(args.deploy) : null;
  const changed = new Set();
  for (const dir of [CONTACT_DIR, STATUS_DIR]) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      try { if (statSync(path.join(dir, f)).mtimeMs >= since - 60000) changed.add(f.slice(0, -5)); } catch { /* removed meanwhile */ }
    }
  }
  log(`catchup: ${changed.size} contacts with message files changed since ${state.contactsStartedAt}${deployMs ? `, keeping app updates after ${args.deploy}` : ""}`);
  let rows = 0;
  let batch = [];
  for (const contactId of changed) {
    const fileRows = contactMessagesFromFiles(contactId).filter(m => m?.id).map(m => (m.contactId ? m : { ...m, contactId }));
    if (!fileRows.length) continue;
    const pgRows = deployMs
      ? new Map((await pool.query(`SELECT * FROM messages WHERE id = ANY($1)`, [fileRows.map(m => m.id)])).rows.map(r => [r.id, rowToMessage(r)]))
      : new Map();
    for (const m of fileRows) batch.push(mergeAfterDeploy(m, pgRows.get(m.id), deployMs));
    if (batch.length >= BATCH_ROWS) { rows += await writeRows(batch, { upsert: true }); batch = []; }
  }
  rows += await writeRows(batch, { upsert: true });
  // Unmatched rows appended to the main log since the unmatched pass: the
  // log only ever grows by replacing its closing "]" with ",{...}]".
  let tail = 0;
  const oldSize = state.unmatchedLogSize;
  const newSize = statSync(MAIN_LOG).size;
  if (oldSize && newSize > oldSize) {
    const fd = openSync(MAIN_LOG, "r");
    try {
      const buf = Buffer.alloc(newSize - (oldSize - 1));
      readSync(fd, buf, 0, buf.length, oldSize - 1);
      const text = buf.toString("utf8");
      const added = text.startsWith(",") ? JSON.parse("[" + text.slice(1)) : [];
      const unmatched = added.filter(m => m?.id && !m.contactId);
      tail = await writeRows(unmatched, { upsert: true });
    } finally { closeSync(fd); }
  }
  state.catchups = [...(state.catchups || []), { at: new Date().toISOString(), contacts: changed.size, rows, unmatchedTail: tail, deploy: args.deploy || null }];
  state.unmatchedLogSize = newSize;
  saveState(state);
  log(`catchup done: ${rows} rows written for ${changed.size} contacts, ${tail} new unmatched rows`);
}

// Spot check: for a random sample of contacts, the Postgres rows must equal
// what the files say (same ids, order, status, history, body).
function normalize(m) {
  const out = {};
  // A missing field and a null one read the same everywhere in the app
  // (Postgres columns come back null where an old row simply lacked the key).
  for (const k of Object.keys(m).sort()) { const v = m[k]; if (v == null) continue; out[k] = v; }
  out.statusHistory = m.statusHistory || [];
  out.inboxDone = !!m.inboxDone;
  // jsonb stores object keys in its own order -- compare content, not order.
  // A preview cut mid-emoji leaves half a surrogate pair, which Postgres
  // stores as U+FFFD (toWellFormed does the same).
  const sortDeep = (v) => (Array.isArray(v) ? v.map(sortDeep) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sortDeep(v[k])])) : typeof v === "string" ? v.replace(/\u0000/g, "").toWellFormed() : v);
  return JSON.stringify(sortDeep(out));
}
async function phaseVerify() {
  const n = Number(args.sample || 500);
  const files = readdirSync(CONTACT_DIR).filter(f => f.endsWith(".json"));
  let ok = 0, bad = 0, rowsChecked = 0;
  const examples = [];
  for (let k = 0; k < n; k++) {
    const contactId = files[Math.floor(Math.random() * files.length)].slice(0, -5);
    const fileRows = contactMessagesFromFiles(contactId).filter(m => m?.id);
    const pgRows = (await pool.query(`SELECT * FROM messages WHERE contact_id = $1 ORDER BY seq`, [contactId])).rows.map(rowToMessage);
    const pgById = new Map(pgRows.map(m => [m.id, m]));
    let same = true;
    for (const m of fileRows) {
      rowsChecked++;
      const p = pgById.get(m.id);
      const fm = m.contactId ? m : { ...m, contactId };
      if (!p || normalize({ ...fm, contactId: p.contactId }) !== normalize(p)) { same = false; if (examples.length < 3) examples.push({ contactId, id: m.id, file: normalize(fm).slice(0, 300), pg: p ? normalize(p).slice(0, 300) : null }); break; }
    }
    if (same) ok++; else bad++;
  }
  const total = (await pool.query("SELECT count(*)::bigint n FROM messages")).rows[0].n;
  log(`verify: ${ok}/${n} sampled contacts identical (${rowsChecked} rows checked), ${bad} differ; messages table has ${total} rows`);
  for (const e of examples) log("  differs:", JSON.stringify(e));
}

const phase = process.argv[2];
const phases = { schema: phaseSchema, contacts: phaseContacts, missing: phaseMissing, unmatched: phaseUnmatched, finish: phaseFinish, catchup: phaseCatchup, verify: phaseVerify };
if (!phases[phase]) { console.error(`usage: messages_backfill.mjs <${Object.keys(phases).join("|")}>`); process.exit(2); }
try { await phases[phase](); }
catch (e) { log(`FAILED in ${phase}:`, e.stack || e.message); process.exitCode = 1; }
finally { await pool.end(); }
