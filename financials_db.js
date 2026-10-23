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
  kind         text NOT NULL,               -- payment | refund | chargeback | transfer | sent | conversion | card | other
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

// Ties unmatched money-in rows to a contact: payer email first (the same
// identity keys contact matching uses everywhere -- email, alt emails, Hyros
// origin email; oldest contact wins a tie), then an exact full-name match
// when exactly one contact has that name.
export async function matchUnmatchedPayments() {
  const rows = await q(`SELECT id, lower(trim(payer_email)) AS email, lower(regexp_replace(trim(payer_name), '\\s+', ' ', 'g')) AS name
    FROM payments WHERE contact_id IS NULL AND kind = ANY('{payment,refund,chargeback}') AND (payer_email IS NOT NULL OR payer_name IS NOT NULL)`);
  if (!rows.length) return 0;
  let matched = 0;
  const emails = [...new Set(rows.map(r => r.email).filter(Boolean))];
  const byEmail = new Map();
  for (let i = 0; i < emails.length; i += 500) {
    const keys = emails.slice(i, i + 500).map(e => `e:${e}`);
    const hits = await q(`SELECT id, contact_identity_keys(email, phone, extra) AS keys FROM contacts
      WHERE contact_identity_keys(email, phone, extra) && $1::text[] ORDER BY created_at NULLS LAST, id`, [keys]);
    for (const h of hits) for (const k of h.keys || []) if (k.startsWith("e:") && !byEmail.has(k.slice(2))) byEmail.set(k.slice(2), h.id);
  }
  const names = [...new Set(rows.filter(r => !(r.email && byEmail.has(r.email))).map(r => r.name).filter(n => n && n.includes(" ")))];
  const byName = new Map();
  if (names.length) {
    const hits = await q(`SELECT n, min(id) AS id, count(*)::int AS c FROM (
        SELECT id, lower(regexp_replace(trim(coalesce(first,'')) || ' ' || trim(coalesce(last,'')), '\\s+', ' ', 'g')) AS n FROM contacts) x
      WHERE n = ANY($1::text[]) GROUP BY n`, [names]);
    for (const h of hits) if (h.c === 1) byName.set(h.n, h.id);
  }
  for (const r of rows) {
    const viaEmail = r.email && byEmail.get(r.email);
    const id = viaEmail || (r.name && byName.get(r.name));
    if (!id) continue;
    await q(`UPDATE payments SET contact_id = $2, match_method = $3, updated_at = now() WHERE id = $1 AND contact_id IS NULL`, [r.id, id, viaEmail ? "email" : "name"]);
    matched++;
  }
  return matched;
}

export async function setPaymentFields(id, { excluded, contactId }) {
  if (excluded !== undefined) await q(`UPDATE payments SET excluded = $2, updated_at = now() WHERE id = $1`, [id, !!excluded]);
  if (contactId !== undefined) {
    await q(`UPDATE payments SET contact_id = $2, match_method = $3, updated_at = now() WHERE id = $1`,
      [id, contactId || null, contactId ? "manual" : null]);
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
         sum(p.amount_usd) FILTER (WHERE p.kind <> 'payment')::float AS refunds,
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
