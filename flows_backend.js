import { randomUUID, randomBytes } from "crypto";
import { readJson, writeJson, readJsonBody, sendJson, getSessionUser } from "./auth_backend.js";
import { CONTACTS_FILE, matchesSegment, findContactMatch } from "./segments_shared.js";
import { AUTOMATIONS_FILE, enrollContact, checkAutomationGoal } from "./automations_backend.js";
import { WORKFLOWS_FILE, enrollContactInWorkflow, checkConversionGoal } from "./workflows_backend.js";
import { pushConversionEvent } from "./conversions_backend.js";
import { syncContactFields } from "./sqlite_inbox.js";
import { sendEmail } from "./email_backend.js";

export const FLOWS_FILE = "crm_flows.json";
export const RUNS_FILE = "crm_flow_runs.json";
const OLD_WEBHOOK_CONFIGS_FILE = "crm_webhook_configs.json"; // retired UI, migrated below

export const TRIGGER_TYPES = ["webhook", "form_submitted", "booking_created"];
export const STEP_TYPES = [
  "filter", "if_then", "delay", "google_sheet",
  "enroll_automation", "enroll_workflow", "add_update_contact", "send_email",
  "add_tag", "remove_tag", "add_to_list", "send_conversion_event",
];

// send_email's Body is a plain textarea, not the block editor's rich HTML --
// escape it like real text, then turn line breaks into <br> so paragraphs
// still read as paragraphs once it's wrapped in a single "text" block for
// sendEmail() (block_editor_shared.js just injects a text block's html raw).
function escapeHtmlForEmail(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>");
}

// Bounds any single external call (Sheets API, SES) a step makes -- without
// this, a stalled connection just hangs the awaiting advanceFlowRun call
// forever with no rejection to .catch(), silently wedging the ENTIRE run
// (and every step after it) in "active" limbo permanently. Confirmed live:
// several runs stuck mid-flow with no error logged anywhere, no way to tell
// something had gone wrong short of noticing they never completed.
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

function getContact(id) { return readJson(CONTACTS_FILE, []).find(c => c.id === id) || null; }
function saveContact(contact) {
  const contacts = readJson(CONTACTS_FILE, []);
  const idx = contacts.findIndex(c => c.id === contact.id);
  if (idx >= 0) {
    contact.updatedAt = new Date().toISOString(); contacts[idx] = contact; writeJson(CONTACTS_FILE, contacts);
    // Every step below (add_tag/change_status/add_update_contact/etc) used
    // to skip this -- confirmed live the sidebar's SQLite snapshot just
    // silently never picked up a status/name/email change made by a flow
    // step until something else happened to re-sync that contact.
    try { syncContactFields(contact.id, contact); } catch (e) { console.error("[sqlite_inbox] contact sync failed:", e.message); }
  }
}

