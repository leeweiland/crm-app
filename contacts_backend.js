import { randomUUID } from "crypto";
import { readJson, writeJson, readJsonBody, sendJson, getSessionUser, updateJsonArrayRecordByField, isAdmin } from "./auth_backend.js";
import { syncContactFields } from "./sqlite_inbox.js";
import { CONTACTS_FILE, SEGMENTS_FILE, matchesSegment, findContactMatch } from "./segments_shared.js";
import { fireTrigger, checkAutomationGoal } from "./automations_backend.js";
import { fireWorkflowTrigger, checkConversionGoal } from "./workflows_backend.js";
import { applyStatusOptOut } from "./compliance_backend.js";

export { CONTACTS_FILE, SEGMENTS_FILE, matchesSegment }; // re-exported: campaigns_backend.js already imports these from here
export const LISTS_FILE = "crm_lists.json";
export const TAGS_FILE = "crm_tags.json";
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
  updateJsonArrayRecordByField(CONTACTS_FILE, "id", contactId, c => {
    c.emailEngagement = c.emailEngagement || {};
    c.emailEngagement[kind] = true;
    c.emailEngagement[`${kind}At`] = new Date().toISOString();
    return c;
  });
}
export function markContactVisitedPage(contactId, path) {
  if (!contactId || !path) return;
  updateJsonArrayRecordByField(CONTACTS_FILE, "id", contactId, c => {
    c.visitedPaths = c.visitedPaths || [];
    if (!c.visitedPaths.includes(path)) c.visitedPaths.push(path);
    return c;
  });
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

function publicContact(c) { return c; } // no sensitive fields to strip yet — placeholder for parity with auth's publicUser

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
    emailOptOut: false, smsOptOut: false,
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

  // ── Contacts ─────────────────────────────────────────────────────────
  if (p === "/api/contacts" && req.method === "GET") {
    const contacts = readJson(CONTACTS_FILE, []);
    const q = (url.searchParams.get("q") || "").trim().toLowerCase();
    const status = url.searchParams.get("status");
    const tag = url.searchParams.get("tag");
    const listId = url.searchParams.get("listId");
    const type = url.searchParams.get("type");
    const filterParam = url.searchParams.get("filter");
    let filtered = contacts;
    if (q) filtered = filtered.filter(c =>
      `${c.first} ${c.last}`.toLowerCase().includes(q) ||
      (c.email || "").toLowerCase().includes(q) ||
      (c.accountName || "").toLowerCase().includes(q)
    );
    if (status) filtered = filtered.filter(c => c.status === status);
    if (tag) filtered = filtered.filter(c => c.tags.includes(tag));
    if (listId) filtered = filtered.filter(c => c.listIds.includes(listId));
    if (type) filtered = filtered.filter(c => c.type === type);
    // Advanced multi-condition filter (same {all:[...]}/{any:[...]} shape
    // segments save) -- lets the Contacts filter builder preview results
    // live before a user commits to saving it as a segment.
    if (filterParam) {
      try { const filter = JSON.parse(filterParam); filtered = filtered.filter(c => matchesSegment(c, filter)); }
      catch { return sendJson(res, 400, { error: "filter must be valid JSON" }); }
    }
    const total = filtered.length;
    // Sort/paginate are both opt-in via query params -- other callers
    // (inbox.html, workflow-detail.html, reporting.html) fetch this same
    // endpoint with no params at all and expect the full unsorted list back,
    // so omitting either param must behave exactly as before.
    const sortField = url.searchParams.get("sort");
    if (sortField) {
      const sortDir = url.searchParams.get("dir") === "desc" ? -1 : 1;
      filtered = [...filtered].sort((a, b) => {
        let av, bv;
        if (sortField === "createdAt") { av = a.firstSeenAt || a.createdAt || ""; bv = b.firstSeenAt || b.createdAt || ""; }
        else { av = (a[sortField] || "").toString().toLowerCase(); bv = (b[sortField] || "").toString().toLowerCase(); }
        return av < bv ? -sortDir : av > bv ? sortDir : 0;
      });
    }
    const limitParam = url.searchParams.get("limit");
    let page = filtered;
    if (limitParam) {
      const limit = Math.max(1, parseInt(limitParam, 10) || 50);
      const offset = Math.max(0, parseInt(url.searchParams.get("offset"), 10) || 0);
      page = filtered.slice(offset, offset + limit);
    }
    return sendJson(res, 200, { contacts: page.map(publicContact), total });
  }
  if (p === "/api/contacts" && req.method === "POST") {
    const body = await readJsonBody(req);
    if (!body.first || !body.last) return sendJson(res, 400, { error: "first and last are required" });
    const contacts = readJson(CONTACTS_FILE, []);
    // Same "email or phone already means the same person" rule every other
    // creation path in this app follows (forms, bookings, imports) --
    // manual "+ Add Contact" was the one place that didn't, so typing in an
    // email/phone that already belonged to someone silently created a
    // second record instead of updating the one that already exists.
    let record = findContactMatch(contacts, body.email, body.phone);
    if (record) {
      for (const k of ["first", "last", "accountName", "status"]) if (body[k]) record[k] = body[k];
      if (body.email) record.email = String(body.email).toLowerCase();
      if (body.phone) record.phone = body.phone;
      record.customFields = { ...record.customFields, ...(body.customFields || {}) };
      record.updatedAt = new Date().toISOString();
      writeJson(CONTACTS_FILE, contacts);
    } else {
      record = newContactRecord(body);
      contacts.push(record);
      writeJson(CONTACTS_FILE, contacts);
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
      const allowed = ["type", "programType", "accountName", "first", "last", "email", "phone", "status", "tags", "listIds", "customFields", "ownerId", "emailOptOut", "smsOptOut"];
      let prevListIds, prevTags, prevStatus;
      const updated = updateJsonArrayRecordByField(CONTACTS_FILE, "id", contactMatch[1], (contact) => {
        prevListIds = [...contact.listIds]; prevTags = [...contact.tags]; prevStatus = contact.status;
        for (const k of allowed) if (k in body) contact[k] = body[k];
        if (contact.status !== prevStatus) applyStatusOptOut(contact);
        contact.updatedAt = new Date().toISOString();
        return contact;
      });
      if (!updated) return sendJson(res, 404, { error: "Contact not found" });
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
    const contacts = readJson(CONTACTS_FILE, []);
    const contact = contacts.find(c => c.id === contactMatch[1]);
    if (req.method === "GET") {
      if (!contact) return sendJson(res, 404, { error: "Contact not found" });
      return sendJson(res, 200, { contact: publicContact(contact) });
    }
    if (req.method === "DELETE") {
      if (!contact) return sendJson(res, 404, { error: "Contact not found" });
      writeJson(CONTACTS_FILE, contacts.filter(c => c.id !== contactMatch[1]));
      return sendJson(res, 200, { ok: true });
    }
  }

  // ── Lists ────────────────────────────────────────────────────────────
  if (p === "/api/lists" && req.method === "GET") {
    return sendJson(res, 200, { lists: readJson(LISTS_FILE, []) });
  }
  if (p === "/api/lists" && req.method === "POST") {
    const { name } = await readJsonBody(req);
    if (!name) return sendJson(res, 400, { error: "name is required" });
    const lists = readJson(LISTS_FILE, []);
    const list = { id: randomUUID(), name, createdAt: new Date().toISOString() };
    lists.push(list);
    writeJson(LISTS_FILE, lists);
    return sendJson(res, 200, { ok: true, list });
  }
  // Bulk delete -- ONE contacts-file pass for however many list ids are
  // selected, not one per id. Confirmed live (2026-09-01) that selecting a
  // large batch and deleting one-at-a-time (via Promise.all over the
  // single-delete route below) fired that many CONCURRENT full rewrites of
  // a 180MB+ contacts file, exhausted the disk, and froze the whole
  // single-threaded server for everyone -- exactly the failure mode
  // message_log.js's own comments already document from a prior incident.
  if (p === "/api/lists/bulk-delete" && req.method === "POST") {
    const { ids } = await readJsonBody(req);
    if (!Array.isArray(ids) || !ids.length) return sendJson(res, 400, { error: "ids is required" });
    const idSet = new Set(ids);
    const lists = readJson(LISTS_FILE, []);
    writeJson(LISTS_FILE, lists.filter(l => !idSet.has(l.id)));
    const contacts = readJson(CONTACTS_FILE, []);
    let changed = false;
    contacts.forEach(c => {
      if (Array.isArray(c.listIds) && c.listIds.some(id => idSet.has(id))) {
        c.listIds = c.listIds.filter(id => !idSet.has(id));
        changed = true;
      }
    });
    if (changed) writeJson(CONTACTS_FILE, contacts);
    return sendJson(res, 200, { ok: true });
  }
  const listMatch = p.match(/^\/api\/lists\/([^/]+)$/);
  if (listMatch && req.method === "DELETE") {
    const lists = readJson(LISTS_FILE, []);
    writeJson(LISTS_FILE, lists.filter(l => l.id !== listMatch[1]));
    // Deleting the list record alone left every contact that had it holding
    // a dead id in listIds forever (nothing else in the app ever reads a
    // list's own record to know it's gone). A full contacts-file rewrite is
    // fine here -- list deletion is a rare, deliberate admin action, not a
    // per-request hot path like the message-log writes this app had to
    // stop doing this way.
    const contacts = readJson(CONTACTS_FILE, []);
    let changed = false;
    contacts.forEach(c => {
      if (Array.isArray(c.listIds) && c.listIds.includes(listMatch[1])) {
        c.listIds = c.listIds.filter(id => id !== listMatch[1]);
        changed = true;
      }
    });
    if (changed) writeJson(CONTACTS_FILE, contacts);
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
  if (p === "/api/tags" && req.method === "POST") {
    const { name, color } = await readJsonBody(req);
    if (!name) return sendJson(res, 400, { error: "name is required" });
    const tags = readJson(TAGS_FILE, []);
    const tag = { id: randomUUID(), name, color: color || "#009bff", createdAt: new Date().toISOString() };
    tags.push(tag);
    writeJson(TAGS_FILE, tags);
    return sendJson(res, 200, { ok: true, tag });
  }
  // Same single-pass consolidation as the lists bulk-delete above.
  if (p === "/api/tags/bulk-delete" && req.method === "POST") {
    const { ids } = await readJsonBody(req);
    if (!Array.isArray(ids) || !ids.length) return sendJson(res, 400, { error: "ids is required" });
    const idSet = new Set(ids);
    const tags = readJson(TAGS_FILE, []);
    writeJson(TAGS_FILE, tags.filter(t => !idSet.has(t.id)));
    const contacts = readJson(CONTACTS_FILE, []);
    let changed = false;
    contacts.forEach(c => {
      if (Array.isArray(c.tags) && c.tags.some(id => idSet.has(id))) {
        c.tags = c.tags.filter(id => !idSet.has(id));
        changed = true;
      }
    });
    if (changed) writeJson(CONTACTS_FILE, contacts);
    return sendJson(res, 200, { ok: true });
  }
  const tagMatch = p.match(/^\/api\/tags\/([^/]+)$/);
  if (tagMatch && req.method === "DELETE") {
    const tags = readJson(TAGS_FILE, []);
    writeJson(TAGS_FILE, tags.filter(t => t.id !== tagMatch[1]));
    // Same orphaned-id cleanup as list deletion above.
    const contacts = readJson(CONTACTS_FILE, []);
    let changed = false;
    contacts.forEach(c => {
      if (Array.isArray(c.tags) && c.tags.includes(tagMatch[1])) {
        c.tags = c.tags.filter(id => id !== tagMatch[1]);
        changed = true;
      }
    });
    if (changed) writeJson(CONTACTS_FILE, contacts);
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
    return sendJson(res, 200, { segments: readJson(SEGMENTS_FILE, []) });
  }
  if (p === "/api/segments" && req.method === "POST") {
    const { name, filter, channel } = await readJsonBody(req);
    if (!name || !filter) return sendJson(res, 400, { error: "name and filter are required" });
    if (channel && !["email", "sms"].includes(channel)) return sendJson(res, 400, { error: "channel must be 'email' or 'sms'" });
    const segments = readJson(SEGMENTS_FILE, []);
    const segment = { id: randomUUID(), name, filter, channel: channel || "email", createdAt: new Date().toISOString() };
    segments.push(segment);
    writeJson(SEGMENTS_FILE, segments);
    return sendJson(res, 200, { ok: true, segment });
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
  const segmentMatch = p.match(/^\/api\/segments\/([^/]+)$/);
  if (segmentMatch && req.method === "DELETE") {
    const segments = readJson(SEGMENTS_FILE, []);
    writeJson(SEGMENTS_FILE, segments.filter(s => s.id !== segmentMatch[1]));
    return sendJson(res, 200, { ok: true });
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
  if (p === "/api/custom-fields" && req.method === "GET") {
    const entityType = url.searchParams.get("entityType");
    let fields = readJson(CUSTOM_FIELDS_FILE, []);
    if (entityType) fields = fields.filter(f => f.entityType === entityType);
    return sendJson(res, 200, { fields });
  }
  if (p === "/api/custom-fields" && req.method === "POST") {
    const { entityType, label } = await readJsonBody(req);
    if (!["lead", "contact", "opportunity"].includes(entityType)) return sendJson(res, 400, { error: "entityType must be 'lead', 'contact', or 'opportunity'" });
    if (!label) return sendJson(res, 400, { error: "label is required" });
    const fields = readJson(CUSTOM_FIELDS_FILE, []);
    const order = fields.filter(f => f.entityType === entityType).length;
    const field = { id: randomUUID(), entityType, label, type: "text", order, createdAt: new Date().toISOString() };
    fields.push(field);
    writeJson(CUSTOM_FIELDS_FILE, fields);
    return sendJson(res, 200, { ok: true, field });
  }
  const fieldMatch = p.match(/^\/api\/custom-fields\/([^/]+)$/);
  if (fieldMatch && req.method === "DELETE") {
    const fields = readJson(CUSTOM_FIELDS_FILE, []);
    writeJson(CUSTOM_FIELDS_FILE, fields.filter(f => f.id !== fieldMatch[1]));
    return sendJson(res, 200, { ok: true });
  }

  return false;
}
