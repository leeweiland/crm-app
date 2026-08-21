import { randomUUID } from "crypto";
import { readJson, writeJson, readJsonBody, sendJson, getSessionUser } from "./auth_backend.js";
import { CONTACTS_FILE, SEGMENTS_FILE, matchesSegment, findContactMatch } from "./segments_shared.js";
import { fireTrigger, checkAutomationGoal } from "./automations_backend.js";
import { fireWorkflowTrigger, checkConversionGoal } from "./workflows_backend.js";
import { applyStatusOptOut } from "./compliance_backend.js";

export { CONTACTS_FILE, SEGMENTS_FILE, matchesSegment }; // re-exported: campaigns_backend.js already imports these from here
export const LISTS_FILE = "crm_lists.json";
export const TAGS_FILE = "crm_tags.json";
export const CUSTOM_FIELDS_FILE = "crm_custom_fields.json";

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
    const contacts = readJson(CONTACTS_FILE, []);
    const contact = contacts.find(c => c.id === contactMatch[1]);
    if (req.method === "GET") {
      if (!contact) return sendJson(res, 404, { error: "Contact not found" });
      return sendJson(res, 200, { contact: publicContact(contact) });
    }
    if (req.method === "PATCH") {
      if (!contact) return sendJson(res, 404, { error: "Contact not found" });
      const body = await readJsonBody(req);
      const prevListIds = [...contact.listIds], prevTags = [...contact.tags], prevStatus = contact.status;
      const allowed = ["type", "programType", "accountName", "first", "last", "email", "phone", "status", "tags", "listIds", "customFields", "ownerId", "emailOptOut", "smsOptOut"];
      for (const k of allowed) if (k in body) contact[k] = body[k];
      if (contact.status !== prevStatus) applyStatusOptOut(contact);
      contact.updatedAt = new Date().toISOString();
      writeJson(CONTACTS_FILE, contacts);
      // Only fire for genuinely NEW list/tag membership, not every patch --
      // an automation shouldn't re-enroll someone just because their email
      // was edited.
      contact.listIds.filter(id => !prevListIds.includes(id)).forEach(listId => { fireTrigger("list_subscribe", { contactId: contact.id, listId }); fireWorkflowTrigger("list_subscribe", { contactId: contact.id, listId }); });
      contact.tags.filter(id => !prevTags.includes(id)).forEach(tagId => { fireTrigger("tag_added", { contactId: contact.id, tagId }); fireWorkflowTrigger("tag_added", { contactId: contact.id, tagId }); });
      if (contact.status !== prevStatus) { checkConversionGoal("lead_status_change", contact.id); checkAutomationGoal("lead_status_change", contact.id, contact.status); }
      return sendJson(res, 200, { ok: true, contact: publicContact(contact) });
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
  const listMatch = p.match(/^\/api\/lists\/([^/]+)$/);
  if (listMatch && req.method === "DELETE") {
    const lists = readJson(LISTS_FILE, []);
    writeJson(LISTS_FILE, lists.filter(l => l.id !== listMatch[1]));
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
  const tagMatch = p.match(/^\/api\/tags\/([^/]+)$/);
  if (tagMatch && req.method === "DELETE") {
    const tags = readJson(TAGS_FILE, []);
    writeJson(TAGS_FILE, tags.filter(t => t.id !== tagMatch[1]));
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
