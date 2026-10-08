// Shared Postgres access for back-channel scripts (2026-10-08). The live
// contacts store is the Postgres `contacts` table -- crm_contacts.json is
// no longer read by the app, so a script that still rewrites that file
// changes nothing anyone sees. Every write here goes to Postgres and then
// NOTIFYs the app's `contacts_changed` channel, which is how each of the
// server's threads refreshes exactly the touched rows in its own cache
// (see contacts_db.js). The contact shape (rowToContact/contactToParams)
// is imported from the app itself so this can never drift from it.
//
//   const { loadAllContactsPg, patchContactsPg } = await import(...contacts_pg.mjs);
//   const contacts = await loadAllContactsPg();            // plain objects, app shape
//   await patchContactsPg([{ id, customFields: { [fieldId]: "2026-10-01" }, set: { updated_at: now } }]);
//
// patchContactsPg merges into custom_fields / extra with jsonb `||` and
// sets only the named columns, so a concurrent edit the app makes to some
// OTHER field of the same contact is never clobbered by a stale snapshot.
// upsertContactsPg writes the full row and is only for scripts that own
// the entire record (imports).
import path from "path";
import { pathToFileURL } from "url";

const APP_DIR = process.env.APP_DIR || "/app";
const app = await import(pathToFileURL(path.join(APP_DIR, "contacts_db.js")).href);
const { contactsPool: pool, rowToContact, contactToParams, CONTACT_COLUMNS, CONTACTS_CHANGED_CHANNEL } = app;
const ORIGIN = `backchannel:${process.pid}`;
const NOTIFY_IDS_PER_CHUNK = 150;

export async function loadAllContactsPg() {
  const r = await pool.query("SELECT * FROM contacts");
  return r.rows.map(rowToContact);
}

async function notifyIds(client, ids) {
  for (let i = 0; i < ids.length; i += NOTIFY_IDS_PER_CHUNK) {
    await client.query("SELECT pg_notify($1, $2)", [CONTACTS_CHANGED_CHANNEL, JSON.stringify({ o: ORIGIN, ids: ids.slice(i, i + NOTIFY_IDS_PER_CHUNK) })]);
  }
}

const PATCHABLE_COLUMNS = new Set(CONTACT_COLUMNS.filter(c => !["id", "custom_fields", "extra", "external_ids"].includes(c)));
// patches: [{ id, customFields?: {...merge}, extra?: {...merge}, externalIds?: {...merge}, set?: { column: value } }]
// Returns the fresh rows (app shape) after the update, for any follow-up
// sync the script does (e.g. sqlite_inbox.js's syncContactFields).
export async function patchContactsPg(patches) {
  if (!patches.length) return [];
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const p of patches) {
      const sets = [], vals = [p.id];
      const add = (sql, v) => { vals.push(v); sets.push(sql.replace("?", `$${vals.length}`)); };
      if (p.customFields) add("custom_fields = COALESCE(custom_fields, '{}'::jsonb) || ?::jsonb", JSON.stringify(p.customFields));
      if (p.extra) add("extra = COALESCE(extra, '{}'::jsonb) || ?::jsonb", JSON.stringify(p.extra));
      if (p.externalIds) add("external_ids = COALESCE(external_ids, '{}'::jsonb) || ?::jsonb", JSON.stringify(p.externalIds));
      for (const [col, v] of Object.entries(p.set || {})) {
        if (!PATCHABLE_COLUMNS.has(col)) throw new Error(`patchContactsPg: not a patchable column: ${col}`);
        add(`${col} = ?`, v);
      }
      if (!sets.length) continue;
      await client.query(`UPDATE contacts SET ${sets.join(", ")} WHERE id = $1`, vals);
    }
    const ids = patches.map(p => p.id);
    await notifyIds(client, ids);
    await client.query("COMMIT");
    const r = await pool.query("SELECT * FROM contacts WHERE id = ANY($1)", [ids]);
    return r.rows.map(rowToContact);
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch { /* connection gone */ }
    throw e;
  } finally { client.release(); }
}

// Full-row upsert, chunked. Only for scripts that own the whole record.
export async function upsertContactsPg(contacts) {
  if (!contacts.length) return 0;
  const JSONB = new Set(["external_ids", "custom_fields", "extra"]);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (let i = 0; i < contacts.length; i += 500) {
      const chunk = contacts.slice(i, i + 500);
      const rows = [], params = [];
      chunk.forEach((c, r) => {
        const p = contactToParams(c);
        rows.push("(" + CONTACT_COLUMNS.map((col, k) => { params.push(p[col]); return `$${r * CONTACT_COLUMNS.length + k + 1}${JSONB.has(col) ? "::jsonb" : ""}`; }).join(",") + ")");
      });
      const updates = CONTACT_COLUMNS.filter(c => c !== "id").map(c => `${c}=excluded.${c}`).join(", ");
      await client.query(`INSERT INTO contacts (${CONTACT_COLUMNS.join(", ")}) VALUES ${rows.join(",")} ON CONFLICT (id) DO UPDATE SET ${updates}`, params);
    }
    await notifyIds(client, contacts.map(c => c.id));
    await client.query("COMMIT");
    return contacts.length;
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch { /* connection gone */ }
    throw e;
  } finally { client.release(); }
}

export async function closeContactsPg() { await pool.end(); }
