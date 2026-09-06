import { randomUUID } from "crypto";
import { readJson, writeJson, readJsonBody, sendJson, getSessionUser } from "./auth_backend.js";
import { CONTACTS_FILE, matchesSegment, resolveBulkContactIds } from "./segments_shared.js";
import { sendEmail } from "./email_backend.js";
import { addToCustomAudience } from "./facebook_backend.js";
import { maybeSnapshotVersion, listVersions, getVersion } from "./versions_shared.js";
import { getEmailTheme } from "./integrations_backend.js";
import { BOOKINGS_FILE, EVENT_TYPES_FILE, applyBookingTokens, getBookingTokenValues } from "./scheduling_backend.js";

// Which booking a step's %EVENTNAME%/%WHEN%/etc tokens refer to: the exact
// booking that triggered enrollment when there is one (booking_created
// trigger), otherwise this contact's next upcoming confirmed booking of
// ANY event type -- most automations/sequences here aren't triggered by
// the booking itself (a lead comes in off a list/tag and is *separately*
// on the books for a call), so gating tokens to only the booking_created
// trigger left them unavailable for exactly the "your call is on ..."
// content this business actually sends.
function resolveTokenBooking(contactId, bookingId) {
  const bookings = readJson(BOOKINGS_FILE, []);
  if (bookingId) return bookings.find(b => b.id === bookingId) || null;
  const now = Date.now();
  return bookings
    .filter(b => b.contactId === contactId && b.status === "confirmed" && new Date(b.startAt).getTime() > now)
    .sort((a, b) => new Date(a.startAt) - new Date(b.startAt))[0] || null;
}

export const AUTOMATIONS_FILE = "crm_automations.json";
export const ENROLLMENTS_FILE = "crm_automation_enrollments.json";
export const AUTOMATION_VERSIONS_FILE = "crm_automation_versions.json";
const VERSIONED_FIELDS = ["name", "triggers", "steps", "startStepId", "goal"];
// A send_email step's failure retries up to this many times, waiting this
// long between attempts, before giving up and moving on -- see
// advanceEnrollment's send_email branch.
const SEND_STEP_MAX_RETRIES = 3;
const SEND_STEP_RETRY_DELAY_MS = 5 * 60 * 1000;
function automationSnapshotFields(automation) {
  const out = {};
  for (const k of VERSIONED_FIELDS) out[k] = automation[k];
  return out;
}

// "page_visit" fires from tracking_backend.js's /api/track/pageview (the
// crm_cid cookie set on a tracked email-link click identifies the browser).
// "form_submitted" fires from forms_backend.js once a public form submission
// has been matched/upserted to a contact.
// "booking_created" fires from scheduling_backend.js once a public booking
// has been matched/upserted to a contact -- same shape as form_submitted.
// "add_to_facebook_audience" degrades gracefully -- see facebook_backend.js
// -- same "not configured yet" pattern as SES/Twilio.
export const TRIGGER_TYPES = ["list_subscribe", "tag_added", "email_opened", "email_clicked", "page_visit", "form_submitted", "booking_created"];
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

// Goal: when a contact hits the automation's defined goal (currently just
// "their status changed to X"), pull them straight to completed regardless
// of which step they're on -- mirrors workflows_backend.js's
// checkConversionGoal, called from the same contacts_backend.js status-PATCH
// hook. A blank goal.status means "any status change counts."
export function checkAutomationGoal(trigger, contactId, statusValue) {
  if (!contactId || trigger !== "lead_status_change") return;
  const automations = readJson(AUTOMATIONS_FILE, []).filter(a => a.active && a.goal?.trigger === "lead_status_change" && (!a.goal.status || a.goal.status === statusValue));
  if (!automations.length) return;
  const enrollments = readJson(ENROLLMENTS_FILE, []);
  let changed = false;
  automations.forEach(a => {
    enrollments.filter(e => e.automationId === a.id && e.contactId === contactId && e.status === "active").forEach(e => {
      e.status = "goal_met"; e.goalMetAt = new Date().toISOString(); changed = true;
    });
  });
  if (changed) writeJson(ENROLLMENTS_FILE, enrollments);
}

