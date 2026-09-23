import { randomUUID, randomBytes } from "crypto";
import { readJson, writeJson, readJsonBody, sendJson, getSessionUser } from "./auth_backend.js";
import { CONTACTS_FILE, matchesSegment, findContactMatch } from "./segments_shared.js";
import { AUTOMATIONS_FILE, enrollContact, checkAutomationGoal } from "./automations_backend.js";
import { WORKFLOWS_FILE, enrollContactInWorkflow, checkConversionGoal } from "./workflows_backend.js";
import { pushConversionEvent } from "./conversions_backend.js";
import { syncContactFields, getContactByIdFast } from "./sqlite_inbox.js";
import { sendEmail } from "./email_backend.js";
import { acConfigured, fetchAcListsForPicker, fetchAcAutomationsForPicker, fetchAcCustomFieldsForPicker, pushContactToAc, syncContactToAc } from "./import_backend.js";
import { claimByIdentity, getAdCaptureByIdentity } from "./tracking_backend.js";
import { normalizePhoneForCapture } from "./phone_util.js";
import { applyStatusOptOut } from "./compliance_backend.js";
import { fetchChannelFeed, addVideoToPlaylist } from "./youtube_backend.js";

export const FLOWS_FILE = "crm_flows.json";
export const RUNS_FILE = "crm_flow_runs.json";
const OLD_WEBHOOK_CONFIGS_FILE = "crm_webhook_configs.json"; // retired UI, migrated below

export const TRIGGER_TYPES = ["webhook", "form_submitted", "booking_created", "youtube_new_video"];
export const STEP_TYPES = [
  "filter", "if_then", "delay", "google_sheet",
  "enroll_automation", "enroll_workflow", "add_update_contact", "send_email",
  "add_tag", "remove_tag", "add_to_list", "send_conversion_event", "add_to_ac", "add_update_contact_ac",
  "youtube_add_to_playlist",
];

