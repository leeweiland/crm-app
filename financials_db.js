// Payments pulled from the payment processors (PayPal, Wise) or read from
// Google Sheets of their exports (Kurv, SwipeSimple) -- the real cash behind
// Reporting's "True ROAS". One `payments` table in the same Postgres as
// contacts/messages; every query here is async on its own small pool (the
// table is thousands of rows, not millions, and nothing here sits on a
// synchronous request path).
import pg from "pg";

let _pool = null;
function pool() {
  if (!_pool) {
    _pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2, options: "-c statement_timeout=60000" });
    _pool.on("error", (e) => console.error("[financials_db] pool error:", e.message));
  }
  return _pool;
}
export const financialsDbAvailable = () => !!process.env.DATABASE_URL;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS payments (
  id           text PRIMARY KEY,            -- provider:account:txn_id
  provider     text NOT NULL,               -- paypal | wise | kurv | swipesimple | other
  account      text,                        -- which connected account / CSV label
  txn_id       text NOT NULL,
  occurred_at  timestamptz NOT NULL,
  amount       numeric(14,2) NOT NULL,      -- signed, in currency
  amount_usd   numeric(14,2),               -- signed; null = couldn't convert (not counted)
  fee          numeric(14,2),
  currency     text NOT NULL,
  kind         text NOT NULL,               -- payment | refund | chargeback | transfer | loan | sent | conversion | card | other
  status       text,
  payer_email  text,
  payer_name   text,
  description  text,
  contact_id   text,
  match_method text,                        -- email | name | manual
  excluded     boolean NOT NULL DEFAULT false,
  raw          jsonb,
  imported_at  timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS payments_occurred ON payments (occurred_at);
CREATE INDEX IF NOT EXISTS payments_contact ON payments (contact_id) WHERE contact_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS payment_sources (
  key            text PRIMARY KEY,          -- e.g. paypal:<accountId>
  synced_through timestamptz,
  last_sync_at   timestamptz,
  last_error     text,
  last_count     integer
);`;

let _schema = null;
export function ensureFinancialsSchema() {
  if (!_schema) _schema = pool().query(SCHEMA_SQL).catch((e) => { _schema = null; throw e; });
  return _schema;
}
async function q(sql, params) {
  await ensureFinancialsSchema();
  return (await pool().query(sql, params)).rows;
}

// What counts as cash collected: money in from customers, minus refunds and
// chargebacks. Transfers between our own accounts, currency conversions,
// card spending and money we sent are kept for the record but never count.
export const REVENUE_KINDS = ["payment", "refund", "chargeback"];
const REVENUE_WHERE = `NOT p.excluded AND p.kind = ANY('{payment,refund,chargeback}') AND p.amount_usd IS NOT NULL AND coalesce(p.status,'') <> 'D'`;

// Insert or refresh rows from a sync/import. A row's own contact match and
// "excluded" choice survive a re-sync (only provider-side fields refresh).
export async function upsertPayments(rows) {
  if (!rows.length) return 0;
  await ensureFinancialsSchema();
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    for (const r of rows) {
      await client.query(
        `INSERT INTO payments (id, provider, account, txn_id, occurred_at, amount, amount_usd, fee, currency, kind, status, payer_email, payer_name, description, raw)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         ON CONFLICT (id) DO UPDATE SET occurred_at = EXCLUDED.occurred_at, amount = EXCLUDED.amount,
           amount_usd = coalesce(EXCLUDED.amount_usd, payments.amount_usd), fee = EXCLUDED.fee, currency = EXCLUDED.currency,
           kind = EXCLUDED.kind, status = EXCLUDED.status, payer_email = EXCLUDED.payer_email, payer_name = EXCLUDED.payer_name,
           description = EXCLUDED.description, raw = EXCLUDED.raw, updated_at = now()`,
        [r.id, r.provider, r.account || null, r.txnId, r.occurredAt, r.amount, r.amountUsd ?? null, r.fee ?? null, r.currency,
          r.kind, r.status || null, r.payerEmail || null, r.payerName || null, r.description || null, r.raw ? JSON.stringify(r.raw) : null]
      );
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  return rows.length;
}

// Ties unmatched money-in rows to a contact, strongest evidence first:
//  1. email   -- payer email via the contact identity keys (email, alt emails,
//                Hyros origin email; oldest contact wins a tie)
//  2. history -- the same payer email/name already matched on another payment
//  3. name    -- payer name vs contact first+last with accents, case, middle
//                names, "Last, First" and nicknames (Matt/Matthew) handled;
//                a family-name-only or first-initial match needs the contact's
//                own recorded enrollment amount to agree
//  4. sales   -- a CALLS TRACKING enrollment row (salesRecords) with the same
//                amount within days of the payment, whose buyer then resolves
//                to a contact by email, phone or name
// Every step must point at exactly one person: ties between different people
// stay unmatched (several contacts with the same full name are one person
// entered twice -- the ENROLLED, then oldest, one is used).
const normName = (s) => String(s || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z\s'-]/g, " ").replace(/\s+/g, " ").trim();
const tokensOf = (s) => normName(s).split(" ").filter(t => t.length >= 2);
const lastTen = (p) => String(p || "").replace(/\D/g, "").slice(-10);
const DAY_MS = 86400000;

async function contactsByIdentity(keys) {
  const out = new Map();
  for (let i = 0; i < keys.length; i += 500) {
    const hits = await q(`SELECT id, contact_identity_keys(email, phone, extra) AS keys FROM contacts
      WHERE contact_identity_keys(email, phone, extra) && $1::text[] ORDER BY created_at NULLS LAST, id`, [keys.slice(i, i + 500)]);
    for (const h of hits) for (const k of h.keys || []) if (!out.has(k)) out.set(k, h.id);
  }
  return out;
}
// Contacts whose first or last name is one of these tokens (accent-insensitive
// comparison happens in JS; the SQL just narrows the field).
async function nameCandidates(tokens) {
  if (!tokens.length) return [];
  const rows = await q(`SELECT id, first, last, status, created_at, custom_fields->>'enrollAmountPaid' AS paid FROM contacts
    WHERE lower(last) = ANY($1) OR lower(first) = ANY($1)
       OR lower(split_part(last, ' ', -1)) = ANY($1) OR lower(split_part(first, ' ', 1)) = ANY($1)`, [tokens]);
  return rows.map(r => {
    const f = tokensOf(r.first), l = tokensOf(r.last);
    return { ...r, f0: f[0] || "", lN: l[l.length - 1] || "", full: [...f, ...l].join(" "), paidN: Number(String(r.paid || "").replace(/[^0-9.]/g, "")) || null };
  });
}
function scoreName(payTokens, amount, c) {
  if (!c.lN || !c.f0 || c.lN === c.f0) return 0; // "Amy amy" / "lee lee" junk names can't confirm anyone
  const has = (t) => payTokens.includes(t);
  let s = 0;
  if (has(c.lN) && has(c.f0)) s = 100;                                  // first+last, any order, middle names ignored
  else if (has(c.lN) && payTokens.some(t => t !== c.lN && t.length >= 3 && c.f0.length >= 3 && (t.startsWith(c.f0) || c.f0.startsWith(t)))) s = 85; // Matt/Matthew, Kat/Kathleen
  else if (has(c.lN) && payTokens.some(t => t !== c.lN && t[0] === c.f0[0])) s = 50; // initial only
  else if (has(c.lN)) s = 25;                                           // family name only (a spouse or parent paying?)
  else return 0;
  if (c.paidN && amount && Math.abs(c.paidN - Math.abs(amount)) < 1) s += 40; // agrees with the enrollment amount recorded on the contact
  return s;
}
function pickOne(scored, threshold) {
  scored.sort((a, b) => b.s - a.s || (b.c.status === "ENROLLED") - (a.c.status === "ENROLLED") || String(a.c.created_at).localeCompare(String(b.c.created_at)));
  const [best, second] = scored;
  if (!best || best.s < threshold) return null;
  if (second && best.s - second.s < 20 && second.c.full !== best.c.full) return null; // two different people fit about as well
  return best.c.id;
}

export async function matchUnmatchedPayments(salesRecords = [], { dryRun = false } = {}) {
  const rows = await q(`SELECT id, occurred_at, amount_usd::float AS amount, lower(trim(payer_email)) AS email, payer_name AS name
    FROM payments WHERE contact_id IS NULL AND kind = ANY('{payment,refund,chargeback}') AND NOT excluded
      AND coalesce(match_method, '') <> 'unlinked'`);
  if (!rows.length) return 0;
  const found = new Map(); // payment id -> [contactId, method]

  // 1. email
  const byKey = await contactsByIdentity([...new Set(rows.map(r => r.email).filter(Boolean))].map(e => `e:${e}`));
  for (const r of rows) if (r.email && byKey.has(`e:${r.email}`)) found.set(r.id, [byKey.get(`e:${r.email}`), "email"]);

  // 2. history: this payer's other payments, when they all point at one contact
  const prior = await q(`SELECT lower(trim(payer_email)) AS email, payer_name AS name, contact_id FROM payments WHERE contact_id IS NOT NULL`);
  const hist = new Map();
  const note = (k, id) => { if (!k) return; const v = hist.get(k); hist.set(k, v === undefined || v === id ? id : null); };
  for (const p of prior) { note(p.email && "e:" + p.email, p.contact_id); note(normName(p.name).length > 4 && "n:" + normName(p.name), p.contact_id); }
  for (const r of rows) {
    if (found.has(r.id)) continue;
    const id = (r.email && hist.get("e:" + r.email)) || (normName(r.name).length > 4 && hist.get("n:" + normName(r.name)));
    if (id) found.set(r.id, [id, "history"]);
  }

  // 3. name
  const open = rows.filter(r => !found.has(r.id) && r.name);
  const cands = await nameCandidates([...new Set(open.flatMap(r => tokensOf(r.name)).filter(t => t.length >= 3))]);
  for (const r of open) {
    const pt = tokensOf(r.name);
    const scored = cands.map(c => ({ c, s: scoreName(pt, r.amount, c) })).filter(x => x.s > 0);
    const id = pickOne(scored, 85);
    if (id) found.set(r.id, [id, "name"]);
  }

  // 4. sales records (CALLS TRACKING): same amount, within a few days; a payer
  // name has to share the buyer's family name, a nameless payment needs the
  // amount+date to point at a single sale.
  if (salesRecords.length) {
    const sales = salesRecords.filter(x => x.amount && x.dateMs);
    const pending = [];
    for (const r of rows) {
      if (found.has(r.id) || !r.amount) continue;
      const at = new Date(r.occurred_at).getTime(), pt = tokensOf(r.name);
      const scored = [];
      for (const x of sales) {
        const days = Math.abs(at - x.dateMs) / DAY_MS;
        if (days > 7 || Math.abs(x.amount - r.amount) > Math.max(1, r.amount * 0.04)) continue; // allow a card surcharge/fee
        let s = Math.abs(x.amount - r.amount) < 1 ? 50 : 35;
        s += days <= 2 ? 30 : 15;
        const lt = tokensOf(x.last).pop(), ft = tokensOf(x.first)[0];
        if (pt.length) { if (!lt || !pt.includes(lt)) continue; s += ft && pt.includes(ft) ? 40 : 20; }
        scored.push({ c: { id: x, status: "", created_at: "", full: `${normName(x.first)} ${normName(x.last)}|${x.email || ""}` }, s });
      }
      const sale = pickOne(scored, pt.length ? 100 : 80);
      if (sale) pending.push([r.id, sale]);
    }
    if (pending.length) {
      const keys = pending.flatMap(([, x]) => [x.email && `e:${String(x.email).trim().toLowerCase()}`, lastTen(x.phone).length === 10 && `p:${lastTen(x.phone)}`]).filter(Boolean);
      const ids = await contactsByIdentity([...new Set(keys)]);
      const byName = await nameCandidates([...new Set(pending.flatMap(([, x]) => tokensOf(`${x.first} ${x.last}`)).filter(t => t.length >= 3))]);
      for (const [pid, x] of pending) {
        let id = (x.email && ids.get(`e:${String(x.email).trim().toLowerCase()}`)) || (lastTen(x.phone).length === 10 && ids.get(`p:${lastTen(x.phone)}`));
        if (!id) id = pickOne(byName.map(c => ({ c, s: scoreName(tokensOf(`${x.first} ${x.last}`), null, c) })).filter(y => y.s > 0), 100);
        if (id) found.set(pid, [id, "sales record"]);
      }
    }
  }

  if (dryRun) return found;
  for (const [pid, [id, method]] of found) {
    await q(`UPDATE payments SET contact_id = $2, match_method = $3, updated_at = now() WHERE id = $1 AND contact_id IS NULL`, [pid, id, method]);
  }
  return found.size;
}

export async function setPaymentFields(id, { excluded, contactId }) {
  if (excluded !== undefined) await q(`UPDATE payments SET excluded = $2, updated_at = now() WHERE id = $1`, [id, !!excluded]);
  if (contactId !== undefined) {
    await q(`UPDATE payments SET contact_id = $2, match_method = $3, updated_at = now() WHERE id = $1`,
      [id, contactId || null, contactId ? "manual" : "unlinked"]); // "unlinked": someone said this auto-match was wrong -- never re-match it
  }
}

// Cash collected in [startMs, endMs], split by the matched contact's
// program (online / gym / unassigned = no contact or no program).
export async function cashByProgram(startMs, endMs) {
  const rows = await q(`SELECT coalesce(c.program_type, '') AS program, sum(p.amount_usd)::float AS cash, count(*)::int AS n
    FROM payments p LEFT JOIN contacts c ON c.id = p.contact_id
    WHERE ${REVENUE_WHERE} AND p.occurred_at >= to_timestamp($1 / 1000.0) AND p.occurred_at <= to_timestamp($2 / 1000.0)
    GROUP BY 1`, [startMs, endMs]);
  const out = { online: 0, gym: 0, unassigned: 0, total: 0, count: 0 };
  for (const r of rows) {
    const k = r.program === "online" || r.program === "gym" ? r.program : "unassigned";
    out[k] += r.cash || 0; out.total += r.cash || 0; out.count += r.n;
  }
  return out;
}

// contactId -> cash in the range (unmatched rows under null).
export async function cashByContact(startMs, endMs) {
  const rows = await q(`SELECT p.contact_id, sum(p.amount_usd)::float AS cash FROM payments p
    WHERE ${REVENUE_WHERE} AND p.occurred_at >= to_timestamp($1 / 1000.0) AND p.occurred_at <= to_timestamp($2 / 1000.0)
    GROUP BY 1`, [startMs, endMs]);
  return new Map(rows.map(r => [r.contact_id, r.cash || 0]));
}

export async function financialsSummary(startMs, endMs) {
  const range = `p.occurred_at >= to_timestamp($1 / 1000.0) AND p.occurred_at <= to_timestamp($2 / 1000.0)`;
  const [byProvider, byKind, byMonth, program, unconverted] = await Promise.all([
    q(`SELECT p.provider, sum(p.amount_usd)::float AS cash, count(*) FILTER (WHERE p.kind = 'payment')::int AS payments,
         sum(p.amount_usd) FILTER (WHERE p.kind <> 'payment' AND p.amount_usd < 0)::float AS refunds,
         sum(p.amount_usd) FILTER (WHERE p.kind = 'chargeback' AND p.amount_usd > 0)::float AS won,
         count(*) FILTER (WHERE p.contact_id IS NULL)::int AS unmatched
       FROM payments p WHERE ${REVENUE_WHERE} AND ${range} GROUP BY 1 ORDER BY 2 DESC NULLS LAST`, [startMs, endMs]),
    q(`SELECT p.kind, count(*)::int AS n, sum(p.amount_usd)::float AS usd FROM payments p WHERE ${range} GROUP BY 1 ORDER BY 2 DESC`, [startMs, endMs]),
    q(`SELECT to_char(p.occurred_at AT TIME ZONE 'America/Anchorage', 'YYYY-MM') AS month, p.provider, sum(p.amount_usd)::float AS cash
       FROM payments p WHERE ${REVENUE_WHERE} AND ${range} GROUP BY 1, 2 ORDER BY 1`, [startMs, endMs]),
    cashByProgram(startMs, endMs),
    q(`SELECT p.currency, count(*)::int AS n, sum(p.amount)::float AS amount FROM payments p
       WHERE NOT p.excluded AND p.kind = ANY('{payment,refund,chargeback}') AND p.amount_usd IS NULL AND ${range} GROUP BY 1`, [startMs, endMs]),
  ]);
  return { byProvider, byKind, byMonth, program, unconverted };
}

export async function listPayments({ startMs, endMs, provider, kind, unmatched, search, limit = 100, offset = 0 }) {
  const where = [`p.occurred_at >= to_timestamp($1 / 1000.0)`, `p.occurred_at <= to_timestamp($2 / 1000.0)`];
  const params = [startMs, endMs];
  if (provider) { params.push(provider); where.push(`p.provider = $${params.length}`); }
  if (kind === "revenue") where.push(`p.kind = ANY('{payment,refund,chargeback}')`);
  else if (kind) { params.push(kind); where.push(`p.kind = $${params.length}`); }
  if (unmatched) where.push(`p.contact_id IS NULL`);
  if (search) {
    params.push(`%${String(search).toLowerCase()}%`);
    where.push(`(lower(coalesce(p.payer_email,'')) LIKE $${params.length} OR lower(coalesce(p.payer_name,'')) LIKE $${params.length} OR lower(coalesce(p.description,'')) LIKE $${params.length} OR lower(p.txn_id) LIKE $${params.length})`);
  }
  const w = where.join(" AND ");
  const [rows, total] = await Promise.all([
    q(`SELECT p.id, p.provider, p.account, p.txn_id, p.occurred_at, p.amount::float, p.amount_usd::float, p.fee::float, p.currency, p.kind, p.status,
         p.payer_email, p.payer_name, p.description, p.contact_id, p.match_method, p.excluded,
         c.first AS contact_first, c.last AS contact_last, c.program_type AS contact_program
       FROM payments p LEFT JOIN contacts c ON c.id = p.contact_id
       WHERE ${w} ORDER BY p.occurred_at DESC LIMIT ${Math.min(500, Number(limit) || 100)} OFFSET ${Math.max(0, Number(offset) || 0)}`, params),
    q(`SELECT count(*)::int AS n FROM payments p WHERE ${w}`, params),
  ]);
  return { rows, total: total[0]?.n || 0 };
}

export async function getSourceStates() {
  return q(`SELECT key, synced_through, last_sync_at, last_error, last_count FROM payment_sources`);
}
export async function setSourceState(key, fields) {
  await q(`INSERT INTO payment_sources (key, synced_through, last_sync_at, last_error, last_count) VALUES ($1, $2, now(), $3, $4)
    ON CONFLICT (key) DO UPDATE SET synced_through = coalesce(EXCLUDED.synced_through, payment_sources.synced_through),
      last_sync_at = now(), last_error = EXCLUDED.last_error, last_count = EXCLUDED.last_count`,
    [key, fields.syncedThrough || null, fields.error || null, fields.count ?? null]);
}
export async function resetSourceState(key) {
  await q(`DELETE FROM payment_sources WHERE key = $1`, [key]);
}
// Removes this source's rows that are no longer in it (a Google Sheet row deleted).
export async function deleteMissing(idPrefix, keepIds) {
  const rows = await q(`DELETE FROM payments WHERE id LIKE $1 AND NOT (id = ANY($2::text[])) RETURNING id`,
    [idPrefix.replace(/[\\%_]/g, (c) => "\\" + c) + "%", keepIds]);
  return rows.length;
}
// Rows still missing a USD value (a foreign-currency payment from before a rate was available).
export async function paymentsMissingUsd(limit = 500) {
  return q(`SELECT id, currency, occurred_at, amount::float FROM payments WHERE amount_usd IS NULL AND kind = ANY('{payment,refund,chargeback}') LIMIT ${limit}`);
}
export async function setAmountUsd(id, usd) {
  await q(`UPDATE payments SET amount_usd = $2, updated_at = now() WHERE id = $1`, [id, usd]);
}