// ── Trigger firing — called from contacts_backend.js (list/tag changes)
// and email_backend.js (SES open/click webhook + click-tracking redirect).
// This is the ONE place any future event source (Framer webhook, Twilio
// inbound SMS) needs to call into to enroll contacts. ─────────────────
// An automation can have several OR'd start triggers (e.g. "any email
// open" OR "any email click" OR "visits any page" all doing the same
// thing) -- mirrors ActiveCampaign's multi-trigger automations, where a
// single fired event only needs to satisfy ONE of the automation's
// triggers of the matching type, not all of them.
function triggerMatches(trig, type, { listId, tagId, path, formId, eventTypeId }) {
  if (trig.type !== type) return false;
  const cfg = trig.config || {};
  if (type === "list_subscribe" && cfg.listId) return cfg.listId === listId;
  if (type === "tag_added" && cfg.tagId) return cfg.tagId === tagId;
  if (type === "page_visit" && cfg.urlContains) return String(path || "").includes(cfg.urlContains);
  if (type === "form_submitted" && cfg.formId) return cfg.formId === formId;
  if (type === "booking_created" && cfg.eventTypeId) return cfg.eventTypeId === eventTypeId;
  // email_opened / email_clicked: any tracked email counts for v1 -- no
  // per-campaign trigger scoping yet. Also the no-scoping-config fallback
  // for the other types above (any list/tag/form/event type).
  return true;
}
export function fireTrigger(type, { contactId, listId, tagId, path, formId, eventTypeId, bookingId }) {
  if (!TRIGGER_TYPES.includes(type) || !contactId) return;
  const automations = readJson(AUTOMATIONS_FILE, []).filter(a => a.active);
  for (const automation of automations) {
    const triggers = automation.triggers || [];
    if (triggers.some(t => triggerMatches(t, type, { listId, tagId, path, formId, eventTypeId }))) {
      enrollContact(automation, contactId, { bookingId });
    }
  }
}

