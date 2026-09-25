import { getSessionUser, sendJson, readJsonBody, readJson, writeJson, isAdmin } from "./auth_backend.js";
import { getContact } from "./email_backend.js";
import { googleAccessToken, googleCreds, getAdsSettings, setCallsSheetId } from "./ads_backend.js";

// "Mark as Enrolled" popup (call-popup.js's sibling, enroll-popup.js) --
// fires from every place staff can change a contact's status (inline-edit.js,
// the chat panel's status select, and both contact-detail/Inbox-overlay
// autosave paths) when the NEW value is "ENROLLED". Finds that person's row
// in the same CALLS TRACKING spreadsheet ads_backend.js already reads sales
// from (ONLINE or GYM tab, staff picks which in the popup) and fills in
// Qualified/Result/Program/Amount Paid/Payment/Notes/Start Date/End Date/
// Date Of Enrollment -- the record ads_backend.js's own sales sync already
// depends on existing.
//
// What this actually does is editable from Settings > Ads > "View & Edit
// Enrollment Flow" (enroll-flow.html) instead of being pure backend code --
// getEnrollSheetSettings() below is the one place both this file and that
// page read/write, with these DEFAULT_* constants as the fallback (so
// nothing changes for anyone until someone actually edits it there).
//
// Column names are looked up by HEADER, never hardcoded letters -- ONLINE and
// GYM don't share a layout (ONLINE has an extra Timezone column shifting
// everything after it by one), confirmed live 2026-09-22.

const INTEGRATIONS_FILE = "crm_integrations.json"; // same file every other Settings tab (SES/Twilio/Ads/etc) reads and writes
const DEFAULT_SHEET_TABS = { online: "ONLINE", gym: "GYM" };

// Confirmed live against the sheet's own real headers and data-validation
// dropdowns (2026-09-22). Sheets API writes aren't blocked by validation
// either way, but matching the option lists exactly means a written cell
// never shows the little red "doesn't match the dropdown" warning triangle.
const DEFAULT_COLUMN_NAMES = {
  first: "First", last: "Last", email: "Email", phone: "Phone",
  qualified: "Qualified", result: "Result", program: "Program",
  amountPaid: "Amount Paid", payment: "Payment", notes: "Notes",
  startDate: "Start Date", endDate: "End Date", enrollmentDate: "Date Of Enrollment",
};
const DEFAULT_PROGRAM_OPTIONS = {
  online: ["4 Month Standard", "4 Month Modified", "6 Month Standard", "1Year Standard", "Renewal 6 Month Standard", "Retreat", "Other", "NA"],
  gym: ["4 Month Standard", "4 Month Modified", "6 Month Standard", "1Year Standard", "Other", "NA"],
};
const DEFAULT_PAYMENT_OPTIONS = ["Paypal", "Wise", "Stripe", "Zelle", "Bank Transfer", "Venmo", "Shopify", "Melio", "NA"];
// {date} and {notes} get substituted in; always applied (not just when
// there's already something in the cell) so every note this popup writes is
// consistently tagged with when it was added.
const DEFAULT_NOTES_TEMPLATE = "[Enrolled {date}] {notes}";
// The two fixed values actually written into Qualified/Result -- shown in
// the flow page for transparency, but NOT themselves editable: the sheet's
// own dropdown only recognizes these two exact strings for what this popup
// means (a completed enrollment), so making them freely editable would just
// let someone quietly break that link, not create the flexibility more
// dropdown-driven fields (Program/Payment) genuinely have.
export const QUALIFIED_VALUE = "Qualified", RESULT_VALUE = "Enrolled";

