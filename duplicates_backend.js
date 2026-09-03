import { randomUUID } from "crypto";
import { readJson, writeJson, readJsonBody, sendJson, getSessionUser, isAdmin, updateAllJsonArrayRecordsByField } from "./auth_backend.js";
import { CONTACTS_FILE } from "./segments_shared.js";
import { MESSAGE_LOG_FILE } from "./message_log.js";
import { CALLS_FILE, TASKS_FILE } from "./inbox_backend.js";
import { CONVERSATION_META_FILE } from "./conversation_meta.js";
import { PAGE_VISITS_FILE, claimVisitorHistory } from "./tracking_backend.js";

export const POSSIBLE_DUPLICATES_FILE = "crm_possible_duplicates.json";

function normName(c) {
  const first = (c.first || "").trim().toLowerCase();
  const last = (c.last || "").trim().toLowerCase();
  if (!first || !last) return null; // too weak a signal on its own -- skip blank/first-name-only contacts entirely
  return `${first} ${last}`;
}
function visitSignals(contactId, visits) {
  const mine = visits.filter(v => v.contactId === contactId);
  return {
    ips: new Set(mine.map(v => v.ip).filter(Boolean)),
    locations: new Set(mine.filter(v => v.location).map(v => `${v.location.city}|${v.location.region}|${v.location.country}`)),
  };
}

// Two contacts sharing an exact email or phone is the CLEAREST duplicate
// signal there is -- more certain than name+IP/location, not less. This
// used to skip exact-match pairs on the assumption that findContactMatch()
// would already have prevented them from existing as separate records --
// wrong in practice: /api/inbox/confirm-potential and manual "+ Add
// Contact" both used to create a new contact without ever checking for an
// existing match (now fixed at the source too, see contacts_backend.js and
// inbox_backend.js), and any data imported before findContactMatch existed
// never got deduped at all. So this still flags for a human to confirm --
// per the "never auto-merge" rule -- but on the STRONGER exact-match signal
// first, falling back to the fuzzy name+IP/location signal only when
// neither email nor phone already ties the pair together.
export function scanForPossibleDuplicates() {
  const contacts = readJson(CONTACTS_FILE, []);
  const visits = readJson(PAGE_VISITS_FILE, []);
  const existing = readJson(POSSIBLE_DUPLICATES_FILE, []);
  const alreadyFlagged = new Set(existing.map(d => [d.contactAId, d.contactBId].sort().join("|")));

  const byEmail = new Map(), byPhone = new Map(), byName = new Map();
  contacts.forEach(c => {
    if (c.email) { const k = c.email.toLowerCase(); if (!byEmail.has(k)) byEmail.set(k, []); byEmail.get(k).push(c); }
    if (c.phone) { const k = c.phone.replace(/\D/g, "").slice(-10); if (k) { if (!byPhone.has(k)) byPhone.set(k, []); byPhone.get(k).push(c); } }
    const nameKey = normName(c);
    if (nameKey) { if (!byName.has(nameKey)) byName.set(nameKey, []); byName.get(nameKey).push(c); }
  });

  let added = 0;
  function flagPair(a, b, reason) {
    const pairKey = [a.id, b.id].sort().join("|");
    if (alreadyFlagged.has(pairKey)) return;
    existing.push({ id: randomUUID(), contactAId: a.id, contactBId: b.id, reason, status: "pending", createdAt: new Date().toISOString() });
    alreadyFlagged.add(pairKey);
    added++;
  }
  function flagGroups(groups, reason) {
    for (const group of groups) {
      for (let i = 0; i < group.length; i++) {
        for (let j = i + 1; j < group.length; j++) flagPair(group[i], group[j], reason);
      }
    }
  }
  flagGroups(byEmail.values(), "email");
  flagGroups(byPhone.values(), "phone");

  for (const group of byName.values()) {
    if (group.length < 2) continue;
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i], b = group[j];
        const pairKey = [a.id, b.id].sort().join("|");
        if (alreadyFlagged.has(pairKey)) continue; // already flagged above by email/phone
        const sigA = visitSignals(a.id, visits), sigB = visitSignals(b.id, visits);
        const sharedIp = [...sigA.ips].some(ip => sigB.ips.has(ip));
        const sharedLocation = !sharedIp && [...sigA.locations].some(loc => sigB.locations.has(loc));
        if (sharedIp) flagPair(a, b, "ip");
        else if (sharedLocation) flagPair(a, b, "location");
      }
    }
  }
  if (added) writeJson(POSSIBLE_DUPLICATES_FILE, existing);
  return added;
}

