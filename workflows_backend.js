import { randomUUID } from "crypto";
import { readJson, writeJson, readJsonBody, sendJson, getSessionUser } from "./auth_backend.js";
import { CONTACTS_FILE } from "./segments_shared.js";
import { applyMergeTags } from "./block_editor_shared.js";
import { sendSms } from "./sms_backend.js";

export const WORKFLOWS_FILE = "crm_workflows.json";
export const WF_ENROLLMENTS_FILE = "crm_workflow_enrollments.json";

// Same trigger vocabulary automations_backend.js offers, for the same
// reason (nothing wires page_visit/Facebook events yet) -- workflows also
// support direct manual enrollment via POST /api/workflows/:id/enroll,
// matching how Close lets you drop a lead into a workflow by hand.
const TRIGGER_TYPES = ["list_subscribe", "tag_added", "email_opened", "email_clicked", "page_visit", "form_submitted", "booking_created"];

// Conversion goals actually wired to a real event source in this v1:
// incoming_sms (sms_backend.js's inbound webhook), lead_status_change
// (contacts_backend.js's PATCH handler), and meeting_booked
// (scheduling_backend.js's booking creation). incoming_email and
// incoming_call are selectable in the UI but won't fire yet -- there's no
// inbound-email channel or call-tracking in the app to source them from.
// Wiring one later is just a checkConversionGoal() call at that new event's
// source, same as the others.
export const CONVERSION_GOAL_TYPES = ["incoming_email", "incoming_sms", "incoming_call", "meeting_booked", "lead_status_change", "outcome_met"];

function getContact(id) { return readJson(CONTACTS_FILE, []).find(c => c.id === id) || null; }