// ── One-time migration: the old Settings > Webhook Forms UI (crm_webhook_configs.json,
// webhooks_backend.js) is retired in favor of this engine. Each old config becomes a
// Flow with a "webhook" trigger carrying the SAME webhookToken, so any Framer form
// already pointed at /api/webhooks/framer/<token> keeps working with zero changes on
// the Framer side -- its defaultStatusId/defaultTagIds/defaultListIds become the
// equivalent change_status/add_tag/add_to_list steps. Runs once per config (skipped
// if a flow with that token already exists), safe to leave this call in permanently.
function migrateOldWebhookConfigs() {
  const oldConfigs = readJson(OLD_WEBHOOK_CONFIGS_FILE, []);
  if (!oldConfigs.length) return;
  const flows = readJson(FLOWS_FILE, []);
  let changed = false;
  for (const config of oldConfigs) {
    if (flows.some(f => f.trigger?.type === "webhook" && f.trigger.config?.webhookToken === config.webhookToken)) continue;
    const steps = {};
    let startStepId = null, prevId = null;
    const addStep = (type, cfg) => {
      const id = randomUUID();
      steps[id] = { id, type, config: cfg, nextStepId: null, yesStepId: null, noStepId: null };
      if (prevId) steps[prevId].nextStepId = id; else startStepId = id;
      prevId = id;
    };
    if (config.defaultStatusId) addStep("add_update_contact", { statusId: config.defaultStatusId });
    (config.defaultTagIds || []).forEach(tagId => addStep("add_tag", { tagId }));
    (config.defaultListIds || []).forEach(listId => addStep("add_to_list", { listId }));
    flows.push({
      id: randomUUID(), name: config.name || "Migrated Webhook Form", active: true,
      trigger: { type: "webhook", config: { webhookToken: config.webhookToken, fieldMap: config.fieldMap || {} } },
      steps, startStepId,
      createdAt: config.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    changed = true;
  }
  if (changed) writeJson(FLOWS_FILE, flows);
}
migrateOldWebhookConfigs();

// ── Google Sheets (google_sheet step) — same connected account/scopes as
// ../update_ads_tracking_daily.js's Sheets writes (GOOGLE_REFRESH_TOKEN_LW
// already carries the spreadsheets scope), copied rather than imported
// since this is a separate deployment.
export function sheetsConfigured() {
  return !!(process.env.GOOGLE_REFRESH_TOKEN_LW && process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}
async function getSheetsAccessToken() {
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN_LW, grant_type: "refresh_token",
    }),
  });
  const d = await r.json();
  if (!d.access_token) throw new Error("Sheets token refresh failed: " + JSON.stringify(d));
  return d.access_token;
}
async function getSheetHeaders(spreadsheetId, tabName) {
  const accessToken = await getSheetsAccessToken();
  const range = encodeURIComponent(`'${tabName || "Sheet1"}'!1:1`);
  const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error?.message || "Could not read that tab");
  return (d.values && d.values[0]) || [];
}
function columnLetter(n) {
  let s = "";
  while (n > 0) { const rem = (n - 1) % 26; s = String.fromCharCode(65 + rem) + s; n = Math.floor((n - 1) / 26); }
  return s || "A";
}

