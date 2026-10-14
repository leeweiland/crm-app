// Per-contact SMS facts for segment conditions (2026-10-14): when they last
// texted US (inbound), and whether any text to them ever errored. Close smart
// views filtered on exactly these ("no errored SMS", "no inbound SMS in the
// last 100 days") for the re-engagement SMS batches.
//
// The full SMS history lives in the per-contact message files (10+GB across
// 115k contacts) -- far too much to scan per segment evaluation, the same
// reason emailOpened/visitedPage read small denormalized properties instead
// of the message log (see segments_shared.js). So this keeps one tiny row per
// contact, updated as each SMS is logged or changes status (message_log.js),
// in its own SQLite file. backchannel/sms_stats_backfill.mjs seeded it from
// history once.
import { DatabaseSync } from "node:sqlite";
import { join } from "path";
import { DATA_DIR } from "./auth_backend.js";

const DB_PATH = join(DATA_DIR, "crm_sms_stats.db");
// "error" is Close's status for a text that never went out; failed/undelivered are Twilio's.
export const SMS_ERROR_STATUSES = new Set(["error", "failed", "undelivered"]);

let db = null;
function getDb() {
  if (db) return db;
  db = new DatabaseSync(DB_PATH);
  db.exec("PRAGMA busy_timeout = 30000;");
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(`CREATE TABLE IF NOT EXISTS sms_contact_stats (
    contact_id TEXT PRIMARY KEY,
    last_inbound_at TEXT,
    error_count INTEGER NOT NULL DEFAULT 0,
    last_error_at TEXT
  )`);
  return db;
}
const iso = (at) => { const d = new Date(at || Date.now()); return isNaN(d) ? new Date().toISOString() : d.toISOString(); };

export function noteSmsInbound(contactId, at) {
  if (!contactId) return;
  getDb().prepare(`INSERT INTO sms_contact_stats (contact_id, last_inbound_at) VALUES (?, ?)
    ON CONFLICT(contact_id) DO UPDATE SET last_inbound_at =
      CASE WHEN last_inbound_at IS NULL OR excluded.last_inbound_at > last_inbound_at THEN excluded.last_inbound_at ELSE last_inbound_at END`)
    .run(contactId, iso(at));
  _idx = null;
}
export function noteSmsError(contactId, at) {
  if (!contactId) return;
  getDb().prepare(`INSERT INTO sms_contact_stats (contact_id, error_count, last_error_at) VALUES (?, 1, ?)
    ON CONFLICT(contact_id) DO UPDATE SET error_count = error_count + 1,
      last_error_at = CASE WHEN last_error_at IS NULL OR excluded.last_error_at > last_error_at THEN excluded.last_error_at ELSE last_error_at END`)
    .run(contactId, iso(at));
  _idx = null;
}
// A freshly logged message row (message_log.js persistRowSideEffects).
export function noteSmsRow(row) {
  if (!row || row.channel !== "sms" || !row.contactId) return;
  if (row.direction === "inbound") noteSmsInbound(row.contactId, row.createdAt);
  // twilio_not_configured is our setup, not a problem with their number.
  else if (SMS_ERROR_STATUSES.has(row.status) && row.failReason !== "twilio_not_configured") noteSmsError(row.contactId, row.createdAt);
}
// A status change on an existing message -- counted once, on the transition into an error status.
export function noteSmsStatusChange(msg, oldStatus, newStatus) {
  if (!msg || msg.channel !== "sms" || msg.direction === "inbound") return;
  if (SMS_ERROR_STATUSES.has(newStatus) && !SMS_ERROR_STATUSES.has(oldStatus)) noteSmsError(msg.contactId);
}

// contactId -> { lastInboundAt, errorCount } for segment evaluation, which
// asks once per contact across the whole contact list -- memoized so a full
// pass is one query, refreshed at most every 30s (sooner after a local write).
let _idx = null, _idxAt = 0;
export function smsStatsIndex() {
  if (!_idx || Date.now() - _idxAt > 30000) {
    const m = new Map();
    for (const r of getDb().prepare("SELECT contact_id, last_inbound_at, error_count FROM sms_contact_stats").all()) {
      m.set(r.contact_id, { lastInboundAt: r.last_inbound_at, errorCount: r.error_count });
    }
    _idx = m; _idxAt = Date.now();
  }
  return _idx;
}
