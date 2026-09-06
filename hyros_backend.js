import { randomUUID } from "crypto";
import { readJson, writeJson } from "./auth_backend.js";
import { CONTACTS_FILE, findContactMatch, markFirstSeen, digitsOnly } from "./segments_shared.js";
import { MESSAGE_LOG_FILE } from "./message_log.js";
import { getOrCreateTag } from "./contacts_backend.js";
import { syncContactFields } from "./sqlite_inbox.js";

// Base URL confirmed by live testing, not just docs -- the published
// api-docs.hyros.com spec omits the server URL entirely; the real base
// carries an extra "/v1" segment ahead of "/api/v1.0" that isn't obvious
// from the docs (https://api.hyros.com/v1/api/v1.0/...).
const HYROS_BASE = "https://api.hyros.com/v1/api/v1.0";

export function hyrosConfigured() { return !!process.env.HYROS_API_KEY; }

// Cursor-based pagination (pageId), unlike AC/Close's numeric offset --
// callers store whatever nextPageId comes back and pass it straight through
// next call; a falsy nextPageId means the last page was reached.
export async function fetchHyrosLeadsPage(pageId, pageSize) {
  const params = new URLSearchParams({ pageSize: String(pageSize || 50) });
  if (pageId) params.set("pageId", pageId);
  const r = await fetch(`${HYROS_BASE}/leads?${params}`, { headers: { "API-Key": process.env.HYROS_API_KEY } });
  if (!r.ok) return { ok: false, reason: `Hyros API error ${r.status}` };
  const data = await r.json();
  return { ok: true, leads: data.result || [], nextPageId: data.nextPageId || null };
}

// Targeted single-identity lookup -- unlike fetchHyrosLeadsPage (bulk
// paginated sweep), this is for cross-referencing a contact ALREADY found
// via another source (e.g. a Close-first import) to see if Hyros also has
// them. Tries email first since Hyros's own dedup is email-primary.
export async function searchHyrosLeadByIdentity(email, phone) {
  const headers = { "API-Key": process.env.HYROS_API_KEY };
  if (email) {
    const r = await fetch(`${HYROS_BASE}/leads?${new URLSearchParams({ emails: email })}`, { headers });
    if (r.ok) { const d = await r.json(); if (d.result?.length) return d.result[0]; }
  }
  const phoneDigits = digitsOnly(phone);
  if (phoneDigits) {
    const r = await fetch(`${HYROS_BASE}/leads?${new URLSearchParams({ phones: phoneDigits })}`, { headers });
    if (r.ok) { const d = await r.json(); if (d.result?.length) return d.result[0]; }
  }
  return null;
}

