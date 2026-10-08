// SQLite-backed store for automation enrollments (2026-10-08), replacing
// crm_automation_enrollments.json as the live store. Same crm_prototype.db
// file, same per-thread DatabaseSync connection pattern, same WAL +
// busy_timeout as sqlite_inbox.js -- confirmed live tonight that those
// settings already handle the main thread and several worker threads
// writing concurrently.
//
// Why (found by direct code trace, confirmed with /proc I/O counters on the
// live process -- 404MB written in 8s, 27.9GB total, by one thread): that
// JSON file had grown to 36MB / 49k records, and EVERY enrollment write
// (enrollContact, saveEnrollment, completeEnrollment, an end_automation
// step) was a full readJson of all 36MB + a full writeJson of all 36MB.
// One real email open ran that chain ~6 times (enroll Part 2 -> end Part 1
// -> re-enroll Part 1 -> end another -> complete), i.e. ~216MB of
// enrollment-file writes per open, before even counting the contact-file
// rewrites its tag steps did. That -- not disk hardware, not thread count,
// not any webhook-side code -- is what made a single open cost ~20+
// seconds, and therefore why open/click processing has lagged by hours
// for days. Every operation here is an indexed point read/write instead.
//
// Record shape is preserved exactly: `data` holds the full enrollment
// object (history, goalHits, stepRetryCount, reenterCurrentStep,
// bookingId, ...), so nothing automations_backend.js reads or writes on an
// enrollment is lost or renamed. The indexed columns are mirrors of fields
// inside `data`, maintained on every write, used only for lookups.
//
// One-time migration: on first use after deploy, the existing JSON file is
// imported in a single transaction (INSERT OR IGNORE, so a second thread
// racing the first can't duplicate anything), then renamed aside as a
// backup rather than deleted, and a marker file stops it running again.
import { DatabaseSync } from "node:sqlite";
import { existsSync, renameSync, writeFileSync } from "fs";
import { join } from "path";
import { DATA_DIR, readJson } from "./auth_backend.js";

const DB_PATH = join(DATA_DIR, "crm_prototype.db");
const LEGACY_JSON_FILE = "crm_automation_enrollments.json";
const MIGRATED_MARKER = join(DATA_DIR, "_automation_enrollments_sqlite_migrated.done");

