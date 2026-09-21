import { randomUUID } from "crypto";
import { readJson, writeJson, readJsonBody, sendJson, getSessionUser, updateJsonArrayRecordByField, updateJsonArrayRecordsByIds, removeValuesFromArrayField, appendJsonRecordFast, isAdmin } from "./auth_backend.js";
import { renewalForContact, syncContactFields, getContactByIdSqlite, deleteContactIndex, queryContactsSqlite, contactsIndexCount, backfillContactsIndex, sqliteInboxAvailable, tagCountsSqlite, listCountsSqlite } from "./sqlite_inbox.js";
import { CONTACTS_FILE, SEGMENTS_FILE, matchesSegment, findContactMatch } from "./segments_shared.js";
import { fireTrigger, checkAutomationGoal } from "./automations_backend.js";
import { fireWorkflowTrigger, checkConversionGoal } from "./workflows_backend.js";
import { applyStatusOptOut } from "./compliance_backend.js";
import { removeConversationSummary, deleteContactMessageFile } from "./message_index.js";
import { logMessage } from "./message_log.js";

export { CONTACTS_FILE, SEGMENTS_FILE, matchesSegment }; // re-exported: campaigns_backend.js already imports these from here
export const LISTS_FILE = "crm_lists.json";
export const TAGS_FILE = "crm_tags.json";

// Tags/lists/segments counts used to be computed fresh on every single
// Contacts page load -- confirmed live (2026-09-16) as a combined 5-10s of
// the page's load time, every time, regardless of server load otherwise.
// tagCountsSqlite/listCountsSqlite's json_each() over 176k rows' tags_json/
// list_ids_json isn't actually fast at this scale (no index possible on an
// exploded JSON array), and segments/counts has no fast path at all -- a
// full contacts-file read plus every segment's matchesSegment() against
// every contact, from scratch, every time. The real fix is a normalized
// join table (one indexed row per contact-tag pair) instead of exploding
// JSON blobs at query time, which is a schema migration deserving its own
// non-rushed session, not a fix to make live on top of tonight's incident.
// This instead moves the SAME computation off the request path entirely:
// refreshCountsCacheIfDue runs it periodically from the scheduler tick
// (see scheduler.js) and the three endpoints below just read the result,
// so a page load never pays this cost -- staleness of a few minutes is a
// fine tradeoff for a display count like this.
const COUNTS_CACHE_FILE = "crm_counts_cache.json";
const COUNTS_CACHE_TTL_MS = 3 * 60 * 1000;
// contacts.json is ~181MB -- deliberately never mtime-cached by readJson on
// the live server (see auth_backend.js's own comment: holding a parsed copy
// forever is exactly what caused a real OOM crash), so every call streams
// the whole file fresh, no exceptions. This one load is shared across
// everything below that needs it (segments always did; tags/lists only need
// it as a fallback when their SQLite fast path is unavailable; testContactIds
// piggybacks on whichever of those already paid the cost) specifically so a
// single cache refresh never reads this file more than once.
function computeAllCounts() {
  let contacts = null;
  const getContacts = () => contacts || (contacts = readJson(CONTACTS_FILE, []));
  const tags = tagCountsSqlite() || (() => {
    const counts = {};
    for (const c of getContacts()) for (const tagId of c.tags || []) counts[tagId] = (counts[tagId] || 0) + 1;
    return counts;
  })();
  const lists = listCountsSqlite() || (() => {
    const counts = {};
    for (const c of getContacts()) {
      for (const listId of c.listIds || []) {
        const entry = counts[listId] || (counts[listId] = { total: 0, subscribed: 0 });
        entry.total++;
        if (!c.emailOptOut) entry.subscribed++;
      }
    }
    return counts;
  })();
  const segmentList = readJson(SEGMENTS_FILE, []);
  const segments = {};
  for (const s of segmentList) segments[s.id] = 0;
  for (const c of getContacts()) for (const s of segmentList) if (matchesSegment(c, s.filter)) segments[s.id]++;
  // testContact IDs, for reporting_backend.js's excludeTestContacts -- was
  // its own full readJson(CONTACTS_FILE, []) on every single campaign/
  // automation/workflow report request (confirmed live as the dominant cost
  // of the Email Campaigns list page: 8 campaigns on screen fired 8 of these
  // requests, each paying the same ~1.5s full-file stream). Piggybacks on
  // getContacts() here instead -- costs nothing extra since segments above
  // already forces that same read.
  const testContactIds = getContacts().filter(c => c.testContact).map(c => c.id);
  return { tags, lists, segments, testContactIds, computedAt: new Date().toISOString() };
}
// Called from scheduler.js's tick -- cheap staleness check every 30s, only
// pays the real (multi-second) computation cost once every COUNTS_CACHE_TTL_MS.
export function refreshCountsCacheIfDue() {
  const cache = readJson(COUNTS_CACHE_FILE, null);
  if (cache?.computedAt && Date.now() - new Date(cache.computedAt).getTime() < COUNTS_CACHE_TTL_MS) return;
  writeJson(COUNTS_CACHE_FILE, computeAllCounts());
}
// Used by reporting_backend.js's excludeTestContacts -- see its own comment.
export function getCachedTestContactIds() {
  const cache = readJson(COUNTS_CACHE_FILE, null);
  return cache?.testContactIds ?? null; // null (not []) means "no cache yet" -- caller falls back to computing live
}
export const CUSTOM_FIELDS_FILE = "crm_custom_fields.json";