// Phase 2 of ad/social click attribution (Phase 1 is
// tracking_backend.js's claimVisitorHistory, which links a visitor's OWN
// anonymous browsing to the contact THEY opt in as -- same device, same
// crm_vid cookie, certain). This covers the case Phase 1 can't: an
// anonymous visit from a DIFFERENT device than the one that eventually
// opted in (phone ad click, laptop opt-in). There's no cookie to bridge
// that gap -- the only signals available are IP/approximate location,
// which is exactly the same fuzzy, "could be a coincidence" territory
// scanForPossibleDuplicates above already works in for two CONTACTS. This
// is that same idea applied to one contact + one still-anonymous session:
// flag it for a human to confirm, never auto-attribute. An anonymous
// visit carries no name/email/phone to layer on top of IP/location the
// way two real contact records can be compared -- IP/location is the only
// signal there is until a human confirms it, at which point the visit
// stops being anonymous.
export const POSSIBLE_VISITOR_MATCHES_FILE = "crm_possible_visitor_matches.json";
// Indexed rather than compared pairwise (orphan x every contact) --
// crm_contacts.json already has 176K+ rows, and looping every anonymous
// session against every contact to recompute its visit signals each time
// is exactly the O(orphans x contacts x visits) shape that already caused
// real trouble elsewhere this session once real data volume hit it. One
// pass over the visits log builds ip/location -> contactIds indexes, and
// looks each orphan's own signals up in O(1) against those instead.
export function scanForPossibleVisitorMatches() {
  const contacts = readJson(CONTACTS_FILE, []);
  const contactsById = new Map(contacts.map(c => [c.id, c]));
  const visits = readJson(PAGE_VISITS_FILE, []);
  const existing = readJson(POSSIBLE_VISITOR_MATCHES_FILE, []);
  const alreadyFlagged = new Set(existing.map(m => `${m.visitorId}|${m.contactId}`));

  const contactsByIp = new Map(), contactsByLocation = new Map();
  const orphans = new Map(); // visitorId -> {ips, locations, lastVisit}
  for (const v of visits) {
    if (v.contactId) {
      if (v.ip) { if (!contactsByIp.has(v.ip)) contactsByIp.set(v.ip, new Set()); contactsByIp.get(v.ip).add(v.contactId); }
      if (v.location) { const k = `${v.location.city}|${v.location.region}|${v.location.country}`; if (!contactsByLocation.has(k)) contactsByLocation.set(k, new Set()); contactsByLocation.get(k).add(v.contactId); }
    } else if (v.visitorId) {
      if (!orphans.has(v.visitorId)) orphans.set(v.visitorId, { ips: new Set(), locations: new Set(), lastVisit: null });
      const o = orphans.get(v.visitorId);
      if (v.ip) o.ips.add(v.ip);
      if (v.location) o.locations.add(`${v.location.city}|${v.location.region}|${v.location.country}`);
      o.lastVisit = v; // visits are appended in order, so this ends up as the latest
    }
  }

  let added = 0;
  for (const [vid, sig] of orphans) {
    const ipCandidates = new Set();
    for (const ip of sig.ips) { const s = contactsByIp.get(ip); if (s) s.forEach(id => ipCandidates.add(id)); }
    const locCandidates = new Set();
    for (const loc of sig.locations) { const s = contactsByLocation.get(loc); if (s) s.forEach(id => locCandidates.add(id)); }
    for (const contactId of new Set([...ipCandidates, ...locCandidates])) {
      const key = `${vid}|${contactId}`;
      if (alreadyFlagged.has(key) || !contactsById.has(contactId)) continue;
      existing.push({
        id: randomUUID(), visitorId: vid, contactId,
        reason: ipCandidates.has(contactId) ? "ip" : "location",
        sampleVisit: sig.lastVisit ? { path: sig.lastVisit.path, el: sig.lastVisit.el, at: sig.lastVisit.at } : null,
        status: "pending", createdAt: new Date().toISOString(),
      });
      alreadyFlagged.add(key);
      added++;
    }
  }
  if (added) writeJson(POSSIBLE_VISITOR_MATCHES_FILE, existing);
  return added;
}

