// One-time backfill of contacts' email-engagement TIMES from the messages
// already stored per contact -- chiefly the ActiveCampaign history that took a
// week to import (clicks with their real timestamps, 1:1-campaign opens, ...).
// That history lives in each contact's message file (msg_by_contact/<id>.json,
// the same data the chat panel and Customer Journey render), but the segment
// filters only ever read contact.emailEngagement, which until now was fed by
// live SES events alone -- so "opened an email" ignored all of it.
//
// A message counts the way the chat panel counts it: an `opened` OR `clicked`
// entry in its statusHistory (ActiveCampaign exposes no open pixel for bulk
// sends, only clicks, so a click stands in for an open). The LATEST such time
// per contact lands on emailEngagement.openedAt / clickedAt, which is what the
// "Opened Email in the last N days" condition reads. Idempotent: it only ever
// moves a time later and sets flags true, so re-running is harmless.
//
// Runs inside the live server process (never a second process sharing the
// container): the scan yields to live requests every ~25ms, then ONE in-place
// streaming pass patches the contacts file and the SQLite mirror is re-synced
// in yielding chunks. Triggered by an admin hitting
// GET /api/contacts/admin/backfill-email-engagement (contacts_backend.js).
import { readdirSync, readFileSync, existsSync, writeFileSync } from "fs";
import { join } from "path";
import { DATA_DIR, patchJsonArrayRecordsByIdMap } from "./auth_backend.js";
import { CONTACTS_FILE } from "./segments_shared.js";
import { CONTACT_MSG_DIR } from "./message_index.js";
import { syncContactFields } from "./sqlite_inbox.js";

const REPORT_FILE = join(DATA_DIR, "_email_engagement_backfill_report.json");
const yieldToLoop = () => new Promise(r => setImmediate(r));

// -> { openedAt, clickedAt } (ISO strings, either may be null) or null if this
// contact's messages hold no open/click at all. Exported for tests.
export function extractEngagement(messages, nowMs = Date.now()) {
  let opened = 0, clicked = 0;
  const latestAllowed = nowMs + 24 * 3600 * 1000; // ignore garbage far-future timestamps
  for (const m of messages) {
    if (!m || m.channel !== "email" || m.direction === "inbound") continue;
    const history = Array.isArray(m.statusHistory) && m.statusHistory.length
      ? m.statusHistory
      : (m.status ? [{ status: m.status, at: m.createdAt || m.sentAt }] : []);
    for (const h of history) {
      if (h?.status !== "opened" && h?.status !== "clicked") continue;
      const t = h.at ? new Date(h.at).getTime() : NaN;
      if (isNaN(t) || t > latestAllowed) continue;
      if (h.status === "opened") opened = Math.max(opened, t); else clicked = Math.max(clicked, t);
    }
  }
  if (!opened && !clicked) return null;
  return { openedAt: opened ? new Date(opened).toISOString() : null, clickedAt: clicked ? new Date(clicked).toISOString() : null };
}

// Applies one contact's extracted times to its record. Only ever moves a time
// later / sets a flag true. A click implies an open, so a clicked contact is
// flagged opened too (matching how the segment filter and chat panel read it).
export function applyEngagement(contact, patch) {
  const eng = contact.emailEngagement || (contact.emailEngagement = {});
  let changed = false;
  const later = (a, b) => !a || new Date(b) > new Date(a);
  if (patch.openedAt) {
    if (later(eng.openedAt, patch.openedAt)) { eng.openedAt = patch.openedAt; changed = true; }
    if (!eng.opened) { eng.opened = true; changed = true; }
  }
  if (patch.clickedAt) {
    if (later(eng.clickedAt, patch.clickedAt)) { eng.clickedAt = patch.clickedAt; changed = true; }
    if (!eng.clicked) { eng.clicked = true; changed = true; }
    if (!eng.opened) { eng.opened = true; changed = true; }
  }
  return changed;
}

const state = { state: "idle", startedAt: null, finishedAt: null, filesTotal: 0, filesScanned: 0, contactsWithEvents: 0, contactsUpdated: 0, sqliteSynced: 0, error: null };

