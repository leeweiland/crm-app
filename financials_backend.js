// Financials: real cash from the payment processors, for Reporting's True
// ROAS. PayPal (Transaction Search API) and Wise (balance statements) sync on
// a timer with read-only credentials saved in Settings -> Financials; Kurv and
// SwipeSimple have no merchant API, so their transaction exports live in
// Google Sheets (one tab per source, set up in the same settings) that the
// same timer reads. Every row lands in Postgres (financials_db.js) and is
// matched to a contact by payer email, then by exact full name.
import { createHash, randomUUID } from "crypto";
import { readJson, writeJson, readJsonBody, sendJson, getSessionUser, isAdmin } from "./auth_backend.js";
import { INTEGRATIONS_FILE } from "./integrations_backend.js";
import { anchorageMidnightUTC, googleCreds } from "./ads_backend.js";
import * as fdb from "./financials_db.js";

const DAY = 86400000;
const PAYPAL_API = "https://api-m.paypal.com";
const WISE_API = "https://api.wise.com";
// Payments from these names/addresses are money moving between our own
// accounts (PayPal -> PayPal, a wire into Wise), not sales.
const DEFAULT_OWN_NAMES = ["pacific rim athletics", "weiland"];

function readAll() { return readJson(INTEGRATIONS_FILE, {}); }
export function getFinancialsSettings() {
  const f = readAll().financials || {};
  return {
    paypal: Array.isArray(f.paypal) ? f.paypal : [],
    wise: Array.isArray(f.wise) ? f.wise : [],
    sheets: Array.isArray(f.sheets) ? f.sheets : [],
    ownNames: Array.isArray(f.ownNames) ? f.ownNames : DEFAULT_OWN_NAMES,
  };
}
function isOwn(settings, name, email) {
  const hay = `${name || ""} ${email || ""}`.toLowerCase();
  return settings.ownNames.some(n => n && hay.includes(String(n).toLowerCase()));
}

// ── Dates ──────────────────────────────────────────────────────────────
// A wall-clock time in Anchorage -> UTC ms (CSV exports carry no zone).
function anchorageToUtc(y, mo, d, h = 0, mi = 0, s = 0) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Anchorage", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(guess)).map(p => [p.type, p.value]));
  const asLocal = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return guess - (asLocal - guess);
}
export function rangeMs(start, end) {
  const today = new Date().toISOString().slice(0, 10);
  const s = /^\d{4}-\d\d-\d\d$/.test(start || "") ? start : today.slice(0, 8) + "01";
  const e = /^\d{4}-\d\d-\d\d$/.test(end || "") ? end : today;
  return { startMs: anchorageMidnightUTC(s).getTime(), endMs: anchorageMidnightUTC(e).getTime() + DAY - 1, start: s, end: e };
}
const isoNoMs = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

// ── Currency ───────────────────────────────────────────────────────────
// Foreign-currency payments get a USD value from Wise's own historical rate
// for that day (any Wise token can read rates). No Wise token -> left
// uncounted and listed as such on the Financials page.
const rateCache = new Map();
async function usdRate(currency, atMs) {
  if (currency === "USD") return 1;
  const wise = getFinancialsSettings().wise.find(w => w.token);
  if (!wise) return null;
  const day = new Date(atMs).toISOString().slice(0, 10);
  const key = `${currency}:${day}`;
  if (rateCache.has(key)) return rateCache.get(key);
  const r = await fetch(`${WISE_API}/v1/rates?source=${encodeURIComponent(currency)}&target=USD&time=${day}T12:00:00Z`, { headers: { Authorization: `Bearer ${wise.token}` } });
  const j = r.ok ? await r.json().catch(() => null) : null;
  const rate = Array.isArray(j) && j[0]?.rate ? Number(j[0].rate) : null;
  if (rate) rateCache.set(key, rate);
  return rate;
}
async function withUsd(rows) {
  for (const r of rows) {
    if (r.currency === "USD") r.amountUsd = r.amount;
    else if (fdb.REVENUE_KINDS.includes(r.kind)) {
      const rate = await usdRate(r.currency, Date.parse(r.occurredAt)).catch(() => null);
      r.amountUsd = rate ? Math.round(r.amount * rate * 100) / 100 : null;
    }
  }
  return rows;
}

