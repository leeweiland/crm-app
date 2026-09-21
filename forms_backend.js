import { randomUUID } from "crypto";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { readJson, writeJson, readJsonBody, sendJson, getSessionUser } from "./auth_backend.js";
import { CONTACTS_FILE, findContactMatch, applyAdvancingStatus } from "./segments_shared.js";
import { logMessage } from "./message_log.js";
import { fireTrigger } from "./automations_backend.js";
import { fireWorkflowTrigger } from "./workflows_backend.js";
import { fireFlowTrigger } from "./flows_backend.js";
import { clientIp, lookupIpLocation, claimVisitorHistory } from "./tracking_backend.js";
import { normalizePhoneForRequest } from "./phone_util.js";
import { EVENT_TYPES_FILE, BOOKINGS_FILE } from "./scheduling_backend.js";
import { syncContactFields } from "./sqlite_inbox.js";
import { estimateIncomeInBackground } from "./income_estimate.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const FORMS_FILE = "crm_forms.json";
export const RESPONSES_FILE = "crm_form_responses.json";
// Best-effort funnel analytics only (Forms > Drop-offs tab) -- { [formId]:
// { [stepIndex]: { [sid]: "YYYY-MM-DD" } } }, one entry per DISTINCT visitor
// who reached that step, keyed by a client-generated sessionStorage id (see
// public-form.html's stepViewSid), deliberately separate from the vid/
// visitorId ad-attribution cookie since that one is blank for most direct/
// organic traffic and would undercount every step to "1 visitor." The date
// is the visitor's FIRST-seen day for that step (never overwritten on a
// later revisit), in Anchorage's calendar day -- same timezone convention
// reporting.html's own date-range picker uses -- so the Drop-offs tab's
// period filter buckets consistently with every other report in the app.
export const STEP_VIEWS_FILE = "crm_form_step_views.json";
// The first Drop-offs release (Sep 13, 10:33 AKDT) stored each step's visitors as
// a plain ARRAY of ids; the date-range picker shipped two hours later switched
// to { id: "YYYY-MM-DD" } objects with no migration. A step still holding the
// old array made every later view a silent no-op (setting a string key on an
// array is dropped by JSON.stringify) -- ONLINE APP's steps all stayed arrays,
// so nothing was recorded for it after that morning -- and the date filter
// never matched the old array's ids either. Old entries were all recorded that
// first morning, hence the fixed date.
const LEGACY_STEP_VIEW_DATE = "2026-09-13";
function normalizeStepViews(forForm) {
  for (const [idx, val] of Object.entries(forForm)) {
    if (Array.isArray(val)) forForm[idx] = Object.fromEntries(val.map(sid => [sid, LEGACY_STEP_VIEW_DATE]));
  }
  return forForm;
}
// Same "which Anchorage calendar day does this instant fall on" question
// ads_backend.js's resolveRange answers for ad spend -- duplicated (not
// imported) since it's a one-line Intl call, not worth a shared module for.
function anchorageDateStr(d) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Anchorage", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

// "statement"/"headline"/"image"/"video"/"calendar" are display-only content
// blocks (no answer), "page_break" is a layout marker (splits the public
// renderer into steps, Tally's one-question-at-a-time feel) -- none of
// these are validated as required and none ever carry an answer. "calendar"
// embeds one of scheduling_backend.js's booking pages inline (same
// .scheduling-inline-widget + /widget.js pattern book.html's own embed
// snippet uses) -- the booking itself still happens on that system, this
// step is just where it's shown in the form's flow. "country" is answerable
// but invisible -- public-form.html silently fills its own answer in via
// IP geolocation (see /detect-country below) rather than asking the
// visitor anything, so the SAME per-field logic-rule builder every other
// field already has (equals/contains -> hide_next or redirect) works as a
// country screen for free, no separate mechanism needed.
export const FIELD_TYPES = [
  "short_text", "long_text", "email", "phone", "first_name", "last_name",
  "number", "dropdown", "multiple_choice", "checkboxes", "date", "country",
  "statement", "headline", "image", "video", "calendar", "page_break",
];
const CHOICE_TYPES = ["dropdown", "multiple_choice", "checkboxes"];
const NON_ANSWERABLE_TYPES = ["statement", "headline", "image", "video", "calendar", "page_break"];
const ANSWERABLE_TYPES = FIELD_TYPES.filter(t => !NON_ANSWERABLE_TYPES.includes(t));

