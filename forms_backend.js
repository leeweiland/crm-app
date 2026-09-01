import { randomUUID } from "crypto";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { readJson, writeJson, readJsonBody, sendJson, getSessionUser } from "./auth_backend.js";
import { CONTACTS_FILE, findContactMatch } from "./segments_shared.js";
import { logMessage } from "./message_log.js";
import { fireTrigger } from "./automations_backend.js";
import { fireWorkflowTrigger } from "./workflows_backend.js";
import { fireFlowTrigger } from "./flows_backend.js";
import { clientIp, lookupIpLocation } from "./tracking_backend.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const FORMS_FILE = "crm_forms.json";
export const RESPONSES_FILE = "crm_form_responses.json";

// "statement"/"headline"/"image"/"video"/"calendar" are display-only content
// blocks (no answer), "page_break" is a layout marker (splits the public
// renderer into steps, Tally's one-question-at-a-time feel) -- none of
// these are validated as required and none ever carry an answer. "calendar"
// embeds one of scheduling_backend.js's booking pages inline (same
// .scheduling-inline-widget + /widget.js pattern book.html's own embed
// snippet uses) -- the booking itself still happens on that system, this
// step is just where it's shown in the form's flow.
export const FIELD_TYPES = [
  "short_text", "long_text", "email", "phone", "first_name", "last_name",
  "number", "dropdown", "multiple_choice", "checkboxes", "date",
  "statement", "headline", "image", "video", "calendar", "page_break",
];
const CHOICE_TYPES = ["dropdown", "multiple_choice", "checkboxes"];
const NON_ANSWERABLE_TYPES = ["statement", "headline", "image", "video", "calendar", "page_break"];
const ANSWERABLE_TYPES = FIELD_TYPES.filter(t => !NON_ANSWERABLE_TYPES.includes(t));

// Same two embed patterns scheduling_backend.js's widget.js offers (inline
// auto-scan + JS-driven popup overlay), scoped to forms so the Embed modal
// in form-builder.html can offer the same Inline/Popup/Direct Link choices.
const FORMS_WIDGET_JS = `(function(){
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
    iframe.src = opts.url;
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
      var iframe = document.createElement('iframe');
      iframe.src = el.getAttribute('data-url');
      iframe.style.width = '100%';
      iframe.style.height = '100%';
      iframe.style.border = '0';
      iframe.style.minHeight = el.style.height || '700px';
      el.appendChild(iframe);
    }
  }
  window.FormWidget = { initPopupWidget: openPopup };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initInlineWidgets);
  else initInlineWidgets();
})();`;