// ── IANA-timezone-aware "which day/time is this step due" math, same
// toLocaleString round-trip trick used elsewhere in this business's other
// apps for DST-correct conversion without a date-library dependency. ────
function weekdayInZone(dateStr, timeZone) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  return d.toLocaleDateString("en-US", { timeZone, weekday: "short" }).toLowerCase().slice(0, 3);
}
function zonedTimeToUtc(dateStr, timeStr, timeZone) {
  const asIfUtc = new Date(`${dateStr}T${timeStr}:00Z`);
  const inZone = new Date(asIfUtc.toLocaleString("en-US", { timeZone }));
  const diff = asIfUtc.getTime() - inZone.getTime();
  return new Date(asIfUtc.getTime() + diff);
}
// Steps carry a real delayValue+delayUnit (hours/days/weeks/months) instead
// of only whole days, matching how Close's own sequences mix a fast
// same-hour first reply with day/week-scale follow-ups. "hours" is treated
// as an exact-time offset (a lead who signs up at 2pm shouldn't have their
// 2-hour follow-up silently pushed to tomorrow's send window) -- everything
// coarser than a day still goes through the existing sending-day/window/
// blackout-date search, since those only make sense at day granularity.
// dayOffset is read as a fallback for steps saved before this field existed.
function computeStepDueDate(workflow, enrolledAtISO, step) {
  const rs = workflow.recipientSettings || {};
  const tz = rs.timezone || "America/Anchorage";
  const sendingDays = rs.sendingDays?.length ? rs.sendingDays : ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  const blackoutDates = rs.blackoutDates || [];
  const windowStart = rs.sendingWindow?.start || "09:00";
  const unit = step?.delayUnit || "days";
  const amount = step?.delayValue ?? step?.dayOffset ?? 0;

  if (unit === "hours") {
    let target = new Date(new Date(enrolledAtISO).getTime() + amount * 3600000);
    for (let i = 0; i < 14; i++) {
      const dateStr = target.toISOString().slice(0, 10);
      const wd = weekdayInZone(dateStr, tz);
      if (sendingDays.includes(wd) && !blackoutDates.includes(dateStr)) return target.toISOString();
      target = new Date(target.getTime() + 86400000);
      target = new Date(zonedTimeToUtc(target.toISOString().slice(0, 10), windowStart, tz));
    }
    return new Date(Date.now() + 86400000).toISOString();
  }

  const days = unit === "weeks" ? amount * 7 : unit === "months" ? amount * 30 : amount;
  let d = new Date(enrolledAtISO);
  d.setUTCDate(d.getUTCDate() + (days || 0));
  for (let i = 0; i < 14; i++) {
    const dateStr = d.toISOString().slice(0, 10);
    const wd = weekdayInZone(dateStr, tz);
    if (sendingDays.includes(wd) && !blackoutDates.includes(dateStr)) {
      return zonedTimeToUtc(dateStr, windowStart, tz).toISOString();
    }
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return new Date(Date.now() + 86400000).toISOString(); // 14-day search exhausted -- fall back rather than never scheduling
}

function saveWfEnrollment(enrollment) {
  const enrollments = readJson(WF_ENROLLMENTS_FILE, []);
  const idx = enrollments.findIndex(e => e.id === enrollment.id);
  if (idx >= 0) enrollments[idx] = enrollment; else enrollments.push(enrollment);
  writeJson(WF_ENROLLMENTS_FILE, enrollments);
}

export function enrollContactInWorkflow(workflow, contactId) {
  const enrollments = readJson(WF_ENROLLMENTS_FILE, []);
  if (workflow.recipientSettings?.runMode !== "multiple") {
    if (enrollments.some(e => e.workflowId === workflow.id && e.contactId === contactId && e.status === "active")) return;
  }
  if (!workflow.steps.length) return;
  const enrollment = {
    id: randomUUID(), workflowId: workflow.id, contactId, status: "active", currentStepIndex: 0,
    enrolledAt: new Date().toISOString(), nextStepDueAt: computeStepDueDate(workflow, new Date().toISOString(), workflow.steps[0]),
    completedAt: null, goalMetAt: null,
  };
  enrollments.push(enrollment);
  writeJson(WF_ENROLLMENTS_FILE, enrollments);
}

export function fireWorkflowTrigger(type, { contactId, listId, tagId, path, formId, eventTypeId }) {
  if (!TRIGGER_TYPES.includes(type) || !contactId) return;
  const workflows = readJson(WORKFLOWS_FILE, []).filter(w => w.active && w.trigger?.type === type);
  for (const workflow of workflows) {
    const cfg = workflow.trigger.config || {};
    let matches = true;
    if (type === "list_subscribe" && cfg.listId) matches = cfg.listId === listId;
    if (type === "tag_added" && cfg.tagId) matches = cfg.tagId === tagId;
    if (type === "page_visit" && cfg.urlContains) matches = String(path || "").includes(cfg.urlContains);
    if (type === "form_submitted" && cfg.formId) matches = cfg.formId === formId;
    if (type === "booking_created" && cfg.eventTypeId) matches = cfg.eventTypeId === eventTypeId;
    if (matches) enrollContactInWorkflow(workflow, contactId);
  }
}

// Called from sms_backend.js's inbound webhook and contacts_backend.js's
// status-change PATCH -- see CONVERSION_GOAL_TYPES comment above for what's
// actually wired vs. selectable-but-dormant.
export function checkConversionGoal(trigger, contactId) {
  if (!contactId || !CONVERSION_GOAL_TYPES.includes(trigger)) return;
  const workflows = readJson(WORKFLOWS_FILE, []).filter(w => w.active && (w.conversionGoals || []).some(g => g.trigger === trigger));
  if (!workflows.length) return;
  const enrollments = readJson(WF_ENROLLMENTS_FILE, []);
  let changed = false;
  workflows.forEach(w => {
    enrollments.filter(e => e.workflowId === w.id && e.contactId === contactId && e.status === "active").forEach(e => {
      e.status = "goal_met"; e.goalMetAt = new Date().toISOString(); changed = true;
    });
  });
  if (changed) writeJson(WF_ENROLLMENTS_FILE, enrollments);
}

// Called by scheduler.js every tick.
export async function advanceDueWorkflowEnrollments() {
  const enrollments = readJson(WF_ENROLLMENTS_FILE, []);
  const workflows = readJson(WORKFLOWS_FILE, []);
  const due = enrollments.filter(e => e.status === "active" && e.nextStepDueAt && new Date(e.nextStepDueAt).getTime() <= Date.now());
  for (const enrollment of due) {
    const workflow = workflows.find(w => w.id === enrollment.workflowId);
    if (!workflow) continue;
    const step = workflow.steps[enrollment.currentStepIndex];
    if (!step) { enrollment.status = "completed"; enrollment.completedAt = new Date().toISOString(); saveWfEnrollment(enrollment); continue; }

    if (step.type === "sms") {
      const contact = getContact(enrollment.contactId);
      if (contact && step.config.body && contact.phone) {
        const result = await sendSms({
          to: contact.phone, body: applyMergeTags(step.config.body, contact), contactId: contact.id,
          sourceType: "workflow_step", sourceId: `${workflow.id}:${step.id}`,
        });
        if (!result.ok && result.reason !== "twilio_not_configured" && result.reason !== "opted_out") enrollment.status = "errored";
      }
    }

    const nextIndex = enrollment.currentStepIndex + 1;
    const nextStep = workflow.steps[nextIndex];
    enrollment.currentStepIndex = nextIndex;
    if (enrollment.status === "active") {
      if (nextStep) {
        enrollment.nextStepDueAt = computeStepDueDate(workflow, enrollment.enrolledAt, nextStep);
      } else {
        enrollment.status = "completed"; enrollment.completedAt = new Date().toISOString(); enrollment.nextStepDueAt = null;
      }
    }
    saveWfEnrollment(enrollment);
  }
}

function workflowStats(workflowId) {
  const enrollments = readJson(WF_ENROLLMENTS_FILE, []).filter(e => e.workflowId === workflowId);
  return {
    active: enrollments.filter(e => e.status === "active").length,
    enrolled: enrollments.length,
    completed: enrollments.filter(e => e.status === "completed").length,
    goalMet: enrollments.filter(e => e.status === "goal_met").length,
    bounced: enrollments.filter(e => e.status === "bounced").length,
    errored: enrollments.filter(e => e.status === "errored").length,
  };
}

export async function handleWorkflowsRequest(req, res, url) {
  const p = url.pathname;
  if (!p.startsWith("/api/workflows")) return false;
  const me = getSessionUser(req);
  if (!me) return sendJson(res, 401, { error: "Not logged in" });

  if (p === "/api/workflows" && req.method === "GET") {
    const workflows = readJson(WORKFLOWS_FILE, []);
    return sendJson(res, 200, { workflows: workflows.map(w => ({ ...w, stats: workflowStats(w.id) })) });
  }
  if (p === "/api/workflows" && req.method === "POST") {
    const { name } = await readJsonBody(req);
    const workflows = readJson(WORKFLOWS_FILE, []);
    const workflow = {
      id: randomUUID(), name: name || "Untitled Workflow", active: false,
      trigger: { type: "tag_added", config: {} },
      steps: [], conversionGoals: [],
      recipientSettings: { runMode: "once", sendingDays: ["mon", "tue", "wed", "thu", "fri"], sendingWindow: { start: "09:00", end: "18:00" }, timezone: "America/Anchorage", blackoutDates: [] },
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    workflows.push(workflow);
    writeJson(WORKFLOWS_FILE, workflows);
    return sendJson(res, 200, { ok: true, workflow });
  }

  const duplicateMatch = p.match(/^\/api\/workflows\/([^/]+)\/duplicate$/);
  if (duplicateMatch && req.method === "POST") {
    const workflows = readJson(WORKFLOWS_FILE, []);
    const source = workflows.find(w => w.id === duplicateMatch[1]);
    if (!source) return sendJson(res, 404, { error: "Not found" });
    const copy = {
      id: randomUUID(), name: `Copy of ${source.name}`, active: false,
      trigger: JSON.parse(JSON.stringify(source.trigger)),
      steps: JSON.parse(JSON.stringify(source.steps)),
      conversionGoals: JSON.parse(JSON.stringify(source.conversionGoals)),
      recipientSettings: JSON.parse(JSON.stringify(source.recipientSettings)),
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    workflows.push(copy);
    writeJson(WORKFLOWS_FILE, workflows);
    return sendJson(res, 200, { ok: true, workflow: copy });
  }

  const workflowMatch = p.match(/^\/api\/workflows\/([^/]+)$/);
  if (workflowMatch) {
    const workflows = readJson(WORKFLOWS_FILE, []);
    const workflow = workflows.find(w => w.id === workflowMatch[1]);
    if (req.method === "GET") {
      if (!workflow) return sendJson(res, 404, { error: "Not found" });
      return sendJson(res, 200, { workflow, stats: workflowStats(workflow.id) });
    }
    if (req.method === "PATCH") {
      if (!workflow) return sendJson(res, 404, { error: "Not found" });
      const body = await readJsonBody(req);
      for (const k of ["name", "trigger", "steps", "conversionGoals", "recipientSettings"]) if (k in body) workflow[k] = body[k];
      workflow.updatedAt = new Date().toISOString();
      writeJson(WORKFLOWS_FILE, workflows);
      return sendJson(res, 200, { ok: true, workflow });
    }
    if (req.method === "DELETE") {
      writeJson(WORKFLOWS_FILE, workflows.filter(w => w.id !== workflowMatch[1]));
      return sendJson(res, 200, { ok: true });
    }
  }

  const activeMatch = p.match(/^\/api\/workflows\/([^/]+)\/active$/);
  if (activeMatch && req.method === "POST") {
    const { active } = await readJsonBody(req);
    const workflows = readJson(WORKFLOWS_FILE, []);
    const workflow = workflows.find(w => w.id === activeMatch[1]);
    if (!workflow) return sendJson(res, 404, { error: "Not found" });
    workflow.active = !!active;
    writeJson(WORKFLOWS_FILE, workflows);
    return sendJson(res, 200, { ok: true, workflow });
  }

  const enrollMatch = p.match(/^\/api\/workflows\/([^/]+)\/enroll$/);
  if (enrollMatch && req.method === "POST") {
    const { contactId } = await readJsonBody(req);
    const workflow = readJson(WORKFLOWS_FILE, []).find(w => w.id === enrollMatch[1]);
    if (!workflow) return sendJson(res, 404, { error: "Not found" });
    if (!contactId) return sendJson(res, 400, { error: "contactId is required" });
    enrollContactInWorkflow(workflow, contactId);
    return sendJson(res, 200, { ok: true });
  }

  const wfEnrollmentsMatch = p.match(/^\/api\/workflows\/([^/]+)\/enrollments$/);
  if (wfEnrollmentsMatch && req.method === "GET") {
    const enrollments = readJson(WF_ENROLLMENTS_FILE, []).filter(e => e.workflowId === wfEnrollmentsMatch[1]);
    const contacts = readJson(CONTACTS_FILE, []);
    return sendJson(res, 200, { enrollments: enrollments.map(e => ({ ...e, contact: contacts.find(c => c.id === e.contactId) || null })) });
  }

  return false;
}