const DUPLICATE_SCAN_STATE_FILE = "crm_duplicate_scan_state.json";
const SCAN_INTERVAL_MS = 24 * 60 * 60 * 1000; // once/day -- new page-visit data trickles in continuously, no need for this to run every scheduler tick
// Called every scheduler tick (see scheduler.js) -- cheap no-op unless a
// full day has actually passed since the last real scan, so matches like
// "same person, phone this morning, desktop this afternoon" surface
// without anyone remembering to click the button.
export function runScheduledDuplicateScan() {
  const state = readJson(DUPLICATE_SCAN_STATE_FILE, { lastScanAt: null });
  if (state.lastScanAt && Date.now() - new Date(state.lastScanAt).getTime() < SCAN_INTERVAL_MS) return;
  const added = scanForPossibleDuplicates();
  const visitorMatches = scanForPossibleVisitorMatches();
  state.lastScanAt = new Date().toISOString();
  writeJson(DUPLICATE_SCAN_STATE_FILE, state);
  if (added) console.log(`[duplicates] scheduled scan found ${added} new possible duplicate${added === 1 ? "" : "s"}`);
  if (visitorMatches) console.log(`[duplicates] scheduled scan found ${visitorMatches} new possible visitor match${visitorMatches === 1 ? "" : "es"}`);
}

// Reassigns every message/call/task/conversation-meta row from mergeId to
// keepId, folds in any field keepId is missing (email/phone/customFields)
// from the losing record, then deletes the losing contact. Doesn't touch
// message/call/task CONTENT -- only which contact they're attributed to --
// so nothing about the underlying history is lost, just consolidated onto
// one contact.
export function mergeContacts(keepId, mergeId) {
  const contacts = readJson(CONTACTS_FILE, []);
  const keep = contacts.find(c => c.id === keepId);
  const merge = contacts.find(c => c.id === mergeId);
  if (!keep || !merge) return { ok: false, reason: "Contact not found" };

  if (!keep.email && merge.email) keep.email = merge.email;
  if (!keep.phone && merge.phone) keep.phone = merge.phone;
  keep.customFields = { ...merge.customFields, ...keep.customFields };
  keep.tags = [...new Set([...(keep.tags || []), ...(merge.tags || [])])];
  keep.listIds = [...new Set([...(keep.listIds || []), ...(merge.listIds || [])])];
  if (!keep.externalIds?.acContactId && merge.externalIds?.acContactId) keep.externalIds.acContactId = merge.externalIds.acContactId;
  if (!keep.externalIds?.closeLeadId && merge.externalIds?.closeLeadId) keep.externalIds.closeLeadId = merge.externalIds.closeLeadId;
  if (merge.firstSeenAt && (!keep.firstSeenAt || new Date(merge.firstSeenAt) < new Date(keep.firstSeenAt))) keep.firstSeenAt = merge.firstSeenAt;
  keep.updatedAt = new Date().toISOString();
  writeJson(CONTACTS_FILE, contacts.filter(c => c.id !== mergeId));

  // Byte-scanned in place instead of readJson+forEach+writeJson -- the
  // message log alone reached 12GB+ and a full parse/rewrite of it hung the
  // server outright the moment someone next merged a duplicate contact.
  updateAllJsonArrayRecordsByField(MESSAGE_LOG_FILE, "contactId", mergeId, m => { m.contactId = keepId; return m; });
  updateAllJsonArrayRecordsByField(CALLS_FILE, "contactId", mergeId, c => { c.contactId = keepId; return c; });
  updateAllJsonArrayRecordsByField(TASKS_FILE, "contactId", mergeId, t => { t.contactId = keepId; return t; });
  updateAllJsonArrayRecordsByField(PAGE_VISITS_FILE, "contactId", mergeId, v => { v.contactId = keepId; return v; });

  // Keep whichever conversation meta (pin/star/done/archived) already
  // exists for the surviving contact; the losing one's meta row (if any)
  // just becomes orphaned and is left alone rather than guessing how to
  // combine two archived/done states.
  const meta = readJson(CONVERSATION_META_FILE, []);
  writeJson(CONVERSATION_META_FILE, meta.filter(m => m.contactId !== mergeId));

  return { ok: true };
}

