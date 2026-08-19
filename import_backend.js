import { randomUUID } from "crypto";
import { readJson, writeJson, readJsonBody, sendJson, getSessionUser, isAdmin } from "./auth_backend.js";
import { CONTACTS_FILE } from "./segments_shared.js";

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

// Matched first by the provider's own id (repeatable imports never
// duplicate), falling back to email match (catches a contact that already
// exists from a Framer form submission or manual entry, so importing
// doesn't create a second copy of someone already in the system).
function upsertFromAc(acContact, defaultStatus) {
  const contacts = readJson(CONTACTS_FILE, []);
  const email = (acContact.email || "").toLowerCase();
  let contact = contacts.find(c => c.externalIds?.acContactId === acContact.id) || (email ? contacts.find(c => c.email?.toLowerCase() === email) : null);
  if (contact) {
    contact.first = acContact.firstName || contact.first;
    contact.last = acContact.lastName || contact.last;
    contact.phone = acContact.phone || contact.phone;
    contact.externalIds.acContactId = acContact.id;
    contact.updatedAt = new Date().toISOString();
  } else {
    contact = {
      id: randomUUID(), type: "contact", accountName: "",
      first: acContact.firstName || "", last: acContact.lastName || "", email, phone: acContact.phone || "",
      status: defaultStatus || "", tags: [], listIds: [], customFields: {}, source: "ac_import", ownerId: null,
      emailOptOut: false, smsOptOut: false, externalIds: { acContactId: acContact.id, closeLeadId: null },
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
    let contact = contacts.find(c => c.externalIds?.closeLeadId === lead.id && c.email === email) || (email ? contacts.find(c => c.email?.toLowerCase() === email) : null);
    if (contact) {
      contact.accountName = lead.display_name || contact.accountName;
      contact.status = lead.status_label || contact.status;
      contact.externalIds.closeLeadId = lead.id;
      contact.updatedAt = new Date().toISOString();
    } else {
      contact = {
        id: randomUUID(), type: "lead", accountName: lead.display_name || "",
        first, last, email, phone,
        status: lead.status_label || defaultStatus || "", tags: [], listIds: [], customFields: {}, source: "close_import", ownerId: null,
        emailOptOut: false, smsOptOut: false, externalIds: { acContactId: null, closeLeadId: lead.id },
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      };
      contacts.push(contact);
    }
    count++;
  });
  writeJson(CONTACTS_FILE, contacts);
  return count;
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
        let contact = (email && contacts.find(c => c.email?.toLowerCase() === email)) || (!email && phone && contacts.find(c => c.phone === phone));
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
