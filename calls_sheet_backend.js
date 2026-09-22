import { getSessionUser, sendJson, readJsonBody } from "./auth_backend.js";
import { getContact } from "./email_backend.js";
import { googleAccessToken, googleCreds, getAdsSettings } from "./ads_backend.js";

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
// Column names are looked up by HEADER, never hardcoded letters -- ONLINE and
// GYM don't share a layout (ONLINE has an extra Timezone column shifting
// everything after it by one), confirmed live 2026-09-22.

const SHEET_TABS = { online: "ONLINE", gym: "GYM" };
// Confirmed live against the sheet's own data-validation dropdowns
// (2026-09-22) -- Sheets API writes aren't blocked by validation either way,
// but matching these exactly means a written cell never shows the little
// red "doesn't match the dropdown" warning triangle. If the sheet's own
// dropdowns are ever edited, update these to match.
export const PROGRAM_OPTIONS = {
  online: ["4 Month Standard", "4 Month Modified", "6 Month Standard", "1Year Standard", "Renewal 6 Month Standard", "Retreat", "Other", "NA"],
  gym: ["4 Month Standard", "4 Month Modified", "6 Month Standard", "1Year Standard", "Other", "NA"],
};
export const PAYMENT_OPTIONS = ["Paypal", "Wise", "Stripe", "Zelle", "Bank Transfer", "Venmo", "Shopify", "Melio", "NA"];
const QUALIFIED_VALUE = "Qualified", RESULT_VALUE = "Enrolled";

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
// this popup can write. Returns null (never throws) when the tab has none of
// the columns this needs -- the caller falls back to appending a new row.
function findRow(rows, { email, phone, first, last }) {
  const hdr = (rows[0] || []).map(c => String(c).trim().toLowerCase());
  const cols = {};
  for (const name of ["first", "last", "email", "phone", "qualified", "result", "program", "amount paid", "payment", "notes", "start date", "end date", "date of enrollment"]) {
    cols[name] = hdr.indexOf(name);
  }
  if (cols.email < 0 && cols.phone < 0 && (cols.first < 0 || cols.last < 0)) return { cols, rowIndex: -1 };
  const wantEmail = normName(email), wantPhone = digitsLast10(phone), wantFirst = normName(first), wantLast = normName(last);
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
  if (p === "/api/calls-sheet/options" && req.method === "GET") {
    const me = getSessionUser(req);
    if (!me) return sendJson(res, 401, { error: "Not logged in" });
    return sendJson(res, 200, { programOptions: PROGRAM_OPTIONS, paymentOptions: PAYMENT_OPTIONS });
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
    const tab = SHEET_TABS[sheetKey];
    const { program, amountPaid, payment, notes, startDate, endDate, enrollmentDate } = body;
    if (program && !PROGRAM_OPTIONS[sheetKey].includes(program)) return sendJson(res, 400, { error: "Unrecognized program for that sheet" });
    if (payment && !PAYMENT_OPTIONS.includes(payment)) return sendJson(res, 400, { error: "Unrecognized payment type" });

    const { refreshToken } = googleCreds();
    if (!refreshToken) return sendJson(res, 400, { error: "Google Sheets isn't connected (Settings > Ads)" });
    const sheetId = getAdsSettings().callsSheetId;
    let accessToken;
    try { accessToken = await googleAccessToken(); } catch (e) { return sendJson(res, 502, { error: e.message }); }

    try {
      const range = `'${tab}'!A1:T5000`;
      const data = await sheetsGet(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}?valueRenderOption=FORMATTED_VALUE`, accessToken);
      const rows = data.values || [[]];
      const { cols, rowIndex } = findRow(rows, contact);

      if (rowIndex > 0) {
        // Update ONLY the named columns, one ranged write per column -- never
        // a whole-row overwrite, so a column this popup doesn't know about
        // (Origin, Date Of Call, the trailing stats cells, anything a human
        // typed since this read started) can never be clobbered.
        const sheetRow = rowIndex + 1; // 1-based for A1 notation
        const existingNotes = cols.notes >= 0 ? String(rows[rowIndex][cols.notes] || "").trim() : "";
        const newNotes = notes ? (existingNotes ? `${existingNotes}\n\n[Enrolled ${longDate(enrollmentDate) || new Date().toLocaleDateString("en-US")}] ${notes}` : notes) : null;
        const writes = [];
        const set = (col, value) => { if (cols[col] >= 0 && value != null) writes.push({ range: `'${tab}'!${colLetter(cols[col])}${sheetRow}`, values: [[value]] }); };
        set("qualified", QUALIFIED_VALUE);
        set("result", RESULT_VALUE);
        set("program", program || null);
        set("amount paid", amountPaid != null && amountPaid !== "" ? Number(amountPaid) : null);
        set("payment", payment || null);
        if (newNotes != null) set("notes", newNotes);
        set("start date", longDate(startDate) || null);
        set("end date", longDate(endDate) || null);
        set("date of enrollment", longDate(enrollmentDate) || null);
        if (writes.length) {
          // RAW, not USER_ENTERED -- confirmed live (2026-09-22) that USER_ENTERED
          // parses a written date STRING into a real Sheets date value, which then
          // displays as a bare serial number ("46287") on any of these columns,
          // none of which already carry a date number format on every row (the
          // sheet's own free-typed dates are plain text in every shape imaginable --
          // see parseSheetDate's comment -- not real Sheets dates either). RAW keeps
          // the human-readable string exactly as sent.
          await sheetsPost(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values:batchUpdate`, accessToken, { valueInputOption: "RAW", data: writes });
        }
        return sendJson(res, 200, { ok: true, matched: true, row: sheetRow, sheet: tab });
      }

      // No existing row -- appends a new one instead of silently doing
      // nothing, using whichever columns THIS tab's header actually has (in
      // its own order), so it still lands correctly even though ONLINE and
      // GYM don't share a column layout.
      const hdr = (rows[0] || []).map(c => String(c).trim().toLowerCase());
      const newRow = hdr.map(h => {
        if (h === "first") return contact.first || "";
        if (h === "last") return contact.last || "";
        if (h === "email") return contact.email || "";
        if (h === "phone") return contact.phone || "";
        if (h === "qualified") return QUALIFIED_VALUE;
        if (h === "result") return RESULT_VALUE;
        if (h === "program") return program || "";
        if (h === "amount paid") return amountPaid != null && amountPaid !== "" ? Number(amountPaid) : "";
        if (h === "payment") return payment || "";
        if (h === "notes") return notes || "";
        if (h === "start date") return longDate(startDate);
        if (h === "end date") return longDate(endDate);
        if (h === "date of enrollment") return longDate(enrollmentDate);
        return "";
      });
      await sheetsPost(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(`'${tab}'!A1`)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, accessToken, { values: [newRow] });
      return sendJson(res, 200, { ok: true, matched: false, sheet: tab });
    } catch (e) {
      return sendJson(res, 502, { error: e.message });
    }
  }

  return false;
}