// ── PayPal ─────────────────────────────────────────────────────────────
async function paypalToken(acct) {
  const r = await fetch(`${PAYPAL_API}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: "Basic " + Buffer.from(`${acct.clientId}:${acct.clientSecret}`).toString("base64"), "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  const j = await r.json().catch(() => ({}));
  if (!j.access_token) throw new Error(`PayPal sign-in failed: ${j.error_description || j.error || r.status}`);
  return j.access_token;
}
// PayPal event codes: T00xx payments (except T0001 mass-pay receipts and
// T0014 rebates), T1106/T1107 refunds we issued, T12xx chargebacks and their
// reversals, T03xx/T04xx bank deposits & withdrawals, T02xx conversions.
// Every other T11xx/T15xx/T21xx is a hold or a hold's release, and a positive
// T1107 is a merchant refunding us. Working Capital loan money arrives as an
// ordinary T0000 payment from WebBank, so it's caught by name.
const LOAN_PAYER = /web ?bank|working capital|loanbuilder|business loan/i;
function paypalKind(code, amount, payerName) {
  const c = String(code || "");
  if (LOAN_PAYER.test(payerName || "")) return amount > 0 ? "loan" : "sent";
  if (c === "T0001" || c === "T0014") return "other";
  if (c.startsWith("T00")) return amount > 0 ? "payment" : "sent";
  if (c === "T1106" || c === "T1107") return amount < 0 ? "refund" : "other";
  if (c.startsWith("T12")) return "chargeback";
  if (c.startsWith("T03") || c.startsWith("T04")) return "transfer";
  if (c.startsWith("T02")) return "conversion";
  if (c.startsWith("T07")) return "card";
  return "other";
}
function paypalRow(acct, settings, d) {
  const t = d.transaction_info || {}, p = d.payer_info || {};
  const amount = Number(t.transaction_amount?.value || 0);
  const name = p.payer_name?.alternate_full_name || [p.payer_name?.given_name, p.payer_name?.surname].filter(Boolean).join(" ") || null;
  let kind = paypalKind(t.transaction_event_code, amount, name);
  if (kind === "payment" && isOwn(settings, name, p.email_address)) kind = "transfer";
  const items = (d.cart_info?.item_details || []).map(i => i.item_name).filter(Boolean).join(", ");
  return {
    id: `paypal:${acct.id}:${t.transaction_id}`, provider: "paypal", account: acct.label || "PayPal", txnId: t.transaction_id,
    occurredAt: t.transaction_initiation_date, amount, fee: t.fee_amount ? Number(t.fee_amount.value) : null,
    currency: t.transaction_amount?.currency_code || "USD", kind, status: t.transaction_status || null,
    payerEmail: p.email_address || null, payerName: name,
    description: t.transaction_subject || items || t.transaction_note || null,
    raw: { code: t.transaction_event_code, invoice: t.invoice_id || null, payerId: p.account_id || null },
  };
}
async function syncPaypal(acct, settings, state) {
  const key = `paypal:${acct.id}`;
  const token = await paypalToken(acct);
  const now = Date.now();
  // First sync: PayPal keeps 3 years. Later: re-read the last 3 days too
  // (PayPal can take up to ~3 hours to list a payment, and statuses change).
  let from = state?.synced_through ? new Date(state.synced_through).getTime() - 3 * DAY : now - 3 * 365 * DAY + DAY;
  let total = 0;
  while (from < now) {
    const to = Math.min(from + 31 * DAY - 1000, now);
    for (let page = 1, pages = 1; page <= pages; page++) {
      const qs = new URLSearchParams({ start_date: isoNoMs(from), end_date: isoNoMs(to), fields: "transaction_info,payer_info,cart_info", page_size: "500", page: String(page) });
      const r = await fetch(`${PAYPAL_API}/v1/reporting/transactions?${qs}`, { headers: { Authorization: `Bearer ${token}` } });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        const msg = j.message || j.name || `HTTP ${r.status}`;
        throw new Error(r.status === 403 ? `PayPal says this app isn't allowed Transaction Search yet (${msg}) -- it can take a few hours after turning it on` : `PayPal: ${msg}`);
      }
      pages = j.total_pages || 1;
      const rows = (j.transaction_details || []).map(d => paypalRow(acct, settings, d)).filter(r => r.txnId && r.occurredAt);
      total += await fdb.upsertPayments(await withUsd(rows));
    }
    await fdb.setSourceState(key, { syncedThrough: new Date(to).toISOString(), count: total });
    from = to + 1000;
  }
  return total;
}