// Denormalized engagement signals so segment evaluation (segments_shared.js's
// evalCondition) never has to scan crm_message_log.json or
// crm_page_visits.json -- both can grow huge in production, and a full-file
// scan against the message log already caused a real outage (see
// message_log.js). Written incrementally, one record at a time, from the
// exact code paths that already handle these events: email_backend.js's SES
// webhook and tracking_backend.js's pageview handler.
export function markContactEmailEngagement(contactId, kind) { // kind: "opened" | "clicked"
  if (!contactId) return;
  const updated = updateJsonArrayRecordByField(CONTACTS_FILE, "id", contactId, c => {
    c.emailEngagement = c.emailEngagement || {};
    c.emailEngagement[kind] = true;
    c.emailEngagement[`${kind}At`] = new Date().toISOString();
    return c;
  });
  // Without this, the SQLite mirror (contacts_idx) silently drifts from
  // the real file the moment an open/click lands -- confirmed live: caught
  // getContactByIdFast (sqlite_inbox.js) returning a stale emailEngagement
  // for a contact that had opened an email minutes earlier. Best-effort,
  // same reasoning as the PATCH /api/contacts/:id handler's own sync call
  // below -- a sync bug here shouldn't block the actual contact save.
  if (updated) { try { syncContactFields(contactId, updated); } catch (e) { console.error("[sqlite_inbox] contact sync failed:", e.message); } }
}
// A hard bounce or spam complaint (SES webhook, see email_backend.js) is
// treated the same as an explicit unsubscribe -- reuses the exact same
// emailOptOut flag sendEmail() already checks before every send, so a
// bounced/complained address stops getting mailed automatically instead of
// only being recorded as a data point nobody acts on. Required for SES
// production access review, and just correct practice regardless --
// repeatedly mailing a bounced address is what damages sender reputation.
export function suppressContactEmail(contactId, reason) { // reason: "bounced" | "complained"
  if (!contactId) return;
  const updated = updateJsonArrayRecordByField(CONTACTS_FILE, "id", contactId, c => {
    c.emailOptOut = true;
    c.emailSuppressedReason = reason;
    c.emailSuppressedAt = new Date().toISOString();
    return c;
  });
  if (updated) { try { syncContactFields(contactId, updated); } catch (e) { console.error("[sqlite_inbox] contact sync failed:", e.message); } }
}
export function markContactVisitedPage(contactId, path) {
  if (!contactId || !path) return;
  const updated = updateJsonArrayRecordByField(CONTACTS_FILE, "id", contactId, c => {
    c.visitedPaths = c.visitedPaths || [];
    if (!c.visitedPaths.includes(path)) c.visitedPaths.push(path);
    return c;
  });
  if (updated) { try { syncContactFields(contactId, updated); } catch (e) { console.error("[sqlite_inbox] contact sync failed:", e.message); } }
}

// Matched by exact name (case-insensitive) -- used by every importer
// (AC tags, Hyros tags, AC lists) so re-running an import never creates a
// second "VIP" tag just because of casing, and a tag/list that already
// exists from manual use in the CRM gets reused instead of duplicated.
export function getOrCreateTag(name) {
  const clean = String(name || "").trim();
  if (!clean) return null;
  const tags = readJson(TAGS_FILE, []);
  let tag = tags.find(t => t.name.toLowerCase() === clean.toLowerCase());
  if (!tag) {
    tag = { id: randomUUID(), name: clean, color: "#009bff", createdAt: new Date().toISOString() };
    tags.push(tag);
    writeJson(TAGS_FILE, tags);
  }
  return tag;
}
// Matched by exact label (case-insensitive) within the same entityType --
// used by the Close importer to map its freeform "custom" application-data
// object (age/height/goals/injuries/etc) onto real CRM custom fields
// without creating a duplicate field on every re-import.
export function getOrCreateCustomField(entityType, label) {
  const clean = String(label || "").trim();
  if (!clean || !["lead", "contact", "opportunity"].includes(entityType)) return null;
  const fields = readJson(CUSTOM_FIELDS_FILE, []);
  let field = fields.find(f => f.entityType === entityType && f.label.toLowerCase() === clean.toLowerCase());
  if (!field) {
    const order = fields.filter(f => f.entityType === entityType).length;
    field = { id: randomUUID(), entityType, label: clean, type: "text", order, createdAt: new Date().toISOString() };
    fields.push(field);
    writeJson(CUSTOM_FIELDS_FILE, fields);
  }
  return field;
}
export function getOrCreateList(name) {
  const clean = String(name || "").trim();
  if (!clean) return null;
  const lists = readJson(LISTS_FILE, []);
  let list = lists.find(l => l.name.toLowerCase() === clean.toLowerCase());
  if (!list) {
    list = { id: randomUUID(), name: clean, createdAt: new Date().toISOString() };
    lists.push(list);
    writeJson(LISTS_FILE, lists);
  }
  return list;
}

// Lazy one-time migration: older list/segment records predate the manual
// sort-order feature and have no .order field. Stamp one in from current
// array position (first load only -- the write is skipped once every record
// already has an order) so manual mode has something to sort by immediately
// instead of every existing row colliding at order 0.
function backfillOrder(items, file) {
  if (items.every(it => typeof it.order === "number")) return items;
  items.forEach((it, i) => { if (typeof it.order !== "number") it.order = i; });
  writeJson(file, items);
  return items;
}
export function getOrderedLists() { return backfillOrder(readJson(LISTS_FILE, []), LISTS_FILE); }
export function getOrderedSegments() { return backfillOrder(readJson(SEGMENTS_FILE, []), SEGMENTS_FILE); }

// No sensitive fields to strip; attaches the (computed, never stored) renewal alert for an ENROLLED
// student near their END DATE. A shallow copy only when there's an alert, so cached records are never mutated.
function publicContact(c) { const renewal = renewalForContact(c); return renewal ? { ...c, renewal } : c; }