// send_email's Body is still just a flat string (not the block editor's
// real HTML) -- escape it like real text first, so nothing a lead typed
// into a form answer (or the literal text of the field itself) can inject
// markup, THEN convert the flow-builder's own **bold** markers (see
// flow-builder.html's toggleBoldSelection/insertQaPair -- its Bold button
// and the Body field's "insert as Q&A pair" token action both produce
// this marker, not real stored HTML) to real <b> tags, safe to do after
// escaping since escaping never touches `*` characters. Line breaks last,
// so paragraphs still read as paragraphs once it's wrapped in a single
// "text" block for sendEmail() (block_editor_shared.js just injects a
// text block's html raw).
function escapeHtmlForEmail(s) {
  return String(s || "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/\n/g, "<br>");
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

// Was readJson(CONTACTS_FILE, []).find(...) -- a full parse of this file's
// real size (~3.7s, confirmed live) EVERY step of EVERY flow run touches a
// contact, including the synchronous portion of kicking a flow off (this
// runs before advanceFlowRun's first await, so the caller -- e.g. a
// booking's own request handler firing "booking_created" -- sits through
// it too, even though that call itself is never awaited). getContactByIdFast
// is the same indexed lookup already used elsewhere for exactly this.
function getContact(id) { return getContactByIdFast(id); }
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

// Read-the-count-then-write-that-row is two separate round trips, not one
// atomic operation -- two flow runs (e.g. two real bookings/submissions
// landing close together, or someone testing the flow while a real one
// fires) can both read the SAME "current last row" before either has
// written, both compute the SAME nextRow, and the second PUT silently
// overwrites the first's row instead of erroring -- confirmed live: a real
// booking's row was simply never on the sheet (verified via direct read),
// while a bunch of near-simultaneous test rows from the same window were.
// perSheetQueue below serializes every append for the SAME spreadsheet+tab
// through this one Node process so the read-then-write sequence can never
// interleave with another one -- doesn't help across multiple server
// instances, but this app runs as one, so that's the actual failure mode
// this closes.
const perSheetQueue = new Map();
function withSheetLock(key, fn) {
  const prev = perSheetQueue.get(key) || Promise.resolve();
  const settled = prev.catch(() => {});
  const result = settled.then(fn);
  perSheetQueue.set(key, result.catch(() => {}));
  return result;
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
  return withSheetLock(`${spreadsheetId}::${sheetName}`, async () => {
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
    const put = () => fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${writeRange}?valueInputOption=USER_ENTERED`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ values: [rowValues] }),
    });
    let r = await put();
    let d = await r.json();
    // An explicit-row write (unlike values.append, which Zapier used) never
    // grows the tab: once the last row of the grid is filled it fails with
    // "exceeds grid limits" (the ONLINE LEADS tab hit its 178,217-row limit
    // 2026-09-19 and every new lead silently missed the sheet). Add rows and retry.
    if (!r.ok && /exceeds grid limits/i.test(d?.error?.message || "")) {
      const metaRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets.properties(sheetId,title)`, { headers: { Authorization: `Bearer ${accessToken}` } });
      const meta = await metaRes.json();
      const sheetId = meta.sheets?.find(s => s.properties.title === sheetName)?.properties.sheetId;
      if (sheetId == null) throw new Error("Sheets write failed: " + JSON.stringify(d));
      const grow = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`, {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ requests: [{ appendDimension: { sheetId, dimension: "ROWS", length: 1000 } }] }),
      });
      if (!grow.ok) throw new Error("Sheets could not add rows: " + JSON.stringify(await grow.json()));
      console.log(`[flows] '${sheetName}' was out of rows -- added 1000`);
      r = await put();
      d = await r.json();
    }
    if (!r.ok) throw new Error("Sheets write failed: " + JSON.stringify(d));
    return d;
  });
}

// {{first}}/{{email}}/{{customFields.x}} resolve against the contact;
// {{payload.rawFieldName}} reaches into the original trigger payload (the
// raw webhook body, or {} for form/booking triggers) for anything not
// mapped onto the contact itself; {{timestamp}} is when the run's trigger
// actually fired (run.enteredAt) -- not "whenever this step happens to
// execute", which would read differently if an earlier delay step pushed
// this step minutes/hours/days past the real capture time.
// {{clickIds.gclid}} / {{clickIds.fbclid}} started as bare click IDs (flows
// already use them). They now print the ad behind the click -- "Ad name · Ad
// set · Campaign (click ID: ...)" -- so those flows pick it up unedited. Falls
// back to just the click ID when the ad couldn't be identified, or to just the
// ad when there's no click ID, and to "" for a lead from the other platform.
function describeAdClick(clickIds, platform) {
  if (!clickIds) return "";
  const id = clickIds[platform === "google" ? "gclid" : "fbclid"] || "";
  const ad = clickIds.ads?.[platform];
  const adText = ad ? [ad.name || `Ad ${ad.id}`, ad.adGroup && `${platform === "google" ? "Ad group" : "Ad set"}: ${ad.adGroup}`, ad.campaign && `Campaign: ${ad.campaign}`].filter(Boolean).join(" · ") : "";
  return adText && id ? `${adText} (click ID: ${id})` : adText || id;
}
function resolveTemplate(str, { contact, payload, timestamp }) {
  // [^{}]+ (not [\w.]+) -- a raw webhook field name is often a human label
  // like "First Name" or "Work Email", spaces and all. The old \w-only
  // pattern silently failed to match those at all, leaving the literal
  // "{{payload.First Name}}" text sitting in the sheet cell instead of
  // resolving (or even blanking) it.
  return String(str || "").replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_, path) => {
    if (path === "timestamp") return timestamp || "";
    if (path === "clickIds.gclid" || path === "clickIds.fbclid") return describeAdClick(contact?.clickIds, path === "clickIds.gclid" ? "google" : "meta");
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
    run.history.push({ stepId: step.id, at: new Date().toISOString(), skipped: !!step.skipped });
    if (step.skipped) {
      // Bypasses the step's action (and, for filter/delay, the thing that
      // would otherwise end or pause the run) entirely -- the toggle in
      // flow-builder.html is meant to "smoothly skip" a step without
      // deleting it, so a skipped filter can't dead-end the run and a
      // skipped delay doesn't pause it. if_then has no single "next" to
      // fall through to, so a skipped one just always takes its YES path
      // (or NO if that's the only one wired) rather than stalling.
      run.currentStepId = step.type === "if_then" ? (step.yesStepId || step.noStepId || null) : (step.nextStepId || null);
      if (!run.currentStepId) { completeRun(run); return; }
      saveRun(run);
      continue;
    }
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
        // Claims whatever vid a client-side submit beacon already reported
        // for this email/phone (see tracking_backend.js's TRACK_SNIPPET +
        // /api/track/identify) -- this webhook's own payload never carries
        // a vid itself, so linkage has to come from that separate signal.
        // This was the only contact-creation path that had never done any
        // claim-back at all, so a webhook lead's prior ad click/page
        // visits (and thus its whole attribution story) went permanently
        // unclaimed.
        claimByIdentity(resolvedEmail, resolvedPhone, workingContact.id);
        // Replaces (not merges) so a returning lead's newest click isn't
        // mixed with an older click's other ID. Persisted by saveContact below.
        const capture = getAdCaptureByIdentity(resolvedEmail, resolvedPhone);
        if (capture) {
          const clickIds = { ...(capture.clickIds || {}), capturedAt: new Date().toISOString() };
          // fbc_id marks a Meta click, gc_id a Google one (same rule as
          // reporting_backend.js's attributionKeyForVisit). The lookup is
          // bounded and best-effort -- without it the tokens still print the click ID.
          const ap = capture.adParams;
          const platform = ap?.fbc_id ? "meta" : ap?.gc_id ? "google" : null;
          if (platform) {
            const { lookupAdInfo } = await import("./ads_backend.js");
            const info = await withTimeout(lookupAdInfo(platform, ap.h_ad_id), 8000, "ad name lookup").catch(() => null);
            clickIds.ads = { [platform]: { id: ap.h_ad_id, ...(info || {}) } };
          }
          workingContact.clickIds = clickIds;
        }
      }
      const prevStatus = workingContact.status;
      for (const field of ["first", "last", "email", "phone", "programType"]) {
        if (cfg[field]) {
          const resolved = resolveTemplate(cfg[field], ctx);
          if (resolved) workingContact[field] = (field === "email" || field === "programType") ? resolved.toLowerCase() : resolved;
        }
      }
      if (cfg.statusId) workingContact.status = cfg.statusId;
      // A flow that moves someone to BLACKLIST gets the same opt-outs,
      // hidden conversation, and Blacklist-sheet row a manual status change
      // does -- applyStatusOptOut's own contract is "any path", but this one
      // wrote the status directly and skipped it.
      if (workingContact.status !== prevStatus) applyStatusOptOut(workingContact);
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
    } else if (step.type === "add_to_ac") {
      const cfg = step.config || {};
      if (contact && (cfg.acListId || cfg.acAutomationId)) {
        try {
          const result = await withTimeout(pushContactToAc(contact, cfg), 20000, "add_to_ac");
          if (result.ok && result.acContactId && !contact.externalIds?.acContactId) {
            contact.externalIds = { ...(contact.externalIds || {}), acContactId: result.acContactId };
            saveContact(contact);
          } else if (!result.ok) {
            console.error("[flows] add_to_ac failed:", result.reason);
          }
        } catch (e) { console.error("[flows] add_to_ac failed", e.message); }
      }
      run.currentStepId = step.nextStepId || null;
    } else if (step.type === "add_update_contact_ac") {
      const cfg = step.config || {};
      const resolvedEmail = cfg.email ? resolveTemplate(cfg.email, ctx).trim().toLowerCase() : "";
      if (resolvedEmail) {
        const fieldValues = Object.entries(cfg.customFields || {})
          .map(([fieldId, tpl]) => ({ field: fieldId, value: resolveTemplate(tpl, ctx) }))
          .filter(fv => fv.value);
        try {
          await withTimeout(syncContactToAc({
            email: resolvedEmail,
            first: cfg.first ? resolveTemplate(cfg.first, ctx) : "",
            last: cfg.last ? resolveTemplate(cfg.last, ctx) : "",
            phone: cfg.phone ? resolveTemplate(cfg.phone, ctx) : "",
            fieldValues,
          }), 20000, "add_update_contact_ac");
        } catch (e) { console.error("[flows] add_update_contact_ac failed", e.message); }
      }
      run.currentStepId = step.nextStepId || null;
    } else if (step.type === "youtube_add_to_playlist") {
      const cfg = step.config || {};
      const videoId = resolveTemplate(cfg.videoId || "", ctx).trim();
      if (cfg.playlistId && videoId) {
        // A video processed seconds ago can briefly 404/5xx on playlistItems,
        // so a few spaced attempts (worst case ~50s, well under STALE_RUN_MS)
        // before giving up; the last error lands on this step's history entry.
        let lastErr = null;
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            const r = await withTimeout(addVideoToPlaylist(cfg.playlistId, videoId), 20000, "youtube_add_to_playlist");
            console.log(`[flows] youtube_add_to_playlist ${videoId} -> ${cfg.playlistId}: ${r.alreadyThere ? "already there" : "added"}`);
            lastErr = null;
            break;
          } catch (e) {
            lastErr = e;
            if (attempt < 3) await new Promise(r => setTimeout(r, 10000));
          }
        }
        if (lastErr) {
          console.error("[flows] youtube_add_to_playlist failed", videoId, lastErr.message);
          run.history[run.history.length - 1].error = lastErr.message;
        }
      } else {
        run.history[run.history.length - 1].error = "Missing playlist or video ID";
      }
      run.currentStepId = step.nextStepId || null;
    } else {
      run.currentStepId = step.nextStepId || null;
    }

    if (!run.currentStepId) { completeRun(run); return; }
    // Persisted after EVERY step, not just at the natural exit points
    // (delay/complete) below -- confirmed live that skipping this let a
    // stale-run resume (recoverStaleFlowRuns above) re-execute steps that
    // had already genuinely succeeded on an earlier attempt, because the
    // only on-disk record of progress was the run's state from BEFORE this
    // step started. A step with a real side effect (send_email, in this
    // case) isn't idempotent, so re-running it on every retry sent dozens
    // of duplicate emails to the same recipients before the run finally
    // got past whatever kept failing later in the chain.
    saveRun(run);
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

// ── YouTube "new video" trigger. Called by scheduler.js every tick; each
// active youtube_new_video flow is only actually checked every ~2 minutes.
// The FIRST check of a flow just records what's already on the channel (no
// backfill -- only uploads after activation fire), and a flow that goes
// inactive drops its record so re-activating later starts fresh the same way,
// instead of firing for everything uploaded while it was off. Each new video
// is marked seen BEFORE its run starts, so a crash can only skip one, never
// fire it twice. Contactless run: payload = {videoId, title, url, ...}.
const YT_POLL_STATE_FILE = "crm_youtube_poll_state.json";
const YT_POLL_EVERY_MS = 2 * 60 * 1000;
export async function pollYoutubeFlows() {
  const flows = readJson(FLOWS_FILE, []).filter(f => f.active && f.trigger?.type === "youtube_new_video" && f.trigger.config?.channelId);
  const state = readJson(YT_POLL_STATE_FILE, {}) || {};
  let dirty = false;
  for (const id of Object.keys(state)) {
    if (!flows.some(f => f.id === id)) { delete state[id]; dirty = true; }
  }
  for (const flow of flows) {
    const st = state[flow.id] || (state[flow.id] = { seen: [], seededAt: null, lastPollAt: 0, recent: [], lastError: null });
    if (Date.now() - (st.lastPollAt || 0) < YT_POLL_EVERY_MS) continue;
    st.lastPollAt = Date.now();
    dirty = true;
    try {
      const channelId = flow.trigger.config.channelId;
      const { channelTitle, videos } = await fetchChannelFeed(channelId);
      st.lastError = null;
      const asPayload = (v) => ({ videoId: v.videoId, title: v.title, url: `https://www.youtube.com/watch?v=${v.videoId}`, publishedAt: v.publishedAt, channelId, channelTitle });
      if (!st.seededAt) {
        st.seen = videos.map(v => v.videoId);
        st.seededAt = new Date().toISOString();
        st.recent = videos.slice(0, 5).map(asPayload);
        continue;
      }
      const fresh = videos.filter(v => !st.seen.includes(v.videoId)).reverse(); // oldest first
      for (const v of fresh) {
        st.seen.push(v.videoId);
        st.recent = [asPayload(v), ...st.recent].slice(0, 5);
        writeJson(YT_POLL_STATE_FILE, state);
        console.log(`[flows] new YouTube video ${v.videoId} ("${v.title}") -> flow "${flow.name}"`);
        startFlowRun(flow, null, asPayload(v));
      }
      st.seen = st.seen.slice(-200);
    } catch (e) {
      st.lastError = e.message;
      console.error(`[flows] YouTube poll failed for flow "${flow.name}":`, e.message);
    }
  }
  if (dirty) writeJson(YT_POLL_STATE_FILE, state);
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
// Per-step "how many active runs currently sit here" for the builder's step
// cards -- previously never wired up at all (the frontend's runCounts stayed
// permanently {}), so every card showed "0 here"/"0 waiting" regardless of
// real data.
function stepCounts(flowId) {
  const runs = readJson(RUNS_FILE, []).filter(r => r.flowId === flowId && r.status === "active");
  const counts = {};
  runs.forEach(r => { if (r.currentStepId) counts[r.currentStepId] = (counts[r.currentStepId] || 0) + 1; });
  return counts;
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

    if (!flow.active) { res.writeHead(200); res.end(); return true; } // accept + no-op so a paused flow doesn't error the external form

    // Framer (or whatever's calling this) retries on a slow/failed
    // response -- up to 5 times, confirmed live: a real lead's single form
    // submission produced 5 separate flow runs within 17 seconds, each
    // independently emailing/texting the same person, because nothing here
    // was idempotent against a retried call. Dedup against an identical
    // payload already submitted to this same flow in the last couple
    // minutes, rather than trying to make every downstream step itself
    // idempotent -- still responds 200 either way, so a genuine retry stops
    // erroring on the sender's end too. Checked via disk (not an in-memory
    // cache) specifically so it survives this process restarting mid-retry-
    // storm, which is exactly the kind of moment a retry storm happens in.
    const recentRuns = readJson(RUNS_FILE, []);
    const payloadKey = JSON.stringify(fields);
    const dedupeCutoffMs = Date.now() - 2 * 60 * 1000;
    const isDuplicate = recentRuns.some(r => r.flowId === flow.id &&
      JSON.stringify(r.triggerPayload || {}) === payloadKey &&
      new Date(r.enteredAt).getTime() > dedupeCutoffMs);

    // Respond BEFORE any writes -- confirmed live, this volume's per-file-
    // write latency alone was regularly eating 5-8+ seconds (writeJson on
    // an array writes it one element at a time, see writeJsonToDisk's own
    // comment on why -- each of those small writeSync calls apparently
    // costs real wall-clock time here), consistently landing close to or
    // past whatever window Framer/the caller waits before deciding to
    // retry. Two reads (above) is now the only I/O left before this
    // response; everything that WRITES happens after, since nothing past
    // this point can make the caller retry anymore -- it already has its
    // 2xx.
    sendJson(res, 200, { ok: true, deduped: isDuplicate });
    if (isDuplicate) return true;

    // A Framer phone field sends whatever was typed -- national format ("07497
    // 519636", "0431 414 124") with no country code -- and nothing after this
    // point (the flow's Add/Update Contact step, the notification email, the
    // Sheet row) ever adds one. Fixed here, once, before it fans out. Number
    // shape only (see phone_util.js) -- deliberately no IP guess, because this
    // request may come from Framer's servers rather than the visitor's browser.
    for (const [k, v] of Object.entries(fields)) {
      if (typeof v === "string" && v.trim() && (flow.trigger.config?.fieldMap?.[k] === "phone" || /^(phone|mobile|cell|tel)/i.test(k))) fields[k] = normalizePhoneForCapture(v);
    }

    // Captured even while the flow is still being built (inactive) -- same
    // "send a real test hit and we'll show you what arrived" flow Zapier's
    // trigger step uses, so the field-mapping UI has real field names to
    // work with instead of the builder guessing them blind. Kept to the 5
    // most recent so this can't grow unbounded on a busy form.
    flow.trigger.config = { ...flow.trigger.config, samples: [fields, ...(flow.trigger.config.samples || [])].slice(0, 5) };
    writeJson(FLOWS_FILE, flows);

    // No contact resolution here anymore -- that's now an explicit
    // "Add/Update Contact" step the flow itself contains (usually first),
    // so it's visible/editable in the builder instead of an implicit
    // upsert baked into the trigger. A flow with no such step just never
    // gets a contact, and every contact-dependent step downstream no-ops.
    startFlowRun(flow, null, fields);
    return true;
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

  if (p === "/api/flows/ac-refs" && req.method === "GET") {
    if (!acConfigured()) return sendJson(res, 200, { configured: false, lists: [], automations: [], customFields: [] });
    const [lists, automations, customFields] = await Promise.all([fetchAcListsForPicker(), fetchAcAutomationsForPicker(), fetchAcCustomFieldsForPicker()]);
    return sendJson(res, 200, { configured: true, lists, automations, customFields });
  }

  const flowMatch = p.match(/^\/api\/flows\/([^/]+)$/);
  if (flowMatch) {
    const flows = readJson(FLOWS_FILE, []);
    const flow = flows.find(f => f.id === flowMatch[1]);
    if (req.method === "GET") {
      if (!flow) return sendJson(res, 404, { error: "Flow not found" });
      return sendJson(res, 200, { flow, webhookUrlBase: "/api/webhooks/framer/", stepCounts: stepCounts(flow.id) });
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

  // Relocates every active run currently sitting at the step being deleted --
  // called by the builder right before it actually deletes that step, so
  // contacts mid-flow don't just vanish into a dangling currentStepId.
  // toStepId=null means "no destination", so those runs are simply marked
  // done instead. Reuses the real advanceFlowRun engine (not a fake state
  // copy) so a destination step's own side effects (send_email, add_to_ac,
  // etc.) and pause behavior (delay's waitUntil) work exactly like a normal
  // arrival, rather than leaving a run "active" with no waitUntil -- which
  // advanceDueFlowRuns() would never pick up, silently stranding it forever.
  const moveRunsMatch = p.match(/^\/api\/flows\/([^/]+)\/steps\/([^/]+)\/move-runs$/);
  if (moveRunsMatch && req.method === "POST") {
    const flows = readJson(FLOWS_FILE, []);
    const flow = flows.find(f => f.id === moveRunsMatch[1]);
    if (!flow) return sendJson(res, 404, { error: "Flow not found" });
    const { toStepId } = await readJsonBody(req);
    const runs = readJson(RUNS_FILE, []).filter(r => r.flowId === flow.id && r.currentStepId === moveRunsMatch[2] && r.status === "active");
    for (const run of runs) {
      if (!toStepId) { completeRun(run); continue; }
      run.currentStepId = toStepId;
      run.waitUntil = null;
      saveRun(run);
      await advanceFlowRun(run, flow).catch(e => console.error("[flows] move-runs advance failed", e.message));
    }
    return sendJson(res, 200, { moved: runs.length });
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
      // fieldLabels (code -> current question wording) is for the token
      // picker's display text ONLY -- every sample itself is still
      // dual-keyed (code AND label, same as the real trigger payload -- see
      // forms_backend.js's own labeledAnswers) so an ALREADY-built
      // template's {{payload.<old label>}} token still finds a match here
      // too, not just at actual send time.
      const fieldLabels = {};
      // From the form's own definition (not just the answered fields of the
      // last few responses), so the picker can always tell a code from its
      // label-keyed duplicate -- including on a form with no submissions yet.
      const configuredForm = formId ? forms.find(f => f.id === formId) : null;
      (configuredForm?.fields || []).forEach(f => { if (f.label && f.type !== "headline" && f.type !== "statement" && f.type !== "page_break") fieldLabels[f.code || f.label || f.type] = f.label; });
      const samples = responses.map(r => {
        const form = forms.find(f => f.id === r.formId);
        const labeled = {};
        (form?.fields || []).forEach(f => {
          if (r.answers[f.id] !== undefined && r.answers[f.id] !== "") {
            const val = Array.isArray(r.answers[f.id]) ? r.answers[f.id].join(", ") : r.answers[f.id];
            const key = f.code || f.label || f.type;
            labeled[key] = val;
            if (f.label) { labeled[f.label] = val; fieldLabels[key] = f.label; }
          }
        });
        // Always present (blank for a response taken before this was
        // captured) so "Timezone" is offered in the token picker right away,
        // not only after the next submission -- see forms_backend.js.
        if (!("Timezone" in labeled)) labeled["Timezone"] = r.timezone || "";
        return labeled;
      });
      return sendJson(res, 200, { samples, fieldLabels });
    }
    if (type === "booking_created") {
      const eventTypes = readJson("crm_event_types.json", []);
      let bookings = readJson("crm_bookings.json", []);
      const eventTypeId = flow.trigger.config?.eventTypeId;
      if (eventTypeId) bookings = bookings.filter(b => b.eventTypeId === eventTypeId);
      bookings = bookings.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 5);
      // fieldLabels merged newest-first (bookings is already sorted that
      // way) -- only fills in a code the first time it's seen, so the most
      // recent booking's wording for a given question wins, same "favors
      // the latest" precedence the trigger-payload example lookups already
      // use elsewhere in this file.
      const fieldLabels = {};
      bookings.forEach(b => {
        const labels = b.formAnswerLabels && typeof b.formAnswerLabels === "object" ? b.formAnswerLabels : {};
        for (const [k, v] of Object.entries(labels)) if (!(k in fieldLabels)) fieldLabels[k] = v;
      });
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
        "Timezone": b.timezone || "",
        // Same rendering as scheduling_backend.js's formatWhenWithZoneName --
        // only bookings saved after calendarTimezone was recorded have one.
        ...(b.calendarTimezone ? { "Calendar Time": new Date(b.startAt).toLocaleString("en-US", { timeZone: b.calendarTimezone, weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }) } : {}),
      }));
      return sendJson(res, 200, { samples, fieldLabels });
    }
    if (type === "youtube_new_video") {
      // Real recent uploads once the poller has seen the channel; before that,
      // one blank row so {{payload.videoId}} etc. are still pickable tokens.
      const recent = readJson(YT_POLL_STATE_FILE, {})?.[flow.id]?.recent || [];
      return sendJson(res, 200, { samples: recent.length ? recent : [{ videoId: "", title: "", url: "", publishedAt: "", channelId: "", channelTitle: "" }] });
    }
    return sendJson(res, 200, { samples: [] });
  }

  return false;
}