// ── Wise ───────────────────────────────────────────────────────────────
async function wiseGet(acct, path) {
  const r = await fetch(`${WISE_API}${path}`, { headers: { Authorization: `Bearer ${acct.token}` } });
  if (r.status === 403 && r.headers.get("x-2fa-approval")) throw new Error("Wise wants its extra security step (SCA) for statements on this account -- tell Claude to set up the signing key");
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`Wise: ${j?.errors?.[0]?.message || j?.error_description || j?.error || `HTTP ${r.status}`}`);
  return j;
}
function wiseKind(t) {
  const type = t.details?.type;
  if (type === "CONVERSION") return "conversion";
  if (type === "MONEY_ADDED" || type === "ACCRUAL_CHARGE") return "transfer";
  if (type === "CARD") return t.type === "CREDIT" ? "other" : "card"; // money back to our own card isn't a customer refund
  if (t.type === "CREDIT" && (type === "DEPOSIT" || type === "TRANSFER" || type === "ACQUIRING_PAYMENT")) return "payment";
  if (t.type === "DEBIT") return "sent";
  return "other";
}
async function syncWise(acct, settings, state) {
  const key = `wise:${acct.id}`;
  const profiles = await wiseGet(acct, "/v2/profiles");
  const now = Date.now();
  let from = state?.synced_through ? new Date(state.synced_through).getTime() - 3 * DAY : now - 3 * 365 * DAY;
  let total = 0;
  for (const prof of profiles || []) {
    const balances = await wiseGet(acct, `/v4/profiles/${prof.id}/balances?types=STANDARD`);
    for (const bal of balances || []) {
      for (let f = from; f < now; f += 360 * DAY) {
        const to = Math.min(f + 360 * DAY, now);
        const qs = new URLSearchParams({ currency: bal.currency, intervalStart: new Date(f).toISOString(), intervalEnd: new Date(to).toISOString(), type: "COMPACT" });
        const st = await wiseGet(acct, `/v1/profiles/${prof.id}/balance-statements/${bal.id}/statement.json?${qs}`);
        const rows = (st?.transactions || []).map(t => {
          let kind = wiseKind(t);
          // A card payment taken through Wise names the payer only in its description.
          const name = t.details?.senderName || t.details?.recipient?.name
            || (/^Received payment from (.+?)(?: -- |$)/.exec(t.details?.description || "") || [])[1] || null;
          if (kind === "payment" && isOwn(settings, name, null)) kind = "transfer";
          return {
            id: `wise:${acct.id}:${t.referenceNumber}:${bal.currency}`, provider: "wise", account: acct.label || prof.fullName || "Wise",
            txnId: `${t.referenceNumber}:${bal.currency}`, occurredAt: t.date, amount: Number(t.amount?.value || 0),
            fee: t.totalFees?.value != null ? Number(t.totalFees.value) : null, currency: t.amount?.currency || bal.currency, kind,
            status: "S", payerEmail: null, payerName: name,
            description: [t.details?.description, t.details?.paymentReference].filter(Boolean).join(" -- ") || null,
            raw: { type: t.type, detailsType: t.details?.type || null, profile: prof.id },
          };
        }).filter(r => r.txnId && r.occurredAt);
        total += await fdb.upsertPayments(await withUsd(rows));
      }
    }
  }
  await fdb.setSourceState(key, { syncedThrough: new Date(now).toISOString(), count: total });
  return total;
}