// context.bookingId (only ever set for a booking_created trigger) rides
// along on the enrollment itself so a later send_email step -- possibly
// after a wait step, well after the triggering request has returned --
// can still look up which specific booking this contact's journey through
// the automation is about, to resolve %WHEN%/%DATE%/%TIME% etc.
export function enrollContact(automation, contactId, context) {
  // An inactive automation must never start (or resume) sending -- the
  // trigger-fired path already filtered on `.active` before calling here,
  // but manual/API enrollment and jump_to_automation didn't, so a toggled-
  // off automation could still email a contact.
  if (!automation.active) return;
  const enrollments = readJson(ENROLLMENTS_FILE, []);
  if (enrollments.some(e => e.automationId === automation.id && e.contactId === contactId && e.status === "active")) return;
  const enrollment = {
    id: randomUUID(), automationId: automation.id, contactId,
    status: "active", currentStepId: automation.startStepId || null,
    enteredAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    waitUntil: null, history: [], bookingId: context?.bookingId || null,
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
  if (!automation || !automation.active) return; // paused mid-flight -- resumes once reactivated
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
        let subject = step.config.subject || "";
        let previewText = step.config.previewText;
        let blocks = step.config.blocks || [];
        // Resolve %EVENTNAME%/%WHEN%/%DATE%/%TIME%/etc (see
        // scheduling_backend.js) before the normal contact merge tags run
        // inside sendEmail(), same substitution scheduling_backend.js's own
        // confirmation/reminder sends do. No booking found (never booked,
        // or nothing upcoming) just leaves these tokens unresolved as
        // literal text -- same "didn't customize it" fallback behavior as
        // an unset subject/blocks.
        const booking = resolveTokenBooking(enrollment.contactId, enrollment.bookingId);
        const et = booking ? readJson(EVENT_TYPES_FILE, []).find(e => e.id === booking.eventTypeId) : null;
        if (booking && et) {
          const tokens = getBookingTokenValues(booking, et);
          subject = applyBookingTokens(subject, tokens);
          if (previewText) previewText = applyBookingTokens(previewText, tokens);
          blocks = blocks.map(b => (b.type === "text" && b.html) ? { ...b, html: applyBookingTokens(b.html, tokens) } : b);
        }
        const result = await sendEmail({
          to: contact.email, subject, previewText, blocks, theme: step.config.theme,
          footerTemplateId: step.config.footerTemplateId, contactId: contact.id,
          sourceType: "automation_step", sourceId: `${automation.id}:${step.id}`,
        });
        // A transient failure here used to be permanent -- silently logged
        // "failed" and the enrollment moved straight past this step with no
        // retry and nothing visible to notice. Confirmed live: a real lead
        // never got their welcome email this way. opted_out is a genuine,
        // permanent reason to skip -- retrying that would just keep hitting
        // the same opt-out forever, so it counts as "done", not "failed".
        if (!result.ok && result.reason !== "opted_out") {
          const retryCount = (enrollment.stepRetryCount || 0) + 1;
          if (retryCount <= SEND_STEP_MAX_RETRIES) {
            enrollment.stepRetryCount = retryCount;
            enrollment.waitUntil = new Date(Date.now() + SEND_STEP_RETRY_DELAY_MS).toISOString();
            saveEnrollment(enrollment);
            return; // pauses here like a wait step -- advanceDueEnrollments resumes and retries this exact step
          }
          // Retries exhausted -- move on rather than leaving the enrollment
          // stuck here forever (which would also block ever re-enrolling
          // this contact, via enrollContact's own active-enrollment check).
        }
      }
      enrollment.stepRetryCount = 0;
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
      if (target) enrollContact(target, enrollment.contactId, { bookingId: enrollment.bookingId });
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
    if (!automation.active) continue; // leave waitUntil as-is -- fires as soon as reactivated, not lost
    const currentStep = automation.steps[enrollment.currentStepId];
    enrollment.waitUntil = null;
    // A genuine "wait" step advances past itself once due -- but a
    // send_email step that set waitUntil for its own retry (see
    // advanceEnrollment's send_email branch) needs to be RE-ATTEMPTED, not
    // skipped, so currentStepId only moves for an actual wait step here.
    if (currentStep?.type === "wait") enrollment.currentStepId = currentStep.nextStepId || null;
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

// Mirrors workflows_backend.js's workflowStats -- automations don't track
// "bounced" or "errored" enrollment states (those are SMS-delivery-specific,
// only set by workflows_backend.js's own send step), so this only reports
// the statuses that actually occur here: active/completed/goal_met/cancelled.
function automationStats(automationId) {
  const enrollments = readJson(ENROLLMENTS_FILE, []).filter(e => e.automationId === automationId);
  return {
    active: enrollments.filter(e => e.status === "active").length,
    enrolled: enrollments.length,
    completed: enrollments.filter(e => e.status === "completed").length,
    goalMet: enrollments.filter(e => e.status === "goal_met").length,
    cancelled: enrollments.filter(e => e.status === "cancelled").length,
  };
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
      triggers: [{ type: "list_subscribe", config: {} }],
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
      triggers: JSON.parse(JSON.stringify(source.triggers || [])),
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
      return sendJson(res, 200, { automation, stepCounts: stepCounts(automation.id), stats: automationStats(automation.id) });
    }
    if (req.method === "PATCH") {
      if (!automation) return sendJson(res, 404, { error: "Not found" });
      const body = await readJsonBody(req);
      // Snapshot the pre-change state before overwriting it -- throttled
      // (see versions_shared.js) so this doesn't create a new version on
      // every debounced autosave, just roughly once per editing session.
      // Shared with campaigns_backend.js's identical versioning, in its own
      // file (crm_automation_versions.json) rather than growing unboundedly
      // inline on the automation record itself.
      maybeSnapshotVersion(AUTOMATION_VERSIONS_FILE, "automationId", automation.id, automationSnapshotFields(automation));
      for (const k of VERSIONED_FIELDS) if (k in body) automation[k] = body[k];
      automation.updatedAt = new Date().toISOString();
      writeJson(AUTOMATIONS_FILE, automations);
      return sendJson(res, 200, { ok: true, automation });
    }
    if (req.method === "DELETE") {
      writeJson(AUTOMATIONS_FILE, automations.filter(a => a.id !== automationMatch[1]));
      return sendJson(res, 200, { ok: true });
    }
  }

  const versionsMatch = p.match(/^\/api\/automations\/([^/]+)\/versions$/);
  if (versionsMatch && req.method === "GET") {
    return sendJson(res, 200, { versions: listVersions(AUTOMATION_VERSIONS_FILE, "automationId", versionsMatch[1]) });
  }
  const restoreMatch = p.match(/^\/api\/automations\/([^/]+)\/versions\/([^/]+)\/restore$/);
  if (restoreMatch && req.method === "POST") {
    const automations = readJson(AUTOMATIONS_FILE, []);
    const automation = automations.find(a => a.id === restoreMatch[1]);
    if (!automation) return sendJson(res, 404, { error: "Automation not found" });
    const version = getVersion(AUTOMATION_VERSIONS_FILE, "automationId", automation.id, restoreMatch[2]);
    if (!version) return sendJson(res, 404, { error: "Version not found" });
    maybeSnapshotVersion(AUTOMATION_VERSIONS_FILE, "automationId", automation.id, automationSnapshotFields(automation), { force: true });
    Object.assign(automation, version.snapshot);
    automation.updatedAt = new Date().toISOString();
    writeJson(AUTOMATIONS_FILE, automations);
    return sendJson(res, 200, { ok: true, automation });
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

  // Manual bulk enroll -- from the Contacts table's bulk-select, or a
  // Segments/Tags row's "Add to Automation" action. Accepts contactIds/
  // contactId/segmentId/tagId (see resolveBulkContactIds); a segment/tag
  // is resolved to its current member contacts at enroll time, not stored
  // as a live membership, so someone who joins the tag/segment LATER
  // isn't automatically enrolled too -- same one-time-snapshot semantics
  // as picking contacts by hand.
  const bulkEnrollMatch = p.match(/^\/api\/automations\/([^/]+)\/enroll$/);
  if (bulkEnrollMatch && req.method === "POST") {
    const automations = readJson(AUTOMATIONS_FILE, []);
    const automation = automations.find(a => a.id === bulkEnrollMatch[1]);
    if (!automation) return sendJson(res, 404, { error: "Not found" });
    if (!automation.active) return sendJson(res, 400, { error: "This automation is inactive -- turn it on before enrolling anyone." });
    const body = await readJsonBody(req);
    const contactIds = resolveBulkContactIds(body);
    if (!contactIds.length) return sendJson(res, 400, { error: "No matching contacts to enroll" });
    contactIds.forEach(id => enrollContact(automation, id));
    return sendJson(res, 200, { ok: true, enrolled: contactIds.length });
  }

  const enrollmentsMatch = p.match(/^\/api\/automations\/([^/]+)\/enrollments$/);
  if (enrollmentsMatch && req.method === "GET") {
    const enrollments = readJson(ENROLLMENTS_FILE, []).filter(e => e.automationId === enrollmentsMatch[1]);
    const contacts = readJson(CONTACTS_FILE, []);
    const withContacts = enrollments.map(e => ({ ...e, contact: contacts.find(c => c.id === e.contactId) || null }));
    return sendJson(res, 200, { enrollments: withContacts });
  }

  // Unenroll one contact -- marks the enrollment cancelled rather than
  // deleting the record, so it drops out of every "active" filter (the
  // tick-driven resumer included) while keeping history.
  const enrollmentDeleteMatch = p.match(/^\/api\/automations\/([^/]+)\/enrollments\/([^/]+)$/);
  if (enrollmentDeleteMatch && req.method === "DELETE") {
    const enrollments = readJson(ENROLLMENTS_FILE, []);
    const enrollment = enrollments.find(e => e.id === enrollmentDeleteMatch[2] && e.automationId === enrollmentDeleteMatch[1]);
    if (!enrollment) return sendJson(res, 404, { error: "Not found" });
    enrollment.status = "cancelled";
    enrollment.updatedAt = new Date().toISOString();
    writeJson(ENROLLMENTS_FILE, enrollments);
    return sendJson(res, 200, { ok: true });
  }

  // Bulk reset (Settings > Email Theme's "reset all" button) -- re-copies
  // the current org theme into every send_email step. A single step's own
  // "Reset to default" (in its editor) just updates local state and goes
  // out through the normal autosave path instead of a dedicated endpoint.
  if (p === "/api/automations/reset-all-themes" && req.method === "POST") {
    const automations = readJson(AUTOMATIONS_FILE, []);
    const theme = getEmailTheme();
    let count = 0;
    automations.forEach(a => {
      Object.values(a.steps || {}).forEach(step => {
        if (step.type === "send_email") { step.config.theme = { ...theme }; count++; }
      });
      a.updatedAt = new Date().toISOString();
    });
    writeJson(AUTOMATIONS_FILE, automations);
    return sendJson(res, 200, { ok: true, count });
  }

  return false;
}