let db = null;
function getDb() {
  if (db) return db;
  db = new DatabaseSync(DB_PATH);
  // 30s, not sqlite_inbox.js's 5s: at boot every worker thread imports
  // this module within the same second, and whichever one wins the
  // one-time 49k-row import below holds the write lock for a few seconds
  // -- the others must wait that out, not throw SQLITE_BUSY mid-startup.
  db.exec("PRAGMA busy_timeout = 30000;");
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS automation_enrollments (
      id TEXT PRIMARY KEY,
      automation_id TEXT NOT NULL,
      contact_id TEXT NOT NULL,
      status TEXT NOT NULL,
      current_step_id TEXT,
      entered_at TEXT,
      updated_at TEXT,
      wait_until TEXT,
      data TEXT NOT NULL
    )
  `);
  db.exec("CREATE INDEX IF NOT EXISTS ae_auto_contact_status ON automation_enrollments (automation_id, contact_id, status)");
  db.exec("CREATE INDEX IF NOT EXISTS ae_status_wait ON automation_enrollments (status, wait_until)");
  db.exec("CREATE INDEX IF NOT EXISTS ae_auto_status ON automation_enrollments (automation_id, status)");
  db.exec("CREATE INDEX IF NOT EXISTS ae_contact_status ON automation_enrollments (contact_id, status)");
  // Never allowed to take a thread down at startup: if this one lost the
  // boot-time race (see busy_timeout above) or the file is already gone,
  // the data is already in the table from whichever thread won.
  try { migrateLegacyJsonOnce(); } catch (e) { console.error("[automation_enrollments_db] legacy import skipped on this thread:", e.message); }
  return db;
}

function rowParams(e) {
  return {
    id: e.id, automationId: e.automationId, contactId: e.contactId, status: e.status || "active",
    currentStepId: e.currentStepId ?? null, enteredAt: e.enteredAt ?? null, updatedAt: e.updatedAt ?? null,
    waitUntil: e.waitUntil ?? null, data: JSON.stringify(e),
  };
}
const UPSERT_SQL = `
  INSERT INTO automation_enrollments (id, automation_id, contact_id, status, current_step_id, entered_at, updated_at, wait_until, data)
  VALUES (:id, :automationId, :contactId, :status, :currentStepId, :enteredAt, :updatedAt, :waitUntil, :data)
  ON CONFLICT(id) DO UPDATE SET
    automation_id = excluded.automation_id, contact_id = excluded.contact_id, status = excluded.status,
    current_step_id = excluded.current_step_id, entered_at = excluded.entered_at, updated_at = excluded.updated_at,
    wait_until = excluded.wait_until, data = excluded.data
`;
const INSERT_IGNORE_SQL = `
  INSERT OR IGNORE INTO automation_enrollments (id, automation_id, contact_id, status, current_step_id, entered_at, updated_at, wait_until, data)
  VALUES (:id, :automationId, :contactId, :status, :currentStepId, :enteredAt, :updatedAt, :waitUntil, :data)
`;

function migrateLegacyJsonOnce() {
  if (existsSync(MIGRATED_MARKER)) return;
  const p = join(DATA_DIR, LEGACY_JSON_FILE);
  // A populated table means another thread already won the boot-time race
  // and committed the import -- nothing to do but record that.
  const already = db.prepare("SELECT count(*) AS n FROM automation_enrollments").get().n;
  if (existsSync(p) && already === 0) {
    const rows = readJson(LEGACY_JSON_FILE, []);
    const ins = db.prepare(INSERT_IGNORE_SQL);
    // IMMEDIATE: take the write lock up front (waiting via busy_timeout)
    // rather than upgrading a read snapshot mid-transaction, which under
    // WAL fails outright if another writer committed in between.
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const e of rows) { if (e && e.id && e.automationId && e.contactId) ins.run(rowParams(e)); }
      db.exec("COMMIT");
    } catch (err) {
      try { db.exec("ROLLBACK"); } catch { /* nothing open */ }
      throw err;
    }
    // Kept as a backup, never deleted -- but it must never be READ as the
    // live store again, which is why every reader in automations_backend.js
    // goes through this module now and nothing references the JSON name.
    try { renameSync(p, `${p}.migrated-${Date.now()}`); } catch { /* another thread already moved it */ }
    console.log(`[automation_enrollments_db] migrated ${rows.length} enrollments from ${LEGACY_JSON_FILE} into SQLite`);
  }
  try { writeFileSync(MIGRATED_MARKER, new Date().toISOString()); } catch { /* read-only or raced -- harmless, INSERT OR IGNORE makes a rerun a no-op */ }
}

// Depth-aware: a transaction opened inside an outer withEnrollmentBatch()
// just runs inline in it (SQLite can't nest BEGINs on one connection).
let _txDepth = 0;
function transaction(fn) {
  const d = getDb();
  if (_txDepth > 0) return fn();
  d.exec("BEGIN IMMEDIATE");
  _txDepth++;
  try { const r = fn(); d.exec("COMMIT"); return r; }
  catch (e) { try { d.exec("ROLLBACK"); } catch { /* nothing open */ } throw e; }
  finally { _txDepth--; }
}
// Wrap a whole drain batch's enrollment writes in ONE transaction (2026-10-08).
// Measured live after the SQLite move: every first-open runs the Engagement
// Tagging chain -- ~8 enrollment writes -- and each autocommitted write is
// its own fsync, ~40ms on this volume (sqlite_inbox.js documents the same
// lesson: "1,600 contacts froze the whole server for ~140s" from per-row
// autocommits). One fsync per 500-row batch instead of ~8 per open.
export function withEnrollmentBatch(fn) { return transaction(fn); }
const parse = (r) => JSON.parse(r.data);

// Upsert the full record (insert if new, replace if existing).
export function saveEnrollment(e) {
  getDb().prepare(UPSERT_SQL).run(rowParams(e));
}
// Same, for many records in ONE transaction (one fsync, not N).
export function saveEnrollments(list) {
  if (!list || !list.length) return;
  transaction(() => { const stmt = getDb().prepare(UPSERT_SQL); for (const e of list) stmt.run(rowParams(e)); });
}
export function getEnrollment(id) {
  const r = getDb().prepare("SELECT data FROM automation_enrollments WHERE id = ?").get(id);
  return r ? parse(r) : null;
}
export function hasActiveEnrollment(automationId, contactId) {
  return !!getDb().prepare("SELECT 1 FROM automation_enrollments WHERE automation_id = ? AND contact_id = ? AND status = 'active' LIMIT 1").get(automationId, contactId);
}
export function listEnrollments({ automationId, contactId, status } = {}) {
  const where = [], args = [];
  if (automationId) { where.push("automation_id = ?"); args.push(automationId); }
  if (contactId) { where.push("contact_id = ?"); args.push(contactId); }
  if (status) { where.push("status = ?"); args.push(status); }
  const sql = `SELECT data FROM automation_enrollments${where.length ? " WHERE " + where.join(" AND ") : ""} ORDER BY entered_at`;
  return getDb().prepare(sql).all(...args).map(parse);
}
// Active enrollments whose wait has expired as of nowIso -- ISO-8601 UTC
// strings compare correctly as plain text.
export function listDueEnrollments(nowIso) {
  return getDb().prepare("SELECT data FROM automation_enrollments WHERE status = 'active' AND wait_until IS NOT NULL AND wait_until <= ? ORDER BY wait_until").all(nowIso).map(parse);
}
// An end_automation step: complete this contact's active enrollment(s) in
// the target automation. Returns how many were completed.
export function completeActiveEnrollments(automationId, contactId, nowIso) {
  const rows = listEnrollments({ automationId, contactId, status: "active" });
  if (!rows.length) return 0;
  for (const e of rows) { e.status = "completed"; e.updatedAt = nowIso; }
  saveEnrollments(rows);
  return rows.length;
}
export function stepCounts(automationId) {
  const counts = {};
  for (const r of getDb().prepare("SELECT current_step_id AS s, count(*) AS n FROM automation_enrollments WHERE automation_id = ? AND status = 'active' AND current_step_id IS NOT NULL GROUP BY current_step_id").all(automationId)) counts[r.s] = r.n;
  return counts;
}
// Map automationId -> { active, total }, one query for the whole list page.
export function countsByAutomation() {
  const out = new Map();
  for (const r of getDb().prepare("SELECT automation_id AS a, status AS s, count(*) AS n FROM automation_enrollments GROUP BY automation_id, status").all()) {
    const cur = out.get(r.a) || { active: 0, total: 0 };
    cur.total += r.n;
    if (r.s === "active") cur.active += r.n;
    out.set(r.a, cur);
  }
  return out;
}
export function automationStats(automationId) {
  const enrollments = listEnrollments({ automationId });
  return {
    active: enrollments.filter(e => e.status === "active").length,
    enrolled: enrollments.length,
    completed: enrollments.filter(e => e.status === "completed").length,
    goalMet: enrollments.filter(e => e.status === "goal_met" || (e.goalHits || []).length).length,
    cancelled: enrollments.filter(e => e.status === "cancelled").length,
  };
}

// Open (and migrate, once) at module load on every thread that imports
// automations_backend.js, so the one-time import cost lands at startup --
// not inside the first webhook or scheduler tick that happens to touch an
// enrollment.
getDb();
