import { randomUUID } from "crypto";
import { readJson, writeJson, readJsonBody, sendJson, getSessionUser, readJsonArrayFiltered, reduceJsonArray } from "./auth_backend.js";
import { CONTACTS_FILE, findContactMatch } from "./segments_shared.js";
import { MESSAGE_LOG_FILE } from "./message_log.js";
import { sendEmail } from "./email_backend.js";
import { sendSms } from "./sms_backend.js";
import { CONVERSATION_META_FILE, getConvoMetaMap, setConvoMeta } from "./conversation_meta.js";

function digitsOnly(phone) { return String(phone || "").replace(/\D/g, ""); }

export const CALLS_FILE = "crm_calls.json";
export const TASKS_FILE = "crm_tasks.json";
export const NOTES_FILE = "crm_notes.json";
export { CONVERSATION_META_FILE };

function withContact(item, contacts) {
  return { ...item, contact: item.contactId ? contacts.find(c => c.id === item.contactId) || null : null };
}

// Close-style unified Inbox -- no telephony/call-recording integration in
// scope, so Calls is a manually-logged record (like Close's own "log a
// call" fallback for calls that didn't happen through their dialer)
// rather than a live call feed.
export async function handleInboxRequest(req, res, url) {
  const p = url.pathname;
  const owned = p === "/api/inbox" || p === "/api/inbox/confirm-potential" || p === "/api/inbox/mark-done" || p === "/api/inbox/send" || p === "/api/inbox/conversations" || p.startsWith("/api/calls") || p.startsWith("/api/tasks") || p.startsWith("/api/notes") || p.startsWith("/api/inbox/contact/") || p.startsWith("/api/inbox/conversations/");
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
    const messages = readJsonArrayFiltered(MESSAGE_LOG_FILE, m => m.contactId === contactId).map(m => ({ ...m, itemType: m.channel, at: m.createdAt, done: !!m.inboxDone }));
    const calls = readJson(CALLS_FILE, []).filter(c => c.contactId === contactId).map(c => ({ ...c, itemType: "call", at: c.createdAt, done: !!c.inboxDone }));
    const tasks = readJson(TASKS_FILE, []).filter(t => t.contactId === contactId).map(t => ({ ...t, itemType: t.type, at: t.dueAt || t.createdAt }));
    const notes = readJson(NOTES_FILE, []).filter(n => n.contactId === contactId).map(n => ({ ...n, itemType: "note", at: n.createdAt }));
    const items = [...messages, ...calls, ...tasks, ...notes].sort((a, b) => new Date(b.at) - new Date(a.at));
    return sendJson(res, 200, { items });
  }

  // ── Chat-style conversation list -- one row per contact (or per raw
  // from/to for a not-yet-confirmed Potential Contact) with any email/sms
  // activity, most-recently-active first. Powers the Inbox's left sidebar.
  //
  // Filtering/sorting/search all happen HERE, before pagination, rather
  // than being applied client-side to whatever page happens to be loaded
  // -- with a large conversation list, a client-side filter over just the
  // first page would silently miss matches further down, and "search"
  // needs to cover the whole list regardless of scroll position. Only the
  // final page slice is ever serialized/sent, which is what actually
  // fixes the "too slow to load" problem: the JSON payload and the DOM
  // render are both bounded by `limit`, not by total conversation count.
  if (p === "/api/inbox/conversations" && req.method === "GET") {
    const channel = url.searchParams.get("channel"); // 'email' | 'sms' | null (both, plus form/booking activity)
    const statusFilter = url.searchParams.get("status") || "";
    const typeFilter = url.searchParams.get("type") || "";
    const bucket = url.searchParams.get("filter") || "all"; // all|done|unresponded|archived|favorites
    const sortDir = url.searchParams.get("sort") === "oldest" ? "oldest" : "newest";
    const search = (url.searchParams.get("search") || "").trim().toLowerCase();
    const limit = Math.min(200, Math.max(1, parseInt(url.searchParams.get("limit"), 10) || 40));
    const offset = Math.max(0, parseInt(url.searchParams.get("offset"), 10) || 0);
    const contacts = readJson(CONTACTS_FILE, []);
    // Folds directly into a bounded per-contact summary as the log streams
    // by, instead of collecting every individual message into a per-group
    // array first -- confirmed live: with the message log past several GB
    // (millions of records, most carrying full email bodies/statusHistory/
    // hyrosSaleData), materializing "every message, grouped" crashed the
    // live server with a real OOM on every sidebar load. Peak memory here
    // is bounded by (distinct contacts × a few retained message refs each),
    // not by total message count.
    const groups = reduceJsonArray(MESSAGE_LOG_FILE, (groups, m) => {
      if (!["email", "sms", "form", "booking", "activity"].includes(m.channel)) return groups;
      if (channel && m.channel !== channel) return groups;
      const key = m.contactId || `unmatched:${m.channel}:${m.direction === "inbound" ? m.from : m.to}`;
      let g = groups.get(key);
      if (!g) { g = { key, contactId: m.contactId || null, last: null, lastMine: null, lastInbound: null, unreadCount: 0 }; groups.set(key, g); }
      if (!g.last || new Date(m.createdAt) > new Date(g.last.createdAt)) g.last = m;
      if (m.direction === "outbound" && (!g.lastMine || new Date(m.createdAt) > new Date(g.lastMine.createdAt))) g.lastMine = m;
      if (m.direction === "inbound") {
        if (!g.lastInbound || new Date(m.createdAt) > new Date(g.lastInbound.createdAt)) g.lastInbound = m;
        if (!m.inboxDone) g.unreadCount++;
      }
      return groups;
    }, new Map());

    const contactById = new Map(contacts.map(c => [c.id, c]));
    const metaByContactId = getConvoMetaMap();
    const conversations = [...groups.values()].map(g => {
      const last = g.last;
      const contact = g.contactId ? contactById.get(g.contactId) || null : null;
      const meta = g.contactId ? metaByContactId.get(g.contactId) || null : null;
      // Read-receipt-style status for the last MINE message in this thread
      // (independent of `last`, which could be their most recent inbound
      // reply) -- single check (sent/queued), double grey (delivered), or
      // double blue once we know it was opened (email) -- SMS has no
      // carrier-level "read" signal, so it never goes past delivered.
      const lastMine = g.lastMine;
      const lastOpened = !!lastMine?.statusHistory?.some(h => h.status === "opened");
      // A contact stuck on an automated drip sequence keeps getting fresh
      // OUTBOUND timestamps forever even if they never reply -- sorting by
      // raw last-activity buries a genuine reply from yesterday under five
      // leads who last engaged a year ago but are still mid-sequence.
      // lastInboundAt is what "Newest first" actually sorts by; lastAt
      // stays the true last-touch for the preview text/ticks.
      const lastInbound = g.lastInbound;
      return {
        key: g.key, contactId: g.contactId, contact,
        displayName: contact ? `${contact.first} ${contact.last}`.trim() : (last.direction === "inbound" ? last.from : last.to) || "Unknown",
        lastChannel: last.channel, lastDirection: last.direction,
        lastPreview: last.subject || last.bodyPreview || "",
        lastAt: last.createdAt, lastInboundAt: lastInbound?.createdAt || null, lastMessageId: last.id, unreadCount: g.unreadCount,
        pinned: !!meta?.pinned, starred: !!meta?.starred, archived: !!meta?.archived,
        // "Done" only counts once you've actually seen everything -- new
        // inbound activity after being marked done drops unreadCount back
        // above 0, which is enough on its own to fall out of the DONE
        // filter (unresponded && done are mutually exclusive by construction).
        done: !!meta?.done && g.unreadCount === 0,
        lastStatus: lastMine?.status || null, lastOpened,
      };
    });

    let rows = conversations;
    if (search) rows = rows.filter(c => c.displayName.toLowerCase().includes(search));
    // Archived conversations (opted-out / blacklisted contacts, or manually
    // archived) stay out of every other view -- there's nothing left to
    // action on them -- and only show up when Archived is explicitly selected.
    if (bucket === "archived") rows = rows.filter(c => c.archived);
    else {
      rows = rows.filter(c => !c.archived);
      if (bucket === "done") rows = rows.filter(c => c.done);
      else if (bucket === "unresponded") rows = rows.filter(c => c.unreadCount > 0);
      else if (bucket === "favorites") rows = rows.filter(c => c.starred);
    }
    if (statusFilter) rows = rows.filter(c => c.contact?.status === statusFilter);
    if (typeFilter) rows = rows.filter(c => c.contact?.programType === typeFilter);

    rows.sort((a, b) => {
      if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
      // Never-replied threads (lastInboundAt: null) sort after every thread
      // that has a real reply, oldest of the never-replied group last.
      if (!a.lastInboundAt || !b.lastInboundAt) {
        if (!a.lastInboundAt && !b.lastInboundAt) return sortDir === "oldest" ? new Date(a.lastAt) - new Date(b.lastAt) : new Date(b.lastAt) - new Date(a.lastAt);
        return (a.lastInboundAt ? -1 : 1) * (sortDir === "oldest" ? -1 : 1);
      }
      return sortDir === "oldest" ? new Date(a.lastInboundAt) - new Date(b.lastInboundAt) : new Date(b.lastInboundAt) - new Date(a.lastInboundAt);
    });

    const page = rows.slice(offset, offset + limit);
    return sendJson(res, 200, { conversations: page, total: rows.length, hasMore: offset + limit < rows.length });
  }

  // Pin/star a conversation -- purely presentational state, kept
  // independent of the contact record itself.
  const pinMatch = p.match(/^\/api\/inbox\/conversations\/([^/]+)\/pin$/);
  if (pinMatch && req.method === "POST") {
    const { pinned } = await readJsonBody(req);
    return sendJson(res, 200, { ok: true, meta: setConvoMeta(pinMatch[1], { pinned: !!pinned }) });
  }
  const starMatch = p.match(/^\/api\/inbox\/conversations\/([^/]+)\/star$/);
  if (starMatch && req.method === "POST") {
    const { starred } = await readJsonBody(req);
    return sendJson(res, 200, { ok: true, meta: setConvoMeta(starMatch[1], { starred: !!starred }) });
  }
  // Archive -- manual toggle from the context menu, and also set
  // automatically (see conversation_meta.js's setConvoMeta callers in
  // compliance_backend.js/email_backend.js/contacts_backend.js) whenever a
  // contact opts out or gets blacklisted, since a suppressed contact has
  // nothing left to action in the Inbox.
  const archiveMatch = p.match(/^\/api\/inbox\/conversations\/([^/]+)\/archive$/);
  if (archiveMatch && req.method === "POST") {
    const { archived } = await readJsonBody(req);
    return sendJson(res, 200, { ok: true, meta: setConvoMeta(archiveMatch[1], { archived: !!archived }) });
  }
  // Mark an entire thread done -- clears every unread inbound message for
  // this contact (same effect as the old per-message mark-done, just
  // scoped by contactId instead of an explicit id list) and remembers the
  // "done" state itself so the DONE filter has something to match even
  // once unreadCount naturally hits 0 some other way.
  const doneMatch = p.match(/^\/api\/inbox\/conversations\/([^/]+)\/done$/);
  if (doneMatch && req.method === "POST") {
    const contactId = doneMatch[1];
    const { done } = await readJsonBody(req);
    const value = done !== false;
    if (value) {
      const log = readJson(MESSAGE_LOG_FILE, []);
      let changed = false;
      log.forEach(m => { if (m.contactId === contactId && m.direction === "inbound" && !m.inboxDone) { m.inboxDone = true; changed = true; } });
      if (changed) writeJson(MESSAGE_LOG_FILE, log);
    }
    return sendJson(res, 200, { ok: true, meta: setConvoMeta(contactId, { done: value }) });
  }

  // Permanently delete an entire conversation -- every message to/from this
  // contact (or, for a not-yet-confirmed Potential Contact, every message
  // matching that raw address), plus its pin/star/done state. Irreversible,
  // so the frontend gates this behind its own explicit confirm dialog.
  const deleteConvoMatch = p.match(/^\/api\/inbox\/conversations\/([^/]+)$/);
  if (deleteConvoMatch && req.method === "DELETE") {
    const key = decodeURIComponent(deleteConvoMatch[1]);
    const log = readJson(MESSAGE_LOG_FILE, []);
    let remaining;
    const unmatched = key.match(/^unmatched:(email|sms):(.*)$/);
    if (unmatched) {
      const [, channel, address] = unmatched;
      remaining = log.filter(m => !(!m.contactId && m.channel === channel && (m.direction === "inbound" ? m.from : m.to) === address));
    } else {
      remaining = log.filter(m => m.contactId !== key);
      const meta = readJson(CONVERSATION_META_FILE, []).filter(m => m.contactId !== key);
      writeJson(CONVERSATION_META_FILE, meta);
    }
    if (remaining.length !== log.length) writeJson(MESSAGE_LOG_FILE, remaining);
    return sendJson(res, 200, { ok: true });
  }

  // Ad-hoc 1:1 send from the Inbox chat panel -- unlike campaigns/
  // automations/booking confirmations, this always goes out as the
  // logged-in staff member's own address (see email_backend.js's `from`
  // override), not the single shared campaign sender.
  if (p === "/api/inbox/send" && req.method === "POST") {
    const { contactId, channel, subject, body } = await readJsonBody(req);
    const contacts = readJson(CONTACTS_FILE, []);
    const contact = contacts.find(c => c.id === contactId);
    if (!contact) return sendJson(res, 400, { error: "Unknown contact" });
    if (!body || !body.trim()) return sendJson(res, 400, { error: "Message is required" });

    if (channel === "email") {
      if (!contact.email) return sendJson(res, 400, { error: "This contact has no email address" });
      const result = await sendEmail({
        to: contact.email, subject: subject || "(no subject)",
        blocks: [{ id: "b1", type: "text", html: body.replace(/\n/g, "<br/>") }], theme: {}, footerTemplateId: null,
        contactId, sourceType: "inbox", sourceId: me.id,
        from: `${me.first} ${me.last} <${me.email}>`,
      });
      if (!result.ok) return sendJson(res, 502, { error: result.reason || "Send failed" });
      return sendJson(res, 200, { ok: true });
    }
    if (channel === "sms") {
      if (!contact.phone) return sendJson(res, 400, { error: "This contact has no phone number" });
      const result = await sendSms({ to: contact.phone, body, contactId, sourceType: "inbox", sourceId: me.id });
      if (!result.ok) return sendJson(res, 502, { error: result.reason || "Send failed" });
      return sendJson(res, 200, { ok: true });
    }
    return sendJson(res, 400, { error: "channel must be 'email' or 'sms'" });
  }

  if (p === "/api/inbox" && req.method === "GET") {
    const tab = url.searchParams.get("tab") || "primary";
    // view: 'new' (default, not yet handled) | 'past' (marked done) | 'all'
    const view = url.searchParams.get("view") || "new";
    const contacts = readJson(CONTACTS_FILE, []);
    // Inbox is for things that need a human's attention -- incoming
    // messages, calls, and open tasks/reminders -- not a log of the CRM's
    // own outbound sends (those belong in Contacts/Campaigns reporting).
    // Filtering to inbound-only INSIDE the scan (not after materializing
    // everything) is what keeps this safe at message-log scale -- most
    // records are outbound campaign/activity sends and never need to be
    // held in memory at all for this endpoint.
    const inbound = readJsonArrayFiltered(MESSAGE_LOG_FILE, m => m.direction === "inbound")
      .map(m => ({ ...m, itemType: m.channel, at: m.createdAt, done: !!m.inboxDone }));
    const calls = readJson(CALLS_FILE, []).map(c => ({ ...c, itemType: "call", at: c.createdAt, done: !!c.inboxDone }));
    const tasks = readJson(TASKS_FILE, []).map(t => ({ ...t, itemType: t.type, at: t.dueAt || t.createdAt }));

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

  // Turns a Potential Contact (an unmatched message -- inbound OR outbound,
  // e.g. a self-test send with no contact behind it yet) into a real
  // contact, then backfills every prior unmatched message to/from that
  // same address so they immediately disappear from Potential Contacts and
  // show up correctly in the rest of the Inbox.
  if (p === "/api/inbox/confirm-potential" && req.method === "POST") {
    const { messageId, first, last } = await readJsonBody(req);
    if (!first) return sendJson(res, 400, { error: "first name is required" });
    const log = readJson(MESSAGE_LOG_FILE, []);
    const row = log.find(m => m.id === messageId);
    if (!row) return sendJson(res, 404, { error: "Message not found" });
    // Which field is actually THEIR address depends on the row's own
    // direction -- from=them on an inbound message, but to=them on an
    // outbound one (the bug this replaced always read `.from`, which is
    // US on anything outbound, silently creating a contact with the wrong
    // address and -- since it never matched anything below -- leaving the
    // row "unmatched" forever, so confirming again looked like it "did
    // nothing" and just kept creating duplicate contacts).
    const theirAddress = row.direction === "inbound" ? row.from : row.to;
    const phone = row.channel === "sms" ? theirAddress : null;
    const email = row.channel === "email" ? theirAddress : null;

    const contacts = readJson(CONTACTS_FILE, []);
    // Same person can show up as TWO separate Potential Contacts rows (one
    // per channel -- an unmatched SMS row and an unmatched email row),
    // confirmed minutes apart. Without this check each confirm created its
    // own new contact instead of recognizing the other channel's contact
    // already exists, silently producing duplicates every time.
    let contact = findContactMatch(contacts, email, phone);
    if (contact) {
      if (!contact.email && email) contact.email = email.toLowerCase();
      if (!contact.phone && phone) contact.phone = phone;
      contact.updatedAt = new Date().toISOString();
    } else {
      contact = {
        id: randomUUID(), type: "lead", accountName: "",
        first, last: last || "", email: (email || "").toLowerCase(), phone: phone || "",
        status: "", tags: [], listIds: [], customFields: {},
        source: "inbound_confirmed", ownerId: null, emailOptOut: false, smsOptOut: false,
        externalIds: { acContactId: null, closeLeadId: null },
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      };
      contacts.push(contact);
    }
    writeJson(CONTACTS_FILE, contacts);

    let logChanged = false;
    if (phone) {
      const digits = digitsOnly(phone);
      log.forEach(m => { if (!m.contactId && digitsOnly(m.direction === "inbound" ? m.from : m.to) === digits) { m.contactId = contact.id; logChanged = true; } });
    }
    if (email) {
      const lower = email.toLowerCase();
      log.forEach(m => { if (!m.contactId && (m.direction === "inbound" ? m.from : m.to)?.toLowerCase() === lower) { m.contactId = contact.id; logChanged = true; } });
    }
    if (logChanged) writeJson(MESSAGE_LOG_FILE, log);
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

  // Freeform contact notes -- same list/add/edit/delete shape as Tasks,
  // just no dueAt/done (a note isn't something you complete).
  if (p === "/api/notes" && req.method === "POST") {
    const { contactId, text } = await readJsonBody(req);
    if (!text) return sendJson(res, 400, { error: "text is required" });
    const notes = readJson(NOTES_FILE, []);
    const note = { id: randomUUID(), contactId: contactId || null, text, createdAt: new Date().toISOString(), createdBy: me.id };
    notes.push(note);
    writeJson(NOTES_FILE, notes);
    return sendJson(res, 200, { ok: true, note });
  }
  const noteMatch = p.match(/^\/api\/notes\/([^/]+)$/);
  if (noteMatch) {
    const notes = readJson(NOTES_FILE, []);
    const note = notes.find(n => n.id === noteMatch[1]);
    if (req.method === "PATCH") {
      if (!note) return sendJson(res, 404, { error: "Not found" });
      const { text } = await readJsonBody(req);
      if (text) note.text = text;
      writeJson(NOTES_FILE, notes);
      return sendJson(res, 200, { ok: true, note });
    }
    if (req.method === "DELETE") {
      writeJson(NOTES_FILE, notes.filter(n => n.id !== noteMatch[1]));
      return sendJson(res, 200, { ok: true });
    }
  }

  return false;
}
