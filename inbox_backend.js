import { randomUUID } from "crypto";
import { readJson, writeJson, readJsonBody, sendJson, getSessionUser } from "./auth_backend.js";
import { CONTACTS_FILE } from "./segments_shared.js";
import { MESSAGE_LOG_FILE } from "./message_log.js";

function digitsOnly(phone) { return String(phone || "").replace(/\D/g, ""); }

export const CALLS_FILE = "crm_calls.json";
export const TASKS_FILE = "crm_tasks.json";

function withContact(item, contacts) {
  return { ...item, contact: item.contactId ? contacts.find(c => c.id === item.contactId) || null : null };
}

// Close-style unified Inbox -- no telephony/call-recording integration in
// scope, so Calls is a manually-logged record (like Close's own "log a
// call" fallback for calls that didn't happen through their dialer)
// rather than a live call feed.
export async function handleInboxRequest(req, res, url) {
  const p = url.pathname;
  const owned = p === "/api/inbox" || p === "/api/inbox/confirm-potential" || p === "/api/inbox/mark-done" || p.startsWith("/api/calls") || p.startsWith("/api/tasks") || p.startsWith("/api/inbox/contact/");
  if (!owned) return false;
  const me = getSessionUser(req);
  if (!me) return sendJson(res, 401, { error: "Not logged in" });

  // Same cross-source aggregation as the main Inbox above, scoped to one
  // contact -- the activity timeline on their detail page. Every source
  // (email/sms sends, inbound messages, manually-logged calls, tasks) is
  // already just one flat record per event, so "everything about this
  // contact" is a filter, not a new query shape.
  const contactActivityMatch = p.match(/^\/api\/inbox\/contact\/([^/]+)$/);
  if (contactActivityMatch && req.method === "GET") {
    const contactId = contactActivityMatch[1];
    const messages = readJson(MESSAGE_LOG_FILE, []).filter(m => m.contactId === contactId).map(m => ({ ...m, itemType: m.channel, at: m.createdAt }));
    const calls = readJson(CALLS_FILE, []).filter(c => c.contactId === contactId).map(c => ({ ...c, itemType: "call", at: c.createdAt }));
    const tasks = readJson(TASKS_FILE, []).filter(t => t.contactId === contactId).map(t => ({ ...t, itemType: t.type, at: t.dueAt || t.createdAt }));
    const items = [...messages, ...calls, ...tasks].sort((a, b) => new Date(b.at) - new Date(a.at));
    return sendJson(res, 200, { items });
  }

  if (p === "/api/inbox" && req.method === "GET") {
    const tab = url.searchParams.get("tab") || "primary";
    // view: 'new' (default, not yet handled) | 'past' (marked done) | 'all'
    const view = url.searchParams.get("view") || "new";
    const contacts = readJson(CONTACTS_FILE, []);
    const messages = readJson(MESSAGE_LOG_FILE, []).map(m => ({ ...m, itemType: m.channel, at: m.createdAt, done: !!m.inboxDone }));
    const calls = readJson(CALLS_FILE, []).map(c => ({ ...c, itemType: "call", at: c.createdAt, done: !!c.inboxDone }));
    const tasks = readJson(TASKS_FILE, []).map(t => ({ ...t, itemType: t.type, at: t.dueAt || t.createdAt }));

    // Inbox is for things that need a human's attention -- incoming
    // messages, calls, and open tasks/reminders -- not a log of the CRM's
    // own outbound sends (those belong in Contacts/Campaigns reporting).
    const inbound = messages.filter(m => m.direction === "inbound");

    let items;
    if (tab === "emails") items = inbound.filter(m => m.channel === "email");
    else if (tab === "messages") items = inbound.filter(m => m.channel === "sms");
    else if (tab === "calls") items = calls;
    else if (tab === "tasks") items = tasks.filter(t => t.type === "task");
    else if (tab === "reminders") items = tasks.filter(t => t.type === "reminder");
    else items = [...inbound, ...calls, ...tasks]; // primary

    if (view === "new") items = items.filter(i => !i.done);
    else if (view === "past") items = items.filter(i => i.done);

    items = items.map(i => withContact(i, contacts)).sort((a, b) => new Date(b.at) - new Date(a.at));
    return sendJson(res, 200, { items });
  }

  // Bulk (or single, with a 1-item array) mark-done -- items come from the
  // inbox's mixed message/call/task stream, so this matches by id across
  // all three stores rather than requiring the caller to know which file
  // each id lives in.
  if (p === "/api/inbox/mark-done" && req.method === "POST") {
    const { ids, done } = await readJsonBody(req);
    if (!Array.isArray(ids) || !ids.length) return sendJson(res, 400, { error: "ids is required" });
    const idSet = new Set(ids);
    const value = done !== false;

    const log = readJson(MESSAGE_LOG_FILE, []);
    let changed = false;
    log.forEach(m => { if (idSet.has(m.id)) { m.inboxDone = value; changed = true; } });
    if (changed) writeJson(MESSAGE_LOG_FILE, log);

    const calls = readJson(CALLS_FILE, []);
    changed = false;
    calls.forEach(c => { if (idSet.has(c.id)) { c.inboxDone = value; changed = true; } });
    if (changed) writeJson(CALLS_FILE, calls);

    const tasks = readJson(TASKS_FILE, []);
    changed = false;
    tasks.forEach(t => { if (idSet.has(t.id)) { t.done = value; changed = true; } });
    if (changed) writeJson(TASKS_FILE, tasks);

    return sendJson(res, 200, { ok: true });
  }

  // Turns a Potential Contact (an unmatched inbound message) into a real
  // contact, then backfills every prior inbound message from that same
  // phone number so they immediately disappear from Potential Contacts
  // and show up correctly in the rest of the Inbox.
  if (p === "/api/inbox/confirm-potential" && req.method === "POST") {
    const { messageId, first, last } = await readJsonBody(req);
    if (!first) return sendJson(res, 400, { error: "first name is required" });
    const log = readJson(MESSAGE_LOG_FILE, []);
    const row = log.find(m => m.id === messageId);
    if (!row) return sendJson(res, 404, { error: "Message not found" });
    const phone = row.channel === "sms" ? row.from : null;
    const email = row.channel === "email" ? row.from : null;

    const contacts = readJson(CONTACTS_FILE, []);
    const contact = {
      id: randomUUID(), type: "lead", accountName: "",
      first, last: last || "", email: email || "", phone: phone || "",
      status: "", tags: [], listIds: [], customFields: {},
      source: "inbound_confirmed", ownerId: null, emailOptOut: false, smsOptOut: false,
      externalIds: { acContactId: null, closeLeadId: null },
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    contacts.push(contact);
    writeJson(CONTACTS_FILE, contacts);

    if (phone) {
      const digits = digitsOnly(phone);
      log.forEach(m => { if (!m.contactId && digitsOnly(m.from) === digits) m.contactId = contact.id; });
      writeJson(MESSAGE_LOG_FILE, log);
    }
    return sendJson(res, 200, { ok: true, contact });
  }

  if (p === "/api/calls" && req.method === "GET") {
    const contacts = readJson(CONTACTS_FILE, []);
    const calls = readJson(CALLS_FILE, []).map(c => withContact(c, contacts)).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return sendJson(res, 200, { calls });
  }
  if (p === "/api/calls" && req.method === "POST") {
    const { contactId, direction, notes, duration } = await readJsonBody(req);
    const calls = readJson(CALLS_FILE, []);
    const call = { id: randomUUID(), contactId: contactId || null, direction: direction === "inbound" ? "inbound" : "outbound", notes: notes || "", duration: duration || 0, createdAt: new Date().toISOString(), createdBy: me.id };
    calls.push(call);
    writeJson(CALLS_FILE, calls);
    return sendJson(res, 200, { ok: true, call });
  }
  const callMatch = p.match(/^\/api\/calls\/([^/]+)$/);
  if (callMatch && req.method === "DELETE") {
    writeJson(CALLS_FILE, readJson(CALLS_FILE, []).filter(c => c.id !== callMatch[1]));
    return sendJson(res, 200, { ok: true });
  }

  if (p === "/api/tasks" && req.method === "GET") {
    const contacts = readJson(CONTACTS_FILE, []);
    const tasks = readJson(TASKS_FILE, []).map(t => withContact(t, contacts)).sort((a, b) => new Date(a.dueAt || a.createdAt) - new Date(b.dueAt || b.createdAt));
    return sendJson(res, 200, { tasks });
  }
  if (p === "/api/tasks" && req.method === "POST") {
    const { contactId, type, title, dueAt } = await readJsonBody(req);
    if (!title) return sendJson(res, 400, { error: "title is required" });
    const tasks = readJson(TASKS_FILE, []);
    const task = { id: randomUUID(), contactId: contactId || null, type: type === "reminder" ? "reminder" : "task", title, dueAt: dueAt || null, done: false, createdAt: new Date().toISOString(), createdBy: me.id };
    tasks.push(task);
    writeJson(TASKS_FILE, tasks);
    return sendJson(res, 200, { ok: true, task });
  }
  const taskMatch = p.match(/^\/api\/tasks\/([^/]+)$/);
  if (taskMatch) {
    const tasks = readJson(TASKS_FILE, []);
    const task = tasks.find(t => t.id === taskMatch[1]);
    if (req.method === "PATCH") {
      if (!task) return sendJson(res, 404, { error: "Not found" });
      const body = await readJsonBody(req);
      if ("done" in body) task.done = !!body.done;
      if ("title" in body) task.title = body.title;
      if ("dueAt" in body) task.dueAt = body.dueAt;
      writeJson(TASKS_FILE, tasks);
      return sendJson(res, 200, { ok: true, task });
    }
    if (req.method === "DELETE") {
      writeJson(TASKS_FILE, tasks.filter(t => t.id !== taskMatch[1]));
      return sendJson(res, 200, { ok: true });
    }
  }

  return false;
}
