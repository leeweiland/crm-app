// Synchronous Postgres queries for worker threads -- the piece that lets a
// worker read contacts straight from Postgres instead of holding its own
// full in-memory copy of all of them (see contacts_db.js "remote mode").
//
// Every contacts_db read is synchronous (~190 call sites depend on that),
// and pg is async-only. So the query runs on a tiny helper thread
// (contacts_pg_sync_helper.js) while the calling thread blocks on
// Atomics.wait, then picks the answer up with receiveMessageOnPort -- the
// same pattern the `synckit` package uses. Blocking is only allowed off
// the main thread in browsers; Node allows it on the main thread too, where
// messages_db.js uses it -- a query blocks that thread for its few
// milliseconds exactly like the synchronous file reads it replaces did.
//
// The helper bumps a shared counter AFTER posting each answer; the caller
// re-checks the port whenever the counter moves, so an answer can't slip
// in between "checked the port" and "started waiting". Answers to an
// earlier query that timed out carry an old id and are dropped.
import { Worker, MessageChannel, receiveMessageOnPort, isMainThread } from "worker_threads";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
// How long one synchronous query may run. Enforced by Postgres itself
// (statement_timeout on the helper's connection), so a slow query is
// CANCELLED, not just abandoned: the helper has one connection, and an
// abandoned query kept it busy -- every later lookup on the thread queued
// behind it (2026-10-22: one slow Inbox query froze the main thread for ~6
// minutes). The main thread serves every page, so its limit is short; the
// report worker (its own process) sets PG_SYNC_TIMEOUT_MS higher.
const QUERY_TIMEOUT_MS = Number(process.env.PG_SYNC_TIMEOUT_MS) || (isMainThread ? 15 * 1000 : 60 * 1000);

// One helper thread (one Postgres connection) per calling thread, shared by
// every module that needs synchronous queries (contacts_db.js remote mode,
// messages_db.js).
let _shared = null;
export function sharedSyncQuery() {
  if (!_shared) _shared = createSyncQuery(process.env.DATABASE_URL);
  return _shared;
}

export function createSyncQuery(connectionString) {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  const { port1, port2 } = new MessageChannel();
  const helper = new Worker(join(__dirname, "contacts_pg_sync_helper.js"), {
    workerData: { port: port2, signal, connectionString, statementTimeoutMs: QUERY_TIMEOUT_MS - 500 },
    transferList: [port2],
  });
  helper.unref(); // never what keeps a thread alive on its own
  let helperDead = null;
  helper.on("error", (e) => { helperDead = e; console.error("[contacts_pg_sync] helper thread error:", e.message); });
  helper.on("exit", (code) => { helperDead = helperDead || new Error(`helper thread exited (${code})`); });
  let nextId = 1;

  return function querySync(sql, params = []) {
    if (helperDead) throw new Error(`contacts_pg_sync: ${helperDead.message}`);
    const id = nextId++;
    port1.postMessage({ id, sql, params });
    const deadline = Date.now() + QUERY_TIMEOUT_MS;
    for (;;) {
      const seen = Atomics.load(signal, 0);
      let msg;
      while ((msg = receiveMessageOnPort(port1))) {
        const m = msg.message;
        if (m.id !== id) continue; // late answer to a query that already timed out
        if (!m.ok) throw new Error(m.error);
        return m.rows;
      }
      const left = deadline - Date.now() + 2000; // Postgres cancels at QUERY_TIMEOUT_MS; this is only a backstop
      if (left <= 0) throw new Error(`contacts_pg_sync: query timed out after ${QUERY_TIMEOUT_MS / 1000}s`);
      Atomics.wait(signal, 0, seen, left);
    }
  };
}