// Matched first by Hyros's own lead id (repeatable imports never
// duplicate), falling back to email/phone -- same identity-merge rule
// every other importer in this app follows.
export function upsertFromHyros(hyrosLead, defaultStatus) {
  const contacts = readJson(CONTACTS_FILE, []);
  const email = (hyrosLead.email || "").toLowerCase();
  const phone = (hyrosLead.phoneNumbers || [])[0] || "";
  let contact = contacts.find(c => c.externalIds?.hyrosLeadId === hyrosLead.id) || findContactMatch(contacts, email, phone);
  if (contact) {
    contact.first = hyrosLead.firstName || contact.first;
    contact.last = hyrosLead.lastName || contact.last;
    contact.phone = contact.phone || phone;
    if (!contact.status && hyrosLead.currentStage) contact.status = hyrosLead.currentStage;
    contact.externalIds.hyrosLeadId = hyrosLead.id;
    markFirstSeen(contact, hyrosLead.creationDate);
    contact.updatedAt = new Date().toISOString();
  } else {
    contact = {
      id: randomUUID(), type: "contact", accountName: "",
      first: hyrosLead.firstName || "", last: hyrosLead.lastName || "", email, phone,
      status: hyrosLead.currentStage || defaultStatus || "", tags: [], listIds: [], customFields: {}, source: "hyros_import", ownerId: null,
      emailOptOut: false, smsOptOut: false, externalIds: { acContactId: null, closeLeadId: null, hyrosLeadId: hyrosLead.id },
      firstSeenAt: hyrosLead.creationDate || new Date().toISOString(),
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    contacts.push(contact);
  }
  // Hyros's own tags -- get-or-create by name so re-imports never duplicate,
  // same rule as every other tag source in this app. Every tag is kept,
  // including "!"-prefixed ones (!hyros, !clicked, !stripe-stripe, ...) --
  // explicitly wanted in the CRM, not filtered out.
  (hyrosLead.tags || []).forEach(name => {
    const tag = getOrCreateTag(name);
    if (tag && !contact.tags.includes(tag.id)) contact.tags.push(tag.id);
  });
  // Hyros returns EVERY phone/IP a lead has ever used, not just one -- the
  // main contact.phone stays a single value (matches every other source in
  // this app), but the full arrays are kept too since a mismatched phone/IP
  // between two records is exactly the signal that catches someone who
  // opted in and booked under different identities (which Hyros's own
  // dedup doesn't always catch -- see originLead below).
  if (hyrosLead.phoneNumbers?.length) contact.hyrosPhones = [...new Set([...(contact.hyrosPhones || []), ...hyrosLead.phoneNumbers])];
  if (hyrosLead.ips?.length) contact.hyrosIps = [...new Set([...(contact.hyrosIps || []), ...hyrosLead.ips])];
  // originLead: Hyros's own link from a "pre-conversion" click identity to
  // the fuller lead record once they actually convert -- sometimes under a
  // different email/phone than the original click. Captured as-is (not
  // merged into the contact's own identity) so it stays visible as a
  // distinct fact rather than silently overwriting anything.
  if (hyrosLead.originLead) {
    contact.hyrosOriginLead = {
      id: hyrosLead.originLead.id, email: hyrosLead.originLead.email || "",
      firstName: hyrosLead.originLead.firstName || "", lastName: hyrosLead.originLead.lastName || "",
      phoneNumbers: hyrosLead.originLead.phoneNumbers || [],
    };
  }
  writeJson(CONTACTS_FILE, contacts);
  try { syncContactFields(contact.id, contact); } catch (e) { console.error("[sqlite_inbox] contact sync failed:", e.message); }
  return contact;
}

// Hyros's own click/source-attribution data lives right on the lead
// (firstSource/lastSource -- no separate per-contact API call needed,
// unlike AC tags/lists or Close history). Each becomes an "activity" log
// entry so it shows up in the same chat timeline as SMS/email, distinct
// from both -- this is ad/source attribution, not a message. Deduped by a
// synthetic id (hyros lead id + first/last) so re-running an import never
// doubles these up; skips a duplicate entry when first and last source are
// literally the same click.
function hyrosSourceEntry(contact, hyrosLead, source, slot) {
  if (!source?.sourceLinkId) return null;
  return {
    id: randomUUID(), channel: "activity", direction: "inbound",
    contactId: contact.id, sourceType: "hyros_import", sourceId: null, providerMessageId: null,
    to: null, from: null,
    subject: `${slot === "first" ? "First" : "Last"} ad click: ${source.name || source.tag || "Unknown source"}`,
    body: [source.trafficSource?.name, source.category?.name].filter(Boolean).join(" · "),
    bodyPreview: source.tag || "",
    status: "logged", statusHistory: [{ status: "logged", at: source.clickDate || hyrosLead.creationDate }],
    sentAt: source.clickDate || null,
    createdAt: source.clickDate || hyrosLead.creationDate || new Date().toISOString(),
    inboxDone: true,
    hyrosActivityId: `${hyrosLead.id}:${slot}:${source.sourceLinkId}`,
  };
}
export function mergeHyrosActivity(contact, hyrosLead) {
  const log = readJson(MESSAGE_LOG_FILE, []);
  const existingIds = new Set(log.filter(m => m.hyrosActivityId).map(m => m.hyrosActivityId));
  const entries = [
    hyrosSourceEntry(contact, hyrosLead, hyrosLead.firstSource, "first"),
    hyrosLead.lastSource?.sourceLinkId !== hyrosLead.firstSource?.sourceLinkId ? hyrosSourceEntry(contact, hyrosLead, hyrosLead.lastSource, "last") : null,
  ].filter(Boolean);
  let added = 0;
  entries.forEach(e => {
    if (existingIds.has(e.hyrosActivityId)) return;
    log.push(e);
    added++;
  });
  if (added) writeJson(MESSAGE_LOG_FILE, log);
  return added;
}

// Sales and Calls are separate Hyros resources from Leads -- fetched live,
// per contact, keyed by EMAIL ONLY. Confirmed live: emails= filters
// correctly on both endpoints, but phones= on /sales and /calls silently
// ignores the filter and returns an unfiltered default page instead
// (mixing in unrelated people) -- a real bug in Hyros's API, verified by
// testing a known phone number and getting back 50 results for other
// leads entirely. /leads?phones= does NOT have this bug (still used
// safely by searchHyrosLeadByIdentity above) -- this is specific to
// /sales and /calls, so no phone fallback is used for either.
async function fetchHyrosByEmail(resource, email) {
  if (!email) return [];
  const headers = { "API-Key": process.env.HYROS_API_KEY };
  const r = await fetch(`${HYROS_BASE}/${resource}?${new URLSearchParams({ emails: email })}`, { headers });
  if (!r.ok) return [];
  const d = await r.json();
  return d.result || [];
}
export async function fetchHyrosSales(email) { return fetchHyrosByEmail("sales", email); }
export async function fetchHyrosCalls(email) { return fetchHyrosByEmail("calls", email); }

// Deduped by the sale's own Hyros id (stable across re-imports). Keeps the
// real ad-source data (platform, ad id, click id) on the log entry itself,
// not just a summary -- that's what a future Ads-reporting view would
// correlate against spend, so it needs to survive the import, not just the
// human-readable subject/body.
function hyrosSaleEntry(contact, sale) {
  const amount = sale.usdPrice?.price ?? sale.price?.price ?? 0;
  const refunded = sale.usdPrice?.refunded ?? sale.price?.refunded ?? 0;
  const productName = sale.product?.name || "Sale";
  return {
    id: randomUUID(), channel: "activity", direction: "inbound",
    contactId: contact.id, sourceType: "hyros_import", sourceId: null, providerMessageId: null,
    to: null, from: null,
    subject: `Sale: $${amount}${refunded > 0 ? ` (refunded $${refunded})` : ""} — ${productName}`,
    body: [sale.lastSource?.name, sale.lastSource?.trafficSource?.name].filter(Boolean).join(" · "),
    bodyPreview: sale.product?.tag || "",
    status: "logged", statusHistory: [{ status: "logged", at: sale.creationDate }],
    sentAt: sale.creationDate || null,
    createdAt: sale.creationDate || new Date().toISOString(),
    inboxDone: true,
    hyrosActivityId: `hyros_sale:${sale.id}`,
    hyrosSaleData: { amount, refunded, refundDate: sale.refundDate || null, orderId: sale.orderId, product: sale.product, firstSource: sale.firstSource, lastSource: sale.lastSource },
  };
}
function hyrosCallEntry(contact, call) {
  return {
    id: randomUUID(), channel: "activity", direction: "inbound",
    contactId: contact.id, sourceType: "hyros_import", sourceId: null, providerMessageId: null,
    to: null, from: null,
    subject: `${call.name || "Booked Call"} (${call.state || "unknown"})`,
    body: [call.lastSource?.name, call.lastSource?.trafficSource?.name].filter(Boolean).join(" · "),
    bodyPreview: call.tag || "",
    status: "logged", statusHistory: [{ status: "logged", at: call.creationDate }],
    sentAt: call.creationDate || null,
    createdAt: call.creationDate || new Date().toISOString(),
    inboxDone: true,
    hyrosActivityId: `hyros_call:${call.id}`,
  };
}
export function mergeHyrosSales(contact, sales) {
  const log = readJson(MESSAGE_LOG_FILE, []);
  const existingIds = new Set(log.filter(m => m.hyrosActivityId).map(m => m.hyrosActivityId));
  let added = 0;
  sales.forEach(sale => {
    const entry = hyrosSaleEntry(contact, sale);
    if (existingIds.has(entry.hyrosActivityId)) return;
    log.push(entry);
    added++;
  });
  if (added) writeJson(MESSAGE_LOG_FILE, log);
  return added;
}
export function mergeHyrosCalls(contact, calls) {
  const log = readJson(MESSAGE_LOG_FILE, []);
  const existingIds = new Set(log.filter(m => m.hyrosActivityId).map(m => m.hyrosActivityId));
  let added = 0;
  calls.forEach(call => {
    const entry = hyrosCallEntry(contact, call);
    if (existingIds.has(entry.hyrosActivityId)) return;
    log.push(entry);
    added++;
  });
  if (added) writeJson(MESSAGE_LOG_FILE, log);
  return added;
}
