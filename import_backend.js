import { randomUUID } from "crypto";
import { readJson, writeJson, readJsonBody, sendJson, getSessionUser, isAdmin, scanJsonArrayFieldSets, appendJsonRecords } from "./auth_backend.js";
import { CONTACTS_FILE, findContactMatch, markFirstSeen } from "./segments_shared.js";
import { MESSAGE_LOG_FILE } from "./message_log.js";
import { CALLS_FILE, TASKS_FILE, NOTES_FILE } from "./inbox_backend.js";
import { recheckStopStatus, isStopKeyword } from "./compliance_backend.js";
import { getComplianceSettings } from "./integrations_backend.js";
import { getOrCreateTag, getOrCreateList, getOrCreateCustomField } from "./contacts_backend.js";
import { hyrosConfigured, fetchHyrosLeadsPage, upsertFromHyros, mergeHyrosActivity, searchHyrosLeadByIdentity } from "./hyros_backend.js";

export const IMPORT_JOBS_FILE = "crm_import_jobs.json";

// Account-specific base URL, same convention already established elsewhere
// in this business's other apps (build_campaign_cache.js etc) -- not a
// secret, doesn't belong in .env.
const AC_BASE = "https://pacificrimathletics.api-us1.com";
const CLOSE_BASE = "https://api.close.com/api/v1";

function acConfigured() { return !!process.env.AC_API_KEY; }
function closeConfigured() { return !!process.env.CLOSE_API_KEY; }

// Confirmed live via Close's own response headers (x-ratelimit-limit:
// "60, 60;w=1, 100;w=1") that /lead/, /activity/{email,sms,call,note}/,
// and /task/ all share ONE combined ~60-requests/second bucket -- not 60
// each. Limiting how many LEADS process concurrently doesn't control the
// actual request RATE landing on Close's server: a bulk import firing
// several Promise.all'd calls per lead can burst well past 60/sec even at
// modest concurrency (confirmed live: 3 concurrent leads, 18 simultaneous
// requests, got 429'd on nearly every single call). A shared token bucket
// throttles every outgoing Close request to a safe rate regardless of how
// many leads are in flight at once.
class RateLimiter {
  constructor(ratePerSec) {
    this.ratePerSec = ratePerSec;
    this.tokens = ratePerSec;
    this.lastRefill = Date.now();
  }
  async acquire() {
    while (true) {
      const now = Date.now();
      this.tokens = Math.min(this.ratePerSec, this.tokens + ((now - this.lastRefill) / 1000) * this.ratePerSec);
      this.lastRefill = now;
      if (this.tokens >= 1) { this.tokens -= 1; return; }
      await new Promise(r => setTimeout(r, 25));
    }
  }
}
const closeLimiter = new RateLimiter(35); // safety margin under the observed ~60/sec shared limit
async function closeFetch(url, opts) {
  await closeLimiter.acquire();
  return fetch(url, opts);
}

export async function fetchAcBatch(offset, limit) {
  const r = await fetch(`${AC_BASE}/api/3/contacts?limit=${limit}&offset=${offset}`, { headers: { "Api-Token": process.env.AC_API_KEY } });
  if (!r.ok) return { ok: false, reason: `ActiveCampaign API error ${r.status}` };
  const data = await r.json();
  return { ok: true, contacts: data.contacts || [] };
}
export async function fetchCloseBatch(skip, limit) {
  const auth = "Basic " + Buffer.from(process.env.CLOSE_API_KEY + ":").toString("base64");
  const r = await closeFetch(`${CLOSE_BASE}/lead/?_skip=${skip}&_limit=${limit}`, { headers: { Authorization: auth } });
  if (!r.ok) return { ok: false, reason: `Close API error ${r.status}` };
  const data = await r.json();
  return { ok: true, leads: data.data || [], hasMore: !!data.has_more };
}

// AC's v3 API never expands tag/list NAMES onto a contact's own record --
// only their numeric ids come back from /contactTags and /contactLists, so
// resolving what they're actually called takes a separate full account-wide
// fetch of /tags and /lists (paginated, done ONCE per import run and reused
// across every contact in the batch, not re-fetched per contact).
export async function fetchAcIdNameMap(resource) {
  const headers = { "Api-Token": process.env.AC_API_KEY };
  const map = new Map();
  let offset = 0;
  while (true) {
    const r = await fetch(`${AC_BASE}/api/3/${resource}?limit=100&offset=${offset}`, { headers });
    if (!r.ok) throw new Error(`ActiveCampaign ${resource} API error ${r.status}`);
    const data = await r.json();
    const rows = data[resource] || [];
    rows.forEach(row => map.set(String(row.id), row.name || row.tag));
    if (!rows.length || map.size >= +data.meta.total) break;
    offset += 100;
  }
  return map;
}
async function fetchAcContactTagIds(acContactId) {
  const r = await fetch(`${AC_BASE}/api/3/contacts/${acContactId}/contactTags`, { headers: { "Api-Token": process.env.AC_API_KEY } });
  if (!r.ok) return [];
  const data = await r.json();
  return (data.contactTags || []).map(ct => String(ct.tag));
}
async function fetchAcContactLists(acContactId) {
  const r = await fetch(`${AC_BASE}/api/3/contacts/${acContactId}/contactLists`, { headers: { "Api-Token": process.env.AC_API_KEY } });
  if (!r.ok) return [];
  const data = await r.json();
  return data.contactLists || [];
}
// Applies AC's tags/lists onto the matching CRM contact, translating AC's
// numeric ids to real names via the pre-fetched maps, then get-or-create so
// re-running an import never creates duplicate CRM tags/lists. Also sets
// emailOptOut from AC's own per-list subscription status ("2" = unsubscribed,
// confirmed via live contactLists data) -- unsubscribed from ANY list is
// treated as opted out account-wide, erring toward not emailing someone who
// asked to stop rather than only respecting the specific list they left.
export async function enrichAcContact(contact, acContactId, tagMap, listMap) {
  const [tagIds, contactLists] = await Promise.all([fetchAcContactTagIds(acContactId), fetchAcContactLists(acContactId)]);
  tagIds.forEach(id => {
    const name = tagMap.get(id);
    const tag = name ? getOrCreateTag(name) : null;
    if (tag && !contact.tags.includes(tag.id)) contact.tags.push(tag.id);
  });
  contactLists.forEach(cl => {
    const name = listMap.get(String(cl.list));
    const list = name ? getOrCreateList(name) : null;
    if (list && !contact.listIds.includes(list.id)) contact.listIds.push(list.id);
  });
  if (contactLists.some(cl => cl.status === "2")) contact.emailOptOut = true;
}