// Same two embed patterns scheduling_backend.js's widget.js offers (inline
// auto-scan + JS-driven popup overlay), scoped to forms so the Embed modal
// in form-builder.html can offer the same Inline/Popup/Direct Link choices.
const FORMS_WIDGET_JS = `(function(){
  // Appends the PARENT page's crm_vid (visitor id -- see tracking_backend.js)
  // onto the iframe's own src. The iframe is on the CRM's own origin, so it
  // can't read a cookie set by track.js running here on the Framer origin --
  // this is the only way to hand it across, same reasoning as crm_cid
  // crossing the OTHER direction via a query param on /api/email/click's
  // redirect.
  function withVid(url){
    var m = document.cookie.match(/(?:^|; )crm_vid=([^;]*)/);
    if (!m) return url;
    return url + (url.indexOf('?') === -1 ? '?' : '&') + 'vid=' + m[1];
  }
  function injectStyles(){
    if (document.getElementById('form-widget-styles')) return;
    var s = document.createElement('style');
    s.id = 'form-widget-styles';
    s.textContent = '.form-overlay{position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:999999;display:flex;align-items:center;justify-content:center;padding:20px}.form-overlay iframe{width:100%;max-width:640px;height:90vh;border:0;border-radius:12px;background:#0a0a0d}.form-overlay .form-widget-close{position:absolute;top:20px;right:24px;color:#fff;font-size:32px;cursor:pointer;background:none;border:none;line-height:1}';
    document.head.appendChild(s);
  }
  function openPopup(opts){
    injectStyles();
    var overlay = document.createElement('div');
    overlay.className = 'form-overlay';
    var close = document.createElement('button');
    close.className = 'form-widget-close';
    close.innerHTML = '\\u00d7';
    close.onclick = function(){ document.body.removeChild(overlay); };
    var iframe = document.createElement('iframe');
    iframe.src = withVid(opts.url);
    overlay.appendChild(iframe);
    overlay.appendChild(close);
    overlay.addEventListener('click', function(e){ if (e.target === overlay) document.body.removeChild(overlay); });
    document.body.appendChild(overlay);
  }
  function initInlineWidgets(){
    var els = document.querySelectorAll('.form-inline-widget[data-url]');
    for (var i = 0; i < els.length; i++){
      var el = els[i];
      if (el.getAttribute('data-form-widget-initialized')) continue;
      el.setAttribute('data-form-widget-initialized', '1');
      // Older/hand-pasted embed snippets only set min-width, which lets a
      // flex-based site builder (Framer etc.) shrink the div to its content
      // instead of stretching it to fill its column. Default to full width
      // here so that already-placed embeds pick this up too, without
      // clobbering a width the site owner deliberately set.
      if (!el.style.width) el.style.width = '100%';
      var iframe = document.createElement('iframe');
      iframe.src = withVid(el.getAttribute('data-url'));
      iframe.style.width = '100%';
      iframe.style.height = '100%';
      iframe.style.border = '0';
      iframe.style.minHeight = el.style.height || '700px';
      el.appendChild(iframe);
    }
  }
  // The 700px fallback above is just what's shown before the form's own
  // page (public-form.html) measures its real content and posts it here --
  // once that arrives, the box fits the actual step instead of showing an
  // ugly inner scrollbar (too short) or dead space (too tall). Matched by
  // event.source since a page can have more than one inline widget.
  window.addEventListener('message', function(e){
    if (!e.data || e.data.type !== 'pf-resize' || !e.data.height) return;
    var frames = document.querySelectorAll('.form-inline-widget iframe');
    for (var i = 0; i < frames.length; i++){
      if (frames[i].contentWindow === e.source) { frames[i].parentElement.style.height = e.data.height + 'px'; break; }
    }
  });
  window.FormWidget = { initPopupWidget: openPopup };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initInlineWidgets);
  else initInlineWidgets();
})();`;

function slugField(field) {
  const base = String(field.label || field.type || field.id).toLowerCase().trim().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return base || field.id;
}

// A field's `code` is the STABLE identifier flows/customFields key answers
// by -- generated once (from whatever the label happens to be at that
// moment) and never touched again, so relabeling a question later can't
// silently sever a {{payload.code}} token in an already-built flow, or
// fragment a contact's customFields history across two different keys.
// Reordering fields never touches this either, since it lives on the field
// object itself, not its position in the array. Truncated at a word
// boundary rather than a hard character cut, so it stays a real (if
// shortened) phrase instead of ending mid-word.
function codeFromLabel(label, type) {
  const base = String(label || type || "field").toLowerCase().trim().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (!base) return type || "field";
  let out = "";
  for (const word of base.split("_")) {
    const next = out ? `${out}_${word}` : word;
    if (next.length > 48) break;
    out = next;
  }
  return out || base.slice(0, 48) || type || "field";
}

// Backfills `.code` onto any field that doesn't have one yet (a brand-new
// field, or an existing field from before this migration) -- deduped
// against every other code already in use on this form so two same-worded
// questions ("Email", "Email") don't collide. Idempotent: a field that
// already has a code is never touched, no matter how many times this runs.
function ensureFieldCodes(fields) {
  const used = new Set(fields.map(f => f.code).filter(Boolean));
  for (const f of fields) {
    if (f.code || !ANSWERABLE_TYPES.includes(f.type)) continue;
    const base = codeFromLabel(f.label, f.type);
    let code = base, n = 2;
    while (used.has(code)) code = `${base}_${n++}`;
    f.code = code;
    used.add(code);
  }
  return fields;
}
// Self-heal for a form that's never been re-saved in the builder since this
// migration shipped -- newForm/the PATCH handler are the normal places
// codes get assigned, but only run when someone actually opens the
// builder. Called from both the public GET (so public-form.html's own
// bookingWidgetUrl has real codes to key labeledAnswers by) and the submit
// handler (belt and suspenders, in case the visitor's own load happened
// moments before this shipped). No-ops instantly once every field has one.
function selfHealFieldCodes(form, forms) {
  if (form.fields.some(f => ANSWERABLE_TYPES.includes(f.type) && !f.code)) {
    ensureFieldCodes(form.fields);
    writeJson(FORMS_FILE, forms);
  }
}

function newField(type) {
  const id = randomUUID();
  const field = { id, type, label: "", placeholder: "", required: false, helpText: "" };
  if (CHOICE_TYPES.includes(type)) field.options = [{ id: randomUUID(), label: "Option 1" }];
  if (type === "statement") { field.label = "Statement"; field.helpText = ""; delete field.required; }
  if (type === "page_break") { delete field.label; delete field.placeholder; delete field.required; delete field.helpText; }
  return field;
}