// ── Sync orchestration ─────────────────────────────────────────────────
let _syncing = null;
export function financialsSyncRunning() { return !!_syncing; }
export function syncAllFinancials() {
  if (_syncing) return _syncing;
  _syncing = (async () => {
    const settings = getFinancialsSettings();
    const states = new Map((await fdb.getSourceStates()).map(s => [s.key, s]));
    const out = {};
    for (const [kind, fn, list] of [["paypal", syncPaypal, settings.paypal], ["wise", syncWise, settings.wise]]) {
      for (const acct of list) {
        if (kind === "paypal" ? !(acct.clientId && acct.clientSecret) : !acct.token) continue;
        const key = `${kind}:${acct.id}`;
        try { out[key] = { ok: true, count: await fn(acct, settings, states.get(key)) }; }
        catch (e) {
          out[key] = { ok: false, error: e.message };
          await fdb.setSourceState(key, { error: e.message }).catch(() => {});
          console.error(`[financials] ${key} sync failed:`, e.message);
        }
      }
    }
    for (const src of settings.sheets) {
      if (!src.sheetId) continue;
      const key = `sheet:${src.id}`;
      try { out[key] = { ok: true, ...(await syncSheet(src)) }; }
      catch (e) {
        out[key] = { ok: false, error: e.message };
        await fdb.setSourceState(key, { error: e.message }).catch(() => {});
        console.error(`[financials] ${key} sync failed:`, e.message);
      }
    }
    // Foreign-currency rows saved before a rate was available.
    for (const r of await fdb.paymentsMissingUsd()) {
      const rate = await usdRate(r.currency, new Date(r.occurred_at).getTime()).catch(() => null);
      if (rate) await fdb.setAmountUsd(r.id, Math.round(r.amount * rate * 100) / 100);
    }
    out.matched = await fdb.matchUnmatchedPayments();
    return out;
  })().finally(() => { _syncing = null; });
  return _syncing;
}
export function startFinancialsSyncTimer() {
  if (!fdb.financialsDbAvailable()) return;
  const run = () => syncAllFinancials().catch(e => console.error("[financials] sync failed:", e.message));
  setTimeout(run, 3 * 60 * 1000).unref?.();
  setInterval(run, 3 * 60 * 60 * 1000).unref?.();
}