// Close doesn't have AC-style freeform tags, but sequence enrollment
// ("SMS workflows") is the closest analog the user asked to import --
// pulled per-lead (no bulk/flat endpoint exists) and logged as an
// "activity" timeline entry, same treatment as Hyros ad-click attribution.
const closeSequenceNameCache = new Map();
async function closeSequenceName(id, auth) {
  if (closeSequenceNameCache.has(id)) return closeSequenceNameCache.get(id);
  const r = await closeFetch(`${CLOSE_BASE}/sequence/${id}/`, { headers: { Authorization: auth } });
  const name = r.ok ? (await r.json()).name : id;
  closeSequenceNameCache.set(id, name);
  return name;
}
async function fetchCloseSequenceSubscriptions(leadId) {
  const auth = "Basic " + Buffer.from(process.env.CLOSE_API_KEY + ":").toString("base64");
  const r = await closeFetch(`${CLOSE_BASE}/sequence_subscription/?lead_id=${leadId}`, { headers: { Authorization: auth } });
  if (!r.ok) return [];
  const data = await r.json();
  return data.data || [];
}
// AC and Hyros have no real deal-stage concept of their own -- Close's
// status_label is the one authoritative pipeline status across all three
// systems. Rather than defaulting a brand-new AC/Hyros contact to a
// made-up status, actively search Close (even for someone not imported
// from Close yet) so a person who already has a real Close status keeps
// it, instead of showing up blank. Only ever fills in a MISSING status --
// never overwrites one a human (or the Close importer) already set.
async function fetchCloseLeadById(leadId) {
  const auth = "Basic " + Buffer.from(process.env.CLOSE_API_KEY + ":").toString("base64");
  const r = await closeFetch(`${CLOSE_BASE}/lead/${leadId}/`, { headers: { Authorization: auth } });
  return r.ok ? await r.json() : null;
}
async function searchCloseLeadByIdentity(email, phone) {
  const auth = "Basic " + Buffer.from(process.env.CLOSE_API_KEY + ":").toString("base64");
  for (const [field, value] of [["email", email], ["phone", phone]]) {
    if (!value) continue;
    const r = await closeFetch(`${CLOSE_BASE}/lead/?query=${encodeURIComponent(`${field}:"${value}"`)}`, { headers: { Authorization: auth } });
    if (!r.ok) continue;
    const data = await r.json();
    if (data.data?.length) return data.data[0];
  }
  return null;
}
// Applied only when Close has no record of this person at all -- persists
// straight to disk since the in-memory `contact` object may be a stale
// snapshot from an earlier readJson call by this point in the loop.
function persistContact(contact) {
  const contacts = readJson(CONTACTS_FILE, []);
  const stored = contacts.find(c => c.id === contact.id);
  if (stored) { Object.assign(stored, contact); writeJson(CONTACTS_FILE, contacts); }
}
function applyFallbackStatus(contact, status) {
  contact.status = status;
  persistContact(contact);
}
// Close's "custom" object is real application-form data (age/height/goals/
// injuries/readiness/etc) -- worth pulling onto ANY contact linked to that
// lead, not just ones actually imported FROM Close, since AC/Hyros have
// nothing like it. Array-valued fields (Close's "BLAST" multi-select, etc)
// get joined into one text value since every CRM custom field is type
// "text". entityType follows the contact's own type so a "lead" record's
// fields don't collide with a "contact" record's fields of the same label.
export function mergeCloseCustomFields(contact, closeCustom) {
  if (!closeCustom) return;
  Object.entries(closeCustom).forEach(([label, value]) => {
    if (value == null || value === "") return;
    const field = getOrCreateCustomField(contact.type === "contact" ? "contact" : "lead", label);
    if (!field) return;
    contact.customFields[field.id] = Array.isArray(value) ? value.join(", ") : String(value);
    // Close's "TYPE" custom field (ONLINE/GYM) is the only real membership-
    // program signal this app has -- promoted to its own first-class
    // contact.programType (lowercased) so every UI spot that shows it reads
    // one consistent field instead of two different customField ids split
    // by entityType.
    if (label === "TYPE") {
      const v = (Array.isArray(value) ? value[0] : value || "").toString().trim().toLowerCase();
      if (v === "online" || v === "gym") contact.programType = v;
    }
  });
}
export async function enrichStatusFromClose(contact) {
  if (!closeConfigured()) return;
  // Already fully linked -- nothing left for a live search to find. (A
  // contact with a closeLeadId but missing custom fields is backfilled by
  // /api/import/backfill-status instead, via a direct by-id fetch.)
  if (contact.status && contact.first && contact.externalIds.closeLeadId) return;
  const lead = await searchCloseLeadByIdentity(contact.email, contact.phone);
  if (!lead) return;
  if (!contact.status) contact.status = lead.status_label || contact.status;
  // AC/Hyros sometimes carry no name at all for a given record -- Close's
  // nested contact usually does, so it's worth falling back to rather than
  // leaving the contact permanently nameless in the CRM.
  if (!contact.first && !contact.last) {
    const name = (lead.contacts?.[0]?.name || lead.display_name || "").trim();
    if (name) { const parts = name.split(/\s+/); contact.first = parts[0] || ""; contact.last = parts.slice(1).join(" "); }
  }
  if (!contact.externalIds.closeLeadId) contact.externalIds.closeLeadId = lead.id;
  markFirstSeen(contact, lead.date_created);
  mergeCloseCustomFields(contact, lead.custom);
  persistContact(contact);
}
// existingIdsIndex, pendingBuffer: see mergeAcCampaigns's comment in this
// same file -- same fix, same reason, now needed here too since the
// message log this writes into is the same shared, multi-million-record
// file. The single-contact/admin path (no pendingBuffer) keeps the old
// small-scale read-modify-write behavior.
// preFetchedSubs: bulk import path fetches this alongside email/sms/call/
// note/task in one big Promise.all (see pullCloseHistoryForContactBulk)
// instead of the extra serialized round-trip an internal fetch here would
// add on top of everything else already awaited for that contact.
export async function mergeCloseSequences(contact, existingIdsIndex, pendingBuffer, preFetchedSubs) {
  const leadId = contact.externalIds?.closeLeadId;
  if (!leadId || !closeConfigured()) return 0;
  const auth = "Basic " + Buffer.from(process.env.CLOSE_API_KEY + ":").toString("base64");
  const subs = preFetchedSubs || await fetchCloseSequenceSubscriptions(leadId);
  const log = pendingBuffer ? null : readJson(MESSAGE_LOG_FILE, []);
  const existingIds = existingIdsIndex || new Set(log.filter(m => m.closeSequenceSubId).map(m => m.closeSequenceSubId));
  let added = 0;
  for (const s of subs) {
    if (existingIds.has(s.id)) continue;
    const name = await closeSequenceName(s.sequence_id, auth);
    const record = {
      id: randomUUID(), channel: "activity", direction: "inbound",
      contactId: contact.id, sourceType: "close_import", sourceId: null, providerMessageId: null,
      to: null, from: null,
      subject: `SMS/Email Sequence: ${name} (${s.status})`,
      body: "", bodyPreview: s.status,
      status: "logged", statusHistory: [{ status: "logged", at: s.date_created }],
      sentAt: null, createdAt: s.date_created || new Date().toISOString(),
      inboxDone: true,
      closeSequenceSubId: s.id,
    };
    if (pendingBuffer) pendingBuffer.push(record); else log.push(record);
    existingIds.add(s.id);
    added++;
  }
  if (added && !pendingBuffer) writeJson(MESSAGE_LOG_FILE, log);
  return added;
}

