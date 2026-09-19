// Adds a blacklisted contact to the team's Blacklist Google Sheet (the link
// pasted in Settings -> Opt Out). Uses the same connected Google account as
// flows_backend.js's Google Sheet step (GOOGLE_REFRESH_TOKEN_LW already
// carries the spreadsheets scope) -- copied rather than imported so this
// stays free of flows_backend's much larger import graph (compliance_backend
// -> here would otherwise risk an import cycle).
//
// Takes the sheet URL as a parameter and never reads settings itself, for
// the same cycle-avoidance reason: callers own where the URL comes from.

const SHEETS = "https://sheets.googleapis.com/v4/spreadsheets";

export function sheetsConfigured() {
  return !!(process.env.GOOGLE_REFRESH_TOKEN_LW && process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

// "https://docs.google.com/spreadsheets/d/<id>/edit?gid=123#gid=123" ->
// { spreadsheetId, gid } (gid null when the link doesn't name a tab). A bare
// spreadsheet id pasted on its own is accepted too.
export function parseSheetUrl(input) {
  const s = String(input || "").trim();
  if (!s) return null;
  const m = s.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]{15,})/);
  const spreadsheetId = m ? m[1] : (/^[a-zA-Z0-9_-]{25,}$/.test(s) ? s : null);
  if (!spreadsheetId) return null;
  const g = s.match(/[?#&]gid=(\d+)/);
  return { spreadsheetId, gid: g ? Number(g[1]) : null };
}

async function getAccessToken() {
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN_LW, grant_type: "refresh_token",
    }),
  });
  const d = await r.json();
  if (!d.access_token) throw new Error("Google sign-in for Sheets failed: " + JSON.stringify(d));
  return d.access_token;
}

async function sheetsGet(accessToken, path) {
  const r = await fetch(`${SHEETS}/${path}`, { headers: { Authorization: `Bearer ${accessToken}` } });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new SheetsError(r.status, d.error?.message || `HTTP ${r.status}`);
  return d;
}

class SheetsError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
// Plain-language version of the failures someone pasting a link can actually
// hit -- "share it with the account" is the one they can act on.
function friendlyError(e) {
  if (e instanceof SheetsError) {
    if (e.status === 404) return "Couldn't find that spreadsheet -- check the link.";
    if (e.status === 403) return "This CRM's Google account can't edit that sheet -- share it with that account as an Editor (the same account your Flows Google Sheet steps use).";
    if (e.status === 400) return e.message;
  }
  return e.message || String(e);
}

// The tab named by the link's gid (or the first tab when the link has none).
async function resolveTab(accessToken, { spreadsheetId, gid }) {
  const meta = await sheetsGet(accessToken, `${spreadsheetId}?fields=properties.title,sheets.properties(sheetId,title)`);
  const tabs = meta.sheets || [];
  const tab = gid == null ? tabs[0] : tabs.find(t => t.properties.sheetId === gid);
  if (!tab) throw new SheetsError(400, "That link points at a tab that doesn't exist in the spreadsheet.");
  return { title: tab.properties.title, spreadsheetTitle: meta.properties?.title || "" };
}

const q = (title) => `'${String(title).replace(/'/g, "''")}'`;
function columnLetter(n) {
  let s = "";
  while (n > 0) { const rem = (n - 1) % 26; s = String.fromCharCode(65 + rem) + s; n = Math.floor((n - 1) / 26); }
  return s || "A";
}
const norm = (h) => String(h || "").toLowerCase().replace(/[^a-z0-9]/g, "");

// Header names -> which contact field fills that column. Matched by header
// text rather than position so reordering columns or adding one later
// doesn't misfile anyone; an unrecognized header is just left blank.
const HEADER_FIELDS = {
  first: ["first", "firstname"],
  last: ["last", "lastname"],
  name: ["name", "fullname", "contactname", "contact"],
  email: ["email", "emailaddress"],
  phone: ["phone", "phonenumber", "mobile", "cell", "cellphone"],
  date: ["date", "dateadded", "dateblacklisted", "blacklisted", "added"],
  program: ["program", "type", "programtype"],
};
function mapColumns(headerRow) {
  const cols = {};
  (headerRow || []).forEach((h, i) => {
    const n = norm(h);
    for (const [field, aliases] of Object.entries(HEADER_FIELDS)) if (cols[field] == null && aliases.includes(n)) cols[field] = i;
  });
  // No recognizable header at all -> assume the sheet's known 5-column layout.
  if (!["first", "last", "name", "email", "phone"].some(f => cols[f] != null)) return { first: 0, last: 1, email: 2, phone: 3, date: 4 };
  return cols;
}

const last10 = (p) => String(p || "").replace(/\D/g, "").slice(-10);
function todayAnchorage() {
  return new Intl.DateTimeFormat("en-US", { timeZone: "America/Anchorage", year: "numeric", month: "numeric", day: "numeric" }).format(new Date());
}

