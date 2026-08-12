import { randomUUID } from "crypto";
import { readJson, writeJson, readJsonBody, sendJson, getSessionUser } from "./auth_backend.js";
import { CONTACTS_FILE, matchesSegment } from "./segments_shared.js";
import { sendEmail } from "./email_backend.js";
import { addToCustomAudience } from "./facebook_backend.js";

export const AUTOMATIONS_FILE = "crm_automations.json";
export const ENROLLMENTS_FILE = "crm_automation_enrollments.json";

// "page_visit" fires from tracking_backend.js's /api/track/pageview (the
// crm_cid cookie set on a tracked email-link click identifies the browser).
// "add_to_facebook_audience" degrades gracefully -- see facebook_backend.js
// -- same "not configured yet" pattern as SES/Twilio.
export const TRIGGER_TYPES = ["list_subscribe", "tag_added", "email_opened", "email_clicked", "page_visit"];
export const STEP_TYPES = ["send_email", "wait", "add_tag", "remove_tag", "add_to_facebook_audience", "condition", "jump_to_automation", "end_automation"];

function getContact(id) { return readJson(CONTACTS_FILE, []).find(c => c.id === id) || null; }
function saveContact(contact) {
  const contacts = readJson(CONTACTS_FILE, []);
  const idx = contacts.findIndex(c => c.id === contact.id);
  if (idx >= 0) { contacts[idx] = contact; writeJson(CONTACTS_FILE, contacts); }
}
function saveEnrollment(enrollment) {
  const enrollments = readJson(ENROLLMENTS_FILE, []);
  const idx = enrollments.findIndex(e => e.id === enrollment.id);
  if (idx >= 0) enrollments[idx] = enrollment; else enrollments.push(enrollment);
  writeJson(ENROLLMENTS_FILE, enrollments);
}
function completeEnrollment(enrollment) {
  enrollment.status = "completed";
  enrollment.updatedAt = new Date().toISOString();
  saveEnrollment(enrollment);
}

// ── Trigger firing — called from contacts_backend.js (list/tag changes)
// and email_backend.js (SES open/click webhook + click-tracking redirect).
// This is the ONE place any future event source (Framer webhook, Twilio
// inbound SMS) needs to call into to enroll contacts. ─────────────────
export function fireTrigger(type, { contactId, listId, tagId, path }) {
  if (!TRIGGER_TYPES.includes(type) || !contactId) return;
  const automations = readJson(AUTOMATIONS_FILE, []).filter(a => a.active && a.trigger?.type === type);
  for (const automation of automations) {
    const cfg = automation.trigger.config || {};
    let matches = true;
    if (type === "list_subscribe" && cfg.listId) matches = cfg.listId === listId;
    if (type === "tag_added" && cfg.tagId) matches = cfg.tagId === tagId;
    if (type === "page_visit" && cfg.urlContains) matches = String(path || "").includes(cfg.urlContains);
    // email_opened / email_clicked: any tracked email counts for v1 -- no
    // per-campaign trigger scoping yet.
    if (matches) enrollContact(automation, contactId);
  }
}

function enrollContact(automation, contactId) {
  const enrollments = readJson(ENROLLMENTS_FILE, []);
  if (enrollments.some(e => e.automationId === automation.id && e.contactId === contactId && e.status === "active")) return;
  const enrollment = {
    id: randomUUID(), automationId: automation.id, contactId,
    status: "active", currentStepId: automation.startStepId || null,
    enteredAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    waitUntil: null, history: [],
  };
  enrollments.push(enrollment);
  writeJson(ENROLLMENTS_FILE, enrollments);
  if (!enrollment.currentStepId) { completeEnrollment(enrollment); return; }
  advanceEnrollment(enrollment, automation).catch(e => console.error("[automations] advance failed", e.message));
}