// Deliberately NOT the Sheets API's own values.append endpoint -- append
// finds "the table" by scanning from the given range until it hits the
// first blank row, so on any real-world sheet with a stray blank row
// somewhere in the middle (routine after years of manual edits/deletes on a
// large sheet) it silently writes there instead of at the true bottom,
// invisible unless someone happens to scroll to that exact row. Reading the
// full column range first and writing to an EXPLICIT row number instead
// sidesteps that entirely -- values.length reflects the true last row with
// data (Google preserves gap rows as [] within the array), regardless of
// any gaps earlier in the sheet.
async function appendSheetRow(spreadsheetId, sheetName, rowValues) {
  const accessToken = await getSheetsAccessToken();
  const endCol = columnLetter(rowValues.length);
  const colRange = encodeURIComponent(`'${sheetName}'!A:${endCol}`);
  const colRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${colRange}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const colData = await colRes.json();
  if (!colRes.ok) throw new Error("Sheets read failed: " + JSON.stringify(colData));
  const nextRow = (colData.values?.length || 0) + 1;

  const writeRange = encodeURIComponent(`'${sheetName}'!A${nextRow}:${endCol}${nextRow}`);
  const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${writeRange}?valueInputOption=USER_ENTERED`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ values: [rowValues] }),
  });
  const d = await r.json();
  if (!r.ok) throw new Error("Sheets write failed: " + JSON.stringify(d));
  return d;
}

// {{first}}/{{email}}/{{customFields.x}} resolve against the contact;
// {{payload.rawFieldName}} reaches into the original trigger payload (the
// raw webhook body, or {} for form/booking triggers) for anything not
// mapped onto the contact itself; {{timestamp}} is when the run's trigger
// actually fired (run.enteredAt) -- not "whenever this step happens to
// execute", which would read differently if an earlier delay step pushed
// this step minutes/hours/days past the real capture time.
function resolveTemplate(str, { contact, payload, timestamp }) {
  // [^{}]+ (not [\w.]+) -- a raw webhook field name is often a human label
  // like "First Name" or "Work Email", spaces and all. The old \w-only
  // pattern silently failed to match those at all, leaving the literal
  // "{{payload.First Name}}" text sitting in the sheet cell instead of
  // resolving (or even blanking) it.
  return String(str || "").replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_, path) => {
    if (path === "timestamp") return timestamp || "";
    if (path.startsWith("payload.")) {
      // Payload keys are always flat (the raw webhook body / form answers /
      // booking fields) -- no further dot-splitting, so a field literally
      // named e.g. "Company.Name" still matches as one key, not a nested lookup.
      const val = payload?.[path.slice("payload.".length)];
      return val === undefined || val === null ? "" : String(val);
    }
    const parts = path.split(".");
    if (parts[0] === "contact") parts.shift();
    let obj = contact;
    for (const p of parts) obj = obj == null ? undefined : obj[p];
    return obj === undefined || obj === null ? "" : String(obj);
  });
}

// ── Flow run engine — same step-graph shape (steps keyed by id, each with
// its own next-pointer field(s)) and pause/resume-via-scheduler mechanism
// as automations_backend.js's advanceEnrollment/advanceDueEnrollments, so
// a "delay" step pauses a run exactly like a "wait" step pauses an
// enrollment, resumed by advanceDueFlowRuns() below on the next tick.
function saveRun(run) {
  const runs = readJson(RUNS_FILE, []);
  const idx = runs.findIndex(r => r.id === run.id);
  if (idx >= 0) runs[idx] = run; else runs.push(run);
  writeJson(RUNS_FILE, runs);
}
function completeRun(run) { run.status = "completed"; run.updatedAt = new Date().toISOString(); saveRun(run); }

async function advanceFlowRun(run, flow) {
  flow = flow || readJson(FLOWS_FILE, []).find(f => f.id === run.flowId);
  if (!flow) return;
  let guard = 0;
  while (run.status === "active" && run.currentStepId && guard++ < 200) {
    const step = flow.steps[run.currentStepId];
    if (!step) { completeRun(run); return; }
    run.history.push({ stepId: step.id, at: new Date().toISOString() });
    const contact = getContact(run.contactId);
    const ctx = {
      contact, payload: run.triggerPayload || {},
      timestamp: new Date(run.enteredAt).toLocaleString("en-US", { timeZone: "America/Anchorage", dateStyle: "medium", timeStyle: "short" }),
    };

    if (step.type === "delay") {
      const ms = step.config.unit === "days" ? step.config.amount * 86400000
        : step.config.unit === "hours" ? step.config.amount * 3600000
        : step.config.amount * 60000;
      run.waitUntil = new Date(Date.now() + (Number(ms) || 0)).toISOString();
      saveRun(run);
      return; // pauses here -- advanceDueFlowRuns() resumes it
    }

    if (step.type === "filter") {
      const matched = contact ? matchesSegment(contact, step.config.filter) : false;
      if (!matched) { completeRun(run); return; }
      run.currentStepId = step.nextStepId || null;
    } else if (step.type === "if_then") {
      const matched = contact ? matchesSegment(contact, step.config.filter) : false;
      run.currentStepId = (matched ? step.yesStepId : step.noStepId) || null;
    } else if (step.type === "add_tag") {
      if (contact && step.config.tagId && !contact.tags.includes(step.config.tagId)) { contact.tags.push(step.config.tagId); saveContact(contact); }
      run.currentStepId = step.nextStepId || null;
    } else if (step.type === "remove_tag") {
      if (contact && step.config.tagId) { contact.tags = contact.tags.filter(t => t !== step.config.tagId); saveContact(contact); }
      run.currentStepId = step.nextStepId || null;
    } else if (step.type === "add_to_list") {
      if (contact && step.config.listId && !contact.listIds.includes(step.config.listId)) { contact.listIds.push(step.config.listId); saveContact(contact); }
      run.currentStepId = step.nextStepId || null;
    } else if (step.type === "add_update_contact") {
      // The one place a contact gets created or matched for a webhook-
      // triggered run -- the trigger itself no longer does this (see
      // framerMatch below), so a webhook flow needs this step, usually
      // first, or every later step has no contact to act on. If the run
      // already has a contact (form/booking triggers always do, since
      // forms_backend.js/scheduling_backend.js resolve one before firing),
      // this just patches it -- same "add/update" behavior either way.
      const cfg = step.config || {};
      let workingContact = contact;
      if (!workingContact) {
        const resolvedEmail = cfg.email ? resolveTemplate(cfg.email, ctx).toLowerCase() : "";
        const resolvedPhone = cfg.phone ? resolveTemplate(cfg.phone, ctx) : "";
        const contacts = readJson(CONTACTS_FILE, []);
        workingContact = findContactMatch(contacts, resolvedEmail, resolvedPhone);
        if (!workingContact) {
          workingContact = {
            id: randomUUID(), type: "contact", accountName: "",
            first: "", last: "", email: resolvedEmail, phone: resolvedPhone,
            status: "", tags: [], listIds: [], customFields: {}, source: `flow:${flow.id}`, ownerId: null,
            emailOptOut: false, smsOptOut: false, externalIds: { acContactId: null, closeLeadId: null },
            createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
          };
          contacts.push(workingContact);
          writeJson(CONTACTS_FILE, contacts);
        }
        run.contactId = workingContact.id;
      }
      const prevStatus = workingContact.status;
      for (const field of ["first", "last", "email", "phone", "programType"]) {
        if (cfg[field]) {
          const resolved = resolveTemplate(cfg[field], ctx);
          if (resolved) workingContact[field] = (field === "email" || field === "programType") ? resolved.toLowerCase() : resolved;
        }
      }
      if (cfg.statusId) workingContact.status = cfg.statusId;
      // Extra emails/phones beyond the primary -- same altEmails/
      // altPhones arrays segments_shared.js's findContactMatch and every
      // inbound-matching function now checks (SMS, Gmail), not a second
      // primary field.
      if (cfg.altEmail) {
        const resolved = resolveTemplate(cfg.altEmail, ctx).toLowerCase();
        if (resolved && resolved !== workingContact.email && !(workingContact.altEmails || []).includes(resolved)) {
          workingContact.altEmails = [...(workingContact.altEmails || []), resolved];
        }
      }
      if (cfg.altPhone) {
        const resolved = resolveTemplate(cfg.altPhone, ctx);
        const digits = (p) => String(p || "").replace(/\D/g, "").slice(-10);
        if (resolved && digits(resolved) !== digits(workingContact.phone) && !(workingContact.altPhones || []).some(p => digits(p) === digits(resolved))) {
          workingContact.altPhones = [...(workingContact.altPhones || []), resolved];
        }
      }
      if (cfg.customFields && typeof cfg.customFields === "object") {
        workingContact.customFields = workingContact.customFields || {};
        for (const [fieldId, tpl] of Object.entries(cfg.customFields)) {
          const resolved = resolveTemplate(tpl, ctx);
          if (resolved) workingContact.customFields[fieldId] = resolved;
        }
      }
      saveContact(workingContact);
      if (workingContact.status !== prevStatus) {
        checkConversionGoal("lead_status_change", workingContact.id);
        checkAutomationGoal("lead_status_change", workingContact.id, workingContact.status);
      }
      run.currentStepId = step.nextStepId || null;
    } else if (step.type === "enroll_automation") {
      const target = readJson(AUTOMATIONS_FILE, []).find(a => a.id === step.config.automationId);
      if (target && contact) enrollContact(target, contact.id);
      run.currentStepId = step.nextStepId || null;
    } else if (step.type === "enroll_workflow") {
      const target = readJson(WORKFLOWS_FILE, []).find(w => w.id === step.config.workflowId);
      if (target && contact) enrollContactInWorkflow(target, contact.id);
      run.currentStepId = step.nextStepId || null;
    } else if (step.type === "google_sheet") {
      if (step.config.spreadsheetId && step.config.sheetName) {
        const row = (step.config.columns || []).map(tpl => resolveTemplate(tpl, ctx));
        try { await withTimeout(appendSheetRow(step.config.spreadsheetId, step.config.sheetName, row), 20000, "google_sheet append"); }
        catch (e) { console.error("[flows] sheet append failed", e.message); }
      }
      run.currentStepId = step.nextStepId || null;
    } else if (step.type === "send_email") {
      const cfg = step.config || {};
      const toRaw = resolveTemplate(cfg.to || "", ctx);
      // Free-typed, unlike Automations' own send_email step which always
      // mails contact.email -- this one's just as likely aimed at staff
      // (a "new lead" notification) as at the contact, so it accepts
      // however many comma/whitespace-separated addresses got typed in.
      const toAddresses = toRaw.split(/[,;\s]+/).map(s => s.trim()).filter(Boolean);
      if (toAddresses.length) {
        const fromResolved = cfg.from ? resolveTemplate(cfg.from, ctx).trim() : "";
        const subjectResolved = resolveTemplate(cfg.subject || "", ctx);
        const bodyHtml = escapeHtmlForEmail(resolveTemplate(cfg.body || "", ctx));
        for (const to of toAddresses) {
          await withTimeout(sendEmail({
            to, subject: subjectResolved, blocks: [{ type: "text", html: bodyHtml }],
            contactId: contact?.id || null, sourceType: "flow_step", sourceId: `${flow.id}:${step.id}`,
            from: fromResolved || undefined,
          }), 20000, "send_email").catch(e => console.error("[flows] send_email failed", e.message));
        }
      }
      run.currentStepId = step.nextStepId || null;
    } else if (step.type === "send_conversion_event") {
      if (contact && step.config.eventKey) {
        await pushConversionEvent(step.config.eventKey, contact.id).catch(e => console.error("[flows] conversion push failed", e.message));
      }
      run.currentStepId = step.nextStepId || null;
    } else {
      run.currentStepId = step.nextStepId || null;
    }

    if (!run.currentStepId) { completeRun(run); return; }
  }
  saveRun(run);
}

function startFlowRun(flow, contactId, triggerPayload) {
  const run = {
    id: randomUUID(), flowId: flow.id, contactId, status: "active",
    currentStepId: flow.startStepId || null, triggerPayload: triggerPayload || {},
    enteredAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    waitUntil: null, history: [],
  };
  const runs = readJson(RUNS_FILE, []);
  runs.push(run);
  writeJson(RUNS_FILE, runs);
  if (!run.currentStepId) { completeRun(run); return run; }
  advanceFlowRun(run, flow).catch(e => console.error("[flows] advance failed", e.message));
  return run;
}

// Called from forms_backend.js (after a submission resolves to a contact)
// and scheduling_backend.js (after a booking resolves to a contact) --
// same "fire after contact resolution" convention as fireTrigger/
// fireWorkflowTrigger, just for this engine's own Flow set.
export function fireFlowTrigger(type, { contactId, formId, eventTypeId, payload }) {
  if (!TRIGGER_TYPES.includes(type) || !contactId) return;
  const flows = readJson(FLOWS_FILE, []).filter(f => f.active && f.trigger?.type === type);
  for (const flow of flows) {
    const cfg = flow.trigger.config || {};
    let matches = true;
    if (type === "form_submitted" && cfg.formId) matches = cfg.formId === formId;
    if (type === "booking_created" && cfg.eventTypeId) matches = cfg.eventTypeId === eventTypeId;
    if (matches) startFlowRun(flow, contactId, payload || {});
  }
}

// Called by scheduler.js every tick -- resumes any run whose delay step has expired.
export async function advanceDueFlowRuns() {
  const runs = readJson(RUNS_FILE, []);
  const due = runs.filter(r => r.status === "active" && r.waitUntil && new Date(r.waitUntil).getTime() <= Date.now());
  for (const run of due) {
    const flow = readJson(FLOWS_FILE, []).find(f => f.id === run.flowId);
    if (!flow) continue;
    const delayStep = flow.steps[run.currentStepId];
    run.waitUntil = null;
    run.currentStepId = delayStep?.nextStepId || null;
    if (!run.currentStepId) { completeRun(run); continue; }
    await advanceFlowRun(run, flow);
  }
}

// Called by scheduler.js every tick -- resumes any run that's been "active"
// with no waitUntil (so NOT a legitimate delay pause) for way longer than a
// normal run should ever take. A real run finishes in well under a second
// once external calls are bounded by withTimeout above; anything still
// "active" after several minutes almost certainly got orphaned mid-flight
// -- e.g. a deploy restarting the container while a request was still
// awaiting a step (confirmed live: several runs frozen at different steps,
// all from webhook hits that landed right around a deploy). Resuming from
// run.currentStepId means whatever step it was stuck ON re-runs -- an
// at-least-once retry, not guaranteed-exactly-once -- but a duplicate
// email/sheet-row is a far smaller problem than a run stuck forever with
// nothing downstream of it ever executing and no record anywhere that
// something went wrong.
const STALE_RUN_MS = 3 * 60 * 1000;
export async function recoverStaleFlowRuns() {
  const runs = readJson(RUNS_FILE, []);
  const stale = runs.filter(r => r.status === "active" && !r.waitUntil && Date.now() - new Date(r.enteredAt).getTime() > STALE_RUN_MS);
  for (const run of stale) {
    const flow = readJson(FLOWS_FILE, []).find(f => f.id === run.flowId);
    if (!flow) { completeRun(run); continue; } // flow deleted since -- nothing left to resume
    console.error(`[flows] resuming stale run ${run.id} (flow "${flow.name}", stuck at step ${run.currentStepId} since ${run.enteredAt})`);
    await advanceFlowRun(run, flow).catch(e => console.error("[flows] stale-run resume failed", run.id, e.message));
  }
}

function readRawBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", d => body += d);
    req.on("end", () => resolve(body));
  });
}

function newFlow(name) {
  return { id: randomUUID(), name: name || "Untitled Flow", active: false, trigger: { type: "webhook", config: {} }, steps: {}, startStepId: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
}
function runCounts(flowId) {
  const runs = readJson(RUNS_FILE, []).filter(r => r.flowId === flowId);
  return { totalRuns: runs.length, activeRuns: runs.filter(r => r.status === "active").length };
}

export async function handleFlowsRequest(req, res, url) {
  const p = url.pathname;

  // ── Public: no Zapier in the middle -- point a Framer form's "Send to a
  // URL" action (or anything else) straight at this. Same URL contract as
  // the retired webhooks_backend.js so nothing external needs to change.
  const framerMatch = p.match(/^\/api\/webhooks\/framer\/([^/]+)$/);
  if (framerMatch && req.method === "POST") {
    const flows = readJson(FLOWS_FILE, []);
    const flow = flows.find(f => f.trigger?.type === "webhook" && f.trigger.config?.webhookToken === framerMatch[1]);
    if (!flow) { res.writeHead(404); res.end("Unknown form"); return true; }

    const contentType = req.headers["content-type"] || "";
    let fields = {};
    if (contentType.includes("application/json")) fields = await readJsonBody(req);
    else { const raw = await readRawBody(req); fields = Object.fromEntries(new URLSearchParams(raw)); }

    // Captured even while the flow is still being built (inactive) -- same
    // "send a real test hit and we'll show you what arrived" flow Zapier's
    // trigger step uses, so the field-mapping UI has real field names to
    // work with instead of the builder guessing them blind. Kept to the 5
    // most recent so this can't grow unbounded on a busy form.
    flow.trigger.config = { ...flow.trigger.config, samples: [fields, ...(flow.trigger.config.samples || [])].slice(0, 5) };
    writeJson(FLOWS_FILE, flows);

    if (!flow.active) { res.writeHead(200); res.end(); return true; } // accept + no-op so a paused flow doesn't error the external form

    // No contact resolution here anymore -- that's now an explicit
    // "Add/Update Contact" step the flow itself contains (usually first),
    // so it's visible/editable in the builder instead of an implicit
    // upsert baked into the trigger. A flow with no such step just never
    // gets a contact, and every contact-dependent step downstream no-ops.
    startFlowRun(flow, null, fields);
    return sendJson(res, 200, { ok: true });
  }

  // ── Authed: flow management ───────────────────────────────────────────
  if (!p.startsWith("/api/flows")) return false;
  const me = getSessionUser(req);
  if (!me) return sendJson(res, 401, { error: "Not logged in" });

  if (p === "/api/flows" && req.method === "GET") {
    const flows = readJson(FLOWS_FILE, []);
    return sendJson(res, 200, { flows: flows.map(f => ({ ...f, ...runCounts(f.id) })) });
  }
  if (p === "/api/flows" && req.method === "POST") {
    const { name } = await readJsonBody(req);
    const flows = readJson(FLOWS_FILE, []);
    const flow = newFlow(name);
    flows.push(flow);
    writeJson(FLOWS_FILE, flows);
    return sendJson(res, 200, { ok: true, flow });
  }

  // ── Google Sheets browsing -- powers the google_sheet step's visual
  // picker (search a spreadsheet by name -> pick a real tab -> map real
  // column headers) instead of making someone paste a spreadsheet ID and
  // guess column order blind. Placed ahead of the generic /api/flows/:id
  // matcher below since these are multi-segment paths under /api/flows/
  // that would otherwise never be reached (same shadowing bug already hit
  // once with /api/flows/sheets-status).
  if (p === "/api/flows/sheets/search" && req.method === "GET") {
    if (!sheetsConfigured()) return sendJson(res, 200, { files: [] });
    try {
      const accessToken = await getSheetsAccessToken();
      const q = (url.searchParams.get("q") || "").trim();
      const nameClause = q ? ` and name contains '${q.replace(/[\\']/g, "\\$&")}'` : "";
      const driveQuery = `mimeType='application/vnd.google-apps.spreadsheet' and trashed=false${nameClause}`;
      const r = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(driveQuery)}&fields=files(id,name)&pageSize=20&orderBy=modifiedTime desc`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const d = await r.json();
      if (!r.ok) return sendJson(res, 200, { files: [], error: d.error?.message });
      return sendJson(res, 200, { files: d.files || [] });
    } catch (e) {
      return sendJson(res, 200, { files: [], error: e.message });
    }
  }
  const sheetTabsMatch = p.match(/^\/api\/flows\/sheets\/([^/]+)\/tabs$/);
  if (sheetTabsMatch && req.method === "GET") {
    try {
      const accessToken = await getSheetsAccessToken();
      const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetTabsMatch[1]}?fields=sheets.properties.title,sheets.properties.hidden`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const d = await r.json();
      if (!r.ok) return sendJson(res, 400, { error: d.error?.message || "Could not read that spreadsheet" });
      // Excludes tabs hidden in the sheet itself -- someone browsing a
      // spreadsheet full of scratch/archive tabs shouldn't have to pick
      // through ones nobody's meant to see.
      return sendJson(res, 200, { tabs: (d.sheets || []).filter(s => !s.properties.hidden).map(s => s.properties.title) });
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
  }
  const sheetHeadersMatch = p.match(/^\/api\/flows\/sheets\/([^/]+)\/headers$/);
  if (sheetHeadersMatch && req.method === "GET") {
    try {
      const headers = await getSheetHeaders(sheetHeadersMatch[1], url.searchParams.get("tab") || "Sheet1");
      return sendJson(res, 200, { headers });
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
  }

  if (p === "/api/flows/sheets-status" && req.method === "GET") {
    return sendJson(res, 200, { configured: sheetsConfigured() });
  }

  const flowMatch = p.match(/^\/api\/flows\/([^/]+)$/);
  if (flowMatch) {
    const flows = readJson(FLOWS_FILE, []);
    const flow = flows.find(f => f.id === flowMatch[1]);
    if (req.method === "GET") {
      if (!flow) return sendJson(res, 404, { error: "Flow not found" });
      return sendJson(res, 200, { flow, webhookUrlBase: "/api/webhooks/framer/" });
    }
    if (req.method === "PATCH") {
      if (!flow) return sendJson(res, 404, { error: "Flow not found" });
      const body = await readJsonBody(req);
      // Captured up front: the trigger-config editor (flow-builder.html)
      // rebuilds trigger.config from scratch on every save (webhookToken +
      // fieldMap only) with no idea "samples" exists on it -- without this,
      // saving the trigger silently deletes whatever Pull Sample Data had
      // captured.
      const oldSamples = flow.trigger?.type === "webhook" ? flow.trigger.config?.samples : undefined;
      for (const k of ["name", "trigger", "steps", "startStepId", "active"]) if (k in body) flow[k] = body[k];
      // Lazily mint the webhook's URL token the first time a flow's trigger
      // becomes "webhook" -- the client never invents this itself so the
      // URL can't collide/be predicted.
      if (flow.trigger?.type === "webhook" && !flow.trigger.config?.webhookToken) {
        flow.trigger.config = { ...flow.trigger.config, webhookToken: randomBytes(12).toString("hex") };
      }
      if (flow.trigger?.type === "webhook" && !flow.trigger.config?.samples && oldSamples?.length) {
        flow.trigger.config = { ...flow.trigger.config, samples: oldSamples };
      }
      flow.updatedAt = new Date().toISOString();
      writeJson(FLOWS_FILE, flows);
      return sendJson(res, 200, { ok: true, flow });
    }
    if (req.method === "DELETE") {
      writeJson(FLOWS_FILE, flows.filter(f => f.id !== flowMatch[1]));
      writeJson(RUNS_FILE, readJson(RUNS_FILE, []).filter(r => r.flowId !== flowMatch[1]));
      return sendJson(res, 200, { ok: true });
    }
  }

  const activeMatch = p.match(/^\/api\/flows\/([^/]+)\/active$/);
  if (activeMatch && req.method === "POST") {
    const flows = readJson(FLOWS_FILE, []);
    const flow = flows.find(f => f.id === activeMatch[1]);
    if (!flow) return sendJson(res, 404, { error: "Flow not found" });
    const { active } = await readJsonBody(req);
    flow.active = !!active;
    flow.updatedAt = new Date().toISOString();
    writeJson(FLOWS_FILE, flows);
    return sendJson(res, 200, { ok: true, flow });
  }

  const runsMatch = p.match(/^\/api\/flows\/([^/]+)\/runs$/);
  if (runsMatch && req.method === "GET") {
    const runs = readJson(RUNS_FILE, []).filter(r => r.flowId === runsMatch[1]).sort((a, b) => new Date(b.enteredAt) - new Date(a.enteredAt)).slice(0, 100);
    const contacts = readJson(CONTACTS_FILE, []);
    const withContact = runs.map(r => {
      const c = contacts.find(c => c.id === r.contactId);
      return { ...r, contact: c ? { first: c.first, last: c.last, email: c.email } : null };
    });
    return sendJson(res, 200, { runs: withContact });
  }

  // Recent real trigger data, same idea as Zapier's "test trigger" step --
  // lets the builder show real field names/values instead of the user
  // guessing them blind, and offers them as click-to-insert tokens for
  // other steps' template fields (e.g. google_sheet columns). Filenames are
  // inlined rather than imported from forms_backend.js/scheduling_backend.js
  // to avoid a circular import (both of those already import fireFlowTrigger
  // from this file).
  const samplesMatch = p.match(/^\/api\/flows\/([^/]+)\/samples$/);
  if (samplesMatch && req.method === "GET") {
    const flow = readJson(FLOWS_FILE, []).find(f => f.id === samplesMatch[1]);
    if (!flow) return sendJson(res, 404, { error: "Flow not found" });
    const type = flow.trigger?.type;

    if (type === "webhook") {
      return sendJson(res, 200, { samples: flow.trigger.config?.samples || [] });
    }
    if (type === "form_submitted") {
      const forms = readJson("crm_forms.json", []);
      let responses = readJson("crm_form_responses.json", []);
      const formId = flow.trigger.config?.formId;
      if (formId) responses = responses.filter(r => r.formId === formId);
      responses = responses.sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt)).slice(0, 5);
      const samples = responses.map(r => {
        const form = forms.find(f => f.id === r.formId);
        const labeled = {};
        (form?.fields || []).forEach(f => {
          if (r.answers[f.id] !== undefined && r.answers[f.id] !== "") {
            labeled[f.label || f.type] = Array.isArray(r.answers[f.id]) ? r.answers[f.id].join(", ") : r.answers[f.id];
          }
        });
        return labeled;
      });
      return sendJson(res, 200, { samples });
    }
    if (type === "booking_created") {
      const eventTypes = readJson("crm_event_types.json", []);
      let bookings = readJson("crm_bookings.json", []);
      const eventTypeId = flow.trigger.config?.eventTypeId;
      if (eventTypeId) bookings = bookings.filter(b => b.eventTypeId === eventTypeId);
      bookings = bookings.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 5);
      // Same precedence as the real trigger payload (scheduling_backend.js)
      // -- b.formAnswers spread first so the fixed fields always win a
      // same-named collision, and so a calendar-embedded form's OTHER
      // questions (Career, Goals, ...) show up here as pickable tokens too,
      // not just the fixed booking fields.
      const samples = bookings.map(b => ({
        ...(b.formAnswers && typeof b.formAnswers === "object" ? b.formAnswers : {}),
        "Event Type": eventTypes.find(e => e.id === b.eventTypeId)?.name || "",
        "When": new Date(b.startAt).toLocaleString(),
        "Name": b.name, "Email": b.email, "Phone": b.phone, "Notes": b.notes || "",
      }));
      return sendJson(res, 200, { samples });
    }
    return sendJson(res, 200, { samples: [] });
  }

  return false;
}
