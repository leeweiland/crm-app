// Helper thread for contacts_pg_sync.js: runs each query it's handed and
// posts the rows back, then bumps the shared counter so the blocked caller
// wakes up. Queries arrive one at a time (the caller is blocked until it
// gets its answer), so one connection is enough.
import { workerData } from "worker_threads";
import pg from "pg";

const { port, signal, connectionString, statementTimeoutMs } = workerData;
// statement_timeout: Postgres cancels a query that runs too long, so it
// errors back to the caller instead of holding this one connection.
const pool = new pg.Pool({ connectionString, max: 1, options: statementTimeoutMs ? `-c statement_timeout=${Math.max(1000, statementTimeoutMs)}` : undefined });
pool.on("error", (e) => console.error("[contacts_pg_sync] pool error:", e.message));

function answer(msg) {
  port.postMessage(msg);
  Atomics.add(signal, 0, 1);
  Atomics.notify(signal, 0);
}

port.on("message", async ({ id, sql, params }) => {
  try {
    const r = await pool.query(sql, params);
    answer({ id, ok: true, rows: r.rows });
  } catch (e) {
    answer({ id, ok: false, error: e.message });
  }
});
