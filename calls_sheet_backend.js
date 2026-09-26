import { getSessionUser, sendJson, readJsonBody, readJson, writeJson, isAdmin } from "./auth_backend.js";

// "Mark as Enrolled" popup (enroll-popup.js) -- fires from every place staff
// can change a contact's status to ENROLLED. The actual sheet write (finding
// the person's row in the CALLS TRACKING spreadsheet and filling in Qualified/
// Result/Program/etc) now happens as a real, editable Flow step
// ("Enrollment Recording (migrated)" in the Flows list), triggered off the
// contact's status PATCH -- see flows_backend.js's status_changed trigger and
// sheet_upsert step. This file is left with only what that migration couldn't
// move into the flow: the popup's own form -- which program/payment choices
// to show, and how a typed note gets prefixed -- since those are decided
// BEFORE the flow (or any sheet) is ever involved.
const INTEGRATIONS_FILE = "crm_integrations.json"; // same file every other Settings tab (SES/Twilio/Ads/etc) reads and writes

const DEFAULT_PROGRAM_OPTIONS = {
  online: ["4 Month Standard", "4 Month Modified", "6 Month Standard", "1Year Standard", "Renewal 6 Month Standard", "Retreat", "Other", "NA"],
  gym: ["4 Month Standard", "4 Month Modified", "6 Month Standard", "1Year Standard", "Other", "NA"],
};
const DEFAULT_PAYMENT_OPTIONS = ["Paypal", "Wise", "Stripe", "Zelle", "Bank Transfer", "Venmo", "Shopify", "Melio", "NA"];
// {date} and {notes} get substituted in by enroll-popup.js before it PATCHes
// the contact -- always applied so every note is consistently tagged with
// when it was added.
const DEFAULT_NOTES_TEMPLATE = "[Enrolled {date}] {notes}";

function readIntegrations() { return readJson(INTEGRATIONS_FILE, {}); }
export function getEnrollSheetSettings() {
  const s = readIntegrations().enrollSheet || {};
  return {
    programOptions: {
      online: Array.isArray(s.programOptions?.online) && s.programOptions.online.length ? s.programOptions.online : DEFAULT_PROGRAM_OPTIONS.online,
      gym: Array.isArray(s.programOptions?.gym) && s.programOptions.gym.length ? s.programOptions.gym : DEFAULT_PROGRAM_OPTIONS.gym,
    },
    paymentOptions: Array.isArray(s.paymentOptions) && s.paymentOptions.length ? s.paymentOptions : DEFAULT_PAYMENT_OPTIONS,
    notesTemplate: typeof s.notesTemplate === "string" && s.notesTemplate.trim() ? s.notesTemplate : DEFAULT_NOTES_TEMPLATE,
  };
}
function saveEnrollSheetSettings(next) {
  const all = readIntegrations();
  const { programOptions, paymentOptions, notesTemplate } = next;
  all.enrollSheet = { programOptions, paymentOptions, notesTemplate, updatedAt: new Date().toISOString() };
  writeJson(INTEGRATIONS_FILE, all);
}

export async function handleCallsSheetRequest(req, res, url) {
  const p = url.pathname;
  // Read by enroll-popup.js (any logged-in user) to fill the Program/Payment
  // dropdowns and apply the notes template client-side.
  if (p === "/api/calls-sheet/options" && req.method === "GET") {
    const me = getSessionUser(req);
    if (!me) return sendJson(res, 401, { error: "Not logged in" });
    const { programOptions, paymentOptions, notesTemplate } = getEnrollSheetSettings();
    return sendJson(res, 200, { programOptions, paymentOptions, notesTemplate });
  }

  if (p === "/api/calls-sheet/settings" && req.method === "GET") {
    const me = getSessionUser(req);
    if (!me) return sendJson(res, 401, { error: "Not logged in" });
    return sendJson(res, 200, { settings: getEnrollSheetSettings(), defaults: { programOptions: DEFAULT_PROGRAM_OPTIONS, paymentOptions: DEFAULT_PAYMENT_OPTIONS, notesTemplate: DEFAULT_NOTES_TEMPLATE } });
  }
  if (p === "/api/calls-sheet/settings" && req.method === "POST") {
    const me = getSessionUser(req);
    if (!isAdmin(me)) return sendJson(res, 403, { error: "Admins only" });
    const body = await readJsonBody(req);
    const cur = getEnrollSheetSettings();
    const programOptions = { online: cur.programOptions.online, gym: cur.programOptions.gym };
    for (const sheetKey of ["online", "gym"]) {
      const list = body.programOptions?.[sheetKey];
      if (Array.isArray(list) && list.length) programOptions[sheetKey] = list.map(String).map(s => s.trim()).filter(Boolean);
    }
    const paymentOptions = Array.isArray(body.paymentOptions) && body.paymentOptions.length ? body.paymentOptions.map(String).map(s => s.trim()).filter(Boolean) : cur.paymentOptions;
    const notesTemplate = typeof body.notesTemplate === "string" && body.notesTemplate.includes("{notes}") ? body.notesTemplate : cur.notesTemplate;
    saveEnrollSheetSettings({ programOptions, paymentOptions, notesTemplate });
    return sendJson(res, 200, { ok: true, settings: getEnrollSheetSettings() });
  }
  // Resets one setting group back to the hardcoded defaults.
  if (p === "/api/calls-sheet/settings/reset" && req.method === "POST") {
    const me = getSessionUser(req);
    if (!isAdmin(me)) return sendJson(res, 403, { error: "Admins only" });
    const { group } = await readJsonBody(req);
    const cur = getEnrollSheetSettings();
    if (group === "programOptions") cur.programOptions = { online: [...DEFAULT_PROGRAM_OPTIONS.online], gym: [...DEFAULT_PROGRAM_OPTIONS.gym] };
    else if (group === "paymentOptions") cur.paymentOptions = [...DEFAULT_PAYMENT_OPTIONS];
    else if (group === "notesTemplate") cur.notesTemplate = DEFAULT_NOTES_TEMPLATE;
    else return sendJson(res, 400, { error: "Unknown group" });
    saveEnrollSheetSettings(cur);
    return sendJson(res, 200, { ok: true, settings: getEnrollSheetSettings() });
  }

  return false;
}