// Runs an enrollment forward through steps until it hits a wait step (pauses,
// scheduler.js resumes it later), runs out of steps (completes), or an
// end_automation step targeting itself. A guard caps iterations so a
// mis-wired loop (step A -> step B -> step A) can't hang the request/tick.
async function advanceEnrollment(enrollment, automation) {
  automation = automation || readJson(AUTOMATIONS_FILE, []).find(a => a.id === enrollment.automationId);
  if (!automation) return;
  let guard = 0;
  while (enrollment.status === "active" && enrollment.currentStepId && guard++ < 200) {
    const step = automation.steps[enrollment.currentStepId];
    if (!step) { completeEnrollment(enrollment); return; }
    enrollment.history.push({ stepId: step.id, at: new Date().toISOString() });

    if (step.type === "wait") {
      const ms = step.config.unit === "days" ? step.config.amount * 86400000
        : step.config.unit === "hours" ? step.config.amount * 3600000
        : step.config.amount * 60000;
      enrollment.waitUntil = new Date(Date.now() + (Number(ms) || 0)).toISOString();
      saveEnrollment(enrollment);
      return; // pauses here -- scheduler.js's advanceDueEnrollments() resumes it
    }

    if (step.type === "send_email") {
      const contact = getContact(enrollment.contactId);
      if (contact) {
        await sendEmail({
          to: contact.email, subject: step.config.subject || "", blocks: step.config.blocks || [], theme: step.config.theme,
          footerTemplateId: step.config.footerTemplateId, contactId: contact.id,
          sourceType: "automation_step", sourceId: `${automation.id}:${step.id}`,
        });
      }
      enrollment.currentStepId = step.nextStepId || null;
    } else if (step.type === "add_tag") {
      const contact = getContact(enrollment.contactId);
      if (contact && step.config.tagId && !contact.tags.includes(step.config.tagId)) { contact.tags.push(step.config.tagId); saveContact(contact); }
      enrollment.currentStepId = step.nextStepId || null;
    } else if (step.type === "remove_tag") {
      const contact = getContact(enrollment.contactId);
      if (contact && step.config.tagId) { contact.tags = contact.tags.filter(t => t !== step.config.tagId); saveContact(contact); }
      enrollment.currentStepId = step.nextStepId || null;
    } else if (step.type === "add_to_facebook_audience") {
      const contact = getContact(enrollment.contactId);
      if (contact && step.config.audienceId) {
        await addToCustomAudience({ email: contact.email, phone: contact.phone, audienceId: step.config.audienceId }).catch(e => console.error("[automations] facebook audience add failed", e.message));
      }
      enrollment.currentStepId = step.nextStepId || null;
    } else if (step.type === "condition") {
      const contact = getContact(enrollment.contactId);
      const matched = contact ? matchesSegment(contact, step.config.filter) : false;
      enrollment.currentStepId = (matched ? step.yesStepId : step.noStepId) || null;
    } else if (step.type === "jump_to_automation") {
      const target = readJson(AUTOMATIONS_FILE, []).find(a => a.id === step.config.automationId);
      if (target) enrollContact(target, enrollment.contactId);
      enrollment.currentStepId = step.nextStepId || null;
    } else if (step.type === "end_automation") {
      const all = readJson(ENROLLMENTS_FILE, []);
      all.filter(e => e.automationId === step.config.automationId && e.contactId === enrollment.contactId && e.status === "active")
        .forEach(e => { e.status = "completed"; e.updatedAt = new Date().toISOString(); });
      writeJson(ENROLLMENTS_FILE, all);
      enrollment.currentStepId = step.nextStepId || null;
    } else {
      enrollment.currentStepId = step.nextStepId || null;
    }

    if (!enrollment.currentStepId) { completeEnrollment(enrollment); return; }
  }
  saveEnrollment(enrollment);
}

// Called by scheduler.js every tick -- resumes any enrollment whose wait
// step has expired.
export async function advanceDueEnrollments() {
  const enrollments = readJson(ENROLLMENTS_FILE, []);
  const due = enrollments.filter(e => e.status === "active" && e.waitUntil && new Date(e.waitUntil).getTime() <= Date.now());
  for (const enrollment of due) {
    const automation = readJson(AUTOMATIONS_FILE, []).find(a => a.id === enrollment.automationId);
    if (!automation) continue;
    const waitStep = automation.steps[enrollment.currentStepId];
    enrollment.waitUntil = null;
    enrollment.currentStepId = waitStep?.nextStepId || null;
    if (!enrollment.currentStepId) { completeEnrollment(enrollment); continue; }
    await advanceEnrollment(enrollment, automation);
  }
}

function stepCounts(automationId) {
  const enrollments = readJson(ENROLLMENTS_FILE, []).filter(e => e.automationId === automationId && e.status === "active");
  const counts = {};
  enrollments.forEach(e => { if (e.currentStepId) counts[e.currentStepId] = (counts[e.currentStepId] || 0) + 1; });
  return counts;
}