// ActiveCampaign's v3 REST API doesn't expose per-recipient engagement for
// BULK campaigns (no relationship endpoint returns it, and every
// contact-scoped filter on the flat /campaigns collection is silently
// ignored -- confirmed by testing, not assumed). The one thing it DOES
// expose reliably is these personalized "1:1 → email — subject" campaigns
// AC auto-creates for one-off/automation-triggered sends to a single
// recipient -- the email is embedded right in the campaign name, and each
// one carries real per-recipient opens/clicks. Fetches the whole account
// once (paginated) since there's no server-side way to filter to one
// contact; callers should fetch once and reuse the result across contacts
// rather than re-fetching per contact.
const AC_CAMPAIGN_NAME_RE = /^1:1 → ([^ ]+@[^ ]+) — (.*)$/;
export async function fetchAcOneToOneCampaigns() {
  const headers = { "Api-Token": process.env.AC_API_KEY };
  const all = [];
  let offset = 0;
  while (true) {
    const r = await fetch(`${AC_BASE}/api/3/campaigns?limit=100&offset=${offset}`, { headers });
    if (!r.ok) throw new Error(`ActiveCampaign campaigns API error ${r.status}`);
    const data = await r.json();
    all.push(...(data.campaigns || []));
    if (!data.campaigns?.length || all.length >= +data.meta.total) break;
    offset += 100;
  }
  return all
    .map(c => {
      const m = c.name.match(AC_CAMPAIGN_NAME_RE);
      if (!m) return null;
      return { id: c.id, email: m[1].toLowerCase(), subject: m[2], opens: +c.uniqueopens || 0, clicks: +c.uniquelinkclicks || 0, sdate: c.sdate };
    })
    .filter(Boolean);
}
// Merges the subset of oneToOneCampaigns matching this contact's email.
// Dedup key is the AC campaign id (stable across re-runs); only ever ADDS
// an 'opened'/'clicked' statusHistory entry, matching Close's import
// behavior -- there's no exact open/click timestamp from AC's aggregate
// campaign stats, so sdate (send date) stands in for all three.
// existingIdsIndex is an optional caller-owned Set, mutated in place, so a
// bulk import can build the dedup index ONCE (single pass over the log) and
// reuse it across every contact instead of paying log.filter().map() -- a
// full scan of the ENTIRE message log -- on every single call. At ~900K+
// log entries that scan alone was confirmed live to dominate per-contact
// cost and get WORSE as the log grows, on top of the real API latency.
// Falls back to the old rebuild-from-log behavior when omitted (the
// single-contact admin/test path, where a fresh scan costs nothing).
// pendingBuffer: caller-owned array (see appendJsonRecords in
// auth_backend.js) -- when provided, new records are pushed there instead
// of being read/written through the full message log array. Confirmed live
// tonight: readJson(MESSAGE_LOG_FILE) at 4M+ records materializes the whole
// log as parsed JS objects and blows the import script's heap just to push
// a handful of new entries. The single-contact/admin path (no pendingBuffer)
// keeps the old small-scale read-modify-write behavior, which is fine at
// that scale.
export function mergeAcCampaigns(contact, oneToOneCampaigns, existingIdsIndex, pendingBuffer) {
  const matches = oneToOneCampaigns.filter(c => c.email === contact.email?.toLowerCase());
  if (!matches.length) return 0;
  const log = pendingBuffer ? null : readJson(MESSAGE_LOG_FILE, []);
  const existingIds = existingIdsIndex || new Set(log.filter(m => m.acCampaignId).map(m => m.acCampaignId));
  let added = 0;
  matches.forEach(c => {
    if (existingIds.has(c.id)) return;
    const statusHistory = [{ status: "sent", at: c.sdate }];
    if (c.opens > 0) statusHistory.push({ status: "opened", at: c.sdate });
    if (c.clicks > 0) statusHistory.push({ status: "clicked", at: c.sdate });
    const record = {
      id: randomUUID(), channel: "email", direction: "outbound",
      contactId: contact.id, sourceType: "ac_import", sourceId: null, providerMessageId: null,
      to: contact.email, from: null, subject: c.subject || "(no subject)",
      body: "", bodyPreview: c.subject || "",
      status: "sent", statusHistory,
      sentAt: c.sdate, createdAt: c.sdate || new Date().toISOString(),
      inboxDone: true, acCampaignId: c.id,
    };
    if (pendingBuffer) pendingBuffer.push(record); else log.push(record);
    existingIds.add(c.id);
    added++;
  });
  if (added && !pendingBuffer) writeJson(MESSAGE_LOG_FILE, log);
  return added;
}

// AC's per-contact /activities feed (distinct from the flat /emailActivities
// resource, which carries no usable open/click signal at all -- confirmed by
// testing a contact with a KNOWN real open against it and finding nothing).
// This one returns real per-recipient SEND records (`logs`) and CLICK
// records (`linkData`, with timestamp/ip/user-agent/click-count) for BOTH
// bulk and 1:1 campaigns -- broader than mergeAcCampaigns's 265-campaign
// "1:1 →" name-matching, which stays in place since it's still the only
// source for aggregate open COUNTS on a send. Pure pixel-only opens (no
// click) are NOT exposed anywhere in AC's API -- checked the send records,
// a dedicated trackingLogs resource (turned out to be website page-visit
// tracking, unrelated), and every linked sub-resource on the campaign
// object itself. Confirmed absent, not just unfound.
async function fetchAcContactActivities(acContactId) {
  const r = await fetch(`${AC_BASE}/api/3/activities?contact=${acContactId}&limit=100`, { headers: { "Api-Token": process.env.AC_API_KEY } });
  if (!r.ok) return { logs: [], linkData: [] };
  const d = await r.json();
  return { logs: d.logs || [], linkData: d.linkData || [] };
}
const acCampaignNameCache = new Map();
// Bulk-populates the same cache acCampaignName() reads from a single
// paginated sweep of ALL campaigns, instead of one single-record API call
// per distinct campaign id encountered. Without this, a bulk import hits
// acCampaignName's lazy per-id fetch for every not-yet-seen campaign on
// every contact -- a contact with years of send/click history can touch
// dozens of distinct campaigns, meaning dozens of SEQUENTIAL API calls
// before that one contact's activities merge finishes. Confirmed live: this
// alone caused near-every contact to exceed a 20s timeout in the bulk
// importer. Call once, up front, same pattern as fetchAcOneToOneCampaigns.
export async function preloadAcCampaignNames() {
  const map = await fetchAcIdNameMap("campaigns");
  for (const [id, name] of map) acCampaignNameCache.set(id, name || `Campaign ${id}`);
  return acCampaignNameCache.size;
}
async function acCampaignName(campaignId) {
  if (acCampaignNameCache.has(campaignId)) return acCampaignNameCache.get(campaignId);
  const r = await fetch(`${AC_BASE}/api/3/campaigns/${campaignId}`, { headers: { "Api-Token": process.env.AC_API_KEY } });
  const name = r.ok ? (await r.json()).campaign?.name : null;
  acCampaignNameCache.set(campaignId, name || `Campaign ${campaignId}`);
  return acCampaignNameCache.get(campaignId);
}
// Dedup key is AC's own log/linkData row id (stable across re-runs).
// existingIdsIndex, pendingBuffer: see mergeAcCampaigns's comment -- same
// fix, same reason.
export async function mergeAcContactActivities(contact, acContactId, existingIdsIndex, pendingBuffer) {
  const { logs, linkData } = await fetchAcContactActivities(acContactId);
  const log = pendingBuffer ? null : readJson(MESSAGE_LOG_FILE, []);
  const existingIds = existingIdsIndex || new Set(log.filter(m => m.acActivityId).map(m => m.acActivityId));
  let added = 0;
  for (const l of logs) {
    const acActivityId = `ac_send:${l.id}`;
    if (existingIds.has(acActivityId)) continue;
    const name = await acCampaignName(l.campaign);
    const record = {
      id: randomUUID(), channel: "email", direction: "outbound",
      contactId: contact.id, sourceType: "ac_import", sourceId: null, providerMessageId: null,
      to: contact.email, from: null, subject: `Sent: ${name}`, body: "", bodyPreview: name,
      status: "sent", statusHistory: [{ status: "sent", at: l.tstamp }],
      sentAt: l.tstamp, createdAt: l.tstamp || new Date().toISOString(),
      inboxDone: true, acActivityId,
    };
    if (pendingBuffer) pendingBuffer.push(record); else log.push(record);
    existingIds.add(acActivityId);
    added++;
  }
  for (const c of linkData) {
    const acActivityId = `ac_click:${c.id}`;
    if (existingIds.has(acActivityId)) continue;
    const name = await acCampaignName(c.campaign);
    const record = {
      id: randomUUID(), channel: "email", direction: "outbound",
      contactId: contact.id, sourceType: "ac_import", sourceId: null, providerMessageId: null,
      to: contact.email, from: null, subject: `Clicked: ${name}`,
      body: `ip=${c.ip || ""} ua=${c.ua || ""} times=${c.times || 1}`, bodyPreview: name,
      status: "clicked", statusHistory: [{ status: "clicked", at: c.tstamp }],
      sentAt: c.tstamp, createdAt: c.tstamp || new Date().toISOString(),
      inboxDone: true, acActivityId,
    };
    if (pendingBuffer) pendingBuffer.push(record); else log.push(record);
    existingIds.add(acActivityId);
    added++;
  }
  if (added && !pendingBuffer) writeJson(MESSAGE_LOG_FILE, log);
  return added;
}

