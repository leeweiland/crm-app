// Failed-send alerts for staff (Lee, 2026-11-13). When a text or email a
// staff member sent from the Inbox fails (Twilio failed/undelivered, SES
// bounce, or a send error), that staff member gets:
//   - a push to their PRA Inbox app ("Your text to X didn't go through"),
//     tapping it opens that chat, and
//   - a red banner across the top of every CRM page (crm-nav.js), clicking
//     it opens that chat; X dismisses it.
// Only the person who SENT it is told -- Inbox sends carry their user id as
// sourceId (inbox_backend.js). Campaign/automation failures are not staff
// sends and never alert here.
//
// The list is read straight from the messages table through the
// messages_source_slim covering index (source_type, source_id, seq), so it
// is index-only no matter how big the table gets.
import { readJson, writeJson, readJsonBody, sendJson, getSessionUser } from "./auth_backend.js";

const DISMISSED_FILE = "crm_failed_send_dismissed.json"; // { [userId]: { [messageId]: dismissedAtIso } }
const WINDOW_DAYS = 7;
const FAILED = new Set(["failed", "bounced"]);

// Called from message_log.js whenever an outbound message turns failed or
// bounced. Fire-and-forget; never throws into a send/webhook path.
export function noteFailedSend(m, status) {
  try {
    if (!m || m.direction !== "outbound" || m.sourceType !== "inbox" || !m.sourceId || !FAILED.has(status)) return;
    (async () => {
      const [{ getContactById }, { pushToUser }] = await Promise.all([import("./contacts_db.js"), import("./crm_push.js")]);
      let name = "";
      try { const c = m.contactId ? getContactById(m.contactId) : null; name = c ? [c.first, c.last].filter(Boolean).join(" ") || c.phone || c.email || "" : ""; } catch { /* name is optional */ }
      const isEmail = m.channel === "email";
      await pushToUser(m.sourceId, {
        title: isEmail ? "Email failed to send" : "Text failed to send",
        body: `Your ${isEmail ? "email" : "text"} to ${name || "this contact"} didn't go through. Tap to open the chat.`,
        data: { contactId: m.contactId ? String(m.contactId) : "", kind: "failed_send" },
      });
    })().catch(e => console.error("[failed_sends] push failed:", e.message));
  } catch (e) {
    console.error("[failed_sends] noteFailedSend failed:", e.message);
  }
}

async function listFor(userId) {
  const mdb = await import("./messages_db.js");
  if (!mdb.MESSAGES_PG) return [];
  const { getContactsMapByIds } = await import("./contacts_db.js");
  const since = new Date(Date.now() - WINDOW_DAYS * 86400000).toISOString();
  // Last 400 Inbox sends by this user, newest first, index-only.
  const recent = mdb.sourceRecentSlim("inbox", userId, 400).filter(r => FAILED.has(r.status) && (r.created_at || "") >= since);
  const dismissed = readJson(DISMISSED_FILE, {})[userId] || {};
  const open = recent.filter(r => !dismissed[r.id]);
  if (!open.length) return [];
  const details = new Map(mdb.getMessagesByIds(open.map(r => r.id)).map(m => [m.id, m]));
  const contacts = getContactsMapByIds([...new Set(open.map(r => r.contact_id).filter(Boolean))]);
  return open.map(r => {
    const m = details.get(r.id) || {};
    const c = contacts.get(r.contact_id);
    return {
      id: r.id,
      contactId: r.contact_id,
      name: c ? [c.first, c.last].filter(Boolean).join(" ") || c.phone || c.email || "" : (r.to_addr || ""),
      channel: m.channel || (String(r.to_addr || "").includes("@") ? "email" : "sms"),
      status: r.status,
      at: r.sent_at || r.created_at,
      preview: String(m.subject || m.bodyPreview || m.body || "").replace(/\s+/g, " ").slice(0, 80),
      reason: m.failReason || "",
    };
  });
}

export async function handleFailedSendsRequest(req, res, url) {
  const p = url.pathname;
  if (p !== "/api/failed-sends" && p !== "/api/failed-sends/dismiss") return false;
  const me = getSessionUser(req);
  if (!me) return sendJson(res, 401, { error: "Not logged in" });
  if (p === "/api/failed-sends" && req.method === "GET") {
    try { return sendJson(res, 200, { items: await listFor(me.id) }); }
    catch (e) { console.error("[failed_sends] list failed:", e.message); return sendJson(res, 200, { items: [] }); }
  }
  if (p === "/api/failed-sends/dismiss" && req.method === "POST") {
    const { ids } = await readJsonBody(req);
    const list = (Array.isArray(ids) ? ids : []).filter(id => typeof id === "string").slice(0, 500);
    const all = readJson(DISMISSED_FILE, {});
    const mine = all[me.id] || {};
    const now = new Date().toISOString();
    for (const id of list) mine[id] = now;
    // Forget dismissals older than the alert window -- they can't show again anyway.
    const cutoff = new Date(Date.now() - (WINDOW_DAYS + 1) * 86400000).toISOString();
    for (const [id, at] of Object.entries(mine)) if (at < cutoff) delete mine[id];
    all[me.id] = mine;
    writeJson(DISMISSED_FILE, all);
    return sendJson(res, 200, { ok: true });
  }
  return sendJson(res, 405, { error: "Method not allowed" });
}