export async function handleAutomationsRequest(req, res, url) {
  const p = url.pathname;
  if (!p.startsWith("/api/automations")) return false;
  const me = getSessionUser(req);
  if (!me) return sendJson(res, 401, { error: "Not logged in" });

  if (p === "/api/automations" && req.method === "GET") {
    const automations = readJson(AUTOMATIONS_FILE, []);
    const enrollments = readJson(ENROLLMENTS_FILE, []);
    const list = automations.map(a => ({
      ...a,
      enrolledCount: enrollments.filter(e => e.automationId === a.id && e.status === "active").length,
      totalEnrolled: enrollments.filter(e => e.automationId === a.id).length,
    }));
    return sendJson(res, 200, { automations: list });
  }
  if (p === "/api/automations" && req.method === "POST") {
    const { name } = await readJsonBody(req);
    const automations = readJson(AUTOMATIONS_FILE, []);
    const automation = {
      id: randomUUID(), name: name || "Untitled Automation", active: false,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      versions: [],
      trigger: { type: "list_subscribe", config: {} },
      steps: {}, startStepId: null,
    };
    automations.push(automation);
    writeJson(AUTOMATIONS_FILE, automations);
    return sendJson(res, 200, { ok: true, automation });
  }

  const duplicateMatch = p.match(/^\/api\/automations\/([^/]+)\/duplicate$/);
  if (duplicateMatch && req.method === "POST") {
    const automations = readJson(AUTOMATIONS_FILE, []);
    const source = automations.find(a => a.id === duplicateMatch[1]);
    if (!source) return sendJson(res, 404, { error: "Not found" });
    const copy = {
      id: randomUUID(), name: `Copy of ${source.name}`, active: false,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      versions: [],
      trigger: JSON.parse(JSON.stringify(source.trigger)),
      steps: JSON.parse(JSON.stringify(source.steps)),
      startStepId: source.startStepId,
    };
    automations.push(copy);
    writeJson(AUTOMATIONS_FILE, automations);
    return sendJson(res, 200, { ok: true, automation: copy });
  }

  const automationMatch = p.match(/^\/api\/automations\/([^/]+)$/);
  if (automationMatch) {
    const automations = readJson(AUTOMATIONS_FILE, []);
    const automation = automations.find(a => a.id === automationMatch[1]);
    if (req.method === "GET") {
      if (!automation) return sendJson(res, 404, { error: "Not found" });
      return sendJson(res, 200, { automation, stepCounts: stepCounts(automation.id) });
    }
    if (req.method === "PATCH") {
      if (!automation) return sendJson(res, 404, { error: "Not found" });
      const body = await readJsonBody(req);
      // Autosave version snapshot -- capped at the last 20, matching Close's
      // "Last change was saved" pattern rather than a manual "save version" step.
      automation.versions = automation.versions || [];
      automation.versions.push({ versionId: randomUUID(), savedAt: new Date().toISOString(), savedBy: me.id, snapshot: { trigger: automation.trigger, steps: automation.steps, startStepId: automation.startStepId } });
      if (automation.versions.length > 20) automation.versions = automation.versions.slice(-20);
      for (const k of ["name", "trigger", "steps", "startStepId"]) if (k in body) automation[k] = body[k];
      automation.updatedAt = new Date().toISOString();
      writeJson(AUTOMATIONS_FILE, automations);
      return sendJson(res, 200, { ok: true, automation });
    }
    if (req.method === "DELETE") {
      writeJson(AUTOMATIONS_FILE, automations.filter(a => a.id !== automationMatch[1]));
      return sendJson(res, 200, { ok: true });
    }
  }

  const activateMatch = p.match(/^\/api\/automations\/([^/]+)\/active$/);
  if (activateMatch && req.method === "POST") {
    const { active } = await readJsonBody(req);
    const automations = readJson(AUTOMATIONS_FILE, []);
    const automation = automations.find(a => a.id === activateMatch[1]);
    if (!automation) return sendJson(res, 404, { error: "Not found" });
    automation.active = !!active;
    writeJson(AUTOMATIONS_FILE, automations);
    return sendJson(res, 200, { ok: true, automation });
  }

  const enrollmentsMatch = p.match(/^\/api\/automations\/([^/]+)\/enrollments$/);
  if (enrollmentsMatch && req.method === "GET") {
    const enrollments = readJson(ENROLLMENTS_FILE, []).filter(e => e.automationId === enrollmentsMatch[1]);
    const contacts = readJson(CONTACTS_FILE, []);
    const withContacts = enrollments.map(e => ({ ...e, contact: contacts.find(c => c.id === e.contactId) || null }));
    return sendJson(res, 200, { enrollments: withContacts });
  }

  return false;
}
