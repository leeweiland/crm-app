import { randomUUID, randomBytes } from "crypto";
import { readJson, writeJson, readJsonBody, sendJson, getSessionUser } from "./auth_backend.js";
import { CONTACTS_FILE, matchesSegment, findContactMatch } from "./segments_shared.js";
import { AUTOMATIONS_FILE, enrollContact, checkAutomationGoal } from "./automations_backend.js";
import { WORKFLOWS_FILE, enrollContactInWorkflow, checkConversionGoal } from "./workflows_backend.js";

export const FLOWS_FILE = "crm_flows.json";
export const RUNS_FILE = "crm_flow_runs.json";
const OLD_WEBHOOK_CONFIGS_FILE = "crm_webhook_configs.json"; // retired UI, migrated below

export const TRIGGER_TYPES = ["webhook", "form_submitted", "booking_created"];
export const STEP_TYPES = [
  "filter", "if_then", "delay", "google_sheet",
  "enroll_automation", "enroll_workflow", "change_status",
  "add_tag", "remove_tag", "add_to_list",
];

function getContact(id) { return readJson(CONTACTS_FILE, []).find(c => c.id === id) || null; }
function saveContact(contact) {
  const contacts = readJson(CONTACTS_FILE, []);
  const idx = contacts.findIndex(c => c.id === contact.id);
  if (idx >= 0) { contact.updatedAt = new Date().toISOString(); contacts[idx] = contact; writeJson(CONTACTS_FILE, contacts); }
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
    if (config.defaultStatusId) addStep("change_status", { statusId: config.defaultStatusId });
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
async function appendSheetRow(spreadsheetId, sheetName, rowValues) {
  const accessToken = await getSheetsAccessToken();
  const range = encodeURIComponent(`'${sheetName}'!A1`);
  const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}:append?valueInputOption=USER_ENTERED`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ values: [rowValues] }),
  });
  const d = await r.json();
  if (!r.ok) throw new Error("Sheets append failed: " + JSON.stringify(d));
  return d;
}

// {{first}}/{{email}}/{{customFields.x}} resolve against the contact;
// {{payload.rawFieldName}} reaches into the original trigger payload (the
// raw webhook body, or {} for form/booking triggers) for anything not
// mapped onto the contact itself.
function resolveTemplate(str, { contact, payload }) {
  return String(str || "").replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, path) => {
    const parts = path.split(".");
    let obj;
    if (parts[0] === "payload") { obj = payload; parts.shift(); }
    else { obj = contact; if (parts[0] === "contact") parts.shift(); }
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
    const ctx = { contact, payload: run.triggerPayload || {} };

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
    } else if (step.type === "change_status") {
      if (contact && step.config.statusId) {
        const prevStatus = contact.status;
        contact.status = step.config.statusId;
        saveContact(contact);
        if (contact.status !== prevStatus) {
          checkConversionGoal("lead_status_change", contact.id);
          checkAutomationGoal("lead_status_change", contact.id, contact.status);
        }
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
        try { await appendSheetRow(step.config.spreadsheetId, step.config.sheetName, row); }
        catch (e) { console.error("[flows] sheet append failed", e.message); }
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

    const cfg = flow.trigger.config || {};
    const mapped = { first: "", last: "", email: "", phone: "", customFields: {} };
    for (const [externalLabel, target] of Object.entries(cfg.fieldMap || {})) {
      const value = fields[externalLabel];
      if (value === undefined || value === null) continue;
      if (target.startsWith("customField:")) mapped.customFields[target.slice("customField:".length)] = value;
      else mapped[target] = value;
    }

    const contacts = readJson(CONTACTS_FILE, []);
    let contact = findContactMatch(contacts, mapped.email, mapped.phone);
    if (contact) {
      contact.first = mapped.first || contact.first;
      contact.last = mapped.last || contact.last;
      contact.phone = mapped.phone || contact.phone;
      contact.customFields = { ...contact.customFields, ...mapped.customFields };
      contact.updatedAt = new Date().toISOString();
    } else {
      contact = {
        id: randomUUID(), type: "contact", accountName: "",
        first: mapped.first || "", last: mapped.last || "", email: (mapped.email || "").toLowerCase(), phone: mapped.phone || "",
        status: "", tags: [], listIds: [], customFields: mapped.customFields, source: `webhook:${flow.id}`, ownerId: null,
        emailOptOut: false, smsOptOut: false, externalIds: { acContactId: null, closeLeadId: null },
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      };
      contacts.push(contact);
    }
    writeJson(CONTACTS_FILE, contacts);

    startFlowRun(flow, contact.id, fields);
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
      const samples = bookings.map(b => ({
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
