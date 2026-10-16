// Predictive sending (2026-10-16): learns, per contact, which hour of the
// day (UTC) they actually engage with email, from opens/clicks recorded
// from this point forward -- no historical backfill. Campaigns with the
// toggle on and qualifying automation emails hold each recipient's copy
// until their best hour, within 24 hours of when it would otherwise go out.
//
// The signal: one row per (contact, hour) with a weight -- open = 1,
// click = 2 (a click is unambiguously a human). Engagement within
// MACHINE_WINDOW_MS of the email's own send time is discarded: Apple
// Mail's privacy proxy (and link scanners, for clicks) fetch the pixel /
// follow links automatically on delivery, so those timestamps say when
// the email ARRIVED, not when a person read it. Counting them would make
// every contact's "best hour" equal to whatever hour we last sent at.
//
// Writes are buffered in memory and flushed on a short timer through this
// module's own connection to crm_prototype.db (WAL, busy_timeout, same as
// sqlite_inbox.js / automation_enrollments_db.js). Timer callbacks can
// never run inside another module's synchronous BEGIN...COMMIT on this
// thread, so a flush can't deadlock on a lock this thread itself holds.
import { DatabaseSync } from "node:sqlite";
import { join } from "path";
import { DATA_DIR } from "./auth_backend.js";

const DB_PATH = join(DATA_DIR, "crm_prototype.db");
const MACHINE_WINDOW_MS = 3 * 60 * 1000;
const MIN_PERSONAL_WEIGHT = 3; // fewer real engagements than this -> no personal hour yet
const WEIGHTS = { opened: 1, clicked: 2 };
const FLUSH_DELAY_MS = 2000;
export const PREDICTIVE_WINDOW_MS = 24 * 60 * 60 * 1000;

let db = null;
function getDb() {
  if (db) return db;
  db = new DatabaseSync(DB_PATH);
  db.exec("PRAGMA busy_timeout = 30000;");
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(`CREATE TABLE IF NOT EXISTS contact_send_hours (
    contact_id TEXT NOT NULL, hour INTEGER NOT NULL, weight REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (contact_id, hour)
  )`);
  return db;
}

const _pending = new Map(); // "contactId|hour" -> weight
let _flushTimer = null;
function flush() {
  _flushTimer = null;
  if (!_pending.size) return;
  const rows = [..._pending.entries()];
  _pending.clear();
  try {
    const d = getDb();
    const stmt = d.prepare("INSERT INTO contact_send_hours (contact_id, hour, weight) VALUES (?, ?, ?) ON CONFLICT(contact_id, hour) DO UPDATE SET weight = weight + excluded.weight");
    d.exec("BEGIN IMMEDIATE");
    try {
      for (const [k, w] of rows) { const i = k.lastIndexOf("|"); stmt.run(k.slice(0, i), Number(k.slice(i + 1)), w); }
      d.exec("COMMIT");
    } catch (e) { try { d.exec("ROLLBACK"); } catch { /* nothing open */ } throw e; }
  } catch (e) {
    console.error("[send_time_db] flush failed (engagement hours for this window lost, not retried):", e.message);
  }
}

// kind: "opened" | "clicked". eventAtMs: when the person engaged (the SES
// event's own timestamp when available). sentAtMs: when the email was sent.
export function recordEngagementHour(contactId, kind, eventAtMs, sentAtMs) {
  const w = WEIGHTS[kind];
  if (!contactId || !w) return;
  const at = Number.isFinite(eventAtMs) ? eventAtMs : Date.now();
  if (Number.isFinite(sentAtMs) && at - sentAtMs < MACHINE_WINDOW_MS) return;
  const key = `${contactId}|${new Date(at).getUTCHours()}`;
  _pending.set(key, (_pending.get(key) || 0) + w);
  if (!_flushTimer) {
    _flushTimer = setTimeout(flush, FLUSH_DELAY_MS);
    if (_flushTimer.unref) _flushTimer.unref();
  }
}

// Neighboring hours count half, so a contact who engages at 7:55 and 8:05
// reads as "8-ish" instead of splitting evenly between 7 and 8.
function peakHour(weights) {
  let best = null, bestScore = 0;
  for (let h = 0; h < 24; h++) {
    const s = (weights[h] || 0) + 0.5 * ((weights[(h + 23) % 24] || 0) + (weights[(h + 1) % 24] || 0));
    if (s > bestScore) { bestScore = s; best = h; }
  }
  return best;
}

// Map<contactId, hour> for every contact in `contactIds` that has enough
// real engagement to have a personal best hour, plus the list-wide best
// hour across everyone (null until there's any signal at all).
export function bestSendHours(contactIds) {
  const want = contactIds ? new Set(contactIds) : null;
  const per = new Map(), totals = new Map(), global = new Array(24).fill(0);
  for (const r of getDb().prepare("SELECT contact_id AS c, hour AS h, weight AS w FROM contact_send_hours").all()) {
    global[r.h] += r.w;
    if (want && !want.has(r.c)) continue;
    (per.get(r.c) || per.set(r.c, new Array(24).fill(0)).get(r.c))[r.h] += r.w;
    totals.set(r.c, (totals.get(r.c) || 0) + r.w);
  }
  const hours = new Map();
  for (const [c, w] of per) if (totals.get(c) >= MIN_PERSONAL_WEIGHT) hours.set(c, peakHour(w));
  return { hours, globalHour: peakHour(global) };
}
export function bestSendHourFor(contactId) {
  const { hours, globalHour } = bestSendHours([contactId]);
  return hours.has(contactId) ? hours.get(contactId) : globalHour;
}

// Earliest moment >= baseMs that falls in `hour` (UTC). If baseMs is already
// inside that hour, that's baseMs itself. Always within 24h of baseMs.
// null hour (no signal anywhere yet) -> baseMs, i.e. send without holding.
export function releaseAtForHour(baseMs, hour) {
  if (hour == null) return baseMs;
  const d = new Date(baseMs);
  if (d.getUTCHours() === hour) return baseMs;
  const t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hour, 0, 0, 0);
  return t > baseMs ? t : t + PREDICTIVE_WINDOW_MS;
}
