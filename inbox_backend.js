import { randomUUID } from "crypto";
import { readJson, writeJson, readJsonBody, sendJson, getSessionUser } from "./auth_backend.js";
import { CONTACTS_FILE } from "./segments_shared.js";
import { MESSAGE_LOG_FILE } from "./message_log.js";

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
  const owned = p === "/api/inbox" || p.startsWith("/api/calls") || p.startsWith("/api/tasks");
  if (!owned) return false;
  const me = getSessionUser(req);
  if (!me) return sendJson(res, 401, { error: "Not logged in" });

  if (p === "/api/inbox" && req.method === "GET") {
    const tab = url.searchParams.get("tab") || "primary";
    const contacts = readJson(CONTACTS_FILE, []);
    const messages = readJson(MESSAGE_LOG_FILE, []).map(m => ({ ...m, itemType: m.channel, at: m.createdAt }));
    const calls = readJson(CALLS_FILE, []).map(c => ({ ...c, itemType: "call", at: c.createdAt }));
    const tasks = readJson(TASKS_FILE, []).map(t => ({ ...t, itemType: t.type, at: t.dueAt || t.createdAt }));

    let items;
    if (tab === "emails") items = messages.filter(m => m.channel === "email");
    else if (tab === "messages") items = messages.filter(m => m.channel === "sms");
    else if (tab === "calls") items = calls;
    else if (tab === "tasks") items = tasks.filter(t => t.type === "task" && !t.done);
    else if (tab === "reminders") items = tasks.filter(t => t.type === "reminder" && !t.done);
    else items = [...messages, ...calls, ...tasks.filter(t => !t.done)]; // primary

    items = items.map(i => withContact(i, contacts)).sort((a, b) => new Date(b.at) - new Date(a.at));
    return sendJson(res, 200, { items });
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