function readIntegrations() { return readJson(INTEGRATIONS_FILE, {}); }
export function getEnrollSheetSettings() {
  const s = readIntegrations().enrollSheet || {};
  return {
    // The SAME spreadsheet ads_backend.js's own Settings > Ads tab points
    // at -- not a second copy; changing it here changes it there too, and
    // vice versa, since both read/write ads_backend.js's getAdsSettings()/
    // setCallsSheetId().
    sheetId: getAdsSettings().callsSheetId,
    sheetTabs: {
      online: typeof s.sheetTabs?.online === "string" && s.sheetTabs.online.trim() ? s.sheetTabs.online.trim() : DEFAULT_SHEET_TABS.online,
      gym: typeof s.sheetTabs?.gym === "string" && s.sheetTabs.gym.trim() ? s.sheetTabs.gym.trim() : DEFAULT_SHEET_TABS.gym,
    },
    columnNames: { ...DEFAULT_COLUMN_NAMES, ...(s.columnNames || {}) },
    programOptions: {
      online: Array.isArray(s.programOptions?.online) && s.programOptions.online.length ? s.programOptions.online : DEFAULT_PROGRAM_OPTIONS.online,
      gym: Array.isArray(s.programOptions?.gym) && s.programOptions.gym.length ? s.programOptions.gym : DEFAULT_PROGRAM_OPTIONS.gym,
    },
    paymentOptions: Array.isArray(s.paymentOptions) && s.paymentOptions.length ? s.paymentOptions : DEFAULT_PAYMENT_OPTIONS,
    notesTemplate: typeof s.notesTemplate === "string" && s.notesTemplate.trim() ? s.notesTemplate : DEFAULT_NOTES_TEMPLATE,
    // Shown on flows.html's "ENROLLMENT RECORDING" row (see that page) --
    // not read by the enroll-sheet write path itself, just tracked for display.
    enrollCount: Number(s.enrollCount) || 0,
    updatedAt: s.updatedAt || null,
  };
}
// Only ever persists these 5 fields under enrollSheet -- sheetId lives under
// ads_backend.js's own settings instead (see getEnrollSheetSettings), so a
// caller passing the FULL getEnrollSheetSettings() object back in (the
// reset handler below does) can't accidentally stuff a redundant, ignored
// copy of it in here too.
function saveEnrollSheetSettings(next) {
  const all = readIntegrations();
  const { sheetTabs, columnNames, programOptions, paymentOptions, notesTemplate } = next;
  all.enrollSheet = { sheetTabs, columnNames, programOptions, paymentOptions, notesTemplate, enrollCount: all.enrollSheet?.enrollCount || 0, updatedAt: new Date().toISOString() };
  writeJson(INTEGRATIONS_FILE, all);
}
// Called once per successful sheet write (both the matched-update and the
// appended-new-row paths) -- deliberately does NOT touch updatedAt (that's
// "when someone last edited the CONFIGURATION", not "when this last ran").
function bumpEnrollCount() {
  const all = readIntegrations();
  all.enrollSheet = all.enrollSheet || {};
  all.enrollSheet.enrollCount = (Number(all.enrollSheet.enrollCount) || 0) + 1;
  writeJson(INTEGRATIONS_FILE, all);
}

function digitsLast10(phone) { return String(phone || "").replace(/\D/g, "").slice(-10); }
function normName(s) { return String(s || "").trim().toLowerCase(); }
// "2026-09-22" -> "September 22, 2026" -- matches the sheet's own long-form
// dates ("October 16, 2025") so a human reading the row sees the same style
// everywhere, not a mix of formats.
function longDate(dateStr) {
  if (!dateStr) return "";
  const d = new Date(dateStr + "T00:00:00");
  return isNaN(d) ? "" : d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}
function formatNote(template, notes, enrollmentDate) {
  return template.replace("{date}", longDate(enrollmentDate) || new Date().toLocaleDateString("en-US")).replace("{notes}", notes);
}
const colLetter = (i0) => { let s = "", i = i0 + 1; for (; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s; return s; };

async function sheetsGet(url, accessToken) {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(20000) });
  const d = await r.json();
  if (!r.ok) throw new Error(d?.error?.message || `sheets_http_${r.status}`);
  return d;
}
async function sheetsPost(url, accessToken, body) {
  const r = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
  const d = await r.json();
  if (!r.ok) throw new Error(d?.error?.message || `sheets_http_${r.status}`);
  return d;
}

