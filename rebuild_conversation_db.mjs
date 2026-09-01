// One-time/disaster-recovery full rebuild of crm_prototype.db (the Inbox
// sidebar's SQLite conversation-summary table -- see sqlite_inbox.js's
// header comment) from the JSON files that remain the actual source of
// truth: crm_conversation_index.json, crm_contacts.json,
// crm_conversation_meta.json. NOT part of normal operation -- once built,
// sqlite_inbox.js's syncMessageFields/syncMetaFields/syncContactFields keep
// it live-synced incrementally on every send/receive/pin/star/status
// change. Run this only to seed a fresh environment or to recover after
// crm_prototype.db is deleted/corrupted.
//
// Usage: node rebuild_conversation_db.mjs   (run from the app's own
// environment -- reads DATA_DIR the same way the server does, so it finds
// the Railway Volume automatically in production, __dirname locally).
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { DatabaseSync } from "node:sqlite";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || __dirname;
const t0 = Date.now();

function readJsonFile(name, fallback) {
  const p = join(DATA_DIR, name);
  if (!existsSync(p)) return fallback;
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return fallback; }
}

console.log("Reading source JSON files from", DATA_DIR, "...");
const convoIndex = readJsonFile("crm_conversation_index.json", []);
const contacts = readJsonFile("crm_contacts.json", []);
const meta = readJsonFile("crm_conversation_meta.json", []);
console.log(`Read ${convoIndex.length} conversations, ${contacts.length} contacts, ${meta.length} meta rows in ${Date.now() - t0}ms`);

const contactById = new Map(contacts.map(c => [c.id, c]));
const metaByContactId = new Map(meta.map(m => [m.contactId, m]));

const dbPath = join(DATA_DIR, "crm_prototype.db");
const db = new DatabaseSync(dbPath);

db.exec(`
  DROP TABLE IF EXISTS conversations;
  CREATE TABLE conversations (
    key TEXT PRIMARY KEY, contact_id TEXT, display_name TEXT, first TEXT, last TEXT, email TEXT,
    phone TEXT, first_seen_at TEXT,
    status TEXT, program_type TEXT, owner_id TEXT,
    last_at_ms INTEGER, last_inbound_at_ms INTEGER, unread_count INTEGER,
    pinned INTEGER DEFAULT 0, starred INTEGER DEFAULT 0, archived INTEGER DEFAULT 0, done INTEGER DEFAULT 0,
    last_channel TEXT, last_direction TEXT, last_preview TEXT, last_status TEXT, last_opened INTEGER,
    last_message_id TEXT, last_by_channel_json TEXT
  );
`);

const insert = db.prepare(`
  INSERT INTO conversations
    (key, contact_id, display_name, first, last, email, phone, first_seen_at, status, program_type, owner_id,
     last_at_ms, last_inbound_at_ms, unread_count, pinned, starred, archived, done,
     last_channel, last_direction, last_preview, last_status, last_opened, last_message_id, last_by_channel_json)
  VALUES (:key, :contactId, :displayName, :first, :last, :email, :phone, :firstSeenAt, :status, :programType, :ownerId,
          :lastAtMs, :lastInboundAtMs, :unreadCount, :pinned, :starred, :archived, :done,
          :lastChannel, :lastDirection, :lastPreview, :lastStatus, :lastOpened, :lastMessageId, :lastByChannelJson)
`);

const toMs = (s) => { const t = s ? new Date(s).getTime() : NaN; return Number.isFinite(t) ? t : null; };

console.log("Inserting rows...");
const t1 = Date.now();
db.exec("BEGIN");
for (const g of convoIndex) {
  const contact = g.contactId ? contactById.get(g.contactId) : null;
  const m = g.contactId ? metaByContactId.get(g.contactId) : null;
  const displayName = contact ? `${contact.first || ""} ${contact.last || ""}`.trim() : (g.last?.direction === "inbound" ? g.last?.from : g.last?.to) || "Unknown";
  insert.run({
    key: g.key, contactId: g.contactId || null, displayName: displayName || "Unknown",
    first: contact?.first || null, last: contact?.last || null, email: contact?.email || null,
    phone: contact?.phone || null, firstSeenAt: contact?.firstSeenAt || null,
    status: contact?.status || null, programType: contact?.programType || null, ownerId: contact?.ownerId || null,
    lastAtMs: toMs(g.last?.createdAt), lastInboundAtMs: toMs(g.lastInboundAt), unreadCount: g.unreadCount || 0,
    pinned: m?.pinned ? 1 : 0, starred: m?.starred ? 1 : 0, archived: m?.archived ? 1 : 0, done: m?.done ? 1 : 0,
    lastChannel: g.last?.channel || null, lastDirection: g.last?.direction || null,
    lastPreview: g.last?.subject || g.last?.bodyPreview || "",
    lastStatus: g.lastMine?.status || null, lastOpened: g.lastMine?.opened ? 1 : 0,
    lastMessageId: g.last?.id || null, lastByChannelJson: JSON.stringify(g.lastByChannel || {}),
  });
}
db.exec("COMMIT");
console.log(`Inserted ${convoIndex.length} rows in ${Date.now() - t1}ms`);

console.log("Building indexes...");
const t2 = Date.now();
db.exec(`
  CREATE INDEX idx_sort_default ON conversations(archived, pinned, last_inbound_at_ms);
  CREATE INDEX idx_sort_fallback ON conversations(archived, pinned, last_at_ms);
  CREATE INDEX idx_status ON conversations(status);
  CREATE INDEX idx_program_type ON conversations(program_type);
  CREATE INDEX idx_starred ON conversations(archived, starred);
  CREATE INDEX idx_unread ON conversations(archived, unread_count);
  CREATE INDEX idx_display_name ON conversations(display_name);
`);
console.log(`Indexes built in ${Date.now() - t2}ms`);

db.close();
console.log(`\nDone in ${Date.now() - t0}ms total. DB file: ${dbPath}`);