function loadReport() {
  try { return existsSync(REPORT_FILE) ? JSON.parse(readFileSync(REPORT_FILE, "utf8")) : null; } catch { return null; }
}

export function getEngagementBackfillStatus() {
  if (state.state !== "idle") return { ...state };
  const last = loadReport();
  return last ? { state: "done", ...last, note: "Already ran. Add ?force=1 to run it again (safe -- it only ever moves times later)." } : { ...state };
}

async function run() {
  const t0 = Date.now();
  state.startedAt = new Date().toISOString();
  Object.assign(state, { finishedAt: null, filesTotal: 0, filesScanned: 0, contactsWithEvents: 0, contactsUpdated: 0, sqliteSynced: 0, error: null, state: "scanning" });
  const dir = join(DATA_DIR, CONTACT_MSG_DIR);
  const files = existsSync(dir) ? readdirSync(dir) : [];
  state.filesTotal = files.length;

  // 1) Scan every contact's own message file, yielding to live requests.
  //    A file without the words "opened"/"clicked" anywhere can't matter, so
  //    it's skipped before paying for a JSON.parse (most contacts: Hyros
  //    activity rows only).
  const patches = new Map(); // contactId -> { openedAt, clickedAt }
  let i = 0;
  while (i < files.length) {
    const sliceEnd = Date.now() + 25;
    while (i < files.length && Date.now() < sliceEnd) {
      const f = files[i++];
      state.filesScanned = i;
      if (!f.endsWith(".json")) continue;
      let txt;
      try { txt = readFileSync(join(dir, f), "utf8"); } catch { continue; }
      if (!txt.includes('"opened"') && !txt.includes('"clicked"')) continue;
      let msgs;
      try { msgs = JSON.parse(txt); } catch { continue; }
      if (!Array.isArray(msgs)) continue;
      const ev = extractEngagement(msgs);
      if (ev) patches.set(f.slice(0, -5), ev);
    }
    await yieldToLoop();
  }
  state.contactsWithEvents = patches.size;

  // 2) One in-place pass over the contacts file.
  state.state = "updating contacts file";
  await yieldToLoop();
  const changed = patchJsonArrayRecordsByIdMap(CONTACTS_FILE, patches, applyEngagement);
  state.contactsUpdated = changed.length;

  // 3) Keep the SQLite mirror in step (a stale emailEngagement there could be
  //    written back over the real one by a later contact PATCH).
  state.state = "syncing sqlite";
  for (let k = 0; k < changed.length; k++) {
    try { syncContactFields(changed[k].id, changed[k]); state.sqliteSynced++; } catch (e) { console.error("[email-engagement-backfill] sqlite sync failed:", e.message); }
    if (k % 500 === 499) await yieldToLoop();
  }

  const report = { ranAt: state.startedAt, finishedAt: new Date().toISOString(), seconds: Math.round((Date.now() - t0) / 1000), filesScanned: state.filesScanned, contactsWithEvents: state.contactsWithEvents, contactsUpdated: state.contactsUpdated, sqliteSynced: state.sqliteSynced };
  try { writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2)); } catch (e) { console.error("[email-engagement-backfill] could not write report:", e.message); }
  console.log(`[email-engagement-backfill] done in ${report.seconds}s: ${report.filesScanned} message files scanned, ${report.contactsWithEvents} contacts with opens/clicks, ${report.contactsUpdated} contact records updated`);
  state.finishedAt = report.finishedAt;
  state.state = "idle";
}

// Starts the job in the background (returns immediately) unless it's already
// running or has already completed (force re-runs it).
export function startEngagementBackfill({ force = false } = {}) {
  if (state.state !== "idle") return { ...state, note: "Already running -- reload this URL to watch progress." };
  if (!force && loadReport()) return getEngagementBackfillStatus();
  state.state = "starting";
  run().catch(e => { console.error("[email-engagement-backfill] failed:", e); state.error = e.message; state.state = "idle"; });
  return { ...state, note: "Started -- reload this URL to watch progress." };
}
