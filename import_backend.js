import { randomUUID } from "crypto";
import { readJson, writeJson, readJsonBody, sendJson, getSessionUser, isAdmin } from "./auth_backend.js";
import { CONTACTS_FILE, findContactMatch } from "./segments_shared.js";
import { MESSAGE_LOG_FILE } from "./message_log.js";
import { CALLS_FILE } from "./inbox_backend.js";
import { recheckStopStatus } from "./compliance_backend.js";

export const IMPORT_JOBS_FILE = "crm_import_jobs.json";

// Account-specific base URL, same convention already established elsewhere
// in this business's other apps (build_campaign_cache.js etc) -- not a
// secret, doesn't belong in .env.
const AC_BASE = "https://pacificrimathletics.api-us1.com";
const CLOSE_BASE = "https://api.close.com/api/v1";

function acConfigured() { return !!process.env.AC_API_KEY; }
function closeConfigured() { return !!process.env.CLOSE_API_KEY; }

async function fetchAcBatch(offset, limit) {
  const r = await fetch(`${AC_BASE}/api/3/contacts?limit=${limit}&offset=${offset}`, { headers: { "Api-Token": process.env.AC_API_KEY } });
  if (!r.ok) return { ok: false, reason: `ActiveCampaign API error ${r.status}` };
  const data = await r.json();
  return { ok: true, contacts: data.contacts || [] };
}
async function fetchCloseBatch(skip, limit) {
  const auth = "Basic " + Buffer.from(process.env.CLOSE_API_KEY + ":").toString("base64");
  const r = await fetch(`${CLOSE_BASE}/lead/?_skip=${skip}&_limit=${limit}`, { headers: { Authorization: auth } });
  if (!r.ok) return { ok: false, reason: `Close API error ${r.status}` };
  const data = await r.json();
  return { ok: true, leads: data.data || [], hasMore: !!data.has_more };
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
export function mergeAcCampaigns(contact, oneToOneCampaigns) {
  const matches = oneToOneCampaigns.filter(c => c.email === contact.email?.toLowerCase());
  if (!matches.length) return 0;
  const log = readJson(MESSAGE_LOG_FILE, []);
  const existingIds = new Set(log.filter(m => m.acCampaignId).map(m => m.acCampaignId));
  let added = 0;
  matches.forEach(c => {
    if (existingIds.has(c.id)) return;
    const statusHistory = [{ status: "sent", at: c.sdate }];
    if (c.opens > 0) statusHistory.push({ status: "opened", at: c.sdate });
    if (c.clicks > 0) statusHistory.push({ status: "clicked", at: c.sdate });
    log.push({
      id: randomUUID(), channel: "email", direction: "outbound",
      contactId: contact.id, sourceType: "ac_import", sourceId: null, providerMessageId: null,
      to: contact.email, from: null, subject: c.subject || "(no subject)",
      body: "", bodyPreview: c.subject || "",
      status: "sent", statusHistory,
      sentAt: c.sdate, createdAt: c.sdate || new Date().toISOString(),
      inboxDone: true, acCampaignId: c.id,
    });
    added++;
  });
  if (added) writeJson(MESSAGE_LOG_FILE, log);
  return added;
}

// firstSeenAt is "when this person first appeared in ANY connected
// system" (Close lead created / AC contact created), distinct from our own
// createdAt (just when WE imported them). Only ever moves earlier -- an
// older date discovered later (e.g. re-importing from a second source)
// should win, never a newer one overwriting a genuinely earlier date.
function markFirstSeen(contact, candidateISO) {
  if (!candidateISO) return;
  if (!contact.firstSeenAt || new Date(candidateISO) < new Date(contact.firstSeenAt)) contact.firstSeenAt = candidateISO;
}

// Matched first by the provider's own id (repeatable imports never
// duplicate), falling back to email match (catches a contact that already
// exists from a Framer form submission or manual entry, so importing
// doesn't create a second copy of someone already in the system).
function upsertFromAc(acContact, defaultStatus) {
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
  writeJson(CONTACTS_FILE, contacts);
}

// Close's "Lead" is company-level with a nested contacts[] array -- flatten
// each nested person into its own CRM contact, sharing the lead's
// accountName/status.
function upsertFromCloseLead(lead, defaultStatus) {
  const contacts = readJson(CONTACTS_FILE, []);
  const nested = lead.contacts?.length ? lead.contacts : [{ name: lead.display_name, emails: [], phones: [] }];
  let count = 0;
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
      markFirstSeen(contact, lead.date_created);
      contact.updatedAt = new Date().toISOString();
    } else {
      contact = {
        id: randomUUID(), type: "lead", accountName: lead.display_name || "",
        first, last, email, phone,
        status: lead.status_label || defaultStatus || "", tags: [], listIds: [], customFields: {}, source: "close_import", ownerId: null,
        emailOptOut: false, smsOptOut: false, externalIds: { acContactId: null, closeLeadId: lead.id },
        firstSeenAt: lead.date_created || new Date().toISOString(),
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      };
      contacts.push(contact);
    }
    count++;
  });
  writeJson(CONTACTS_FILE, contacts);
  return count;
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
    const r = await fetch(`${CLOSE_BASE}/activity/${type}/?lead_id=${leadId}&_skip=${skip}&_limit=${CLOSE_HISTORY_PAGE_LIMIT}`, { headers: { Authorization: auth } });
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
function mergeCloseEmails(contact, activities) {
  const log = readJson(MESSAGE_LOG_FILE, []);
  const existingIds = new Set(log.filter(m => m.closeActivityId).map(m => m.closeActivityId));
  let added = 0;
  activities.forEach(a => {
    if (existingIds.has(a.id)) return;
    log.push({
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
    });
    added++;
  });
  if (added) writeJson(MESSAGE_LOG_FILE, log);
  return added;
}
// Close keeps recording opens on an email after the fact (someone can open
// a message days later), and this app only captured opens AT IMPORT TIME --
// so re-running an import for a contact should also refresh already-merged
// rows, not just add brand-new ones. Matched by closeActivityId; only ever
// ADDS an 'opened' entry, never removes one.
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
function mergeCloseSms(contact, activities) {
  const log = readJson(MESSAGE_LOG_FILE, []);
  const existingIds = new Set(log.filter(m => m.closeActivityId).map(m => m.closeActivityId));
  let added = 0;
  activities.forEach(a => {
    if (existingIds.has(a.id)) return;
    const outbound = a.direction === "outbound";
    log.push({
      id: randomUUID(), channel: "sms", direction: outbound ? "outbound" : "inbound",
      contactId: contact.id, sourceType: "close_import", sourceId: null, providerMessageId: null,
      to: outbound ? a.remote_phone : a.local_phone, from: outbound ? a.local_phone : a.remote_phone,
      subject: null, body: a.text || "", bodyPreview: (a.text || "").slice(0, 200),
      status: a.status || "sent", statusHistory: [{ status: a.status || "sent", at: a.date_created || a.activity_at }],
      sentAt: a.date_sent || a.date_created || null,
      createdAt: a.activity_at || a.date_created || new Date().toISOString(),
      inboxDone: true,
      closeActivityId: a.id,
    });
    added++;
  });
  if (added) writeJson(MESSAGE_LOG_FILE, log);
  // Re-derived from the contact's full (now-merged) SMS history rather than
  // per-activity during the loop above -- Close doesn't guarantee activities
  // arrive in chronological order, and only the chronologically LATEST
  // inbound message should ever be able to set someone to STOP (see
  // recheckStopStatus's own doc comment for why: a lead who said "stop"
  // once but kept replying normally afterward must not get retroactively
  // suppressed just because "stop" appears somewhere in their history).
  if (added) recheckStopStatus(contact.id);
  return added;
}
function mergeCloseCalls(contact, activities) {
  const calls = readJson(CALLS_FILE, []);
  const existingIds = new Set(calls.filter(c => c.closeActivityId).map(c => c.closeActivityId));
  let added = 0;
  activities.forEach(a => {
    if (existingIds.has(a.id)) return;
    const noteText = (a.note || "").trim();
    calls.push({
      id: randomUUID(), contactId: contact.id,
      direction: a.direction === "inbound" ? "inbound" : "outbound",
      notes: noteText || `${a.disposition || a.status || "Call"} · ${a.duration || 0}s`,
      duration: a.duration || 0,
      createdAt: a.activity_at || a.date_created || new Date().toISOString(),
      createdBy: null,
      closeActivityId: a.id,
    });
    added++;
  });
  if (added) writeJson(CALLS_FILE, calls);
  return added;
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
    return sendJson(res, 200, { activecampaign: acConfigured(), close: closeConfigured() });
  }

  if (p === "/api/import/jobs" && req.method === "GET") {
    return sendJson(res, 200, { jobs: readJson(IMPORT_JOBS_FILE, []) });
  }
  if (p === "/api/import/jobs" && req.method === "POST") {
    const { source, batchSize, defaultStatus } = await readJsonBody(req);
    if (!["activecampaign", "close"].includes(source)) return sendJson(res, 400, { error: "source must be 'activecampaign' or 'close'" });
    const jobs = readJson(IMPORT_JOBS_FILE, []);
    // Reuse an existing not-yet-completed job for this source rather than
    // starting a second parallel one -- "Start Import" is really "resume".
    let job = jobs.find(j => j.source === source && j.status !== "completed");
    if (!job) {
      // Deliberately small default batch size -- this is manual-triggered,
      // one batch per click, never an unattended loop that could import
      // (and then automatically enroll into automations/workflows) a huge
      // batch of contacts unattended.
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

    try {
      if (job.source === "activecampaign") {
        const result = await fetchAcBatch(job.cursor, job.batchSize);
        if (!result.ok) { job.status = "error"; job.errors.push({ externalId: null, message: result.reason }); writeJson(IMPORT_JOBS_FILE, jobs); return sendJson(res, 400, { error: result.reason }); }
        result.contacts.forEach(c => {
          try { upsertFromAc(c, job.defaultStatus); job.totalImported++; } catch (e) { job.totalErrors++; job.errors.push({ externalId: c.id, message: e.message }); }
        });
        job.cursor += result.contacts.length;
        job.status = result.contacts.length < job.batchSize ? "completed" : "idle";
      } else {
        const result = await fetchCloseBatch(job.cursor, job.batchSize);
        if (!result.ok) { job.status = "error"; job.errors.push({ externalId: null, message: result.reason }); writeJson(IMPORT_JOBS_FILE, jobs); return sendJson(res, 400, { error: result.reason }); }
        result.leads.forEach(lead => {
          try { job.totalImported += upsertFromCloseLead(lead, job.defaultStatus); } catch (e) { job.totalErrors++; job.errors.push({ externalId: lead.id, message: e.message }); }
        });
        job.cursor += result.leads.length;
        job.status = result.hasMore ? "idle" : "completed";
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