// Read-only look at the link, plus a no-op write (an empty batchUpdate: no
// changes made, but Google rejects it for view-only access) so a bad link or
// missing Editor share shows up in Settings instead of silently failing the
// first time someone is blacklisted.
export async function checkBlacklistSheet(sheetUrl) {
  if (!sheetsConfigured()) return { ok: false, error: "Google isn't connected for Sheets on this CRM yet." };
  const parsed = parseSheetUrl(sheetUrl);
  if (!parsed) return { ok: false, error: "That doesn't look like a Google Sheets link." };
  try {
    const accessToken = await getAccessToken();
    const tab = await resolveTab(accessToken, parsed);
    const data = await sheetsGet(accessToken, `${parsed.spreadsheetId}/values/${encodeURIComponent(`${q(tab.title)}!A:Z`)}`);
    const rows = data.values || [];
    const cols = mapColumns(rows[0]);
    const w = await fetch(`${SHEETS}/${parsed.spreadsheetId}:batchUpdate`, {
      method: "POST", headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ requests: [] }),
    });
    if (!w.ok) {
      const wd = await w.json().catch(() => ({}));
      throw new SheetsError(w.status, wd.error?.message || `HTTP ${w.status}`);
    }
    return { ok: true, spreadsheetTitle: tab.spreadsheetTitle, tab: tab.title, rows: Math.max(0, rows.length - 1), headers: rows[0] || [], mappedFields: Object.keys(cols) };
  } catch (e) {
    return { ok: false, error: friendlyError(e) };
  }
}

// Same read-count-then-write-explicit-row approach as flows_backend.js's
// appendSheetRow (see its comment for why not values.append), under the same
// kind of per-sheet lock so two blacklistings landing together can't both
// pick the same "next row".
const locks = new Map();
function withLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  const result = prev.catch(() => {}).then(fn);
  locks.set(key, result.catch(() => {}));
  return result;
}

// contact: { first, last, email, phone, programType } snapshot. Skips anyone
// already on the sheet (matched by email, phone's last 10 digits, or -- when
// they have neither -- full name), since the sheet already holds years of
// manual entries and someone can be un-blacklisted and re-blacklisted.
// -> { ok, skipped?, row?, tab?, error? } -- never throws.
export async function appendToBlacklistSheet(sheetUrl, contact) {
  if (!sheetsConfigured()) return { ok: false, error: "Google isn't connected for Sheets on this CRM yet." };
  const parsed = parseSheetUrl(sheetUrl);
  if (!parsed) return { ok: false, error: "The Blacklist sheet link in Settings isn't a valid Google Sheets link." };
  try {
    return await withLock(`${parsed.spreadsheetId}::${parsed.gid}`, async () => {
      const accessToken = await getAccessToken();
      const tab = await resolveTab(accessToken, parsed);
      const data = await sheetsGet(accessToken, `${parsed.spreadsheetId}/values/${encodeURIComponent(`${q(tab.title)}!A:Z`)}`);
      const rows = data.values || [];
      const cols = mapColumns(rows[0]);

      const email = String(contact.email || "").trim().toLowerCase();
      const phone10 = last10(contact.phone);
      const fullName = `${contact.first || ""} ${contact.last || ""}`.trim().toLowerCase();
      const cell = (row, field) => (cols[field] == null ? "" : String(row[cols[field]] || "").trim());
      const already = rows.slice(1).some(r => {
        if (email && cell(r, "email").toLowerCase() === email) return true;
        if (phone10.length >= 7 && last10(cell(r, "phone")) === phone10) return true;
        if (!email && phone10.length < 7) {
          const name = (cols.name != null ? cell(r, "name") : `${cell(r, "first")} ${cell(r, "last")}`).trim().toLowerCase();
          return !!fullName && name === fullName;
        }
        return false;
      });
      if (already) return { ok: true, skipped: true, tab: tab.title };

      const width = Math.max(...Object.values(cols)) + 1;
      const out = Array(width).fill("");
      const put = (field, value) => { if (cols[field] != null) out[cols[field]] = value; };
      put("first", contact.first || "");
      put("last", contact.last || "");
      put("name", `${contact.first || ""} ${contact.last || ""}`.trim());
      put("email", contact.email || "");
      put("phone", contact.phone || "");
      put("date", todayAnchorage());
      put("program", String(contact.programType || "").toUpperCase());

      // RAW, not USER_ENTERED: these strings come from lead-supplied form
      // fields, and a blacklisted lead is exactly who'd type "=IMPORTXML(...)"
      // as a name -- USER_ENTERED would evaluate it as a formula. RAW also
      // keeps "+1 907..." phones as typed instead of turning them into numbers.
      const nextRow = rows.length + 1; // rows preserves gap rows as [], so this is the true bottom
      const range = `${q(tab.title)}!A${nextRow}:${columnLetter(width)}${nextRow}`;
      const r = await fetch(`${SHEETS}/${parsed.spreadsheetId}/values/${encodeURIComponent(range)}?valueInputOption=RAW`, {
        method: "PUT", headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ values: [out] }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new SheetsError(r.status, d.error?.message || `HTTP ${r.status}`);
      return { ok: true, row: nextRow, tab: tab.title };
    });
  } catch (e) {
    return { ok: false, error: friendlyError(e) };
  }
}
