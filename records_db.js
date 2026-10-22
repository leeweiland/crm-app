// Postgres home for the JSON "record list" files that every part of the app
// reads and rewrites whole (2026-10-22): page visits, bookings, flow runs.
// With RECORDS_STORE=pg, auth_backend.js's file helpers (readJson,
// writeJson, appendJsonRecordFast, updateJsonArrayRecordsByIds, ...) route
// these files here, so none of the ~40 call sites change.
//
// One `records` table, one row per record, file order kept by seq. A
// rewrite (writeJson) only touches records that actually changed, and only
// deletes records this thread read and then dropped -- a record another
// thread added in between is never lost, unlike rewriting the whole file.
import { sharedSyncQuery } from "./contacts_pg_sync.js";
import { randomUUID } from "crypto";

export const RECORDS_PG = process.env.RECORDS_STORE === "pg";
export const PG_RECORD_FILES = new Map([
  ["crm_page_visits.json", "page_visits"],
  ["crm_bookings.json", "bookings"],
  ["crm_flow_runs.json", "flow_runs"],
]);
export function isPgRecordFile(file) { return RECORDS_PG && PG_RECORD_FILES.has(file); }

export const RECORDS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS records (
  collection text   NOT NULL,
  pk         text   NOT NULL,
  seq        bigserial,
  data       jsonb  NOT NULL,
  PRIMARY KEY (collection, pk)
);
CREATE INDEX IF NOT EXISTS records_seq ON records (collection, seq);
CREATE INDEX IF NOT EXISTS records_id ON records (collection, (data->>'id'));
CREATE INDEX IF NOT EXISTS records_contact ON records (collection, (data->>'contactId'));
CREATE TABLE IF NOT EXISTS records_imported (collection text PRIMARY KEY, at timestamptz NOT NULL DEFAULT now(), count integer);`;

let _q = null;
function q(sql, params) {
  if (!_q) _q = sharedSyncQuery();
  return _q(sql, params);
}
const coll = (file) => PG_RECORD_FILES.get(file);
// Postgres rejects NUL in jsonb; strip it rather than fail the write.
const toJson = (v) => JSON.stringify(v).replace(/\\u0000/g, "");

// Which row each object came from, and what it looked like when read, so a
// later writeJson can tell new / changed / dropped records apart.
const _pkOf = new WeakMap();                 // record object -> pk
const _seen = new Map();                     // collection -> Map(pk -> json as read)

function hydrate(collection, rows) {
  const seen = new Map();
  const out = rows.map((r) => {
    const obj = r.data;
    _pkOf.set(obj, r.pk);
    seen.set(r.pk, JSON.stringify(obj));
    return obj;
  });
  _seen.set(collection, seen);
  return out;
}

export function readAll(file) {
  const c = coll(file);
  return hydrate(c, q(`SELECT pk, data FROM records WHERE collection = $1 ORDER BY seq`, [c]));
}

export function writeAll(file, records) {
  const c = coll(file);
  if (!Array.isArray(records)) throw new Error(`records_db: ${file} must be written as an array`);
  const seen = _seen.get(c);
  const keep = new Set();
  const inserts = [], updates = [];
  for (const obj of records) {
    if (!obj || typeof obj !== "object") continue;
    let pk = _pkOf.get(obj);
    if (pk && keep.has(pk)) pk = null; // same object written twice: second copy is a new record
    if (!pk) { pk = randomUUID(); _pkOf.set(obj, pk); inserts.push([pk, obj]); }
    else {
      const json = JSON.stringify(obj);
      if (!seen || seen.get(pk) !== json) updates.push([pk, obj]);
    }
    keep.add(pk);
  }
  // Dropped = read by this thread and not written back. Never read here at
  // all: the write is a full replace, so everything else goes.
  const dropped = seen
    ? [...seen.keys()].filter(pk => !keep.has(pk))
    : q(`SELECT pk FROM records WHERE collection = $1`, [c]).map(r => r.pk).filter(pk => !keep.has(pk));
  for (let i = 0; i < inserts.length; i += 500) {
    const chunk = inserts.slice(i, i + 500);
    q(`INSERT INTO records (collection, pk, data) SELECT $1, x.pk, x.data::jsonb FROM unnest($2::text[], $3::text[]) WITH ORDINALITY AS x(pk, data, ord) ORDER BY x.ord`,
      [c, chunk.map(([pk]) => pk), chunk.map(([, o]) => toJson(o))]);
  }
  for (let i = 0; i < updates.length; i += 500) {
    const chunk = updates.slice(i, i + 500);
    q(`UPDATE records r SET data = x.data::jsonb FROM unnest($2::text[], $3::text[]) AS x(pk, data) WHERE r.collection = $1 AND r.pk = x.pk`,
      [c, chunk.map(([pk]) => pk), chunk.map(([, o]) => toJson(o))]);
  }
  if (dropped.length) q(`DELETE FROM records WHERE collection = $1 AND pk = ANY($2)`, [c, dropped]);
  const now = new Map();
  for (const obj of records) if (obj && typeof obj === "object") now.set(_pkOf.get(obj), JSON.stringify(obj));
  _seen.set(c, now);
}

export function append(file, recordsToAdd) {
  const c = coll(file);
  const list = recordsToAdd.filter(r => r && typeof r === "object");
  if (!list.length) return;
  const pks = list.map(() => randomUUID());
  q(`INSERT INTO records (collection, pk, data) SELECT $1, x.pk, x.data::jsonb FROM unnest($2::text[], $3::text[]) WITH ORDINALITY AS x(pk, data, ord) ORDER BY x.ord`,
    [c, pks, list.map(toJson)]);
}

function rowsWhere(c, sql, params) {
  return q(`SELECT pk, data FROM records WHERE collection = $1 AND ${sql} ORDER BY seq`, [c, ...params]);
}
function saveRow(c, pk, obj) { q(`UPDATE records SET data = $3::jsonb WHERE collection = $1 AND pk = $2`, [c, pk, toJson(obj)]); }
function deleteRow(c, pk) { q(`DELETE FROM records WHERE collection = $1 AND pk = $2`, [c, pk]); }

// Same contracts as the auth_backend.js helpers of the same names.
// updater(record) -> replacement record (or mutate in place and return
// nothing); in the ById variants, returning null deletes the record.
export function updateFirstByField(file, field, value, updater) {
  const c = coll(file);
  const r = rowsWhere(c, `data->>$2 = $3`, [field, String(value)]).find(row => row.data[field] === value);
  if (!r) return null;
  const found = updater(r.data) || r.data;
  saveRow(c, r.pk, found);
  return found;
}
export function updateAllByField(file, field, value, updater) {
  const c = coll(file);
  let n = 0;
  for (const r of rowsWhere(c, `data->>$2 = $3`, [field, String(value)])) {
    if (r.data[field] !== value) continue;
    saveRow(c, r.pk, updater(r.data) || r.data);
    n++;
  }
  return n;
}
export function updateByIds(file, ids, updater) {
  const c = coll(file);
  const updated = [];
  for (const r of rowsWhere(c, `data->>'id' = ANY($2)`, [[...ids].map(String)])) {
    const result = updater(r.data);
    if (result === null) { deleteRow(c, r.pk); continue; }
    const toWrite = result || r.data;
    saveRow(c, r.pk, toWrite);
    updated.push(toWrite);
  }
  return updated;
}
export function removeValuesFromField(file, fieldName, valuesToRemove) {
  const remove = new Set(valuesToRemove);
  const all = readAll(file);
  let n = 0;
  for (const r of all) {
    if (!Array.isArray(r[fieldName]) || !r[fieldName].some(v => remove.has(v))) continue;
    r[fieldName] = r[fieldName].filter(v => !remove.has(v));
    n++;
  }
  if (n) writeAll(file, all);
  return n;
}

// Every anonymous visit by this visitor now belongs to the contact (form
// submit / booking identified them) -- one UPDATE instead of reading and
// rewriting all page visits.
export function claimVisits(file, visitorId, contactId) {
  return q(
    `UPDATE records SET data = jsonb_set(data, '{contactId}', to_jsonb($3::text))
      WHERE collection = $1 AND data->>'visitorId' = $2 AND coalesce(data->>'contactId', '') = '' RETURNING pk`,
    [coll(file), visitorId, contactId]
  ).length;
}

// First boot with RECORDS_STORE=pg: copy each file in once, in order.
// Runs on the main thread before any worker starts (server.js), and the
// old container is always stopped before the new one boots (volume-backed
// service), so the files are final at this point.
export function importRecordFilesOnce(readFileArray) {
  q(RECORDS_SCHEMA_SQL);
  for (const [file, c] of PG_RECORD_FILES) {
    if (q(`SELECT 1 FROM records_imported WHERE collection = $1`, [c]).length) continue;
    const arr = readFileArray(file);
    q(`DELETE FROM records WHERE collection = $1`, [c]);
    const list = Array.isArray(arr) ? arr.filter(r => r && typeof r === "object") : [];
    for (let i = 0; i < list.length; i += 1000) {
      const chunk = list.slice(i, i + 1000);
      q(`INSERT INTO records (collection, pk, data) SELECT $1, x.pk, x.data::jsonb FROM unnest($2::text[], $3::text[]) WITH ORDINALITY AS x(pk, data, ord) ORDER BY x.ord`,
        [c, chunk.map(() => randomUUID()), chunk.map(toJson)]);
    }
    q(`INSERT INTO records_imported (collection, count) VALUES ($1, $2)`, [c, list.length]);
    console.log(`[records_db] imported ${list.length} records from ${file} into Postgres`);
  }
}