// Finds the person's row (by email, then phone, then first+last -- whichever
// matches; the LAST matching row wins when more than one does, since rows
// are added call-by-call and the most recent entry is the relevant one to
// update at enrollment time), and the header's column index for each field
// this popup can write (keyed the same as columnNames, e.g. cols.qualified).
// rowIndex -1 when nothing matches -- the caller falls back to appending.
function findRow(rows, contact, columnNames) {
  const hdr = (rows[0] || []).map(c => String(c).trim().toLowerCase());
  const cols = {};
  for (const [key, name] of Object.entries(columnNames)) cols[key] = hdr.indexOf(String(name).trim().toLowerCase());
  if (cols.email < 0 && cols.phone < 0 && (cols.first < 0 || cols.last < 0)) return { cols, rowIndex: -1 };
  const wantEmail = normName(contact.email), wantPhone = digitsLast10(contact.phone), wantFirst = normName(contact.first), wantLast = normName(contact.last);
  let rowIndex = -1;
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const rowEmail = cols.email >= 0 ? normName(r[cols.email]) : "";
    const rowPhone = cols.phone >= 0 ? digitsLast10(r[cols.phone]) : "";
    const rowFirst = cols.first >= 0 ? normName(r[cols.first]) : "";
    const rowLast = cols.last >= 0 ? normName(r[cols.last]) : "";
    const matches =
      (wantEmail && rowEmail && rowEmail === wantEmail) ||
      (wantPhone && rowPhone && rowPhone === wantPhone) ||
      (wantFirst && wantLast && rowFirst === wantFirst && rowLast === wantLast);
    if (matches) rowIndex = i; // keep going -- last match wins
  }
  return { cols, rowIndex };
}

