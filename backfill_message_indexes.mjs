// One-time backfill for msg_by_source/ and crm_daily_message_stats.json --
// run manually via `node backfill_message_indexes.mjs`, e.g. through
// `railway ssh`, as its OWN process. NEVER import or run this from the live
// server -- it iterates every per-contact message file once, which is real
// work (bounded by contact count, not by a single 12GB file, but still not
// something to do on the request path).
//
// Deliberately reads msg_by_contact/*.json, NOT crm_message_log.json:
// updateMessageStatusByProviderId only ever patches the per-contact file's
// copy of a message, never crm_message_log.json's (see message_log.js's own
// comment) -- so the combined log is frozen at whatever status a message had
// the instant it was first logged (usually "sent"/"queued"/"failed") and
// NEVER shows "opened"/"clicked"/"bounced"/"complained". Backfilling from it
// would silently zero out all historical engagement stats. The per-contact
// files are the one place accurate, up-to-date status has lived all along.
import { readdirSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { DATA_DIR, readJson, writeJson } from "./auth_backend.js";

const CONTACT_MSG_DIR = "msg_by_contact";
const SOURCE_MSG_DIR = "msg_by_source";
const DAILY_STATS_FILE = "crm_daily_message_stats.json";

// Must match message_index.js's safeId EXACTLY (strips to nothing, not an
// underscore) -- a mismatch here means backfilled data lands in a different
// filename than getSourceMessages() reads from, silently invisible.
function safeId(s) { return String(s).replace(/[^a-zA-Z0-9_-]/g, ""); }
function sourceKey(sourceType, sourceId) { return `${safeId(sourceType)}__${safeId(sourceId)}`; }
function slimSourceMessage(m) { return { id: m.id, contactId: m.contactId, to: m.to, status: m.status, sentAt: m.sentAt || m.createdAt }; }
function emptyDayBucket() { return { emailOut: {}, smsOut: {}, smsInCount: 0, automationEmailOut: {}, workflowSmsOut: {} }; }
function bump(obj, status) { obj[status] = (obj[status] || 0) + 1; }
function dayKey(iso) { return String(iso || "").slice(0, 10); }

const contactDirPath = join(DATA_DIR, CONTACT_MSG_DIR);
const files = readdirSync(contactDirPath).filter(f => f.endsWith(".json"));
console.log(`Found ${files.length} per-contact message files. Starting scan...`);

const bySource = new Map(); // sourceKey -> slim rows[]
const byDay = new Map();    // date -> bucket

let contactsDone = 0, messagesDone = 0;
for (const file of files) {
  const messages = readJson(`${CONTACT_MSG_DIR}/${file}`, []);
  for (const m of messages) {
    messagesDone++;
    if (m.sourceType && m.sourceId) {
      const key = sourceKey(m.sourceType, m.sourceId);
      if (!bySource.has(key)) bySource.set(key, { sourceType: m.sourceType, sourceId: m.sourceId, rows: [] });
      bySource.get(key).rows.push(slimSourceMessage(m));
    }
    const date = dayKey(m.createdAt);
    if (date) {
      if (!byDay.has(date)) byDay.set(date, emptyDayBucket());
      const bucket = byDay.get(date);
      if (m.channel === "email" && m.direction === "outbound") {
        bump(bucket.emailOut, m.status);
        if (m.sourceType === "automation_step") bump(bucket.automationEmailOut, m.status);
      } else if (m.channel === "sms" && m.direction === "inbound") {
        bucket.smsInCount++;
      } else if (m.channel === "sms") {
        bump(bucket.smsOut, m.status);
        if (m.sourceType === "workflow_step") bump(bucket.workflowSmsOut, m.status);
      }
    }
  }
  contactsDone++;
  if (contactsDone % 5000 === 0) console.log(`${contactsDone}/${files.length} contact files scanned, ${messagesDone} messages so far...`);
}
console.log(`Scan complete: ${contactsDone} contacts, ${messagesDone} messages, ${bySource.size} distinct sources, ${byDay.size} distinct days.`);

const sourceDirPath = join(DATA_DIR, SOURCE_MSG_DIR);
if (!existsSync(sourceDirPath)) mkdirSync(sourceDirPath, { recursive: true });
let written = 0;
for (const [, { sourceType, sourceId, rows } ] of bySource) {
  writeJson(`${SOURCE_MSG_DIR}/${sourceKey(sourceType, sourceId)}.json`, rows);
  written++;
  if (written % 500 === 0) console.log(`${written}/${bySource.size} per-source files written...`);
}
console.log(`Wrote ${written} per-source files.`);

const dailyObj = {};
for (const [date, bucket] of byDay) dailyObj[date] = bucket;
writeJson(DAILY_STATS_FILE, dailyObj);
console.log(`Wrote daily stats for ${byDay.size} days.`);
console.log("Backfill complete.");