// Matched first by the provider's own id (repeatable imports never
// duplicate), falling back to email match (catches a contact that already
// exists from a Framer form submission or manual entry, so importing
// doesn't create a second copy of someone already in the system).
export async function upsertFromAc(acContact, defaultStatus, tagMap, listMap) {
  const contacts = readJson(CONTACTS_FILE, []);
  const email = (acContact.email || "").toLowerCase();
  let contact = contacts.find(c => c.externalIds?.acContactId === acContact.id) || findContactMatch(contacts, email, acContact.phone);
  if (contact) {
    contact.first = acContact.firstName || contact.first;
    contact.last = acContact.lastName || contact.last;
    contact.phone = acContact.phone || contact.phone;
    contact.externalIds.acContactId = acContact.id;
    markFirstSeen(contact, acContact.cdate);
    contact.updatedAt = new Date().toISOString();
  } else {
    contact = {
      id: randomUUID(), type: "contact", accountName: "",
      first: acContact.firstName || "", last: acContact.lastName || "", email, phone: acContact.phone || "",
      status: defaultStatus || "", tags: [], listIds: [], customFields: {}, source: "ac_import", ownerId: null,
      emailOptOut: false, smsOptOut: false, externalIds: { acContactId: acContact.id, closeLeadId: null },
      firstSeenAt: acContact.cdate || new Date().toISOString(),
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    contacts.push(contact);
  }
  if (tagMap && listMap) await enrichAcContact(contact, acContact.id, tagMap, listMap);
  writeJson(CONTACTS_FILE, contacts);
  return contact;
}

// Close's "Lead" is company-level with a nested contacts[] array -- flatten
// each nested person into its own CRM contact, sharing the lead's
// accountName/status.
// Close statuses that mean "never text this person again" -- checked
// against whatever status the lead ends up with (existing contact's
// current status kept if Close has none, matching the line below).
const SMS_BLOCKED_STATUSES = ["STOP", "BAD FIT / BLACKLIST"];
// Close's address object shape is {label, address_1, address_2, city,
// state, zipcode, country} -- joins whichever parts are actually present
// into one readable line rather than assuming every field is populated.
export function formatCloseAddress(addr) {
  return [addr.address_1, addr.address_2, addr.city, addr.state, addr.zipcode, addr.country].filter(Boolean).join(", ");
}
export function upsertFromCloseLead(lead, defaultStatus) {
  const contacts = readJson(CONTACTS_FILE, []);
  const nested = lead.contacts?.length ? lead.contacts : [{ name: lead.display_name, emails: [], phones: [] }];
  const leadAddress = (lead.addresses || []).map(formatCloseAddress).filter(Boolean).join(" | ");
  let count = 0;
  const touched = [];
  nested.forEach(nc => {
    const email = (nc.emails?.[0]?.email || "").toLowerCase();
    const phone = nc.phones?.[0]?.phone || "";
    const parts = (nc.name || lead.display_name || "").trim().split(/\s+/);
    const first = parts[0] || "", last = parts.slice(1).join(" ");
    let contact = contacts.find(c => c.externalIds?.closeLeadId === lead.id && c.email === email) || findContactMatch(contacts, email, phone);
    if (contact) {
      contact.accountName = lead.display_name || contact.accountName;
      contact.status = lead.status_label || contact.status;
      contact.externalIds.closeLeadId = lead.id;
      if (leadAddress) contact.address = leadAddress;
      markFirstSeen(contact, lead.date_created);
      contact.updatedAt = new Date().toISOString();
    } else {
      contact = {
        id: randomUUID(), type: "lead", accountName: lead.display_name || "",
        first, last, email, phone, address: leadAddress || "",
        status: lead.status_label || defaultStatus || "", tags: [], listIds: [], customFields: {}, source: "close_import", ownerId: null,
        emailOptOut: false, smsOptOut: false, externalIds: { acContactId: null, closeLeadId: lead.id },
        firstSeenAt: lead.date_created || new Date().toISOString(),
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      };
      contacts.push(contact);
    }
    // Never downgrades an existing true back to false -- once blocked from
    // SMS by status, a later re-import with a stale/different status label
    // must not silently re-enable texting.
    if (SMS_BLOCKED_STATUSES.includes(contact.status)) contact.smsOptOut = true;
    // Close's own native per-email unsubscribe flag (contacts[].emails[].
    // is_unsubscribed) -- distinct from this app's own SES unsubscribe
    // link, but the same one-way latch: Close saying "unsubscribed" once
    // must not get silently cleared by a later re-import.
    if (nc.emails?.[0]?.is_unsubscribed) contact.emailOptOut = true;
    count++;
    touched.push(contact);
  });
  writeJson(CONTACTS_FILE, contacts);
  return { count, contacts: touched };
}

// Pulls every email/SMS/call activity Close has on a lead and merges it
// into this app's own message log / calls store, so a contact who
// pre-dates this CRM (imported from Close) shows their real conversation
// history in the Inbox instead of an empty thread. Paginated, capped per
// type so one contact with years of activity can't run away; re-running is
// safe since every inserted row is deduped on its Close activity id.
const CLOSE_HISTORY_PAGE_LIMIT = 100;
const CLOSE_HISTORY_MAX_PER_TYPE = 500;
async function fetchAllCloseActivities(leadId, type) {
  const auth = "Basic " + Buffer.from(process.env.CLOSE_API_KEY + ":").toString("base64");
  const all = [];
  let skip = 0;
  while (all.length < CLOSE_HISTORY_MAX_PER_TYPE) {
    const r = await closeFetch(`${CLOSE_BASE}/activity/${type}/?lead_id=${leadId}&_skip=${skip}&_limit=${CLOSE_HISTORY_PAGE_LIMIT}`, { headers: { Authorization: auth } });
    if (!r.ok) throw new Error(`Close ${type} activity API error ${r.status}`);
    const data = await r.json();
    all.push(...(data.data || []));
    if (!data.has_more || !data.data?.length) break;
    skip += data.data.length;
  }
  return all;
}
function closeEmailAddress(raw) {
  // Close stores email participants as "Name <addr@x.com>" (from) or a
  // plain-string array (to/cc) -- pull just the address out either way.
  const match = String(raw || "").match(/<([^>]+)>/);
  return (match ? match[1] : raw || "").toLowerCase();
}
// Close records real per-recipient opens on each email activity (an
// `opens` array of {opened_at, opened_by}) -- no click data exists on this
// endpoint at all, so `clicked` never gets a statusHistory entry from a
// Close import (only a future email sent through this CRM's own SES path,
// which already has real click tracking, can ever show a Clicked badge).
function closeStatusHistory(a) {
  const history = [{ status: "sent", at: a.date_created || a.activity_at }];
  const firstOpen = (a.opens || [])[0];
  if (firstOpen?.opened_at) history.push({ status: "opened", at: firstOpen.opened_at });
  return history;
}
function mergeCloseEmails(contact, activities, existingIdsIndex, pendingBuffer) {
  const log = pendingBuffer ? null : readJson(MESSAGE_LOG_FILE, []);
  const existingIds = existingIdsIndex || new Set(log.filter(m => m.closeActivityId).map(m => m.closeActivityId));
  let added = 0;
  activities.forEach(a => {
    if (existingIds.has(a.id)) return;
    const record = {
      id: randomUUID(), channel: "email",
      direction: a.direction === "incoming" ? "inbound" : "outbound",
      contactId: contact.id, sourceType: "close_import", sourceId: null, providerMessageId: null,
      to: (a.to || []).map(closeEmailAddress).join(", ") || null,
      from: closeEmailAddress(a.sender) || null,
      subject: a.subject || "(no subject)",
      body: a.body_html || a.body_text || "",
      bodyPreview: (a.body_preview || a.body_text || "").slice(0, 200),
      status: "sent", statusHistory: closeStatusHistory(a),
      sentAt: a.date_sent || a.date_created || null,
      createdAt: a.activity_at || a.date_created || new Date().toISOString(),
      // Historical activity that already happened before this contact was
      // in the Inbox -- never counts toward the unread badge.
      inboxDone: true,
      closeActivityId: a.id,
    };
    if (pendingBuffer) pendingBuffer.push(record); else log.push(record);
    existingIds.add(a.id);
    added++;
  });
  if (added && !pendingBuffer) writeJson(MESSAGE_LOG_FILE, log);
  return added;
}
// Close keeps recording opens on an email after the fact (someone can open
// a message days later), and this app only captured opens AT IMPORT TIME --
// so re-running an import for a contact should also refresh already-merged
// rows, not just add brand-new ones. Matched by closeActivityId; only ever
// ADDS an 'opened' entry, never removes one.
//
// Not called from the bulk import path at all (see pullCloseHistoryForContact
// below): this UPDATES an existing row in place, which needs the whole log
// held as parsed objects to find-and-mutate -- exactly what the bulk path's
// pendingBuffer/appendJsonRecords design exists to avoid at multi-million-
// record scale. It's also genuinely a no-op on a first-time historical
// import: closeStatusHistory already bakes in whatever open state existed
// at fetch time when mergeCloseEmails creates the row, so there's nothing
// yet-to-refresh. It stays wired up for the live/admin re-run path, where a
// contact's activities were already imported earlier and may have picked up
// a late open since.
function refreshCloseEmailOpens(activities) {
  const log = readJson(MESSAGE_LOG_FILE, []);
  let updated = 0;
  activities.forEach(a => {
    const firstOpen = (a.opens || [])[0];
    if (!firstOpen?.opened_at) return;
    const row = log.find(m => m.closeActivityId === a.id);
    if (!row || row.statusHistory?.some(h => h.status === "opened")) return;
    row.statusHistory = [...(row.statusHistory || []), { status: "opened", at: firstOpen.opened_at }];
    updated++;
  });
  if (updated) writeJson(MESSAGE_LOG_FILE, log);
  return updated;
}
function mergeCloseSms(contact, activities, existingIdsIndex, pendingBuffer) {
  const log = pendingBuffer ? null : readJson(MESSAGE_LOG_FILE, []);
  const existingIds = existingIdsIndex || new Set(log.filter(m => m.closeActivityId).map(m => m.closeActivityId));
  let added = 0;
  activities.forEach(a => {
    if (existingIds.has(a.id)) return;
    const outbound = a.direction === "outbound";
    const record = {
      id: randomUUID(), channel: "sms", direction: outbound ? "outbound" : "inbound",
      contactId: contact.id, sourceType: "close_import", sourceId: null, providerMessageId: null,
      to: outbound ? a.remote_phone : a.local_phone, from: outbound ? a.local_phone : a.remote_phone,
      subject: null, body: a.text || "", bodyPreview: (a.text || "").slice(0, 200),
      status: a.status || "sent", statusHistory: [{ status: a.status || "sent", at: a.date_created || a.activity_at }],
      sentAt: a.date_sent || a.date_created || null,
      createdAt: a.activity_at || a.date_created || new Date().toISOString(),
      inboxDone: true,
      closeActivityId: a.id,
    };
    if (pendingBuffer) pendingBuffer.push(record); else log.push(record);
    existingIds.add(a.id);
    added++;
  });
  if (added && !pendingBuffer) writeJson(MESSAGE_LOG_FILE, log);
  // Re-derived from the contact's full (now-merged) SMS history rather than
  // per-activity during the loop above -- Close doesn't guarantee activities
  // arrive in chronological order, and only the chronologically LATEST
  // inbound message should ever be able to set someone to STOP (see
  // recheckStopStatus's own doc comment for why: a lead who said "stop"
  // once but kept replying normally afterward must not get retroactively
  // suppressed just because "stop" appears somewhere in their history).
  // Skipped here in bulk mode (pendingBuffer set) -- the bulk import path
  // calls recheckStopStatusFromActivities itself with the same SMS
  // activities already in hand, instead of paying for another full
  // multi-million-record message-log read per contact.
  if (added && !pendingBuffer) recheckStopStatus(contact.id);
  return added;
}
function mergeCloseCalls(contact, activities, existingIdsIndex, pendingBuffer) {
  const calls = pendingBuffer ? null : readJson(CALLS_FILE, []);
  const existingIds = existingIdsIndex || new Set(calls.filter(c => c.closeActivityId).map(c => c.closeActivityId));
  let added = 0;
  activities.forEach(a => {
    if (existingIds.has(a.id)) return;
    const noteText = (a.note || "").trim();
    const record = {
      id: randomUUID(), contactId: contact.id,
      direction: a.direction === "inbound" ? "inbound" : "outbound",
      notes: noteText || `${a.disposition || a.status || "Call"} · ${a.duration || 0}s`,
      duration: a.duration || 0,
      createdAt: a.activity_at || a.date_created || new Date().toISOString(),
      createdBy: null,
      closeActivityId: a.id,
    };
    if (pendingBuffer) pendingBuffer.push(record); else calls.push(record);
    existingIds.add(a.id);
    added++;
  });
  if (added && !pendingBuffer) writeJson(CALLS_FILE, calls);
  return added;
}
// Close's Notes are modeled as an activity type, same /activity/{type}/
// pagination shape as email/sms/call.
async function fetchAllCloseNotes(leadId) {
  return fetchAllCloseActivities(leadId, "note");
}
export function mergeCloseNotes(contact, notes, existingIdsIndex, pendingBuffer) {
  let added = 0;
  notes.forEach(n => {
    if (existingIdsIndex.has(n.id)) return;
    pendingBuffer.push({
      id: randomUUID(), contactId: contact.id,
      text: n.note || "",
      createdAt: n.activity_at || n.date_created || new Date().toISOString(),
      createdBy: null,
      closeNoteId: n.id,
    });
    existingIdsIndex.add(n.id);
    added++;
  });
  return added;
}
// Close's Tasks live under a top-level /task/ resource filtered by
// lead_id, NOT under /activity/{type}/ like email/sms/call/note -- separate
// paginator to match.
async function fetchAllCloseTasks(leadId) {
  const auth = "Basic " + Buffer.from(process.env.CLOSE_API_KEY + ":").toString("base64");
  const all = [];
  let skip = 0;
  while (all.length < CLOSE_HISTORY_MAX_PER_TYPE) {
    const r = await closeFetch(`${CLOSE_BASE}/task/?lead_id=${leadId}&_skip=${skip}&_limit=${CLOSE_HISTORY_PAGE_LIMIT}`, { headers: { Authorization: auth } });
    if (!r.ok) throw new Error(`Close task API error ${r.status}`);
    const data = await r.json();
    all.push(...(data.data || []));
    if (!data.has_more || !data.data?.length) break;
    skip += data.data.length;
  }
  return all;
}
export function mergeCloseTasks(contact, tasks, existingIdsIndex, pendingBuffer) {
  let added = 0;
  tasks.forEach(t => {
    if (existingIdsIndex.has(t.id)) return;
    pendingBuffer.push({
      id: randomUUID(), contactId: contact.id,
      type: "task", title: t.text || "Task",
      dueAt: t.due_date || t.date || null,
      done: !!t.is_complete,
      createdAt: t.date_created || new Date().toISOString(),
      createdBy: null,
      closeTaskId: t.id,
    });
    existingIdsIndex.add(t.id);
    added++;
  });
  return added;
}
// Bulk-safe stop-keyword check: recheckStopStatus (compliance_backend.js)
// re-reads the ENTIRE message log to find a contact's latest inbound SMS --
// fine at live-server scale, but at 4M+ log records that's the same
// materialize-everything cost already fixed everywhere else in the bulk
// import path. The SMS activities for this contact are already sitting in
// memory right here (mergeCloseSms just processed them), so the latest
// inbound one can be found directly from that array instead. Same one-way
// latch semantics as the original: only ever sets STOP, never clears it.
export function recheckStopStatusFromActivities(contact, smsActivities, stopKeywords) {
  if (!stopKeywords?.length || contact.status === "STOP") return false;
  const inbound = smsActivities.filter(a => a.direction !== "outbound");
  if (!inbound.length) return false;
  const latest = inbound.reduce((a, b) =>
    new Date(b.activity_at || b.date_created || 0) > new Date(a.activity_at || a.date_created || 0) ? b : a);
  if (!isStopKeyword(latest.text || "", stopKeywords)) return false;
  contact.status = "STOP";
  contact.smsOptOut = true;
  contact.updatedAt = new Date().toISOString();
  return true;
}
// Runs every fetch this contact needs from Close in ONE Promise.all instead
// of the multiple separately-awaited round-trips the single-contact/admin
// path uses (pullCloseHistoryForContact + mergeCloseSequences's own
// internal fetch) -- confirmed with AC tonight that serializing several
// independent API calls per record, multiplied across hundreds of
// thousands of records, is the dominant cost once concurrency and the
// message-log bottlenecks are fixed. indexes/buffers are the bulk import
// script's shared dedup Sets and pending-write arrays (message log, calls,
// notes, tasks) -- see _tmp_close_full_import.mjs.
export async function pullCloseHistoryForContactBulk(contact, indexes, buffers, stopKeywords) {
  const leadId = contact.externalIds?.closeLeadId;
  if (!leadId || !closeConfigured()) return;
  const [emails, sms, calls, notes, tasks, subs] = await Promise.all([
    fetchAllCloseActivities(leadId, "email"),
    fetchAllCloseActivities(leadId, "sms"),
    fetchAllCloseActivities(leadId, "call"),
    fetchAllCloseNotes(leadId),
    fetchAllCloseTasks(leadId),
    fetchCloseSequenceSubscriptions(leadId),
  ]);
  mergeCloseEmails(contact, emails, indexes.closeActivityId, buffers.log);
  mergeCloseSms(contact, sms, indexes.closeActivityId, buffers.log);
  recheckStopStatusFromActivities(contact, sms, stopKeywords);
  mergeCloseCalls(contact, calls, indexes.closeCallId, buffers.calls);
  mergeCloseNotes(contact, notes, indexes.closeNoteId, buffers.notes);
  mergeCloseTasks(contact, tasks, indexes.closeTaskId, buffers.tasks);
  await mergeCloseSequences(contact, indexes.closeSequenceSubId, buffers.log, subs);
}
// Targeted single-identity lookup (vs fetchAcBatch's bulk paginated sweep)
// -- for cross-referencing a contact already found via another source.
// AC's contact search is email-indexed, not phone, so unlike the Hyros/
// Close identity lookups this one only ever tries email.
async function fetchAcContactByEmail(email) {
  if (!email || !acConfigured()) return null;
  const r = await fetch(`${AC_BASE}/api/3/contacts?${new URLSearchParams({ email })}`, { headers: { "Api-Token": process.env.AC_API_KEY } });
  if (!r.ok) return null;
  const data = await r.json();
  return data.contacts?.[0] || null;
}

// Close-first segment import: for a filtered slice of Close leads (by
// Close's own search query -- status, custom fields, etc.), pull full
// Close history same as the bulk importer, then ALSO cross-reference AC and
// Hyros by email/phone for each one so a person found this way ends up
// exactly as fully populated as someone found via the AC or Hyros bulk
// importers. Reuses every merge/enrich helper the other three import paths
// already use -- this is just a different way of choosing WHO to import,
// not a different way of importing them.
export async function importCloseSegment(query, limit) {
  const auth = "Basic " + Buffer.from(process.env.CLOSE_API_KEY + ":").toString("base64");
  const r = await closeFetch(`${CLOSE_BASE}/lead/?${new URLSearchParams({ query, _limit: String(limit) })}`, { headers: { Authorization: auth } });
  if (!r.ok) throw new Error(`Close search API error ${r.status}`);
  const leads = (await r.json()).data || [];

  // Tags/lists are cheap (~1-2 pages each) so fetched up front; the FULL
  // account-wide campaigns sweep (fetchAcOneToOneCampaigns) is by far the
  // most expensive call this makes (thousands of campaigns, tens of
  // sequential pages) -- for a small targeted segment, most contacts may
  // not even have an AC match at all, so it's fetched lazily on the FIRST
  // AC match found and cached for the rest of this run, instead of paying
  // that cost unconditionally even when nobody in the batch needs it.
  const [tagMap, listMap] = await Promise.all([fetchAcIdNameMap("tags"), fetchAcIdNameMap("lists")]);
  let oneToOneCampaigns = null;

  const contactIds = [];
  for (const lead of leads) {
    const { contacts: touched } = upsertFromCloseLead(lead, null);
    for (const contact of touched) {
      await pullCloseHistoryForContact(contact);
      await mergeCloseSequences(contact);
      mergeCloseCustomFields(contact, lead.custom);
      persistContact(contact);

      const acContact = await fetchAcContactByEmail(contact.email);
      if (acContact) {
        if (!oneToOneCampaigns) oneToOneCampaigns = await fetchAcOneToOneCampaigns();
        const all = readJson(CONTACTS_FILE, []);
        const stored = all.find(c => c.id === contact.id);
        if (stored) {
          stored.externalIds.acContactId = acContact.id;
          stored.first = stored.first || acContact.firstName || "";
          stored.last = stored.last || acContact.lastName || "";
          markFirstSeen(stored, acContact.cdate);
          await enrichAcContact(stored, acContact.id, tagMap, listMap);
          writeJson(CONTACTS_FILE, all);
          mergeAcCampaigns(stored, oneToOneCampaigns);
          await mergeAcContactActivities(stored, acContact.id);
        }
      }

      const hyrosLead = await searchHyrosLeadByIdentity(contact.email, contact.phone);
      if (hyrosLead) {
        const all = readJson(CONTACTS_FILE, []);
        const stored = all.find(c => c.id === contact.id);
        if (stored) {
          stored.externalIds.hyrosLeadId = hyrosLead.id;
          markFirstSeen(stored, hyrosLead.creationDate);
          (hyrosLead.tags || []).forEach(name => {
            const tag = getOrCreateTag(name);
            if (tag && !stored.tags.includes(tag.id)) stored.tags.push(tag.id);
          });
          writeJson(CONTACTS_FILE, all);
          mergeHyrosActivity(stored, hyrosLead);
        }
      }
      contactIds.push(contact.id);
    }
  }
  return { foundInClose: leads.length, imported: contactIds.length, contactIds };
}
export async function pullCloseHistoryForContact(contact) {
  const leadId = contact.externalIds?.closeLeadId;
  if (!leadId) return { ok: false, reason: "Contact has no linked Close lead" };
  if (!closeConfigured()) return { ok: false, reason: "CLOSE_API_KEY isn't set" };
  const [emails, sms, calls] = await Promise.all([
    fetchAllCloseActivities(leadId, "email"),
    fetchAllCloseActivities(leadId, "sms"),
    fetchAllCloseActivities(leadId, "call"),
  ]);
  const emailsAdded = mergeCloseEmails(contact, emails);
  return {
    ok: true,
    emailsAdded, opensRefreshed: refreshCloseEmailOpens(emails),
    smsAdded: mergeCloseSms(contact, sms),
    callsAdded: mergeCloseCalls(contact, calls),
  };
}

export async function handleImportRequest(req, res, url) {
  const p = url.pathname;
  if (!p.startsWith("/api/import")) return false;
  const me = getSessionUser(req);
  if (!me) return sendJson(res, 401, { error: "Not logged in" });
  if (!isAdmin(me)) return sendJson(res, 403, { error: "Admins only" });

  if (p === "/api/import/config-status" && req.method === "GET") {
    return sendJson(res, 200, { activecampaign: acConfigured(), close: closeConfigured(), hyros: hyrosConfigured() });
  }

  // One-off (re-runnable) catch-up: fills in status for any AC/Hyros
  // contact that's missing one, via the same live Close cross-reference the
  // import loop now runs automatically -- needed for contacts imported
  // BEFORE that cross-reference existed, or before their matching Close
  // lead existed yet.
  if (p === "/api/import/backfill-status" && req.method === "POST") {
    if (!closeConfigured()) return sendJson(res, 400, { error: "CLOSE_API_KEY isn't set yet." });
    const all = readJson(CONTACTS_FILE, []);
    const statusTargets = all.filter(c => ["ac_import", "hyros_import"].includes(c.source) && (!c.status || (!c.first && !c.last)));
    let statusUpdated = 0;
    for (const contact of statusTargets) {
      const before = `${contact.status}|${contact.first}`;
      await enrichStatusFromClose(contact);
      if (`${contact.status}|${contact.first}` !== before) statusUpdated++;
    }
    // Separate pass, by closeLeadId directly (not email/phone search) --
    // covers every Close-linked contact regardless of source, including
    // ones the status pass above just linked and ones already linked
    // before this feature existed.
    const fieldTargets = readJson(CONTACTS_FILE, []).filter(c => c.externalIds?.closeLeadId);
    let fieldsUpdated = 0;
    for (const contact of fieldTargets) {
      const lead = await fetchCloseLeadById(contact.externalIds.closeLeadId);
      if (!lead?.custom) continue;
      const before = JSON.stringify(contact.customFields);
      mergeCloseCustomFields(contact, lead.custom);
      if (JSON.stringify(contact.customFields) !== before) { persistContact(contact); fieldsUpdated++; }
    }
    return sendJson(res, 200, { ok: true, statusChecked: statusTargets.length, statusUpdated, fieldsChecked: fieldTargets.length, fieldsUpdated });
  }

  // Close-first segment import, e.g. { query: 'status:"ENROLLED" custom.TYPE:"ONLINE"', limit: 10 }
  // -- Close's own search syntax (status/custom fields/etc), cross-referenced
  // against AC and Hyros for each match. See importCloseSegment's own comment.
  if (p === "/api/import/close-segment" && req.method === "POST") {
    if (!closeConfigured()) return sendJson(res, 400, { error: "CLOSE_API_KEY isn't set yet." });
    const { query, limit } = await readJsonBody(req);
    if (!query) return sendJson(res, 400, { error: "query is required (Close search syntax)" });
    try {
      const result = await importCloseSegment(query, Math.min(limit || 10, 50));
      return sendJson(res, 200, { ok: true, ...result });
    } catch (e) {
      return sendJson(res, 502, { error: e.message });
    }
  }

  if (p === "/api/import/jobs" && req.method === "GET") {
    return sendJson(res, 200, { jobs: readJson(IMPORT_JOBS_FILE, []) });
  }
  if (p === "/api/import/jobs" && req.method === "POST") {
    const { source, batchSize, defaultStatus } = await readJsonBody(req);
    if (!["activecampaign", "close", "hyros"].includes(source)) return sendJson(res, 400, { error: "source must be 'activecampaign', 'close', or 'hyros'" });
    const jobs = readJson(IMPORT_JOBS_FILE, []);
    // Reuse an existing not-yet-completed job for this source rather than
    // starting a second parallel one -- "Start Import" is really "resume".
    let job = jobs.find(j => j.source === source && j.status !== "completed");
    if (!job) {
      // Deliberately small default batch size -- this is manual-triggered,
      // one batch per click, never an unattended loop that could import
      // (and then automatically enroll into automations/workflows) a huge
      // batch of contacts unattended. cursor is a numeric offset for
      // AC/Close, but a Hyros pageId (string) for hyros -- same field,
      // different meaning per source, since job storage doesn't need a
      // stricter shape than that.
      job = { id: randomUUID(), source, status: "idle", cursor: 0, batchSize: batchSize || 50, defaultStatus: defaultStatus || null, totalImported: 0, totalSkipped: 0, totalErrors: 0, errors: [], startedAt: new Date().toISOString(), lastRunAt: null, completedAt: null };
      jobs.push(job);
      writeJson(IMPORT_JOBS_FILE, jobs);
    }
    return sendJson(res, 200, { ok: true, job });
  }

  const runMatch = p.match(/^\/api\/import\/jobs\/([^/]+)\/run$/);
  if (runMatch && req.method === "POST") {
    const jobs = readJson(IMPORT_JOBS_FILE, []);
    const job = jobs.find(j => j.id === runMatch[1]);
    if (!job) return sendJson(res, 404, { error: "Not found" });
    if (job.status === "completed") return sendJson(res, 200, { ok: true, job, done: true });

    if (job.source === "activecampaign" && !acConfigured()) return sendJson(res, 400, { error: "AC_API_KEY isn't set yet." });
    if (job.source === "close" && !closeConfigured()) return sendJson(res, 400, { error: "CLOSE_API_KEY isn't set yet." });
    if (job.source === "hyros" && !hyrosConfigured()) return sendJson(res, 400, { error: "HYROS_API_KEY isn't set yet." });

    try {
      if (job.source === "activecampaign") {
        const result = await fetchAcBatch(job.cursor, job.batchSize);
        if (!result.ok) { job.status = "error"; job.errors.push({ externalId: null, message: result.reason }); writeJson(IMPORT_JOBS_FILE, jobs); return sendJson(res, 400, { error: result.reason }); }
        // Fetched once per batch run and reused across every contact in it
        // -- tag/list names and the 1:1-campaign email history don't need
        // re-fetching per contact.
        const [tagMap, listMap, oneToOneCampaigns] = await Promise.all([
          fetchAcIdNameMap("tags"), fetchAcIdNameMap("lists"), fetchAcOneToOneCampaigns(),
        ]);
        for (const c of result.contacts) {
          try {
            // Close is the one authoritative source of pipeline status --
            // AC has no equivalent field, so a brand-new contact is created
            // with no status, Close gets a chance to fill in the real one,
            // and job.defaultStatus (if set) only applies as a last resort
            // when Close doesn't have this person either.
            const contact = await upsertFromAc(c, null, tagMap, listMap);
            mergeAcCampaigns(contact, oneToOneCampaigns);
            await enrichStatusFromClose(contact);
            if (!contact.status && job.defaultStatus) applyFallbackStatus(contact, job.defaultStatus);
            job.totalImported++;
          } catch (e) { job.totalErrors++; job.errors.push({ externalId: c.id, message: e.message }); }
        }
        job.cursor += result.contacts.length;
        job.status = result.contacts.length < job.batchSize ? "completed" : "idle";
      } else if (job.source === "close") {
        const result = await fetchCloseBatch(job.cursor, job.batchSize);
        if (!result.ok) { job.status = "error"; job.errors.push({ externalId: null, message: result.reason }); writeJson(IMPORT_JOBS_FILE, jobs); return sendJson(res, 400, { error: result.reason }); }
        for (const lead of result.leads) {
          try {
            const { count, contacts: touched } = upsertFromCloseLead(lead, job.defaultStatus);
            job.totalImported += count;
            for (const contact of touched) {
              await pullCloseHistoryForContact(contact);
              await mergeCloseSequences(contact);
              mergeCloseCustomFields(contact, lead.custom);
              persistContact(contact);
            }
          } catch (e) { job.totalErrors++; job.errors.push({ externalId: lead.id, message: e.message }); }
        }
        job.cursor += result.leads.length;
        job.status = result.hasMore ? "idle" : "completed";
      } else {
        // Hyros paginates by cursor (pageId), not numeric offset -- job.cursor
        // holds whatever nextPageId came back last run, or 0 (falsy) to start
        // from the first page.
        const result = await fetchHyrosLeadsPage(job.cursor || null, job.batchSize);
        if (!result.ok) { job.status = "error"; job.errors.push({ externalId: null, message: result.reason }); writeJson(IMPORT_JOBS_FILE, jobs); return sendJson(res, 400, { error: result.reason }); }
        for (const lead of result.leads) {
          try {
            const contact = upsertFromHyros(lead, null);
            mergeHyrosActivity(contact, lead);
            await enrichStatusFromClose(contact);
            if (!contact.status && job.defaultStatus) applyFallbackStatus(contact, job.defaultStatus);
            job.totalImported++;
          } catch (e) { job.totalErrors++; job.errors.push({ externalId: lead.id, message: e.message }); }
        }
        job.cursor = result.nextPageId || 0;
        job.status = result.nextPageId ? "idle" : "completed";
      }
      if (job.status === "completed") job.completedAt = new Date().toISOString();
      job.lastRunAt = new Date().toISOString();
      if (job.errors.length > 50) job.errors = job.errors.slice(-50);
      writeJson(IMPORT_JOBS_FILE, jobs);
      return sendJson(res, 200, { ok: true, job, done: job.status === "completed" });
    } catch (e) {
      job.status = "error"; job.errors.push({ externalId: null, message: e.message });
      writeJson(IMPORT_JOBS_FILE, jobs);
      return sendJson(res, 500, { error: e.message });
    }
  }

  // On-demand pull of one contact's full Close activity history (email/SMS/
  // call) into the Inbox -- separate from the bulk lead import job above,
  // since this is triggered per-contact (e.g. right before viewing them in
  // the Inbox) rather than as a background catch-up job.
  if (p === "/api/import/close-history" && req.method === "POST") {
    const { contactId } = await readJsonBody(req);
    const contact = readJson(CONTACTS_FILE, []).find(c => c.id === contactId);
    if (!contact) return sendJson(res, 404, { error: "Contact not found" });
    try {
      const result = await pullCloseHistoryForContact(contact);
      if (!result.ok) return sendJson(res, 400, { error: result.reason });
      return sendJson(res, 200, result);
    } catch (e) {
      return sendJson(res, 502, { error: e.message });
    }
  }

  // Manual import -- paste/CSV, no external API. Parsing happens client-side
  // (settings.html builds the mapped `records` array so the user sees a
  // live preview before importing); this endpoint just upserts, matched by
  // email the same way the AC/Close importers do.
  if (p === "/api/import/manual" && req.method === "POST") {
    const { records, defaultStatus } = await readJsonBody(req);
    if (!Array.isArray(records) || !records.length) return sendJson(res, 400, { error: "No records to import" });
    const contacts = readJson(CONTACTS_FILE, []);
    let imported = 0, skipped = 0;
    const errors = [];
    records.forEach((r, i) => {
      try {
        const email = (r.email || "").trim().toLowerCase();
        const phone = (r.phone || "").trim();
        if (!email && !phone) { skipped++; return; }
        let contact = findContactMatch(contacts, email, phone);
        if (contact) {
          if (r.first) contact.first = r.first;
          if (r.last) contact.last = r.last;
          if (email) contact.email = email;
          if (phone) contact.phone = phone;
          if (r.status) contact.status = r.status;
          contact.customFields = { ...contact.customFields, ...(r.customFields || {}) };
          contact.updatedAt = new Date().toISOString();
        } else {
          contact = {
            id: randomUUID(), type: "contact", accountName: "",
            first: r.first || "", last: r.last || "", email, phone,
            status: r.status || defaultStatus || "", tags: [], listIds: [], customFields: r.customFields || {},
            source: "manual_import", ownerId: null, emailOptOut: false, smsOptOut: false,
            externalIds: { acContactId: null, closeLeadId: null },
            createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
          };
          contacts.push(contact);
        }
        imported++;
      } catch (e) { errors.push({ row: i, message: e.message }); }
    });
    writeJson(CONTACTS_FILE, contacts);
    return sendJson(res, 200, { ok: true, imported, skipped, errors });
  }

  return false;
}