export async function handleCallsSheetRequest(req, res, url) {
  const p = url.pathname;
  // Read by enroll-popup.js (any logged-in user, same as before) AND by
  // enroll-flow.html to show the current configuration.
  if (p === "/api/calls-sheet/options" && req.method === "GET") {
    const me = getSessionUser(req);
    if (!me) return sendJson(res, 401, { error: "Not logged in" });
    const { programOptions, paymentOptions } = getEnrollSheetSettings();
    return sendJson(res, 200, { programOptions, paymentOptions });
  }

  // The visual flow page's own load/save -- editing the column names and
  // dropdown option lists calls_sheet_backend.js's own write logic reads
  // above, without touching this file. Save is admin-only, same as every
  // other Settings write in this app; viewing isn't gated further than
  // being logged in, same as /options.
  if (p === "/api/calls-sheet/settings" && req.method === "GET") {
    const me = getSessionUser(req);
    if (!me) return sendJson(res, 401, { error: "Not logged in" });
    return sendJson(res, 200, { settings: getEnrollSheetSettings(), defaults: { sheetTabs: DEFAULT_SHEET_TABS, columnNames: DEFAULT_COLUMN_NAMES, programOptions: DEFAULT_PROGRAM_OPTIONS, paymentOptions: DEFAULT_PAYMENT_OPTIONS, notesTemplate: DEFAULT_NOTES_TEMPLATE }, qualifiedValue: QUALIFIED_VALUE, resultValue: RESULT_VALUE });
  }
  if (p === "/api/calls-sheet/settings" && req.method === "POST") {
    const me = getSessionUser(req);
    if (!isAdmin(me)) return sendJson(res, 403, { error: "Admins only" });
    const body = await readJsonBody(req);
    const cur = getEnrollSheetSettings();
    // sheetId lives under ads_backend.js's own settings (same spreadsheet
    // its sales sync reads) -- saved through its own setter, not folded
    // into enrollSheet below. Accepts a pasted URL or a bare ID, same as
    // Settings > Ads' own field.
    if (typeof body.sheetId === "string" && body.sheetId.trim()) setCallsSheetId(body.sheetId);
    const sheetTabs = { online: cur.sheetTabs.online, gym: cur.sheetTabs.gym };
    for (const sheetKey of ["online", "gym"]) {
      const v = body.sheetTabs?.[sheetKey];
      if (typeof v === "string" && v.trim()) sheetTabs[sheetKey] = v.trim();
    }
    const columnNames = { ...cur.columnNames };
    if (body.columnNames && typeof body.columnNames === "object") {
      for (const key of Object.keys(DEFAULT_COLUMN_NAMES)) {
        const v = body.columnNames[key];
        if (typeof v === "string" && v.trim()) columnNames[key] = v.trim();
      }
    }
    const programOptions = { online: cur.programOptions.online, gym: cur.programOptions.gym };
    for (const sheetKey of ["online", "gym"]) {
      const list = body.programOptions?.[sheetKey];
      if (Array.isArray(list) && list.length) programOptions[sheetKey] = list.map(String).map(s => s.trim()).filter(Boolean);
    }
    const paymentOptions = Array.isArray(body.paymentOptions) && body.paymentOptions.length ? body.paymentOptions.map(String).map(s => s.trim()).filter(Boolean) : cur.paymentOptions;
    const notesTemplate = typeof body.notesTemplate === "string" && body.notesTemplate.includes("{notes}") ? body.notesTemplate : cur.notesTemplate;
    saveEnrollSheetSettings({ sheetTabs, columnNames, programOptions, paymentOptions, notesTemplate });
    return sendJson(res, 200, { ok: true, settings: getEnrollSheetSettings() });
  }
  // Resets one setting group back to the hardcoded defaults -- simpler than
  // asking someone to retype every field by hand if an edit goes wrong.
  // (sheetId has no "default" to reset to -- it's the real spreadsheet,
  // already correctly set; not offered here.)
  if (p === "/api/calls-sheet/settings/reset" && req.method === "POST") {
    const me = getSessionUser(req);
    if (!isAdmin(me)) return sendJson(res, 403, { error: "Admins only" });
    const { group } = await readJsonBody(req);
    const cur = getEnrollSheetSettings();
    if (group === "sheetTabs") cur.sheetTabs = { ...DEFAULT_SHEET_TABS };
    else if (group === "columnNames") cur.columnNames = { ...DEFAULT_COLUMN_NAMES };
    else if (group === "programOptions") cur.programOptions = { online: [...DEFAULT_PROGRAM_OPTIONS.online], gym: [...DEFAULT_PROGRAM_OPTIONS.gym] };
    else if (group === "paymentOptions") cur.paymentOptions = [...DEFAULT_PAYMENT_OPTIONS];
    else if (group === "notesTemplate") cur.notesTemplate = DEFAULT_NOTES_TEMPLATE;
    else return sendJson(res, 400, { error: "Unknown group" });
    saveEnrollSheetSettings(cur);
    return sendJson(res, 200, { ok: true, settings: getEnrollSheetSettings() });
  }

  const enrollMatch = p.match(/^\/api\/contacts\/([^/]+)\/enroll-sheet$/);
  if (enrollMatch && req.method === "POST") {
    const me = getSessionUser(req);
    if (!me) return sendJson(res, 401, { error: "Not logged in" });
    const contactId = enrollMatch[1];
    const contact = getContact(contactId);
    if (!contact) return sendJson(res, 404, { error: "Contact not found" });
    const body = await readJsonBody(req);
    const sheetKey = body.sheet === "gym" ? "gym" : body.sheet === "online" ? "online" : null;
    if (!sheetKey) return sendJson(res, 400, { error: "sheet must be 'online' or 'gym'" });
    const { program, amountPaid, payment, notes, startDate, endDate, enrollmentDate } = body;
    const settings = getEnrollSheetSettings();
    const tab = settings.sheetTabs[sheetKey];
    if (program && !settings.programOptions[sheetKey].includes(program)) return sendJson(res, 400, { error: "Unrecognized program for that sheet" });
    if (payment && !settings.paymentOptions.includes(payment)) return sendJson(res, 400, { error: "Unrecognized payment type" });

    const { refreshToken } = googleCreds();
    if (!refreshToken) return sendJson(res, 400, { error: "Google Sheets isn't connected (Settings > Ads)" });
    const sheetId = settings.sheetId;
    let accessToken;
    try { accessToken = await googleAccessToken(); } catch (e) { return sendJson(res, 502, { error: e.message }); }

    try {
      const range = `'${tab}'!A1:T5000`;
      const data = await sheetsGet(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}?valueRenderOption=FORMATTED_VALUE`, accessToken);
      const rows = data.values || [[]];
      const { cols, rowIndex } = findRow(rows, contact, settings.columnNames);

      if (rowIndex > 0) {
        // Update ONLY the named columns, one ranged write per column -- never
        // a whole-row overwrite, so a column this popup doesn't know about
        // (Origin, Date Of Call, the trailing stats cells, anything a human
        // typed since this read started) can never be clobbered.
        const sheetRow = rowIndex + 1; // 1-based for A1 notation
        const existingNotes = cols.notes >= 0 ? String(rows[rowIndex][cols.notes] || "").trim() : "";
        const newNotes = notes ? (existingNotes ? `${existingNotes}\n\n${formatNote(settings.notesTemplate, notes, enrollmentDate)}` : formatNote(settings.notesTemplate, notes, enrollmentDate)) : null;
        const writes = [];
        const set = (col, value) => { if (cols[col] >= 0 && value != null) writes.push({ range: `'${tab}'!${colLetter(cols[col])}${sheetRow}`, values: [[value]] }); };
        set("qualified", QUALIFIED_VALUE);
        set("result", RESULT_VALUE);
        set("program", program || null);
        set("amountPaid", amountPaid != null && amountPaid !== "" ? Number(amountPaid) : null);
        set("payment", payment || null);
        if (newNotes != null) set("notes", newNotes);
        set("startDate", longDate(startDate) || null);
        set("endDate", longDate(endDate) || null);
        set("enrollmentDate", longDate(enrollmentDate) || null);
        if (writes.length) {
          // RAW, not USER_ENTERED -- confirmed live (2026-09-22) that USER_ENTERED
          // parses a written date STRING into a real Sheets date value, which then
          // displays as a bare serial number ("46287") on any of these columns,
          // none of which already carry a date number format on every row (the
          // sheet's own free-typed dates are plain text in every shape imaginable --
          // see ads_backend.js's parseSheetDate comment -- not real Sheets dates
          // either). RAW keeps the human-readable string exactly as sent.
          await sheetsPost(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values:batchUpdate`, accessToken, { valueInputOption: "RAW", data: writes });
        }
        bumpEnrollCount();
        return sendJson(res, 200, { ok: true, matched: true, row: sheetRow, sheet: tab });
      }

      // No existing row -- appends a new one instead of silently doing
      // nothing, using whichever columns THIS tab's header actually has (in
      // its own order), so it still lands correctly even though ONLINE and
      // GYM don't share a column layout.
      const hdr = (rows[0] || []).map(c => String(c).trim().toLowerCase());
      const byLowerName = {};
      for (const [key, name] of Object.entries(settings.columnNames)) byLowerName[String(name).trim().toLowerCase()] = key;
      const valueFor = {
        first: contact.first || "", last: contact.last || "", email: contact.email || "", phone: contact.phone || "",
        qualified: QUALIFIED_VALUE, result: RESULT_VALUE, program: program || "",
        amountPaid: amountPaid != null && amountPaid !== "" ? Number(amountPaid) : "", payment: payment || "",
        notes: notes ? formatNote(settings.notesTemplate, notes, enrollmentDate) : "",
        startDate: longDate(startDate), endDate: longDate(endDate), enrollmentDate: longDate(enrollmentDate),
      };
      const newRow = hdr.map(h => { const key = byLowerName[h]; return key ? (valueFor[key] ?? "") : ""; });
      await sheetsPost(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(`'${tab}'!A1`)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, accessToken, { values: [newRow] });
      bumpEnrollCount();
      return sendJson(res, 200, { ok: true, matched: false, sheet: tab });
    } catch (e) {
      return sendJson(res, 502, { error: e.message });
    }
  }

  return false;
}