function newForm(name) {
  const emailField = newField("email");
  emailField.label = "Email"; emailField.required = true;
  return {
    id: randomUUID(),
    name: name || "Untitled Form",
    status: "draft",
    fields: ensureFieldCodes([emailField]),
    settings: {
      submitButtonText: "Submit",
      confirmationMessage: "Thanks — we got it!",
      redirectUrl: "",
      defaultStatus: "",
      addTagIds: [],
      addListIds: [],
    },
    theme: { accentColor: "#009bff" },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

// A headline/statement block's label is rich text (bold/italic/underline
// from the builder's Ctrl+B/I/U), not the plain string every other field's
// label is -- stored and rendered as real HTML, so it has to be sanitized
// down to an explicit allowlist before it's trusted anywhere, since this
// flows straight into a PUBLIC page via innerHTML. Matches any tag-like
// sequence and keeps ONLY these bare tag names, discarding every attribute
// unconditionally (so a real <script>, an <img onerror=>, or the browser's
// own <span style="font-weight:normal"> -- what execCommand('bold')
// actually produces when un-bolding text that's already bold via CSS, e.g.
// a headline -- all collapse to their inner text instead of ever becoming
// live markup or leaking as visible raw-tag text). This is an allowlist,
// not a blocklist trying to catch every dangerous pattern. Idempotent, so
// re-running it on already-sanitized input is harmless.
function sanitizeRichText(raw) {
  const ALLOWED = ["b", "i", "u", "strong", "em", "br"];
  return String(raw ?? "").replace(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g, (full, slash, tag) => {
    const t = tag.toLowerCase();
    return ALLOWED.includes(t) ? `<${slash}${t}>` : "";
  });
}
function sanitizeRichTextFields(fields) {
  return fields.map(f => (f.type === "headline" || f.type === "statement") ? { ...f, label: sanitizeRichText(f.label) } : f);
}

function publicForm(form) {
  // Strips internal routing config (defaultStatus/addTagIds/addListIds) —
  // the public renderer only needs what it displays and submits against.
  // An "ai_disqualify" logic rule's value (the actual disqualification
  // criteria) is stripped -- the client needs to know the rule EXISTS (to
  // call the ai-screen endpoint after that field's answer settles) but
  // never the criteria text itself, or a visitor could read it straight
  // out of the page source and word their answer to dodge it.
  return {
    id: form.id, name: form.name, theme: form.theme,
    fields: sanitizeRichTextFields(form.fields).map(f => {
      if (!(f.logic || []).some(r => r.op === "ai_disqualify")) return f;
      return { ...f, logic: f.logic.map(r => r.op === "ai_disqualify" ? { ...r, value: undefined } : r) };
    }),
    settings: {
      submitButtonText: form.settings.submitButtonText,
      confirmationMessage: form.settings.confirmationMessage,
      redirectUrl: form.settings.redirectUrl,
    },
  };
}

// ── Same raw-fetch pattern ai_agents_backend.js's generateAgentReply uses
// for Claude -- duplicated rather than imported (separate concerns, and
// this only ever needs a single non-streaming yes/no classification, not
// that function's full conversational-reply shape). ──────────────────────
async function askClaudeYesNo(systemPrompt, userText) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: "claude-sonnet-5", max_tokens: 10,
      system: systemPrompt,
      messages: [{ role: "user", content: userText }],
    }),
  });
  if (!r.ok) throw new Error(`Anthropic error ${r.status}: ${await r.text()}`);
  const d = await r.json();
  const textBlock = (d.content || []).find(b => b.type === "text");
  return String(textBlock?.text || "").trim().toUpperCase().startsWith("PASS");
}

// Same evalCondition op set public-form.html's client-side logic already
// evaluates -- duplicated here (not imported, this is a fully independent
// deployment) purely for country/ai_disqualify rules, since ONLY those two
// need a server round-trip a client can't fake. equals/not_equals/contains/
// is_answered/is_empty on any other field type were never enforceable
// server-side even before this (a determined visitor could always POST
// straight to /submit) -- not a regression this introduces.
function evalRuleServerSide(rule, value) {
  if (rule.op === "is_answered") return Array.isArray(value) ? value.length > 0 : !!String(value || "").trim();
  if (rule.op === "is_empty") return Array.isArray(value) ? value.length === 0 : !String(value || "").trim();
  // Case-insensitive from here down -- matches the client-side evalCondition
  // in public-form.html (a respondent typing "Unemployed" should trip the
  // same rule as "unemployed"), which matters here since this function is
  // what actually re-verifies a country field's rules server-side.
  const lc = (s) => String(s ?? "").toLowerCase();
  const target = lc(rule.value);
  const arr = Array.isArray(value) ? value.map(lc) : null;
  const scalar = arr ? "" : lc(value);
  if (rule.op === "equals") return arr ? arr.includes(target) : scalar === target;
  if (rule.op === "not_equals") return arr ? !arr.includes(target) : scalar !== target;
  if (rule.op === "contains") return arr ? arr.includes(target) : scalar.includes(target);
  if (rule.op === "any_of") {
    const candidates = target.split(",").map(s => s.trim()).filter(Boolean);
    return arr ? arr.some(v => candidates.includes(v)) : candidates.includes(scalar);
  }
  if (rule.op === "contains_any_of") {
    const candidates = target.split(",").map(s => s.trim()).filter(Boolean);
    return arr ? arr.some(v => candidates.includes(v)) : candidates.some(c => scalar.includes(c));
  }
  return false;
}

// Defense in depth for the two screening mechanisms that matter enough to
// re-verify server-side: a "country" field's own hide_next/redirect rules
// (re-detected from the REAL request IP, not whatever the client claims
// its answers object says) and any ai_disqualify rule (re-run against the
// actually-submitted answer). The client-side gate already keeps a normal
// visitor from reaching Submit in either case -- this is what actually
// stops a submission if that's bypassed. Every other rule type was never
// server-enforced before this either (see evalRuleServerSide above), so
// this intentionally doesn't try to become a general server-side logic
// engine -- just closes the two paths framed as real disqualification.
async function checkSubmissionDisqualified(form, answers, req) {
  const countryFields = form.fields.filter(f => f.type === "country");
  if (countryFields.length) {
    const location = await lookupIpLocation(clientIp(req)).catch(() => null);
    const country = location?.country || "";
    for (const f of countryFields) {
      for (const rule of f.logic || []) {
        if ((rule.action === "hide_next" || rule.action === "redirect") && evalRuleServerSide(rule, country)) return true;
      }
    }
  }
  if (process.env.ANTHROPIC_API_KEY) {
    // Every ai_disqualify rule on the form gets re-checked at submit time
    // (the client-side gate a savvy visitor could bypass isn't enough) --
    // a form with two or three such questions was running these Claude
    // round trips one after another, adding their full latency together
    // on top of the booking itself. They're independent checks, so run
    // them concurrently instead; still disqualified if ANY of them fails.
    const checks = [];
    for (const f of form.fields) {
      for (const rule of f.logic || []) {
        if (rule.op !== "ai_disqualify" || !rule.value) continue;
        if (rule.action !== "hide_next" && rule.action !== "redirect") continue;
        checks.push(
          askClaudeYesNo(
            `You are screening one answer to a single form question against a business's disqualification criteria. Given the criteria and the respondent's answer, decide whether the answer PASSES (does not match the disqualifying criteria) or FAILS (matches it). Reply with EXACTLY one word: PASS or FAIL. Nothing else.\n\nDisqualification criteria: ${rule.value}`,
            `Respondent's answer to "${f.label || "this question"}": ${String(answers[f.id] ?? "")}`
          ).then(pass => !pass).catch(() => false) // a failed/rate-limited call blocks nobody
        );
      }
    }
    if (checks.length) {
      const results = await Promise.all(checks);
      if (results.some(Boolean)) return true;
    }
  }
  return false;
}