// ── Google Sheets sources (Kurv, SwipeSimple, anything with an export) ─
// Same Google login as the Ads Tracking Sheet (googleCreds).
export function parseSheetId(v) {
  const t = String(v || "").trim();
  return (/\/d\/([A-Za-z0-9_-]+)/.exec(t) || [])[1] || t;
}
async function sheetsToken() {
  const { clientId, clientSecret, refreshToken } = googleCreds();
  if (!(clientId && clientSecret && refreshToken)) throw new Error("Google Sheets isn't connected (Settings -> Tracking -> Ads Tracking Sheet)");
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: "refresh_token" }),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error("Google token refresh failed");
  return j.access_token;
}
export async function sheetTabs(sheetId) {
  const token = await sheetsToken();
  const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${parseSheetId(sheetId)}?fields=properties.title,sheets.properties.title`, { headers: { Authorization: `Bearer ${token}` } });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error?.message || "Could not open that spreadsheet");
  return { title: j.properties?.title || "", tabs: (j.sheets || []).map(x => x.properties.title) };
}
async function readSheetGrid(sheetId, tab) {
  const token = await sheetsToken();
  const range = encodeURIComponent(`'${String(tab || "Sheet1").replace(/'/g, "''")}'`);
  const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${parseSheetId(sheetId)}/values/${range}?valueRenderOption=FORMATTED_VALUE`, { headers: { Authorization: `Bearer ${token}` } });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error?.message || "Could not read that tab");
  return (j.values || []).map(row => row.map(v => String(v ?? ""))).filter(row => row.some(v => v.trim() !== ""));
}
// One sheet source -> its payments. The sheet is the source of truth: rows
// deleted from it are deleted here too on the next sync.
async function syncSheet(src) {
  const key = `sheet:${src.id}`;
  if (!src.tab) throw new Error("Pick the tab in Settings -> Financials");
  const grid = await readSheetGrid(src.sheetId, src.tab);
  const parsed = gridToPayments({ grid, src });
  await fdb.upsertPayments(await withUsd(parsed.rows));
  const removed = await fdb.deleteMissing(`${key}:`, parsed.rows.map(r => r.id));
  const error = parsed.rows.length || grid.length < 2 ? null : "No rows had a readable date and amount -- check the column mapping";
  await fdb.setSourceState(key, { syncedThrough: new Date().toISOString(), count: parsed.rows.length, error });
  return { count: parsed.rows.length, skipped: parsed.skipped.length, removed };
}

const CSV_FIELDS = ["date", "time", "amount", "id", "email", "name", "status", "type", "description", "currency"];
const CSV_GUESS = {
  date: [/^(transaction )?date( ?\/ ?time)?$/i, /date/i, /created/i, /time/i],
  time: [/^time$/i],
  amount: [/^(sale |transaction |gross |total )?amount$/i, /^total$/i, /^gross$/i, /amount/i, /total/i],
  id: [/^transaction id$/i, /transaction.?id/i, /^id$/i, /reference/i, /txn/i, /order/i],
  email: [/e-?mail/i],
  name: [/^customer( name)?$/i, /card ?holder/i, /customer/i, /^name$/i, /payer/i, /name/i],
  status: [/status/i, /result/i],
  type: [/^(transaction )?type$/i, /type/i],
  description: [/description/i, /memo/i, /note/i, /item/i, /product/i],
  currency: [/currency/i],
};
function guessMapping(headers) {
  const used = new Set(), out = {};
  for (const f of CSV_FIELDS) {
    for (const re of CSV_GUESS[f]) {
      const i = headers.findIndex((h, idx) => !used.has(idx) && re.test(h.trim()));
      if (i >= 0) { out[f] = headers[i]; used.add(i); break; }
    }
  }
  if (out.time && out.time === out.date) delete out.time;
  return out;
}
function parseCsvDate(dateStr, timeStr) {
  const s = `${String(dateStr || "").trim()} ${String(timeStr || "").trim()}`.trim();
  if (!s) return null;
  if (/[zZ]$|[+-]\d\d:?\d\d$/.test(s) && !Number.isNaN(Date.parse(s))) return new Date(Date.parse(s)).toISOString();
  let y, mo, d, rest;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(.*)$/.exec(s);
  if (m) { [, y, mo, d, rest] = m; }
  else if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})(.*)$/.exec(s))) { [, mo, d, y, rest] = m; if (y.length === 2) y = "20" + y; }
  else { const t = Date.parse(s); return Number.isNaN(t) ? null : new Date(t).toISOString(); }
  let h = 0, mi = 0, sec = 0;
  const tm = /(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap]\.?m\.?)?/i.exec(rest || "");
  if (tm) {
    h = +tm[1]; mi = +tm[2]; sec = +(tm[3] || 0);
    if (tm[4]) { const pm = /^p/i.test(tm[4]); if (pm && h < 12) h += 12; if (!pm && h === 12) h = 0; }
  }
  return new Date(anchorageToUtc(+y, +mo, +d, h, mi, sec)).toISOString();
}
function parseMoney(v) {
  const s = String(v ?? "").trim();
  if (!s) return NaN;
  const neg = /^\(.*\)$/.test(s) || /^-/.test(s.replace(/[$\s]/g, ""));
  const n = Number(s.replace(/[^0-9.]/g, ""));
  return neg ? -n : n;
}
export function gridToPayments({ grid, src }) {
  if (grid.length < 2) return { headers: grid[0] || [], mapping: {}, rows: [], skipped: [] };
  const headers = grid[0].map(h => h.trim());
  const map = src.mapping && Object.values(src.mapping).some(Boolean) ? src.mapping : guessMapping(headers);
  const col = (row, f) => { const i = map[f] ? headers.indexOf(map[f]) : -1; return i >= 0 ? (row[i] ?? "").trim() : ""; };
  const provider = src.provider || "other";
  const settings = getFinancialsSettings();
  const rows = [], skipped = [], seen = new Map();
  for (const [n, r] of grid.slice(1).entries()) {
    const occurredAt = parseCsvDate(col(r, "date"), col(r, "time"));
    let amount = parseMoney(col(r, "amount"));
    const status = col(r, "status"), type = col(r, "type");
    if (!occurredAt || !Number.isFinite(amount)) { skipped.push({ line: n + 2, reason: "no date or amount" }); continue; }
    const flags = `${status} ${type}`;
    if (/declin|fail|void|error|cancel|reject|incomplete/i.test(flags)) { skipped.push({ line: n + 2, reason: status || type }); continue; }
    let kind = "payment";
    if (/chargeback|dispute/i.test(flags)) { kind = "chargeback"; amount = -Math.abs(amount); }
    else if (/refund|return|reversal/i.test(flags) || amount < 0) { kind = "refund"; amount = -Math.abs(amount); }
    const name = col(r, "name") || null, email = col(r, "email") || null;
    if (kind === "payment" && isOwn(settings, name, email)) kind = "transfer";
    let txnId = col(r, "id");
    if (!txnId) {
      // No id column: same date/amount/payer twice stays two rows, and re-reading the sheet is a no-op.
      const base = createHash("sha1").update([occurredAt, amount, name, email].join("|")).digest("hex").slice(0, 16);
      const k = seen.get(base) || 0; seen.set(base, k + 1);
      txnId = `h${base}${k ? "-" + k : ""}`;
    }
    rows.push({
      id: `sheet:${src.id}:${txnId}`, provider, account: src.label || provider, txnId, occurredAt, amount,
      fee: null, currency: (col(r, "currency") || "USD").toUpperCase().slice(0, 3), kind, status: status || "S",
      payerEmail: email, payerName: name, description: col(r, "description") || type || null, raw: { line: n + 2 },
    });
  }
  return { headers, mapping: map, rows, skipped };
}

// ── Routes ─────────────────────────────────────────────────────────────
function maskedSettings() {
  const s = getFinancialsSettings();
  return {
    paypal: s.paypal.map(a => ({ id: a.id, label: a.label || "", clientId: a.clientId || "", secretSet: !!a.clientSecret })),
    wise: s.wise.map(a => ({ id: a.id, label: a.label || "", tokenSet: !!a.token })),
    sheets: s.sheets,
    ownNames: s.ownNames,
  };
}
export async function handleFinancialsRequest(req, res, url) {
  const p = url.pathname;
  if (!p.startsWith("/api/financials")) return false;
  const me = getSessionUser(req);
  if (!me) return sendJson(res, 401, { error: "Not logged in" });
  if (!isAdmin(me)) return sendJson(res, 403, { error: "Admins only" });
  if (!fdb.financialsDbAvailable()) return sendJson(res, 503, { error: "No database configured" });

  try {
    if (p === "/api/financials/settings" && req.method === "GET") {
      const states = await fdb.getSourceStates();
      return sendJson(res, 200, { ...maskedSettings(), states, syncing: financialsSyncRunning() });
    }
    if (p === "/api/financials/settings" && req.method === "POST") {
      const body = await readJsonBody(req);
      const all = readAll();
      const cur = getFinancialsSettings();
      const next = { ...cur };
      // Blank secret = keep the saved one (secrets are never sent back to the page).
      if (Array.isArray(body.paypal)) {
        next.paypal = body.paypal.filter(a => a && (a.clientId || a.id)).map(a => {
          const old = cur.paypal.find(o => o.id === a.id);
          return { id: old?.id || randomUUID(), label: String(a.label || "").trim(), clientId: String(a.clientId || "").trim(), clientSecret: String(a.clientSecret || "").trim() || old?.clientSecret || "" };
        });
      }
      if (Array.isArray(body.wise)) {
        next.wise = body.wise.filter(a => a && (a.token || a.id)).map(a => {
          const old = cur.wise.find(o => o.id === a.id);
          return { id: old?.id || randomUUID(), label: String(a.label || "").trim(), token: String(a.token || "").trim() || old?.token || "" };
        });
      }
      if (Array.isArray(body.sheets)) {
        const PROVIDERS = ["kurv", "swipesimple", "paypal", "wise", "other"];
        next.sheets = body.sheets.filter(a => a && a.sheetId).map(a => ({
          id: cur.sheets.find(o => o.id === a.id)?.id || randomUUID(),
          label: String(a.label || "").trim(), provider: PROVIDERS.includes(a.provider) ? a.provider : "other",
          sheetId: parseSheetId(a.sheetId), tab: String(a.tab || "").trim(),
          mapping: Object.fromEntries(CSV_FIELDS.map(f => [f, String(a.mapping?.[f] || "").trim()]).filter(([, v]) => v)),
        }));
        // A removed sheet's payments go with it.
        for (const old of cur.sheets) {
          if (next.sheets.some(n => n.id === old.id)) continue;
          await fdb.deleteMissing(`sheet:${old.id}:`, []);
          await fdb.resetSourceState(`sheet:${old.id}`);
        }
      }
      if (Array.isArray(body.ownNames)) next.ownNames = body.ownNames.map(s => String(s).trim()).filter(Boolean);
      all.financials = next;
      writeJson(INTEGRATIONS_FILE, all);
      // A newly connected account starts syncing right away.
      syncAllFinancials().catch(e => console.error("[financials] sync failed:", e.message));
      return sendJson(res, 200, { ok: true, ...maskedSettings() });
    }
    if (p === "/api/financials/sync" && req.method === "POST") {
      syncAllFinancials().catch(e => console.error("[financials] sync failed:", e.message));
      return sendJson(res, 200, { ok: true, started: true });
    }
    if (p === "/api/financials/summary" && req.method === "GET") {
      const { startMs, endMs, start, end } = rangeMs(url.searchParams.get("start"), url.searchParams.get("end"));
      return sendJson(res, 200, { start, end, ...(await fdb.financialsSummary(startMs, endMs)) });
    }
    if (p === "/api/financials/payments" && req.method === "GET") {
      const sp = url.searchParams;
      const { startMs, endMs } = rangeMs(sp.get("start"), sp.get("end"));
      return sendJson(res, 200, await fdb.listPayments({
        startMs, endMs, provider: sp.get("provider") || null, kind: sp.get("kind") || null, unmatched: sp.get("unmatched") === "1",
        search: sp.get("q") || null, limit: sp.get("limit"), offset: sp.get("offset"),
      }));
    }
    const m = p.match(/^\/api\/financials\/payments\/(.+)$/);
    if (m && req.method === "PATCH") {
      const body = await readJsonBody(req);
      await fdb.setPaymentFields(decodeURIComponent(m[1]), { excluded: body.excluded, contactId: body.contactId });
      return sendJson(res, 200, { ok: true });
    }
    if (p === "/api/financials/sheet-tabs" && req.method === "GET") {
      return sendJson(res, 200, await sheetTabs(url.searchParams.get("sheetId")));
    }
    // What a sheet source would import, before saving it: headers, the column
    // mapping (guessed unless given), totals and the first rows.
    if (p === "/api/financials/sheet-preview" && req.method === "POST") {
      const body = await readJsonBody(req);
      const grid = await readSheetGrid(body.sheetId, body.tab);
      const parsed = gridToPayments({ grid, src: { id: "preview", label: body.label, provider: body.provider, mapping: body.mapping } });
      const revenue = parsed.rows.filter(r => fdb.REVENUE_KINDS.includes(r.kind)).reduce((t, r) => t + r.amount, 0);
      return sendJson(res, 200, {
        headers: parsed.headers, mapping: parsed.mapping, fields: CSV_FIELDS, count: parsed.rows.length, skipped: parsed.skipped.length,
        skippedSample: parsed.skipped.slice(0, 8), revenue: Math.round(revenue * 100) / 100, preview: parsed.rows.slice(0, 8),
      });
    }
  } catch (e) {
    console.error("[financials]", p, e);
    return sendJson(res, 500, { error: e.message });
  }
  return false;
}
