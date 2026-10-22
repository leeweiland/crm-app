// The Reporting page's number-crunching, in its OWN process -- started (and
// stopped) by report_worker_client.js with child_process.fork, never imported
// by the server itself.
//
// Why a separate process: run inside the CRM server, opening Reporting
// crashed the whole CRM with a heap out-of-memory error (2026-10-21) -- each
// report made full copies of all contacts and read thousands of per-contact
// message files, and the server kept every one of those files in memory
// forever. Here:
//   - the process has its own memory limit, so the worst case is that THIS
//     process dies and one report says so -- the CRM keeps running;
//   - READJSON_NO_CACHE=1 (set by the client) makes readJson read each file
//     fresh and let it go, instead of caching it for the life of the process;
//   - jobs run one at a time, so two big reports never stack in memory;
//   - lowest CPU priority, so the CRM's own work always wins.
//
// Protocol (process.send / "message"):
//   parent -> { type: "job", id, job, params }   job = a key of REPORT_JOBS
//   parent -> { type: "shutdown" }               exit when idle
//   worker -> { type: "ready" }                  once contacts are loaded
//   worker -> { type: "result", id, ok, result | error }
import os from "os";
import { loadContactsCache, useContactsFromPostgres } from "./contacts_db.js";
import { REPORTS_PG, ensureReportFunctions } from "./reports_pg.js";
import { REPORT_JOBS } from "./reporting_backend.js";

try { os.setPriority(0, 19); } catch { /* best effort */ }

const mb = () => Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
const t0 = Date.now();
// With messages + records in Postgres the reports query just the rows they
// count (reports_pg.js), so this process holds no copy of the contacts.
if (REPORTS_PG) { await useContactsFromPostgres("report-worker"); ensureReportFunctions(); }
else await loadContactsCache();
console.log(`[report-worker] ready in ${Date.now() - t0}ms (heap ${mb()}MB)`);
process.send({ type: "ready" });

let chain = Promise.resolve();
process.on("message", (m) => {
  if (m?.type === "shutdown") { process.exit(0); }
  if (m?.type !== "job") return;
  chain = chain.then(async () => {
    const started = Date.now();
    const fn = REPORT_JOBS[m.job];
    try {
      if (!fn) throw new Error(`Unknown report: ${m.job}`);
      const result = await fn(m.params || {});
      process.send({ type: "result", id: m.id, ok: true, result });
    } catch (e) {
      process.send({ type: "result", id: m.id, ok: false, error: e?.message || String(e) });
    }
    console.log(`[report-worker] ${m.job} ${Date.now() - started}ms (heap ${mb()}MB)`);
  });
});
// The server restarted or went away -- nothing left to report to.
process.on("disconnect", () => process.exit(0));