function validateAnswers(fields, answers) {
  for (const field of fields) {
    if (!ANSWERABLE_TYPES.includes(field.type) || !field.required) continue;
    const val = answers[field.id];
    const empty = field.type === "checkboxes" ? !Array.isArray(val) || val.length === 0 : val === undefined || val === null || String(val).trim() === "";
    if (empty) return `"${field.label || field.type}" is required`;
  }
  return null;
}

// Upserts a CRM contact from a submission the same way import_backend.js's
// manual importer does — matched by email first, then phone, so a repeat
// submission (or a contact who already exists from another channel) merges
// instead of duplicating. Returns null if the form carried neither an email
// nor a phone field with a value AND no bookedIdentity fallback applies,
// since there's nothing to key a contact on.
//
// bookedIdentity is the real name/email/phone a visitor just typed into an
// in-form calendar step's OWN booking form (public-form.html's
// bookCalendarStep forwards it from scheduling_backend.js's booking
// response) -- used ONLY as a fallback for whichever of email/phone/name
// this form has no dedicated field for, so a funnel that collects identity
// exclusively through its trailing calendar step (e.g. "ONLINE APP") still
// matches the SAME contact scheduling_backend.js already created/matched
// for that booking, instead of this function failing to match any contact
// at all (confirmed live 2026-09-13: every response on that form showed
// "Unmatched" despite a real contact existing from the booking).
function upsertContactFromSubmission(form, answers, bookedIdentity) {
  const emailField = form.fields.find(f => f.type === "email");
  const phoneField = form.fields.find(f => f.type === "phone");
  const firstField = form.fields.find(f => f.type === "first_name");
  const lastField = form.fields.find(f => f.type === "last_name");
  const email = emailField ? String(answers[emailField.id] || "").trim().toLowerCase() : String(bookedIdentity?.email || "").trim().toLowerCase();
  const phone = phoneField ? String(answers[phoneField.id] || "").trim() : String(bookedIdentity?.phone || "").trim();
  if (!email && !phone) return null;
  const [bookedFirst, ...bookedRest] = String(bookedIdentity?.name || "").trim().split(/\s+/);
  const bookedLast = bookedRest.join(" ");

  const contacts = readJson(CONTACTS_FILE, []);
  let contact = findContactMatch(contacts, email, phone);
  const prevTags = contact ? [...contact.tags] : [];
  const prevListIds = contact ? [...contact.listIds] : [];
  const isNew = !contact;

  // A field can be explicitly mapped (mapToCustomFieldId, set in the
  // builder's field settings) to an EXISTING custom field definition from
  // crm_custom_fields.json -- e.g. one imported from Close -- so the answer
  // lands in the same field contact-detail.html/segments/etc. already know
  // about, keyed by that definition's real id. Unmapped fields fall back to
  // f.code -- the stable per-field key (see ensureFieldCodes) -- so a
  // question's customField key survives being reworded later instead of
  // fragmenting into a new key every time (slugField(f) is only a last
  // resort now, for the rare field saved before this migration that
  // somehow still has no code).
  const customFields = {};
  for (const f of form.fields) {
    if (!ANSWERABLE_TYPES.includes(f.type)) continue;
    if ([emailField?.id, phoneField?.id, firstField?.id, lastField?.id].includes(f.id)) continue;
    if (answers[f.id] === undefined || answers[f.id] === "") continue;
    customFields[f.mapToCustomFieldId || f.code || slugField(f)] = answers[f.id];
  }

  if (contact) {
    if (firstField && answers[firstField.id]) contact.first = answers[firstField.id];
    else if (!firstField && bookedFirst) contact.first = bookedFirst;
    if (lastField && answers[lastField.id]) contact.last = answers[lastField.id];
    else if (!lastField && bookedLast) contact.last = bookedLast;
    if (email) contact.email = email;
    if (phone) contact.phone = phone;
    contact.customFields = { ...contact.customFields, ...customFields };
    // Only-if-blank is the safe default for a plain lead-capture form (an
    // established contact's real pipeline stage shouldn't get clobbered by
    // someone re-filling a generic form) -- but a form built around booking
    // a call is different: completing it (new or returning contact either
    // way) IS the actual event this status represents, same as the
    // calendar step's own "on booking, set status" in scheduling_backend.js's
    // upsertContactFromBooking. Either way, applyAdvancingStatus only ever
    // moves a contact FORWARD in the Settings > Statuses hierarchy -- a
    // blacklisted contact re-filling a booking-step form, or an already-
    // ENROLLED contact mistakenly booking a second call, must never get
    // silently knocked back down to this form's default status.
    const hasCalendarStep = form.fields.some(f => f.type === "calendar" && f.eventTypeSlug);
    if (form.settings.defaultStatus && (hasCalendarStep || !contact.status)) applyAdvancingStatus(contact, form.settings.defaultStatus);
  } else {
    contact = {
      id: randomUUID(), type: "lead", accountName: "",
      first: firstField ? (answers[firstField.id] || "") : bookedFirst || "", last: lastField ? (answers[lastField.id] || "") : bookedLast || "",
      email, phone, status: form.settings.defaultStatus || "", tags: [], listIds: [], customFields,
      source: "form", ownerId: null, emailOptOut: false, smsOptOut: false,
      externalIds: { acContactId: null, closeLeadId: null },
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    contacts.push(contact);
  }

  (form.settings.addTagIds || []).forEach(tagId => { if (!contact.tags.includes(tagId)) contact.tags.push(tagId); });
  (form.settings.addListIds || []).forEach(listId => { if (!contact.listIds.includes(listId)) contact.listIds.push(listId); });
  contact.updatedAt = new Date().toISOString();
  writeJson(CONTACTS_FILE, contacts);
  // Without this, a form-created (or form-updated) contact's real status/
  // name/etc. never reaches the Inbox sidebar's SQLite snapshot until
  // something else happens to touch this contact -- confirmed live: a
  // brand-new form submission showed up with a blank "Set status..." row
  // even though the contact record itself already had a real status from
  // form.settings.defaultStatus.
  try { syncContactFields(contact.id, contact); } catch (e) { console.error("[sqlite_inbox] contact sync failed:", e.message); }
  // A new/updated application gets its estimated-income fields filled in
  // now (background, never blocks or fails the submission) so segments that
  // filter on income include this lead without waiting for a backfill.
  estimateIncomeInBackground(contact);

  // Same "only fire for genuinely new membership" rule contacts_backend.js
  // uses for its PATCH handler, so a repeat form submission from an already
  // subscribed contact doesn't re-enroll them into a list-subscribe automation.
  contact.tags.filter(id => !prevTags.includes(id)).forEach(tagId => { fireTrigger("tag_added", { contactId: contact.id, tagId }); fireWorkflowTrigger("tag_added", { contactId: contact.id, tagId }); });
  contact.listIds.filter(id => !prevListIds.includes(id)).forEach(listId => { fireTrigger("list_subscribe", { contactId: contact.id, listId }); fireWorkflowTrigger("list_subscribe", { contactId: contact.id, listId }); });

  return { contact, isNew };
}

export async function handleFormsRequest(req, res, url) {
  const p = url.pathname;

  // ── Public: form renderer + submission — no auth, only published forms ──
  const publicFormMatch = p.match(/^\/api\/public\/forms\/([^/]+)$/);
  if (publicFormMatch && req.method === "GET") {
    const forms = readJson(FORMS_FILE, []);
    const form = forms.find(f => f.id === publicFormMatch[1]);
    if (!form || form.status !== "published") return sendJson(res, 404, { error: "Form not found" });
    selfHealFieldCodes(form, forms);
    return sendJson(res, 200, { form: publicForm(form) });
  }
  // A "country" field never asks the visitor anything -- this silently
  // resolves it from the real request IP so public-form.html can drop the
  // answer straight into the SAME per-field logic-rule builder (equals/
  // contains -> hide_next/redirect) every other field type already has.
  const detectCountryMatch = p.match(/^\/api\/public\/forms\/([^/]+)\/detect-country$/);
  if (detectCountryMatch && req.method === "GET") {
    const forms = readJson(FORMS_FILE, []);
    const form = forms.find(f => f.id === detectCountryMatch[1]);
    if (!form || form.status !== "published") return sendJson(res, 404, { error: "Form not found" });
    const location = await lookupIpLocation(clientIp(req)).catch(() => null);
    return sendJson(res, 200, { country: location?.country || "" });
  }

  // AI screen: re-reads the field's REAL configured criteria server-side
  // (from its ai_disqualify logic rule, by fieldId) -- a client-supplied
  // prompt is never trusted, or any visitor could point this at an
  // arbitrary Anthropic call on the business's own API key/dime.
  const aiScreenMatch = p.match(/^\/api\/public\/forms\/([^/]+)\/ai-screen$/);
  if (aiScreenMatch && req.method === "POST") {
    const forms = readJson(FORMS_FILE, []);
    const form = forms.find(f => f.id === aiScreenMatch[1]);
    if (!form || form.status !== "published") return sendJson(res, 404, { error: "Form not found" });
    const { fieldId, answer } = await readJsonBody(req);
    const field = form.fields.find(f => f.id === fieldId);
    const rule = field?.logic?.find(r => r.op === "ai_disqualify");
    if (!rule?.value) return sendJson(res, 200, { pass: true }); // screening was turned off/removed since the page loaded -- fail open, not closed
    if (!process.env.ANTHROPIC_API_KEY) return sendJson(res, 200, { pass: true }); // not configured -- same fail-open reasoning
    try {
      const pass = await askClaudeYesNo(
        `You are screening one answer to a single form question against a business's disqualification criteria. Given the criteria and the respondent's answer, decide whether the answer PASSES (does not match the disqualifying criteria) or FAILS (matches it). Reply with EXACTLY one word: PASS or FAIL. Nothing else.\n\nDisqualification criteria: ${rule.value}`,
        `Respondent's answer to "${field.label || "this question"}": ${String(answer ?? "")}`
      );
      return sendJson(res, 200, { pass });
    } catch {
      return sendJson(res, 200, { pass: true }); // a failed/rate-limited call blocks nobody -- same fail-open reasoning as above
    }
  }

  // Best-effort funnel beacon -- fired once per step by public-form.html's
  // renderStep. Never blocks/errors toward the visitor either way (a bad
  // body or an unpublished/missing form just no-ops), since this only feeds
  // the Drop-offs tab, not the actual submission.
  const stepViewMatch = p.match(/^\/api\/public\/forms\/([^/]+)\/step-view$/);
  if (stepViewMatch && req.method === "POST") {
    const forms = readJson(FORMS_FILE, []);
    const form = forms.find(f => f.id === stepViewMatch[1]);
    if (form && form.status === "published") {
      const { stepIndex, sid } = await readJsonBody(req).catch(() => ({}));
      const idx = Number(stepIndex);
      if (Number.isInteger(idx) && idx >= 0 && sid) {
        const views = readJson(STEP_VIEWS_FILE, {});
        const forForm = normalizeStepViews(views[form.id] || (views[form.id] = {}));
        const forStep = forForm[idx] || (forForm[idx] = {});
        if (!(sid in forStep)) { forStep[sid] = anchorageDateStr(new Date()); writeJson(STEP_VIEWS_FILE, views); }
      }
    }
    return sendJson(res, 200, { ok: true });
  }

  const submitMatch = p.match(/^\/api\/public\/forms\/([^/]+)\/submit$/);
  if (submitMatch && req.method === "POST") {
    const forms = readJson(FORMS_FILE, []);
    const form = forms.find(f => f.id === submitMatch[1]);
    if (!form || form.status !== "published") return sendJson(res, 404, { error: "Form not found" });
    selfHealFieldCodes(form, forms);
    const { answers, vid, bookedIdentity, timezone: rawTimezone } = await readJsonBody(req);
    // IANA name ("Europe/London") from the visitor's browser -- validated
    // since this is an unauthenticated body that ends up in a Sheet/email.
    let timezone = "";
    try { if (typeof rawTimezone === "string" && rawTimezone.length < 64) { new Intl.DateTimeFormat("en-US", { timeZone: rawTimezone }); timezone = rawTimezone; } } catch { /* not a real timezone -- leave blank */ }
    const cleanAnswers = answers && typeof answers === "object" ? answers : {};
    const validationError = validateAnswers(form.fields, cleanAnswers);
    if (validationError) return sendJson(res, 400, { error: validationError });
    // A phone typed in national format ("07956 650003") is made internationally
    // dialable here, once, so the contact, the response record, the flow payload
    // (-> notification email/Sheet) and every later SMS/call all see the same
    // number -- see phone_util.js for how the country is decided.
    for (const pf of form.fields.filter(ff => ff.type === "phone")) {
      if (cleanAnswers[pf.id]) cleanAnswers[pf.id] = await normalizePhoneForRequest(req, cleanAnswers[pf.id]);
    }
    // Defense in depth -- the client-side gate (a country/ai_disqualify
    // logic rule hiding Next) already keeps a normal visitor from ever
    // reaching Submit, but this is what actually stops a submission if
    // that's bypassed.
    if (await checkSubmissionDisqualified(form, cleanAnswers, req).catch(() => false)) {
      return sendJson(res, 403, { error: "This submission doesn't meet the requirements to continue." });
    }

    const result = upsertContactFromSubmission(form, cleanAnswers, bookedIdentity && typeof bookedIdentity === "object" ? bookedIdentity : null);

    // contactId is returned so the form iframe (public-form.html, itself
    // served from the CRM's own origin) can hand it off to the PARENT page
    // via postMessage -- the same cross-origin problem /api/email/click has
    // (see tracking_backend.js/track.js): a cookie set from a response on
    // this origin would never be visible to document.cookie on the Framer
    // site the iframe is embedded in.
    //
    // Sent BEFORE the bookkeeping below (writing to RESPONSES_FILE, logging,
    // firing triggers) -- none of it changes what the visitor sees redirect
    // to, so there's no reason the redirect should wait on it. On a form
    // with a lot of history (RESPONSES_FILE only ever grows, one entry per
    // submission ever taken) that write alone was adding real, and
    // needlessly felt, latency to every single submission.
    sendJson(res, 200, { ok: true, contactId: result?.contact.id || null, confirmationMessage: form.settings.confirmationMessage, redirectUrl: form.settings.redirectUrl || null });

    // setImmediate, not just "unawaited code after sendJson" -- Node is
    // single-threaded, so synchronous work placed right after sendJson()
    // still runs before the process ever yields to actually flush the
    // response over the socket, gaining nothing. Deferring to the next
    // event-loop tick lets the redirect the visitor is waiting on go out
    // first, THEN does this bookkeeping (none of which affects what they
    // see) -- writing to RESPONSES_FILE (which only ever grows, one entry
    // per submission ever taken) was adding real, needlessly felt latency
    // to every single submission otherwise.
    setImmediate(() => {
      // Retroactively attribute every anonymous page visit this browser made
      // BEFORE this submission (the ad click that brought them here, any
      // pages they browsed) to the contact just created/matched -- see
      // claimVisitorHistory's own comment for why.
      if (result?.contact.id && vid) claimVisitorHistory(vid, result.contact.id);
      const responses = readJson(RESPONSES_FILE, []);
      const response = { id: randomUUID(), formId: form.id, contactId: result?.contact.id || null, answers: cleanAnswers, timezone, submittedAt: new Date().toISOString() };
      responses.push(response);
      writeJson(RESPONSES_FILE, responses);

      if (result?.contact.id) {
        // Log the submission itself as an inbound Inbox activity -- otherwise
        // a form fill only shows up as a contact getting created/updated,
        // with no trace in the conversation thread that they reached out.
        const answerLines = form.fields
          .filter(f => ANSWERABLE_TYPES.includes(f.type) && cleanAnswers[f.id] !== undefined && cleanAnswers[f.id] !== "")
          .map(f => `${f.label || f.type}: ${Array.isArray(cleanAnswers[f.id]) ? cleanAnswers[f.id].join(", ") : cleanAnswers[f.id]}`);
        // Full body is one Q&A block per blank-line-separated paragraph --
        // NOT a single "\n" (a multi-line textarea answer already carries its
        // own embedded "\n"s, which would be visually indistinguishable from
        // the separators between different fields once everything's joined
        // into one flat string; "\n\n" can't collide with a single embedded
        // newline). The conversation panel's noteBubbleHtml splits back on
        // "\n\n" to render each field as its own bold-label/plain-answer
        // block. bodyPreview stays " · "-joined on purpose: it's a
        // single-line summary (inbox list rows, sidebar), where line breaks
        // would just collapse anyway.
        const answerSummary = answerLines.join(" · ");
        logMessage({
          channel: "form", direction: "inbound", contactId: result.contact.id,
          sourceType: "form", sourceId: form.id,
          subject: `Form: ${form.name}`, body: answerLines.join("\n\n"), bodyPreview: answerSummary.slice(0, 200),
          status: "received",
        });
        fireTrigger("form_submitted", { contactId: result.contact.id, formId: form.id });
        fireWorkflowTrigger("form_submitted", { contactId: result.contact.id, formId: form.id });
        // Dual-keyed: by f.code (the stable key -- see ensureFieldCodes --
        // that a REGENERATED {{payload.x}} token will use going forward,
        // immune to this question ever being reworded) AND by f.label (kept
        // for backward compat, so a flow template someone already built
        // against the current wording keeps working right up until the
        // next time this question's label actually changes -- exactly the
        // same as it always has, no regression). The "pull sample data"
        // picker (flows_backend.js's /samples, flow-builder.html) filters
        // the label-keyed duplicates back out so it only ever offers the
        // stable one.
        const labeledAnswers = {};
        form.fields.forEach(f => {
          if (ANSWERABLE_TYPES.includes(f.type) && cleanAnswers[f.id] !== undefined && cleanAnswers[f.id] !== "") {
            const val = Array.isArray(cleanAnswers[f.id]) ? cleanAnswers[f.id].join(", ") : cleanAnswers[f.id];
            labeledAnswers[f.code || slugField(f)] = val;
            if (f.label) labeledAnswers[f.label] = val;
          }
        });
        // Not an answerable question, so it's added here -- never over a
        // real question a form happens to have labeled "Timezone".
        if (timezone && !("Timezone" in labeledAnswers)) labeledAnswers["Timezone"] = timezone;
        fireFlowTrigger("form_submitted", { contactId: result.contact.id, formId: form.id, payload: labeledAnswers });
      }
    });
    return true;
  }

  // Clean public URL (/f/:id) -- just hands back the same static SPA shell
  // as the file route below would; the form id is read client-side from
  // location.pathname, so no server-side templating is needed.
  const shareMatch = p.match(/^\/f\/[^/]+$/);
  if (shareMatch && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(readFileSync(join(__dirname, "public-form.html")));
    return true;
  }
  if (p === "/forms-widget.js" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "public, max-age=3600" });
    res.end(FORMS_WIDGET_JS);
    return true;
  }

  // ── Authed: form + response management ──────────────────────────────────
  if (!p.startsWith("/api/forms")) return false;
  const me = getSessionUser(req);
  if (!me) return sendJson(res, 401, { error: "Not logged in" });

  if (p === "/api/forms" && req.method === "GET") {
    const forms = readJson(FORMS_FILE, []);
    const responses = readJson(RESPONSES_FILE, []);
    const withCounts = forms.map(f => ({ ...f, responseCount: responses.filter(r => r.formId === f.id).length }));
    return sendJson(res, 200, { forms: withCounts });
  }
  if (p === "/api/forms" && req.method === "POST") {
    const { name } = await readJsonBody(req);
    const forms = readJson(FORMS_FILE, []);
    const form = newForm(name);
    forms.push(form);
    writeJson(FORMS_FILE, forms);
    return sendJson(res, 200, { ok: true, form });
  }

  const formMatch = p.match(/^\/api\/forms\/([^/]+)$/);
  if (formMatch) {
    const forms = readJson(FORMS_FILE, []);
    const form = forms.find(f => f.id === formMatch[1]);
    if (req.method === "GET") {
      if (!form) return sendJson(res, 404, { error: "Form not found" });
      selfHealFieldCodes(form, forms);
      return sendJson(res, 200, { form });
    }
    if (req.method === "PATCH") {
      if (!form) return sendJson(res, 404, { error: "Form not found" });
      const body = await readJsonBody(req);
      if ("status" in body && !["draft", "published"].includes(body.status)) return sendJson(res, 400, { error: "status must be 'draft' or 'published'" });
      if ("fields" in body) body.fields = ensureFieldCodes(sanitizeRichTextFields(body.fields));
      for (const k of ["name", "status", "fields", "settings", "theme"]) if (k in body) form[k] = body[k];
      form.updatedAt = new Date().toISOString();
      writeJson(FORMS_FILE, forms);
      return sendJson(res, 200, { ok: true, form });
    }
    if (req.method === "DELETE") {
      if (!form) return sendJson(res, 404, { error: "Form not found" });
      writeJson(FORMS_FILE, forms.filter(f => f.id !== formMatch[1]));
      writeJson(RESPONSES_FILE, readJson(RESPONSES_FILE, []).filter(r => r.formId !== formMatch[1]));
      return sendJson(res, 200, { ok: true });
    }
  }

  const responsesMatch = p.match(/^\/api\/forms\/([^/]+)\/responses$/);
  if (responsesMatch && req.method === "GET") {
    const responses = readJson(RESPONSES_FILE, []).filter(r => r.formId === responsesMatch[1]);
    const contacts = readJson(CONTACTS_FILE, []);
    const withContact = responses.map(r => ({ ...r, contact: contacts.find(c => c.id === r.contactId) ? { first: contacts.find(c => c.id === r.contactId).first, last: contacts.find(c => c.id === r.contactId).last, email: contacts.find(c => c.id === r.contactId).email } : null }));
    withContact.sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt));
    return sendJson(res, 200, { responses: withContact });
  }
  const deleteResponseMatch = p.match(/^\/api\/forms\/([^/]+)\/responses\/([^/]+)$/);
  if (deleteResponseMatch && req.method === "DELETE") {
    const responses = readJson(RESPONSES_FILE, []);
    writeJson(RESPONSES_FILE, responses.filter(r => !(r.formId === deleteResponseMatch[1] && r.id === deleteResponseMatch[2])));
    return sendJson(res, 200, { ok: true });
  }

  // One-time backfill for responses left "Unmatched" by the bug just fixed
  // above (a form with a calendar step but no email/phone field of its own
  // never matched a contact on submit, even though the booking itself
  // already created/matched one). Only ever SETS contactId on a response
  // that currently has none -- never touches an already-matched response,
  // so this is safe to re-run and only moves rows toward more-matched, never
  // the other direction. Correlates by timing (the booking always completes
  // moments before this form's own submit fires -- see public-form.html's
  // Next handler) and, when more than one booking falls in that window,
  // disambiguates by how many of the response's own answers show up in that
  // booking's formAnswers. Never guesses: a response with no confident
  // single candidate is left Unmatched rather than risk a wrong contact.
  const backfillMatch = p.match(/^\/api\/forms\/([^/]+)\/backfill-contact-matches$/);
  if (backfillMatch && req.method === "POST") {
    const forms = readJson(FORMS_FILE, []);
    const form = forms.find(f => f.id === backfillMatch[1]);
    if (!form) return sendJson(res, 404, { error: "Form not found" });
    const calField = form.fields.find(f => f.type === "calendar" && f.eventTypeSlug);
    if (!calField) return sendJson(res, 400, { error: "This form has no calendar step, so there's nothing to match against." });
    const et = readJson(EVENT_TYPES_FILE, []).find(e => e.slug === calField.eventTypeSlug);
    if (!et) return sendJson(res, 400, { error: "The calendar step's event type couldn't be found." });

    const responses = readJson(RESPONSES_FILE, []);
    const unmatched = responses.filter(r => r.formId === form.id && !r.contactId);
    const bookings = readJson(BOOKINGS_FILE, []).filter(b => b.eventTypeId === et.id);
    const claimedBookingIds = new Set();
    let matched = 0;
    const matches = [];
    for (const resp of unmatched) {
      const respTime = new Date(resp.submittedAt).getTime();
      const candidates = bookings.filter(b => {
        if (claimedBookingIds.has(b.id)) return false;
        const delta = respTime - new Date(b.createdAt).getTime();
        return delta >= 0 && delta <= 10 * 60 * 1000; // booking completes shortly BEFORE this form's own submit, within 10 minutes
      });
      if (!candidates.length) continue;
      const scored = candidates.map(b => {
        const fa = b.formAnswers || {};
        let score = 0;
        for (const f of form.fields) {
          if (!f.label) continue;
          const v = resp.answers[f.id];
          if (v === undefined || v === "") continue;
          const flat = Array.isArray(v) ? v.join(", ") : v;
          if (fa[f.label] === flat) score++;
        }
        return { b, score, delta: respTime - new Date(b.createdAt).getTime() };
      }).sort((x, y) => y.score - x.score || x.delta - y.delta);
      const best = scored[0];
      // Ambiguous -- two candidates equally close with equally many
      // matching answers -- skip rather than guess.
      if (scored.length > 1 && scored[1].score === best.score && scored[1].delta === best.delta) continue;
      resp.contactId = best.b.contactId;
      claimedBookingIds.add(best.b.id);
      matches.push({ responseId: resp.id, contactId: best.b.contactId, bookingId: best.b.id });
      matched++;
    }
    if (matched) writeJson(RESPONSES_FILE, responses);
    return sendJson(res, 200, { totalUnmatched: unmatched.length, matched, stillUnmatched: unmatched.length - matched, matches });
  }

  // One row per step (same page_break split as public-form.html's own
  // buildSteps) -- distinct-visitor count who ever reached it, plus the real
  // completion count from RESPONSES_FILE as the final "Completed" row (a step
  // can be VIEWED without the form ever being submitted, e.g. it ends in a
  // calendar step that's abandoned before booking).
  const dropoffsMatch = p.match(/^\/api\/forms\/([^/]+)\/dropoffs$/);
  if (dropoffsMatch && req.method === "GET") {
    const forms = readJson(FORMS_FILE, []);
    const form = forms.find(f => f.id === dropoffsMatch[1]);
    if (!form) return sendJson(res, 404, { error: "Form not found" });
    // start/end are Anchorage calendar-day strings (YYYY-MM-DD), same
    // convention as reporting.html's own date-range picker -- inclusive on
    // both ends. Missing/invalid either one means "no filter" (all-time).
    const dateRe = /^\d{4}-\d{2}-\d{2}$/;
    const start = dateRe.test(url.searchParams.get("start") || "") ? url.searchParams.get("start") : null;
    const end = dateRe.test(url.searchParams.get("end") || "") ? url.searchParams.get("end") : null;
    const inRange = dateStr => (!start || dateStr >= start) && (!end || dateStr <= end);

    const stepCount = form.fields.reduce((n, f) => n + (f.type === "page_break" ? 1 : 0), 0) + 1;
    const stepLabels = [];
    let cur = [];
    for (const f of form.fields) {
      if (f.type === "page_break") { stepLabels.push(cur); cur = []; continue; }
      cur.push(f);
    }
    stepLabels.push(cur);
    const views = normalizeStepViews({ ...(readJson(STEP_VIEWS_FILE, {})[form.id] || {}) });
    const steps = Array.from({ length: stepCount }, (_, i) => ({
      views: Object.values(views[i] || {}).filter(inRange).length,
      label: (stepLabels[i]?.find(f => !["statement", "headline", "image", "video", "calendar", "page_break"].includes(f.type))?.label)
        || stepLabels[i]?.find(f => f.label)?.label || `Step ${i + 1}`,
    }));
    const completed = readJson(RESPONSES_FILE, [])
      .filter(r => r.formId === form.id && inRange(anchorageDateStr(new Date(r.submittedAt))))
      .length;
    return sendJson(res, 200, { steps, completed, start, end });
  }

  return false;
}