function slugField(field) {
  const base = String(field.label || field.type || field.id).toLowerCase().trim().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return base || field.id;
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
    fields: [emailField],
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

function publicForm(form) {
  // Strips internal routing config (defaultStatus/addTagIds/addListIds) —
  // the public renderer only needs what it displays and submits against.
  // aiScreenPrompt is replaced with a bare boolean -- the client needs to
  // know a field is AI-screened (to call the ai-screen endpoint after it's
  // answered) but never the actual disqualification criteria, or a visitor
  // could read it straight out of the page source and word their answer to
  // dodge it. blockedCountries is dropped from settings the same way, for
  // the same reason (see the geo-check endpoint below).
  return {
    id: form.id, name: form.name, theme: form.theme,
    fields: form.fields.map(f => {
      if (!f.aiScreenPrompt) return f;
      const { aiScreenPrompt, ...rest } = f;
      return { ...rest, hasAiScreen: true };
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

// Same country name ip-api.com returns (see tracking_backend.js's
// lookupIpLocation) -- case-insensitive compare so "india" in the admin's
// list still matches "India" from the lookup.
async function isCountryBlocked(req, blockedCountries) {
  if (!Array.isArray(blockedCountries) || !blockedCountries.length) return false;
  const location = await lookupIpLocation(clientIp(req));
  if (!location?.country) return false;
  const blockedLower = blockedCountries.map(c => String(c).trim().toLowerCase()).filter(Boolean);
  return blockedLower.includes(location.country.toLowerCase());
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
// nor a phone field with a value, since there's nothing to key a contact on.
function upsertContactFromSubmission(form, answers) {
  const emailField = form.fields.find(f => f.type === "email");
  const phoneField = form.fields.find(f => f.type === "phone");
  const firstField = form.fields.find(f => f.type === "first_name");
  const lastField = form.fields.find(f => f.type === "last_name");
  const email = emailField ? String(answers[emailField.id] || "").trim().toLowerCase() : "";
  const phone = phoneField ? String(answers[phoneField.id] || "").trim() : "";
  if (!email && !phone) return null;

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
  // the old auto-slugged-from-the-question-label key, unchanged.
  const customFields = {};
  for (const f of form.fields) {
    if (!ANSWERABLE_TYPES.includes(f.type)) continue;
    if ([emailField?.id, phoneField?.id, firstField?.id, lastField?.id].includes(f.id)) continue;
    if (answers[f.id] === undefined || answers[f.id] === "") continue;
    customFields[f.mapToCustomFieldId || slugField(f)] = answers[f.id];
  }

  if (contact) {
    if (firstField && answers[firstField.id]) contact.first = answers[firstField.id];
    if (lastField && answers[lastField.id]) contact.last = answers[lastField.id];
    if (email) contact.email = email;
    if (phone) contact.phone = phone;
    contact.customFields = { ...contact.customFields, ...customFields };
    if (form.settings.defaultStatus && !contact.status) contact.status = form.settings.defaultStatus;
  } else {
    contact = {
      id: randomUUID(), type: "lead", accountName: "",
      first: firstField ? (answers[firstField.id] || "") : "", last: lastField ? (answers[lastField.id] || "") : "",
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
    return sendJson(res, 200, { form: publicForm(form) });
  }
  // Geo-screen: checked once on load (see public-form.html's init) so a
  // blocked visitor sees "not available" up front instead of filling out
  // the whole form first. Never echoes back the actual detected country or
  // the admin's blocked-countries list -- just pass/fail, same reasoning
  // as ai-screen below not echoing the disqualification criteria.
  const geoCheckMatch = p.match(/^\/api\/public\/forms\/([^/]+)\/geo-check$/);
  if (geoCheckMatch && req.method === "GET") {
    const forms = readJson(FORMS_FILE, []);
    const form = forms.find(f => f.id === geoCheckMatch[1]);
    if (!form || form.status !== "published") return sendJson(res, 404, { error: "Form not found" });
    const blocked = await isCountryBlocked(req, form.settings.blockedCountries).catch(() => false);
    return sendJson(res, 200, { blocked });
  }

  // AI screen: re-reads the field's REAL configured prompt server-side by
  // fieldId -- a client-supplied prompt is never trusted, or any visitor
  // could point this at an arbitrary Anthropic call on the business's own
  // API key/dime.
  const aiScreenMatch = p.match(/^\/api\/public\/forms\/([^/]+)\/ai-screen$/);
  if (aiScreenMatch && req.method === "POST") {
    const forms = readJson(FORMS_FILE, []);
    const form = forms.find(f => f.id === aiScreenMatch[1]);
    if (!form || form.status !== "published") return sendJson(res, 404, { error: "Form not found" });
    const { fieldId, answer } = await readJsonBody(req);
    const field = form.fields.find(f => f.id === fieldId);
    if (!field?.aiScreenPrompt) return sendJson(res, 200, { pass: true }); // screening was turned off/removed since the page loaded -- fail open, not closed
    if (!process.env.ANTHROPIC_API_KEY) return sendJson(res, 200, { pass: true }); // not configured -- same fail-open reasoning
    try {
      const pass = await askClaudeYesNo(
        `You are screening one answer to a single form question against a business's disqualification criteria. Given the criteria and the respondent's answer, decide whether the answer PASSES (does not match the disqualifying criteria) or FAILS (matches it). Reply with EXACTLY one word: PASS or FAIL. Nothing else.\n\nDisqualification criteria: ${field.aiScreenPrompt}`,
        `Respondent's answer to "${field.label || "this question"}": ${String(answer ?? "")}`
      );
      return sendJson(res, 200, { pass });
    } catch {
      return sendJson(res, 200, { pass: true }); // a failed/rate-limited call blocks nobody -- same fail-open reasoning as above
    }
  }

  const submitMatch = p.match(/^\/api\/public\/forms\/([^/]+)\/submit$/);
  if (submitMatch && req.method === "POST") {
    const forms = readJson(FORMS_FILE, []);
    const form = forms.find(f => f.id === submitMatch[1]);
    if (!form || form.status !== "published") return sendJson(res, 404, { error: "Form not found" });
    // Defense in depth -- the client-side gate (geo-check on load) already
    // keeps a blocked visitor from ever reaching Submit in the normal flow,
    // but this is what actually stops a submission if that's bypassed.
    if (await isCountryBlocked(req, form.settings.blockedCountries).catch(() => false)) {
      return sendJson(res, 403, { error: "This form is not currently available in your region." });
    }
    const { answers } = await readJsonBody(req);
    const cleanAnswers = answers && typeof answers === "object" ? answers : {};
    const validationError = validateAnswers(form.fields, cleanAnswers);
    if (validationError) return sendJson(res, 400, { error: validationError });

    const result = upsertContactFromSubmission(form, cleanAnswers);
    const responses = readJson(RESPONSES_FILE, []);
    const response = { id: randomUUID(), formId: form.id, contactId: result?.contact.id || null, answers: cleanAnswers, submittedAt: new Date().toISOString() };
    responses.push(response);
    writeJson(RESPONSES_FILE, responses);

    if (result?.contact.id) {
      // Log the submission itself as an inbound Inbox activity -- otherwise
      // a form fill only shows up as a contact getting created/updated,
      // with no trace in the conversation thread that they reached out.
      const answerSummary = form.fields
        .filter(f => ANSWERABLE_TYPES.includes(f.type) && cleanAnswers[f.id] !== undefined && cleanAnswers[f.id] !== "")
        .map(f => `${f.label || f.type}: ${Array.isArray(cleanAnswers[f.id]) ? cleanAnswers[f.id].join(", ") : cleanAnswers[f.id]}`)
        .join(" · ");
      logMessage({
        channel: "form", direction: "inbound", contactId: result.contact.id,
        sourceType: "form", sourceId: form.id,
        subject: `Form: ${form.name}`, body: answerSummary, bodyPreview: answerSummary.slice(0, 200),
        status: "received",
      });
      fireTrigger("form_submitted", { contactId: result.contact.id, formId: form.id });
      fireWorkflowTrigger("form_submitted", { contactId: result.contact.id, formId: form.id });
      // Labeled by field label (not raw field id) so a flow's {{payload.x}}
      // tokens -- and the "pull sample data" picker -- show real, readable
      // field names instead of opaque uuids.
      const labeledAnswers = {};
      form.fields.forEach(f => {
        if (ANSWERABLE_TYPES.includes(f.type) && cleanAnswers[f.id] !== undefined && cleanAnswers[f.id] !== "") {
          labeledAnswers[f.label || f.type] = Array.isArray(cleanAnswers[f.id]) ? cleanAnswers[f.id].join(", ") : cleanAnswers[f.id];
        }
      });
      fireFlowTrigger("form_submitted", { contactId: result.contact.id, formId: form.id, payload: labeledAnswers });
    }

    return sendJson(res, 200, { ok: true, confirmationMessage: form.settings.confirmationMessage, redirectUrl: form.settings.redirectUrl || null });
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
      return sendJson(res, 200, { form });
    }
    if (req.method === "PATCH") {
      if (!form) return sendJson(res, 404, { error: "Form not found" });
      const body = await readJsonBody(req);
      if ("status" in body && !["draft", "published"].includes(body.status)) return sendJson(res, 400, { error: "status must be 'draft' or 'published'" });
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

  return false;
}
