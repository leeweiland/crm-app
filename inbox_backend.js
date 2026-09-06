import { randomUUID } from "crypto";
import { readJson, writeJson, readJsonBody, sendJson, getSessionUser, topKJsonArray, updateJsonArrayRecordsByIds, USERS_FILE, isAdmin } from "./auth_backend.js";
import { CONTACTS_FILE, findContactMatch } from "./segments_shared.js";
import { MESSAGE_LOG_FILE, MESSAGE_ID_INDEX_FILE } from "./message_log.js";
import { sendEmail } from "./email_backend.js";
import { sendSms } from "./sms_backend.js";
import { CONVERSATION_META_FILE, getConvoMetaMap, setConvoMeta } from "./conversation_meta.js";
import {
  getContactMessages, appendContactMessage, updateContactMessagesByIds, deleteContactMessageFile,
  markContactMessagesDone, upsertConversationSummary, recomputeConversationSummary, removeConversationSummary,
  CONVERSATION_INDEX_FILE,
} from "./message_index.js";
import { queryConversationsSqlite } from "./sqlite_inbox.js";
import { reconcileRecentGmailForContact, sendViaGmail } from "./gmail_backend.js";
import { syncAcEngagementForContact, syncAcEngagementForRecentContacts } from "./ac_sync.js";

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
  const owned = p === "/api/inbox" || p === "/api/inbox/confirm-potential" || p === "/api/inbox/mark-done" || p === "/api/inbox/send" || p === "/api/inbox/conversations" || p === "/api/inbox/ac-sync-recent" || p.startsWith("/api/calls") || p.startsWith("/api/tasks") || p.startsWith("/api/notes") || p.startsWith("/api/inbox/contact/") || p.startsWith("/api/inbox/conversations/");
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
    const messages = getContactMessages(contactId).map(m => ({ ...m, itemType: m.channel, at: m.createdAt, done: !!m.inboxDone }));
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
    const ownerFilter = url.searchParams.get("owner") || ""; // a user id, "unassigned", or "" (no filter)
    const bucket = url.searchParams.get("filter") || "all"; // all|done|unresponded|archived|favorites
    const sortDir = url.searchParams.get("sort") === "oldest" ? "oldest" : "newest";
    const search = (url.searchParams.get("search") || "").trim().toLowerCase();
    const limit = Math.min(200, Math.max(1, parseInt(url.searchParams.get("limit"), 10) || 40));
    const offset = Math.max(0, parseInt(url.searchParams.get("offset"), 10) || 0);

    // SQLite is the default path now that message_index.js/conversation_meta.js/
    // contacts_backend.js keep it live-synced on every write (see sqlite_inbox.js's
    // header comment for the exact trigger points). Falls through to the full
    // JSON fold below only when the .db file doesn't exist -- local dev without
    // it built, or (deliberately, ?_sqlite=0) forcing the JSON path to compare
    // against or to recover from a bad sync without waiting on a redeploy.
    if (url.searchParams.get("_sqlite") !== "0") {
      const t0 = Date.now();
      const result = queryConversationsSqlite({ channel, statusFilter, typeFilter, ownerFilter, bucket, sortDir, search, limit, offset });
      if (result) return sendJson(res, 200, { ...result, _queryMs: Date.now() - t0, _engine: "sqlite" });
    }
    const _t0 = Date.now();
    const contacts = readJson(CONTACTS_FILE, []);
    // Reads the persisted per-contact summary index (kept incrementally up
    // to date by message_index.js on every send/receive) instead of folding
    // the whole message log on every request -- that fold was memory-safe
    // (bounded by distinct contacts, not total message count) but still
    // required a full pass over a 12GB+ file, confirmed live to still take
    // 100+ seconds. This file is one small row per contact -- tens of MB,
    // not gigabytes -- so reading it is the same order of cost as the
    // contacts.json read this endpoint already does.
    const allRows = readJson(CONVERSATION_INDEX_FILE, []);
    const rowsForChannel = channel
      ? allRows.filter(g => g.lastByChannel?.[channel]).map(g => ({ ...g, last: g.lastByChannel[channel] }))
      : allRows;

    const contactById = new Map(contacts.map(c => [c.id, c]));
    const metaByContactId = getConvoMetaMap();
    const conversations = rowsForChannel.map(g => {
      const last = g.last;
      const contact = g.contactId ? contactById.get(g.contactId) || null : null;
      const meta = g.contactId ? metaByContactId.get(g.contactId) || null : null;
      // Read-receipt-style status for the last MINE message in this thread
      // (independent of `last`, which could be their most recent inbound
      // reply) -- single check (sent/queued), double grey (delivered), or
      // double blue once we know it was opened (email) -- SMS has no
      // carrier-level "read" signal, so it never goes past delivered.
      const lastMine = g.lastMine;
      const lastOpened = !!lastMine?.opened;
      // A contact stuck on an automated drip sequence keeps getting fresh
      // OUTBOUND timestamps forever even if they never reply -- sorting by
      // raw last-activity buries a genuine reply from yesterday under five
      // leads who last engaged a year ago but are still mid-sequence.
      // lastInboundAt is what "Newest first" actually sorts by; lastAt
      // stays the true last-touch for the preview text/ticks.
      const hidden = !!meta?.hidden;
      // A hidden conversation (blacklisted, via applyStatusOptOut) is a
      // permanent quarantine, not something waiting on a reply -- its
      // inbound messages never count toward the unread badge or the
      // Unresponded filter, in the Hidden tab or anywhere else.
      const unreadCount = hidden ? 0 : g.unreadCount;
      return {
        key: g.key, contactId: g.contactId, contact,
        displayName: contact ? `${contact.first} ${contact.last}`.trim() : (last.direction === "inbound" ? last.from : last.to) || "Unknown",
        lastChannel: last.channel, lastDirection: last.direction,
        // Body snippet, not the subject line -- "Re: yo" (a real subject
        // this business's drip templates use) told a coach nothing about
        // what the lead actually said without opening the thread.
        lastPreview: last.bodyPreview || last.subject || "",
        lastAt: last.createdAt, lastInboundAt: g.lastInboundAt || null, lastMessageId: last.id, unreadCount,
        pinned: !!meta?.pinned, starred: !!meta?.starred, archived: !!meta?.archived, hidden,
        // "Done" only counts once you've actually seen everything -- new
        // inbound activity after being marked done drops unreadCount back
        // above 0, which is enough on its own to fall out of the DONE
        // filter (unresponded && done are mutually exclusive by construction).
        done: !!meta?.done && unreadCount === 0,
        lastStatus: lastMine?.status || null, lastOpened,
      };
    });

    let rows = conversations;
    if (search) rows = rows.filter(c => c.displayName.toLowerCase().includes(search));
    // Archived conversations (manually archived) stay out of every other
    // view -- there's nothing left to action on them -- and only show up
    // when Archived is explicitly selected. Hidden (blacklisted contacts,
    // set via applyStatusOptOut -- permanent, no reverse trigger) is its
    // own dedicated bucket, kept separate from generic "archived" so a
    // plain manually-archived conversation and a blacklisted one don't
    // blend into the same tab.
    if (bucket === "hidden") rows = rows.filter(c => c.hidden);
    else if (bucket === "archived") rows = rows.filter(c => c.archived && !c.hidden);
    else {
      rows = rows.filter(c => !c.archived && !c.hidden);
      if (bucket === "done") rows = rows.filter(c => c.done);
      else if (bucket === "unresponded") rows = rows.filter(c => c.unreadCount > 0);
      else if (bucket === "favorites") rows = rows.filter(c => c.starred);
    }
    if (statusFilter) rows = rows.filter(c => c.contact?.status === statusFilter);
    if (typeFilter) rows = rows.filter(c => c.contact?.programType === typeFilter);
    if (ownerFilter === "unassigned") rows = rows.filter(c => !c.contact?.ownerId);
    else if (ownerFilter) rows = rows.filter(c => c.contact?.ownerId === ownerFilter);

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
    return sendJson(res, 200, { conversations: page, total: rows.length, hasMore: offset + limit < rows.length, _queryMs: Date.now() - _t0, _engine: "json" });
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
      // markContactMessagesDone patches the per-contact file, the one
      // place anything actually reads inboxDone status from (the main log
      // is write-once-append-only -- see updateMessageStatusByProviderId's
      // comment). This used to ALSO call updateJsonArrayRecordsByIds
      // against the main log on the mistaken belief that it's a cheap
      // targeted patch -- it streams its READ of the file but still
      // rewrites the whole thing every call, which at 12GB+ meant marking
      // a conversation done paid for a full read+write of the entire log,
      // for a completely redundant update nothing was ever going to read
      // back. Confirmed live (2026-09-05) as part of the same freeze
      // pattern /api/inbox/mark-done had.
      const idsToFlip = getContactMessages(contactId).filter(m => m.direction === "inbound" && !m.inboxDone).map(m => m.id);
      if (idsToFlip.length) markContactMessagesDone(contactId);
      recomputeConversationSummary(contactId);
    }
    return sendJson(res, 200, { ok: true, meta: setConvoMeta(contactId, { done: value }) });
  }

  // Fired whenever the sidebar opens a conversation -- distinct from
  // /done above, which also sets the persistent "done" meta bucket (a
  // deliberate user action, not implied by just viewing a thread). This
  // only re-derives unread_count from the contact's actual message file,
  // so a badge that's stuck out of sync with reality (stale data, or a
  // phantom row with no real messages behind it -- recomputeConversation
  // Summary deletes those outright) gets corrected the moment someone
  // looks at it, even when there's nothing for /mark-done to flip.
  const openedMatch = p.match(/^\/api\/inbox\/conversations\/([^/]+)\/opened$/);
  if (openedMatch && req.method === "POST") {
    recomputeConversationSummary(openedMatch[1]);
    // Fire-and-forget: catches anything the 30s Gmail poller's history
    // diff missed for THIS contact specifically (a paused poller, a
    // capped backlog -- see gmail_backend.js's MAX_MESSAGES_PER_TICK)
    // without adding a real Gmail API round trip to every conversation
    // open, and without sweeping all ~176k contacts to find the gap.
    // No-ops instantly if nobody's connected Gmail.
    reconcileRecentGmailForContact(openedMatch[1]).catch(e => console.error("[gmail] on-open reconcile failed:", e.message));
    // Same fire-and-forget, on-open reasoning, for ActiveCampaign engagement
    // -- see ac_sync.js's own header comment for why AC is the only real
    // source of opens/clicks right now.
    syncAcEngagementForContact(openedMatch[1]).catch(e => console.error("[ac_sync] on-open sync failed:", e.message));
    return sendJson(res, 200, { ok: true });
  }

  // Manual catch-up for AC sends nobody's reopened the conversation for
  // yet (e.g. a campaign that went out minutes ago). Deliberately scoped
  // to contacts with real recent activity in THIS crm already (bounded,
  // already-indexed), NOT every AC-linked contact -- that's 160,623 of
  // them, checked live, which would mean one real AC API call each,
  // sequentially -- an hours-long sweep for what's supposed to be a
  // same-day catch-up. See ac_sync.js's own comment.
  if (p === "/api/inbox/ac-sync-recent" && (req.method === "POST" || req.method === "GET")) {
    const me = getSessionUser(req);
    if (!me) return sendJson(res, 401, { error: "Not logged in" });
    if (!isAdmin(me)) return sendJson(res, 403, { error: "Admins only" });
    const hours = Number(url.searchParams.get("hours")) || 24;
    try {
      const result = await syncAcEngagementForRecentContacts(Date.now() - hours * 3600 * 1000);
      return sendJson(res, 200, { ok: true, ...result });
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  // Permanently delete an entire conversation -- every message to/from this
  // contact (or, for a not-yet-confirmed Potential Contact, every message
  // matching that raw address), plus its pin/star/done state. Irreversible,
  // so the frontend gates this behind its own explicit confirm dialog.
  const deleteConvoMatch = p.match(/^\/api\/inbox\/conversations\/([^/]+)$/);
  if (deleteConvoMatch && req.method === "DELETE") {
    const key = decodeURIComponent(deleteConvoMatch[1]);
    const unmatched = key.match(/^unmatched:(email|sms):(.*)$/);
    if (unmatched) {
      // Potential Contacts have no contactId, so there's no per-contact
      // file to shortcut through -- this still has to scan the main log.
      // Rare in practice (unconfirmed senders don't accumulate at bulk-
      // import volume), unlike the contactId path below.
      const [, channel, address] = unmatched;
      const log = readJson(MESSAGE_LOG_FILE, []);
      const remaining = log.filter(m => !(!m.contactId && m.channel === channel && (m.direction === "inbound" ? m.from : m.to) === address));
      if (remaining.length !== log.length) writeJson(MESSAGE_LOG_FILE, remaining);
    } else {
      const messages = getContactMessages(key);
      if (messages.length) {
        const ids = messages.map(m => m.id);
        updateJsonArrayRecordsByIds(MESSAGE_LOG_FILE, ids, () => null);
        deleteContactMessageFile(key);
      }
      const meta = readJson(CONVERSATION_META_FILE, []).filter(m => m.contactId !== key);
      writeJson(CONVERSATION_META_FILE, meta);
    }
    removeConversationSummary(key);
    return sendJson(res, 200, { ok: true });
  }

  // Ad-hoc 1:1 send from the Inbox chat panel -- unlike campaigns/
  // automations/booking confirmations, this always goes out as the
  // logged-in staff member's own address (see email_backend.js's `from`
  // override), not the single shared campaign sender.
  if (p === "/api/inbox/send" && req.method === "POST") {
    const { contactId, channel, subject, body, fromUserId } = await readJsonBody(req);
    const contacts = readJson(CONTACTS_FILE, []);
    const contact = contacts.find(c => c.id === contactId);
    if (!contact) return sendJson(res, 400, { error: "Unknown contact" });
    if (!body || !body.trim()) return sendJson(res, 400, { error: "Message is required" });

    if (channel === "email") {
      if (!contact.email) return sendJson(res, 400, { error: "This contact has no email address" });
      // Sending "as" a teammate (compose panel's From dropdown) -- admin
      // only (enforced here too, not just by hiding the dropdown client-
      // side), and only trusts fromUserId enough to look up a REAL other
      // user record, never takes name/email straight from the request body.
      let sender = me;
      if (fromUserId && fromUserId !== me.id && isAdmin(me)) {
        const teamUsers = readJson(USERS_FILE, []);
        const other = teamUsers.find(u => u.id === fromUserId && !u.archived);
        if (other) sender = other;
      }
      // Gmail first when the sender has actually granted send access --
      // SES here is stuck in sandbox mode (confirmed via AWS's own account
      // API: ProductionAccessEnabled false), which caps at 200 sends/24h
      // and rejects any recipient that isn't individually pre-verified in
      // the AWS console, i.e. nearly every real lead. Falls back to SES
      // for anyone who hasn't (re)connected Gmail with the send scope yet
      // rather than hard-failing their send.
      const html = body.replace(/\n/g, "<br/>");
      const result = (sender.gmailRefreshToken && sender.gmailScope?.includes("gmail.send"))
        ? await sendViaGmail({ user: sender, to: contact.email, subject: subject || "(no subject)", html, contactId, sourceType: "inbox", sourceId: sender.id })
        : await sendEmail({
            to: contact.email, subject: subject || "(no subject)",
            blocks: [{ id: "b1", type: "text", html }], theme: {}, footerTemplateId: sender.footerTemplateId || null,
            contactId, sourceType: "inbox", sourceId: sender.id,
            from: `${sender.first} ${sender.last} <${sender.email}>`,
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
    const calls = readJson(CALLS_FILE, []).map(c => ({ ...c, itemType: "call", at: c.createdAt, done: !!c.inboxDone }));
    const tasks = readJson(TASKS_FILE, []).map(t => ({ ...t, itemType: t.type, at: t.dueAt || t.createdAt }));

    // Bounded to the most recent INBOX_MESSAGE_LIMIT inbound messages
    // matching this tab/view instead of materializing every inbound
    // message ever received. Confirmed live: even after switching to a
    // bounded-memory SCAN (readJsonArrayFiltered), "direction === inbound"
    // alone still matched millions of records post-import and crashed the
    // server with a real OOM building that result array -- a bounded scan
    // isn't enough when the match set itself is unbounded; the RESULT also
    // has to be capped. topKJsonArray keeps only the K best (here: most
    // recent) matches in O(k) memory regardless of match count. The
    // channel/done filters are folded into the predicate here (rather than
    // applied after, like the old code did) so the top-K cut happens on
    // the CORRECT final candidate set -- otherwise capping at 1000 overall
    // inbound messages and THEN filtering by tab/view could throw away
    // matches that would have made the cut.
    const needsMessages = tab !== "calls" && tab !== "tasks" && tab !== "reminders";
    const channelFilter = tab === "emails" ? "email" : tab === "messages" ? "sms" : null;
    const doneFilter = view === "new" ? false : view === "past" ? true : null;
    const INBOX_MESSAGE_LIMIT = 1000;
    const inbound = needsMessages
      ? topKJsonArray(
          MESSAGE_LOG_FILE,
          m => m.direction === "inbound" && (!channelFilter || m.channel === channelFilter) && (doneFilter === null || !!m.inboxDone === doneFilter),
          INBOX_MESSAGE_LIMIT,
          (a, b) => new Date(a.createdAt) - new Date(b.createdAt),
        ).map(m => ({ ...m, itemType: m.channel, at: m.createdAt, done: !!m.inboxDone }))
      : [];

    let items;
    if (tab === "emails" || tab === "messages") items = inbound;
    else if (tab === "calls") items = calls;
    else if (tab === "tasks") items = tasks.filter(t => t.type === "task");
    else if (tab === "reminders") items = tasks.filter(t => t.type === "reminder");
    else items = [...inbound, ...calls, ...tasks]; // primary

    // Still needed even though `inbound` is pre-filtered by doneFilter --
    // calls/tasks were never pre-filtered, so this is a no-op for messages
    // and the real filter for everything else.
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

    // contactId per id comes from the small id->contactId index (populated
    // by every logMessage() call), NOT from patching the main log --
    // updateJsonArrayRecordsByIds streams its READ of the target file, but
    // still rewrites the WHOLE thing every call (read the lot, write the
    // lot, rename). crm_message_log.json has grown past 12GB, and this ran
    // on every single mark-done -- i.e. every time anyone opened a
    // conversation with an unread message. Confirmed live (2026-09-05) as
    // a second, separate cause of the Inbox freezing hard on ordinary
    // clicking, after compliance_backend.js's own full-log read (a
    // different bug, same underlying mistake) was already fixed. The main
    // log itself is intentionally write-once-append-only now -- see
    // updateMessageStatusByProviderId's own comment -- so it was never
    // meant to be the one getting patched here in the first place.
    const idIndex = readJson(MESSAGE_ID_INDEX_FILE, {});
    const touchedContacts = new Set(ids.map(id => idIndex[id]?.contactId).filter(Boolean));
    for (const contactId of touchedContacts) {
      updateContactMessagesByIds(contactId, idSet, m => { m.inboxDone = value; });
      recomputeConversationSummary(contactId);
    }

    const calls = readJson(CALLS_FILE, []);
    let changed = false;
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
    const migrated = [];
    if (phone) {
      const digits = digitsOnly(phone);
      log.forEach(m => { if (!m.contactId && digitsOnly(m.direction === "inbound" ? m.from : m.to) === digits) { m.contactId = contact.id; logChanged = true; migrated.push(m); } });
    }
    if (email) {
      const lower = email.toLowerCase();
      log.forEach(m => { if (!m.contactId && (m.direction === "inbound" ? m.from : m.to)?.toLowerCase() === lower) { m.contactId = contact.id; logChanged = true; migrated.push(m); } });
    }
    if (logChanged) writeJson(MESSAGE_LOG_FILE, log);
    // These messages just went from "no contact" (no per-contact file, only
    // ever findable via a full log scan) to belonging to a real contact --
    // feed them into that contact's index now so the Inbox/contact-detail
    // views find them immediately instead of only after a full reindex.
    migrated.forEach(m => appendContactMessage(m));
    if (migrated.length) recomputeConversationSummary(contact.id);
    migrated.forEach(m => removeConversationSummary(`unmatched:${m.channel}:${m.direction === "inbound" ? m.from : m.to}`));
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
