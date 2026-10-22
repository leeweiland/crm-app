// Server-side half of report_worker.js: starts it on demand, hands it report
// jobs, caches the answers, and shuts it down again when Reporting isn't in
// use. Nothing heavy ever runs in the server process itself.
//
//   runReportJob(type, params) -> Promise<the report's JSON>
//
// Caching: a result is reused for RESULT_TTL_MS (the page re-asks for the
// same range constantly -- every tab switch / reload). params.fresh = "1"
// (the Reporting page's "Manual Update" button) skips the cache. Two requests
// for the same report at once share one job.
//
// The default view (Last 30 Days) is pre-computed every PREWARM_EVERY_MS so
// opening Reporting is instant -- skipped while a campaign is sending, so
// this never competes with a send for disk (the 2026-10-20 outage lesson).
import { fork } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { readJson } from "./auth_backend.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = process.env.REPORT_WORKER_PATH || join(__dirname, "report_worker.js"); // override only for tests
const WORKER_HEAP_MB = Number(process.env.REPORT_WORKER_HEAP_MB) || 3072;
const RESULT_TTL_MS = 35 * 60 * 1000;
const CLICKS_TTL_MS = 60 * 1000; // one contact's journey -- keep it close to live
const JOB_TIMEOUT_MS = 10 * 60 * 1000;
const IDLE_SHUTDOWN_MS = 10 * 60 * 1000;
const MAX_CACHED_RESULTS = 60;
const PREWARM_EVERY_MS = 30 * 60 * 1000;
const PREWARM_FIRST_DELAY_MS = 5 * 60 * 1000; // let a fresh deploy finish booting first
const PREWARM_JOBS = ["overview", "attribution", "adsReport", "sentByUser"];
const CAMPAIGNS_FILE = "crm_campaigns.json"; // same file campaigns_backend.js owns (not imported: that module pulls in the whole send stack)

let worker = null; // { child, ready: Promise, pending: Map<id, {resolve, reject, timer}> }
let nextId = 1;
let idleTimer = null;
const inflight = new Map(); // cacheKey -> Promise
const results = new Map(); // cacheKey -> { at, value }

function startWorker() {
  const child = fork(WORKER_PATH, [], {
    execArgv: [`--max-old-space-size=${WORKER_HEAP_MB}`],
    env: { ...process.env, READJSON_NO_CACHE: "1", REPORT_WORKER: "1" },
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  const w = { child, pending: new Map() };
  w.ready = new Promise((resolve, reject) => {
    child.on("message", (m) => {
      if (m?.type === "ready") { resolve(); return; }
      if (m?.type !== "result") return;
      const p = w.pending.get(m.id);
      if (!p) return;
      w.pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.ok) p.resolve(m.result); else p.reject(new Error(m.error || "Report failed"));
      scheduleIdleShutdown();
    });
    child.on("exit", (code, signal) => {
      if (worker === w) worker = null;
      const oom = signal === "SIGABRT" || signal === "SIGKILL" || code === 134 || code === 137;
      const why = oom
        ? "The report ran out of memory (only the report worker stopped -- the CRM is fine). Try a shorter date range."
        : code === 0 ? "The report worker stopped -- try again." : `The report worker crashed (exit ${signal || code}) -- try again.`;
      console.log(`[report-worker] exited code=${code} signal=${signal} pending=${w.pending.size}`);
      reject(new Error(why));
      for (const p of w.pending.values()) { clearTimeout(p.timer); p.reject(new Error(why)); }
      w.pending.clear();
    });
    child.on("error", (e) => console.error("[report-worker] process error:", e.message));
  });
  w.ready.catch(() => {}); // surfaced per job below; never an unhandled rejection
  worker = w;
  return w;
}

function scheduleIdleShutdown() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    const w = worker;
    if (!w || w.pending.size || inflight.size) return scheduleIdleShutdown();
    worker = null; // anything new from here on gets a fresh worker
    try { w.child.send({ type: "shutdown" }); } catch { /* already gone */ }
  }, IDLE_SHUTDOWN_MS);
  idleTimer.unref?.();
}

function sendJob(type, params) {
  const w = worker || startWorker();
  return w.ready.then(() => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => { w.pending.delete(id); reject(new Error("The report took too long -- try a shorter date range.")); }, JOB_TIMEOUT_MS);
    w.pending.set(id, { resolve, reject, timer });
    try { w.child.send({ type: "job", id, job: type, params }); }
    catch (e) { clearTimeout(timer); w.pending.delete(id); reject(new Error("Could not reach the report worker -- try again.")); }
  }));
}

function cacheKey(type, params) {
  return type + ":" + JSON.stringify(Object.keys(params).sort().map(k => [k, params[k]]));
}

export async function runReportJob(type, rawParams = {}) {
  const { fresh, ...params } = rawParams;
  const key = cacheKey(type, params);
  const ttl = type === "contactClicks" ? CLICKS_TTL_MS : RESULT_TTL_MS;
  const hit = results.get(key);
  if (fresh !== "1" && hit && Date.now() - hit.at < ttl) return hit.value;
  if (inflight.has(key)) return inflight.get(key);
  const p = sendJob(type, params)
    .then((value) => {
      results.delete(key);
      results.set(key, { at: Date.now(), value });
      while (results.size > MAX_CACHED_RESULTS) results.delete(results.keys().next().value); // oldest first
      return value;
    })
    .finally(() => { inflight.delete(key); scheduleIdleShutdown(); });
  inflight.set(key, p);
  return p;
}

// The Reporting page's default range, resolved exactly the way reporting.html's
// resolvePeriodRange does for "last30" (Anchorage calendar days, ending
// yesterday) -- so a pre-warmed result is the very cache entry the page asks for.
function last30Range() {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Anchorage", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const todayMs = Date.parse(today + "T00:00:00Z");
  const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
  return { start: iso(todayMs - 30 * 86400000), end: iso(todayMs - 86400000) };
}
async function prewarm() {
  try {
    const sending = readJson(CAMPAIGNS_FILE, []).some(c => c.status === "sending");
    if (sending) { console.log("[report-worker] prewarm skipped: a campaign is sending"); return; }
    const range = last30Range();
    for (const job of PREWARM_JOBS) await runReportJob(job, { ...range, fresh: "1" }).catch(e => console.error(`[report-worker] prewarm ${job} failed:`, e.message));
  } catch (e) { console.error("[report-worker] prewarm failed:", e.message); }
}
// Called once from server.js.
export function startReportPrewarm() {
  if (process.env.REPORT_PREWARM === "0") return;
  setTimeout(() => { prewarm(); setInterval(prewarm, PREWARM_EVERY_MS).unref?.(); }, PREWARM_FIRST_DELAY_MS).unref?.();
}