export async function handleDuplicatesRequest(req, res, url) {
  const p = url.pathname;
  if (!p.startsWith("/api/duplicates")) return false;
  const me = getSessionUser(req);
  if (!me) return sendJson(res, 401, { error: "Not logged in" });
  if (!isAdmin(me)) return sendJson(res, 403, { error: "Admins only" });

  if (p === "/api/duplicates" && req.method === "GET") {
    const contacts = readJson(CONTACTS_FILE, []);
    const pairs = readJson(POSSIBLE_DUPLICATES_FILE, []).filter(d => d.status === "pending");
    const withContacts = pairs
      .map(d => ({ ...d, contactA: contacts.find(c => c.id === d.contactAId) || null, contactB: contacts.find(c => c.id === d.contactBId) || null }))
      .filter(d => d.contactA && d.contactB); // one side may have been deleted/merged elsewhere since flagging
    return sendJson(res, 200, { pairs: withContacts });
  }

  if (p === "/api/duplicates/scan" && req.method === "POST") {
    const added = scanForPossibleDuplicates();
    return sendJson(res, 200, { ok: true, added });
  }

  const dismissMatch = p.match(/^\/api\/duplicates\/([^/]+)\/dismiss$/);
  if (dismissMatch && req.method === "POST") {
    const all = readJson(POSSIBLE_DUPLICATES_FILE, []);
    const row = all.find(d => d.id === dismissMatch[1]);
    if (!row) return sendJson(res, 404, { error: "Not found" });
    row.status = "dismissed";
    writeJson(POSSIBLE_DUPLICATES_FILE, all);
    return sendJson(res, 200, { ok: true });
  }

  const mergeMatch = p.match(/^\/api\/duplicates\/([^/]+)\/merge$/);
  if (mergeMatch && req.method === "POST") {
    const all = readJson(POSSIBLE_DUPLICATES_FILE, []);
    const row = all.find(d => d.id === mergeMatch[1]);
    if (!row) return sendJson(res, 404, { error: "Not found" });
    const { keepId } = await readJsonBody(req);
    if (![row.contactAId, row.contactBId].includes(keepId)) return sendJson(res, 400, { error: "keepId must be one of this pair's two contacts" });
    const mergeId = keepId === row.contactAId ? row.contactBId : row.contactAId;
    const result = mergeContacts(keepId, mergeId);
    if (!result.ok) return sendJson(res, 400, { error: result.reason });
    row.status = "merged";
    writeJson(POSSIBLE_DUPLICATES_FILE, all);
    return sendJson(res, 200, { ok: true });
  }

  // Phase 2 visitor-match review queue (see scanForPossibleVisitorMatches
  // above) -- same "flag for a human, never auto-attribute" shape as the
  // contact-duplicate pairs above.
  if (p === "/api/duplicates/visitor-matches" && req.method === "GET") {
    const contacts = readJson(CONTACTS_FILE, []);
    const rows = readJson(POSSIBLE_VISITOR_MATCHES_FILE, []).filter(m => m.status === "pending");
    const withContacts = rows
      .map(m => ({ ...m, contact: contacts.find(c => c.id === m.contactId) || null }))
      .filter(m => m.contact); // contact may have been deleted/merged since flagging
    return sendJson(res, 200, { matches: withContacts });
  }

  if (p === "/api/duplicates/visitor-matches/scan" && req.method === "POST") {
    const added = scanForPossibleVisitorMatches();
    return sendJson(res, 200, { ok: true, added });
  }

  const visitorDismissMatch = p.match(/^\/api\/duplicates\/visitor-matches\/([^/]+)\/dismiss$/);
  if (visitorDismissMatch && req.method === "POST") {
    const all = readJson(POSSIBLE_VISITOR_MATCHES_FILE, []);
    const row = all.find(m => m.id === visitorDismissMatch[1]);
    if (!row) return sendJson(res, 404, { error: "Not found" });
    row.status = "dismissed";
    writeJson(POSSIBLE_VISITOR_MATCHES_FILE, all);
    return sendJson(res, 200, { ok: true });
  }

  const visitorConfirmMatch = p.match(/^\/api\/duplicates\/visitor-matches\/([^/]+)\/confirm$/);
  if (visitorConfirmMatch && req.method === "POST") {
    const all = readJson(POSSIBLE_VISITOR_MATCHES_FILE, []);
    const row = all.find(m => m.id === visitorConfirmMatch[1]);
    if (!row) return sendJson(res, 404, { error: "Not found" });
    const claimed = claimVisitorHistory(row.visitorId, row.contactId);
    row.status = "confirmed";
    writeJson(POSSIBLE_VISITOR_MATCHES_FILE, all);
    return sendJson(res, 200, { ok: true, claimed });
  }

  return false;
}