export function newContactRecord({ type, accountName, first, last, email, phone, status, tags, listIds, customFields, source, ownerId }) {
  return {
    id: randomUUID(),
    type: type === "lead" ? "lead" : "contact",
    accountName: accountName || "",
    first: first || "", last: last || "", email: (email || "").toLowerCase(), phone: phone || "",
    status: status || "",
    tags: Array.isArray(tags) ? tags : [],
    listIds: Array.isArray(listIds) ? listIds : [],
    customFields: customFields || {},
    source: source || "manual",
    ownerId: ownerId || null,
    emailOptOut: false, smsOptOut: false, testContact: false,
    externalIds: { acContactId: null, closeLeadId: null },
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
}

export async function handleContactsRequest(req, res, url) {
  const p = url.pathname;
  const me = getSessionUser(req);

  // Every /api/contacts*, /api/lists*, /api/tags*, /api/segments*,
  // /api/custom-fields* route requires a logged-in user — this is an
  // internal team tool, no anonymous or public-read surface.
  const owned = p.startsWith("/api/contacts") || p.startsWith("/api/lists") ||
    p.startsWith("/api/tags") || p.startsWith("/api/segments") || p.startsWith("/api/custom-fields");
  if (!owned) return false;
  if (!me) return sendJson(res, 401, { error: "Not logged in" });

  // One-time data-fix, meant to be triggered once (from an already-logged-
  // in admin's own browser tab) and then deleted. The status "BAD FIT /
  // BLACKLIST" is a stale label left over from before this status got
  // renamed back to plain "BLACKLIST" -- the rename never cascaded to
  // contacts that already held the old label. Runs inside this
  // already-running server process (same as any normal PATCH) rather than
  // a separate one-off script, since a separate script sharing this
  // container kept crashing it. Idempotent -- safe to hit more than once,
  // becomes a no-op once nothing matches the old label.
  if (p === "/api/contacts/admin/fix-blacklist-status" && req.method === "GET") {
    if (!isAdmin(me)) return sendJson(res, 403, { error: "Admins only" });
    const contacts = readJson(CONTACTS_FILE, []);
    const affected = contacts.filter(c => c.status === "BAD FIT / BLACKLIST");
    for (const c of affected) { c.status = "BLACKLIST"; c.updatedAt = new Date().toISOString(); }
    if (affected.length) writeJson(CONTACTS_FILE, contacts);
    let synced = 0;
    for (const c of affected) { try { syncContactFields(c.id, c); synced++; } catch {} }
    return sendJson(res, 200, { ok: true, updated: affected.length, synced });
  }

  // Bulk delete from the Contacts page's selection bar. One in-place pass over
  // the contacts file (updateJsonArrayRecordsByIds, updater -> null drops the
  // record) rather than the single DELETE below's read-filter-write, which
  // re-stringifies the whole ~190MB file and races with in-place patches from
  // webhooks. The byte pre-check costs two indexOf per id per record, so the
  // batch is capped -- the client sends larger selections in chunks.
  if (p === "/api/contacts/bulk-delete" && req.method === "POST") {
    const { ids } = await readJsonBody(req);
    if (!Array.isArray(ids) || !ids.length) return sendJson(res, 400, { error: "ids is required" });
    const unique = [...new Set(ids)];
    if (unique.some(id => typeof id !== "string" || !/^[\w-]{1,64}$/.test(id))) return sendJson(res, 400, { error: "invalid contact id" });
    if (unique.length > 100) return sendJson(res, 400, { error: "Delete at most 100 contacts per request" });
    const deleted = [];
    updateJsonArrayRecordsByIds(CONTACTS_FILE, unique, c => { deleted.push(c.id); return null; });
    // Same orphan cleanup as the single DELETE below.
    for (const id of deleted) {
      removeConversationSummary(id);
      deleteContactMessageFile(id);
      try { deleteContactIndex(id); } catch (e) { console.error("[sqlite_inbox] contact index delete failed:", e.message); }
    }
    return sendJson(res, 200, { ok: true, deleted: deleted.length, requested: unique.length });
  }

  // ── Contacts ─────────────────────────────────────────────────────────
  if (p === "/api/contacts" && req.method === "GET") {
    const q = (url.searchParams.get("q") || "").trim().toLowerCase();
    const status = url.searchParams.get("status");
    const tag = url.searchParams.get("tag");
    const listId = url.searchParams.get("listId");
    const type = url.searchParams.get("type");
    const emailOptOutParam = url.searchParams.get("emailOptOut");
    const filterParam = url.searchParams.get("filter");
    let advancedFilter = null;
    if (filterParam) {
      try { advancedFilter = JSON.parse(filterParam); }
      catch { return sendJson(res, 400, { error: "filter must be valid JSON" }); }
    }
    const sortField = url.searchParams.get("sort");
    const sortDir = url.searchParams.get("dir") === "desc" ? "desc" : "asc";
    const limitParam = url.searchParams.get("limit");
    const limit = limitParam ? Math.max(1, parseInt(limitParam, 10) || 50) : null;
    const offset = Math.max(0, parseInt(url.searchParams.get("offset"), 10) || 0);

    // Fast path: contacts_idx (sqlite_inbox.js) instead of a full
    // readJson(CONTACTS_FILE, []) -- a ~190MB JSON.parse -- on every single
    // request, confirmed live as the dominant cost of the Contacts page's
    // 10+s load. Deliberately NOT used for advancedFilter (matchesSegment's
    // condition language covers customFields.*/visitedPage/relative-time
    // operators that aren't columns in that table) -- this app already had
    // one production outage from a "clever" fast path on this exact
    // endpoint (see the streamJsonArrayFiltered revert this replaced), so
    // the one case that doesn't cleanly map to SQL just keeps using the
    // known-safe full read instead of forcing it.
    if (!advancedFilter && url.searchParams.get("_sqlite") !== "0" && sqliteInboxAvailable()) {
      const emailOptOut = emailOptOutParam !== null ? emailOptOutParam === "true" : null;
      const fast = queryContactsSqlite({ q, status, tag, listId, type, emailOptOut, sortField, sortDir, limit, offset });
      if (fast) return sendJson(res, 200, { contacts: fast.contacts.map(publicContact), total: fast.total });
    }

    // REVERTED to plain readJson+filter (2026-09-01): the streamJsonArrayFiltered
    // version made the app hang in production (whole server unresponsive) --
    // likely a real bug in the byte-scan against crm_contacts.json's actual
    // production data, not reproduced against the small local dataset this
    // was tested against before shipping. Back to the known-safe (if slower)
    // approach until that's root-caused properly, not under live-incident
    // pressure. See git history around this date for the attempted fix and
    // its revert. Still the only path for advancedFilter, and the fallback
    // if the sqlite index isn't available for some reason.
    const contacts = readJson(CONTACTS_FILE, []);
    let filtered = contacts;
    if (q) filtered = filtered.filter(c =>
      `${c.first} ${c.last}`.toLowerCase().includes(q) ||
      (c.email || "").toLowerCase().includes(q) ||
      (c.accountName || "").toLowerCase().includes(q)
    );
    if (status) filtered = filtered.filter(c => c.status === status);
    // (c.tags || [])/(c.listIds || []) -- confirmed live one contact with
    // listIds === undefined (not just empty) threw uncaught here, which
    // left that request hanging forever (an unhandled rejection inside
    // this handler never calls sendJson, so the response is never sent).
    if (tag) filtered = filtered.filter(c => (c.tags || []).includes(tag));
    if (listId) filtered = filtered.filter(c => (c.listIds || []).includes(listId));
    if (type) filtered = filtered.filter(c => c.type === type);
    if (emailOptOutParam !== null) { const want = emailOptOutParam === "true"; filtered = filtered.filter(c => !!c.emailOptOut === want); }
    if (advancedFilter) filtered = filtered.filter(c => matchesSegment(c, advancedFilter));
    const total = filtered.length;
    // Sort/paginate are both opt-in via query params -- other callers
    // (inbox.html, workflow-detail.html, reporting.html) fetch this same
    // endpoint with no params at all and expect the full unsorted list back,
    // so omitting either param must behave exactly as before.
    if (sortField) {
      const dirNum = sortDir === "desc" ? -1 : 1;
      filtered = [...filtered].sort((a, b) => {
        let av, bv;
        if (sortField === "createdAt") { av = a.firstSeenAt || a.createdAt || ""; bv = b.firstSeenAt || b.createdAt || ""; }
        else { av = (a[sortField] || "").toString().toLowerCase(); bv = (b[sortField] || "").toString().toLowerCase(); }
        return av < bv ? -dirNum : av > bv ? dirNum : 0;
      });
    }
    let page = filtered;
    if (limit !== null) page = filtered.slice(offset, offset + limit);
    return sendJson(res, 200, { contacts: page.map(publicContact), total });
  }
  if (p === "/api/contacts" && req.method === "POST") {
    const body = await readJsonBody(req);
    if (!body.first || !body.last) return sendJson(res, 400, { error: "first and last are required" });
    // Still a full read -- dedup-by-email/phone genuinely needs to check
    // every existing contact, no way around that without a dedicated
    // index. The WRITE side is what used to cost the same ~190MB
    // stringify+rewrite as PATCH did before that got fixed (see PATCH's
    // own comment below) -- creating one new contact doesn't need the
    // other 176k rewritten just to append/patch one, so this now uses the
    // same streaming append/in-place-patch primitives PATCH already does.
    const contacts = readJson(CONTACTS_FILE, []);
    // Same "email or phone already means the same person" rule every other
    // creation path in this app follows (forms, bookings, imports) --
    // manual "+ Add Contact" was the one place that didn't, so typing in an
    // email/phone that already belonged to someone silently created a
    // second record instead of updating the one that already exists.
    let record = findContactMatch(contacts, body.email, body.phone);
    if (record) {
      const contactId = record.id;
      record = updateJsonArrayRecordByField(CONTACTS_FILE, "id", contactId, (contact) => {
        for (const k of ["first", "last", "accountName", "status"]) if (body[k]) contact[k] = body[k];
        if (body.email) contact.email = String(body.email).toLowerCase();
        if (body.phone) contact.phone = body.phone;
        contact.customFields = { ...contact.customFields, ...(body.customFields || {}) };
        contact.updatedAt = new Date().toISOString();
        return contact;
      });
      try { syncContactFields(record.id, record); } catch (e) { console.error("[sqlite_inbox] contact sync failed:", e.message); }
    } else {
      record = newContactRecord(body);
      appendJsonRecordFast(CONTACTS_FILE, record);
      try { syncContactFields(record.id, record); } catch (e) { console.error("[sqlite_inbox] contact sync failed:", e.message); }
    }
    record.listIds.forEach(listId => { fireTrigger("list_subscribe", { contactId: record.id, listId }); fireWorkflowTrigger("list_subscribe", { contactId: record.id, listId }); });
    record.tags.forEach(tagId => { fireTrigger("tag_added", { contactId: record.id, tagId }); fireWorkflowTrigger("tag_added", { contactId: record.id, tagId }); });
    return sendJson(res, 200, { ok: true, contact: record });
  }
  const contactMatch = p.match(/^\/api\/contacts\/([^/]+)$/);
  if (contactMatch) {
    // PATCH used to share the GET/DELETE branches' full readJson(CONTACTS_FILE)
    // + writeJson(CONTACTS_FILE, contacts) -- fine when this file was small,
    // but at production scale (176k+ contacts, ~190MB) that's a full
    // stringify+rewrite of the ENTIRE file on every single status/type/
    // assignment change, which is what made those feel slow to save. Same
    // streaming byte-level patch already used elsewhere in this file
    // (markContactEmailEngagement/markContactVisitedPage above) -- finds
    // and rewrites just the one matching record instead of the whole array.
    if (req.method === "PATCH") {
      const body = await readJsonBody(req);
      // Assigning who owns a contact is admin-only -- everything else on
      // this shared PATCH endpoint (status changes, tags, etc.) stays open
      // to any staff member who can already reach it.
      if ("ownerId" in body && !isAdmin(me)) return sendJson(res, 403, { error: "Only admins can change contact assignment" });
      const allowed = ["type", "programType", "accountName", "first", "last", "email", "phone", "status", "tags", "listIds", "customFields", "ownerId", "emailOptOut", "smsOptOut", "testContact"];
      let prevListIds, prevTags, prevStatus;
      const updated = updateJsonArrayRecordByField(CONTACTS_FILE, "id", contactMatch[1], (contact) => {
        prevListIds = [...contact.listIds]; prevTags = [...contact.tags]; prevStatus = contact.status;
        for (const k of allowed) if (k in body) contact[k] = body[k];
        if (contact.status !== prevStatus) applyStatusOptOut(contact);
        contact.updatedAt = new Date().toISOString();
        return contact;
      });
      if (!updated) return sendJson(res, 404, { error: "Contact not found" });
      // A status change (BLACKLIST especially) previously left no trace of
      // WHEN it happened or who did it -- confirmed live: the only way to
      // even guess was contact.updatedAt, which isn't reliable (any other
      // field on the same PATCH bumps it too). Logged the same way a form
      // submission or booking is, so it shows up right in the thread.
      if (updated.status !== prevStatus) {
        logMessage({
          channel: "activity", direction: "inbound", contactId: updated.id,
          sourceType: "status_change", sourceId: null,
          subject: `Status changed: ${prevStatus || "(none)"} → ${updated.status || "(none)"}`,
          body: `Changed by ${me?.first ? `${me.first} ${me.last || ""}`.trim() : (me?.email || "system")}`,
          bodyPreview: `${prevStatus || "(none)"} → ${updated.status || "(none)"}`,
          status: "received",
        });
      }
      // Best-effort, same reasoning as message_index.js's safeSqliteSync --
      // a sync bug here shouldn't block the actual contact save.
      try { syncContactFields(updated.id, updated); } catch (e) { console.error("[sqlite_inbox] contact sync failed:", e.message); }
      // Only fire for genuinely NEW list/tag membership, not every patch --
      // an automation shouldn't re-enroll someone just because their email
      // was edited.
      updated.listIds.filter(id => !prevListIds.includes(id)).forEach(listId => { fireTrigger("list_subscribe", { contactId: updated.id, listId }); fireWorkflowTrigger("list_subscribe", { contactId: updated.id, listId }); });
      updated.tags.filter(id => !prevTags.includes(id)).forEach(tagId => { fireTrigger("tag_added", { contactId: updated.id, tagId }); fireWorkflowTrigger("tag_added", { contactId: updated.id, tagId }); });
      if (updated.status !== prevStatus) { checkConversionGoal("lead_status_change", updated.id); checkAutomationGoal("lead_status_change", updated.id, updated.status); }
      return sendJson(res, 200, { ok: true, contact: publicContact(updated) });
    }
    if (req.method === "GET") {
      // Fast path: an indexed lookup instead of a full readJson(CONTACTS_FILE,
      // []).find(...) linear scan over ~190MB -- confirmed live as the
      // dominant cost of contact-detail.html's ~5s load. Falls back to the
      // full read if the index isn't available yet (sqlite missing) or
      // hasn't caught up for this specific id (shouldn't normally happen --
      // every create/update path syncs synchronously -- but never trust a
      // best-effort cache to be the only source of truth).
      const fast = getContactByIdSqlite(contactMatch[1]);
      if (fast !== null && fast !== undefined) return sendJson(res, 200, { contact: publicContact(fast) });
      const contacts = readJson(CONTACTS_FILE, []);
      const contact = contacts.find(c => c.id === contactMatch[1]);
      if (!contact) return sendJson(res, 404, { error: "Contact not found" });
      return sendJson(res, 200, { contact: publicContact(contact) });
    }
    if (req.method === "DELETE") {
      const contacts = readJson(CONTACTS_FILE, []);
      const contact = contacts.find(c => c.id === contactMatch[1]);
      if (!contact) return sendJson(res, 404, { error: "Contact not found" });
      writeJson(CONTACTS_FILE, contacts.filter(c => c.id !== contactMatch[1]));
      // Deleting the contact record alone left its conversation summary
      // (crm_conversation_index.json + the SQLite sidebar snapshot) and per-
      // contact message file behind as orphans -- confirmed live: a deleted
      // test contact kept showing up in the Inbox sidebar indefinitely,
      // complete with a stuck unread badge nothing could ever clear, since
      // there was no longer a real contact or messages behind it for any
      // mark-done/recompute path to reconcile against. Same reasoning now
      // applies to the Contacts-page index -- without deleteContactIndex, a
      // deleted contact would keep showing up there too.
      removeConversationSummary(contactMatch[1]);
      deleteContactMessageFile(contactMatch[1]);
      try { deleteContactIndex(contactMatch[1]); } catch (e) { console.error("[sqlite_inbox] contact index delete failed:", e.message); }
      return sendJson(res, 200, { ok: true });
    }
  }

  // ── Lists ────────────────────────────────────────────────────────────
  if (p === "/api/lists" && req.method === "GET") {
    return sendJson(res, 200, { lists: getOrderedLists() });
  }
  if (p === "/api/lists" && req.method === "POST") {
    const { name } = await readJsonBody(req);
    if (!name) return sendJson(res, 400, { error: "name is required" });
    const lists = readJson(LISTS_FILE, []);
    const list = { id: randomUUID(), name, order: lists.length, createdAt: new Date().toISOString() };
    lists.push(list);
    writeJson(LISTS_FILE, lists);
    return sendJson(res, 200, { ok: true, list });
  }
  // Manual drag-to-reorder: client sends the full ordered id list, we just
  // stamp each record's .order to its new index. Must come before the
  // generic /api/lists/:id routes below or "reorder" gets swallowed as an id.
  if (p === "/api/lists/reorder" && req.method === "POST") {
    const { orderedIds } = await readJsonBody(req);
    if (!Array.isArray(orderedIds)) return sendJson(res, 400, { error: "orderedIds is required" });
    const lists = readJson(LISTS_FILE, []);
    const indexById = new Map(orderedIds.map((id, i) => [id, i]));
    lists.forEach(l => { if (indexById.has(l.id)) l.order = indexById.get(l.id); });
    writeJson(LISTS_FILE, lists);
    return sendJson(res, 200, { ok: true });
  }
  // Bulk delete -- ONE contacts-file pass for however many list ids are
  // selected, not one per id. Confirmed live (2026-09-01) that selecting a
  // large batch and deleting one-at-a-time (via Promise.all over the
  // single-delete route below) fired that many CONCURRENT full rewrites of
  // a 180MB+ contacts file, exhausted the disk, and froze the whole
  // single-threaded server for everyone -- exactly the failure mode
  // message_log.js's own comments already document from a prior incident.
  // removeValuesFromArrayField also fixes a second, subtler cost the fix
  // above didn't: even one combined pass via readJson+forEach+writeJson
  // still fully parsed AND re-stringified all 176k+ contacts just to touch
  // the handful that actually referenced the deleted id(s) -- confirmed
  // live to still take long enough to visibly block the server. This
  // byte-scans instead, only parsing/rewriting records that could actually
  // match; everything else is copied byte-for-byte, never parsed.
  if (p === "/api/lists/bulk-delete" && req.method === "POST") {
    const { ids } = await readJsonBody(req);
    if (!Array.isArray(ids) || !ids.length) return sendJson(res, 400, { error: "ids is required" });
    const idSet = new Set(ids);
    const lists = readJson(LISTS_FILE, []);
    writeJson(LISTS_FILE, lists.filter(l => !idSet.has(l.id)));
    removeValuesFromArrayField(CONTACTS_FILE, "listIds", ids);
    return sendJson(res, 200, { ok: true });
  }
  // Same one-pass bulk-count fix as /api/tags/counts below, extended to
  // lists -- the Contacts page fired 2 requests (total + subscribed) PER
  // LIST via the old per-row `/api/contacts?listId=X&limit=1` pattern.
  // renderManagedList's own comment assumed "only a handful of lists,
  // nowhere near [tags'] scale" -- true in raw request count, but with 8+
  // lists that's still 16+ real network round trips blocking the page's
  // init() sequence (loadContacts() waits on loadLists() finishing) before
  // the actual contacts table could even start loading. Confirmed via real
  // browser network timing (not just server-side request timing, which was
  // fast in isolation) as the actual cause of the reported 5+ second load.
  if (p === "/api/lists/counts" && req.method === "GET") {
    // Served from the periodic cache (see refreshCountsCacheIfDue above) --
    // falls back to computing live only on a cold start, before the
    // scheduler's first tick has populated it yet.
    const cached = readJson(COUNTS_CACHE_FILE, null);
    if (cached?.lists) return sendJson(res, 200, { counts: cached.lists });
    const fast = listCountsSqlite();
    if (fast) return sendJson(res, 200, { counts: fast });
    const contacts = readJson(CONTACTS_FILE, []);
    const counts = {};
    for (const c of contacts) {
      for (const listId of c.listIds || []) {
        const entry = counts[listId] || (counts[listId] = { total: 0, subscribed: 0 });
        entry.total++;
        if (!c.emailOptOut) entry.subscribed++;
      }
    }
    return sendJson(res, 200, { counts });
  }
  const listMatch = p.match(/^\/api\/lists\/([^/]+)$/);
  if (listMatch && req.method === "DELETE") {
    const lists = readJson(LISTS_FILE, []);
    writeJson(LISTS_FILE, lists.filter(l => l.id !== listMatch[1]));
    // Deleting the list record alone left every contact that had it holding
    // a dead id in listIds forever (nothing else in the app ever reads a
    // list's own record to know it's gone).
    removeValuesFromArrayField(CONTACTS_FILE, "listIds", [listMatch[1]]);
    return sendJson(res, 200, { ok: true });
  }
  // Removes just this one contact's membership (not the whole list) --
  // single-record update via updateJsonArrayRecordByField, not a full-table
  // rewrite, since this fires from a per-row "x" in the membership panel.
  const listContactMatch = p.match(/^\/api\/lists\/([^/]+)\/contacts\/([^/]+)$/);
  if (listContactMatch && req.method === "DELETE") {
    const [, listId, contactId] = listContactMatch;
    const found = updateJsonArrayRecordByField(CONTACTS_FILE, "id", contactId, c => {
      c.listIds = (c.listIds || []).filter(id => id !== listId);
      c.updatedAt = new Date().toISOString();
      return c;
    });
    if (!found) return sendJson(res, 404, { error: "Contact not found" });
    return sendJson(res, 200, { ok: true });
  }

  // ── Tags ─────────────────────────────────────────────────────────────
  if (p === "/api/tags" && req.method === "GET") {
    return sendJson(res, 200, { tags: readJson(TAGS_FILE, []) });
  }
  // One pass over every contact, one count per tag -- replaces the
  // Contacts page's old per-tag `GET /api/contacts?tag=X&limit=1`, fired
  // once per tag (3500+ of them in production) to paint the Tags panel's
  // counts. Each of those repeated its OWN full 176K-contact filter;
  // confirmed live as the actual cause of the Contacts tab's 10+ second
  // load (not related to tonight's other changes despite the timing --
  // this N+1 pattern predates them). One read + one loop here does the
  // exact same total work in a single pass instead of 3500+ of them.
  if (p === "/api/tags/counts" && req.method === "GET") {
    // Served from the periodic cache -- see /api/lists/counts above and
    // refreshCountsCacheIfDue's comment for why.
    const cached = readJson(COUNTS_CACHE_FILE, null);
    if (cached?.tags) return sendJson(res, 200, { counts: cached.tags });
    const fast = tagCountsSqlite();
    if (fast) return sendJson(res, 200, { counts: fast });
    const contacts = readJson(CONTACTS_FILE, []);
    const counts = {};
    for (const c of contacts) for (const tagId of c.tags || []) counts[tagId] = (counts[tagId] || 0) + 1;
    return sendJson(res, 200, { counts });
  }
  if (p === "/api/tags" && req.method === "POST") {
    const { name, color } = await readJsonBody(req);
    if (!name) return sendJson(res, 400, { error: "name is required" });
    const tags = readJson(TAGS_FILE, []);
    const tag = { id: randomUUID(), name, color: color || "#009bff", createdAt: new Date().toISOString() };
    tags.push(tag);
    writeJson(TAGS_FILE, tags);
    return sendJson(res, 200, { ok: true, tag });
  }
  // Same single-pass, byte-scanned consolidation as the lists bulk-delete above.
  if (p === "/api/tags/bulk-delete" && req.method === "POST") {
    const { ids } = await readJsonBody(req);
    if (!Array.isArray(ids) || !ids.length) return sendJson(res, 400, { error: "ids is required" });
    const idSet = new Set(ids);
    const tags = readJson(TAGS_FILE, []);
    writeJson(TAGS_FILE, tags.filter(t => !idSet.has(t.id)));
    removeValuesFromArrayField(CONTACTS_FILE, "tags", ids);
    return sendJson(res, 200, { ok: true });
  }
  const tagMatch = p.match(/^\/api\/tags\/([^/]+)$/);
  if (tagMatch && req.method === "DELETE") {
    const tags = readJson(TAGS_FILE, []);
    writeJson(TAGS_FILE, tags.filter(t => t.id !== tagMatch[1]));
    // Same orphaned-id cleanup as list deletion above.
    removeValuesFromArrayField(CONTACTS_FILE, "tags", [tagMatch[1]]);
    return sendJson(res, 200, { ok: true });
  }
  const tagContactMatch = p.match(/^\/api\/tags\/([^/]+)\/contacts\/([^/]+)$/);
  if (tagContactMatch && req.method === "DELETE") {
    const [, tagId, contactId] = tagContactMatch;
    const found = updateJsonArrayRecordByField(CONTACTS_FILE, "id", contactId, c => {
      c.tags = (c.tags || []).filter(id => id !== tagId);
      c.updatedAt = new Date().toISOString();
      return c;
    });
    if (!found) return sendJson(res, 404, { error: "Contact not found" });
    return sendJson(res, 200, { ok: true });
  }

  // ── Segments (saved filters, evaluated live — no materialized membership) ─
  if (p === "/api/segments" && req.method === "GET") {
    return sendJson(res, 200, { segments: getOrderedSegments() });
  }
  if (p === "/api/segments" && req.method === "POST") {
    const { name, filter, channel } = await readJsonBody(req);
    if (!name || !filter) return sendJson(res, 400, { error: "name and filter are required" });
    if (channel && !["email", "sms"].includes(channel)) return sendJson(res, 400, { error: "channel must be 'email' or 'sms'" });
    const segments = readJson(SEGMENTS_FILE, []);
    const segment = { id: randomUUID(), name, filter, channel: channel || "email", order: segments.length, createdAt: new Date().toISOString() };
    segments.push(segment);
    writeJson(SEGMENTS_FILE, segments);
    return sendJson(res, 200, { ok: true, segment });
  }
  // Same manual-reorder pattern as /api/lists/reorder above.
  if (p === "/api/segments/reorder" && req.method === "POST") {
    const { orderedIds } = await readJsonBody(req);
    if (!Array.isArray(orderedIds)) return sendJson(res, 400, { error: "orderedIds is required" });
    const segments = readJson(SEGMENTS_FILE, []);
    const indexById = new Map(orderedIds.map((id, i) => [id, i]));
    segments.forEach(s => { if (indexById.has(s.id)) s.order = indexById.get(s.id); });
    writeJson(SEGMENTS_FILE, segments);
    return sendJson(res, 200, { ok: true });
  }
  // No contacts file involved (segments have no stored membership), but
  // still one write instead of N for consistency with lists/tags.
  if (p === "/api/segments/bulk-delete" && req.method === "POST") {
    const { ids } = await readJsonBody(req);
    if (!Array.isArray(ids) || !ids.length) return sendJson(res, 400, { error: "ids is required" });
    const idSet = new Set(ids);
    const segments = readJson(SEGMENTS_FILE, []);
    writeJson(SEGMENTS_FILE, segments.filter(s => !idSet.has(s.id)));
    return sendJson(res, 200, { ok: true });
  }
  // Same one-pass bulk-count fix as /api/lists/counts above -- each segment
  // used to get its own full-array `/api/contacts?filter=...&limit=1`
  // round trip; this evaluates every segment's filter against every
  // contact in one read instead, same total matchesSegment() calls, one
  // network round trip instead of N.
  if (p === "/api/segments/counts" && req.method === "GET") {
    // Served from the periodic cache -- see /api/lists/counts above and
    // refreshCountsCacheIfDue's comment for why. This one had no fast path
    // at all before (a full contacts-file read plus every segment's
    // matchesSegment() against every contact, from scratch, every load).
    const cached = readJson(COUNTS_CACHE_FILE, null);
    if (cached?.segments) return sendJson(res, 200, { counts: cached.segments });
    const segments = readJson(SEGMENTS_FILE, []);
    const contacts = readJson(CONTACTS_FILE, []);
    const counts = {};
    for (const s of segments) counts[s.id] = 0;
    for (const c of contacts) for (const s of segments) if (matchesSegment(c, s.filter)) counts[s.id]++;
    return sendJson(res, 200, { counts });
  }
  const segmentMatch = p.match(/^\/api\/segments\/([^/]+)$/);
  if (segmentMatch && req.method === "DELETE") {
    const segments = readJson(SEGMENTS_FILE, []);
    writeJson(SEGMENTS_FILE, segments.filter(s => s.id !== segmentMatch[1]));
    return sendJson(res, 200, { ok: true });
  }
  // Edit a saved segment: any of name / filter / channel. Counts aren't
  // recomputed here (a full contacts scan) -- the Contacts page fetches the
  // edited segment's fresh count itself, and the periodic counts cache
  // catches up within a few minutes.
  if (segmentMatch && req.method === "PATCH") {
    const body = await readJsonBody(req);
    const segments = readJson(SEGMENTS_FILE, []);
    const segment = segments.find(s => s.id === segmentMatch[1]);
    if (!segment) return sendJson(res, 404, { error: "Segment not found" });
    if ("name" in body) {
      const name = String(body.name || "").trim();
      if (!name) return sendJson(res, 400, { error: "name can't be empty" });
      segment.name = name;
    }
    if ("filter" in body) {
      const f = body.filter;
      const conds = f && (Array.isArray(f.all) ? f.all : Array.isArray(f.any) ? f.any : null);
      if (!conds || !conds.length || conds.some(c => !c || typeof c.field !== "string" || typeof c.op !== "string")) {
        return sendJson(res, 400, { error: "filter must be { all: [...] } or { any: [...] } with at least one { field, op, value } condition" });
      }
      segment.filter = Array.isArray(f.all) ? { all: f.all } : { any: f.any };
    }
    if ("channel" in body) {
      if (!["email", "sms"].includes(body.channel)) return sendJson(res, 400, { error: "channel must be 'email' or 'sms'" });
      segment.channel = body.channel;
    }
    segment.updatedAt = new Date().toISOString();
    writeJson(SEGMENTS_FILE, segments);
    return sendJson(res, 200, { ok: true, segment });
  }
  const segmentContactsMatch = p.match(/^\/api\/segments\/([^/]+)\/contacts$/);
  if (segmentContactsMatch && req.method === "GET") {
    const segments = readJson(SEGMENTS_FILE, []);
    const segment = segments.find(s => s.id === segmentContactsMatch[1]);
    if (!segment) return sendJson(res, 404, { error: "Segment not found" });
    const contacts = readJson(CONTACTS_FILE, []).filter(c => matchesSegment(c, segment.filter));
    return sendJson(res, 200, { contacts, total: contacts.length });
  }

  // ── Custom fields ────────────────────────────────────────────────────
  // entityType still exists on each record (import_backend.js's Close merge
  // can create "lead"-typed fields, following the underlying contact's own
  // .type) but nothing actually DISPLAYS those anywhere -- contact-detail.html
  // and every other consumer only ever fetch entityType=contact. So the admin
  // UI (settings.html) manages contact fields only; existing lead/opportunity
  // field definitions are left alone in the data, just no longer exposed
  // through this UI (already effectively true before this, since they were
  // never shown anywhere else either).
  if (p === "/api/custom-fields" && req.method === "GET") {
    const entityType = url.searchParams.get("entityType");
    let fields = readJson(CUSTOM_FIELDS_FILE, []);
    if (entityType) fields = fields.filter(f => f.entityType === entityType);
    return sendJson(res, 200, { fields: fields.slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0)) });
  }
  if (p === "/api/custom-fields" && req.method === "POST") {
    const { label } = await readJsonBody(req);
    if (!label) return sendJson(res, 400, { error: "label is required" });
    const fields = readJson(CUSTOM_FIELDS_FILE, []);
    const order = fields.filter(f => f.entityType === "contact").length;
    const field = { id: randomUUID(), entityType: "contact", label, type: "text", order, createdAt: new Date().toISOString() };
    fields.push(field);
    writeJson(CUSTOM_FIELDS_FILE, fields);
    return sendJson(res, 200, { ok: true, field });
  }
  if (p === "/api/custom-fields/reorder" && req.method === "POST") {
    const { orderedIds } = await readJsonBody(req);
    if (!Array.isArray(orderedIds)) return sendJson(res, 400, { error: "orderedIds must be an array" });
    const fields = readJson(CUSTOM_FIELDS_FILE, []);
    orderedIds.forEach((id, i) => {
      const f = fields.find(x => x.id === id);
      if (f) f.order = i;
    });
    writeJson(CUSTOM_FIELDS_FILE, fields);
    return sendJson(res, 200, { ok: true });
  }
  const fieldMatch = p.match(/^\/api\/custom-fields\/([^/]+)$/);
  if (fieldMatch && req.method === "DELETE") {
    const fields = readJson(CUSTOM_FIELDS_FILE, []);
    writeJson(CUSTOM_FIELDS_FILE, fields.filter(f => f.id !== fieldMatch[1]));
    return sendJson(res, 200, { ok: true });
  }

  return false;
}
