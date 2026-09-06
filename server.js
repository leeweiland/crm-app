import { createServer } from "http";
import { readFileSync, existsSync } from "fs";
import { join, dirname, extname } from "path";
import { fileURLToPath } from "url";
import { Worker } from "worker_threads";
import dotenv from "dotenv";
import { handleAuthRequest } from "./auth_backend.js";
import { handleContactsRequest } from "./contacts_backend.js";
import { handleStatusesRequest } from "./statuses_backend.js";
import { handleEmailRequest } from "./email_backend.js";
import { handleCampaignsRequest } from "./campaigns_backend.js";
import { handleAutomationsRequest } from "./automations_backend.js";
import { handleSmsRequest } from "./sms_backend.js";
import { handleWorkflowsRequest } from "./workflows_backend.js";
import { handleInboxRequest } from "./inbox_backend.js";
import { handleReportingRequest } from "./reporting_backend.js";
import { handleImportRequest } from "./import_backend.js";
import { handleFacebookRequest } from "./facebook_backend.js";
import { handleTrackingRequest } from "./tracking_backend.js";
import { handleFormsRequest } from "./forms_backend.js";
import { handleSchedulingRequest } from "./scheduling_backend.js";
import { handleIntegrationsRequest } from "./integrations_backend.js";
import { handleUploadsRequest } from "./uploads_backend.js";
import { handleAdsRequest } from "./ads_backend.js";
import { handleFlowsRequest } from "./flows_backend.js";
import { handleDuplicatesRequest } from "./duplicates_backend.js";
import { handleAiAgentsRequest } from "./ai_agents_backend.js";
import { handleAiActiveRequest } from "./ai_active_backend.js";
import { handleConversionsRequest } from "./conversions_backend.js";
import { handleMeetingsRequest } from "./meetings_backend.js";
import { handleGmailRequest } from "./gmail_backend.js";
import { startScheduler } from "./scheduler.js";
import { readJson, DATA_DIR } from "./auth_backend.js";
import { CONTACTS_FILE } from "./segments_shared.js";
import { sqliteInboxAvailable } from "./sqlite_inbox.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Explicit path, not dotenv's default (process.cwd()) -- the preview
// launcher runs `node <absolute path to server.js>` without first `cd`ing
// into this folder, so process.cwd() is wrong and .env silently never
// loads. Doesn't affect Railway, which injects env vars directly into
// process.env regardless of any .env file.
dotenv.config({ path: join(__dirname, ".env") });
const PORT = process.env.PORT || 3457;

process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason instanceof Error ? reason.stack : reason);
});
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err?.stack ?? err);
});

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif":  "image/gif",
  ".svg":  "image/svg+xml",
  ".ico":  "image/x-icon",
};

// Temporary diagnostic (2026-09-05): the server has frozen hard multiple
// times tonight with zero error output and steadily climbing CPU (confirmed
// live via /proc/<pid>/stat -- not I/O-wait, a genuine runaway synchronous
// computation), and every fix attempted for the suspected cause (the Gmail
// poller, since disabled entirely) didn't stop it recurring. This tracks
// every in-flight request and logs any that's been running more than 3s,
// checked every 5s -- next time it freezes, this points at the exact
// request that's stuck instead of guessing from the outside. Remove once
// the real cause is found and fixed.
const _inFlightRequests = new Map();
let _reqCounter = 0;
setInterval(() => {
  const now = Date.now();
  for (const [id, info] of _inFlightRequests) {
    if (now - info.startedAt > 3000) {
      console.error(`[watchdog] request #${id} (${info.method} ${info.url}) has been running ${((now - info.startedAt) / 1000).toFixed(1)}s`);
    }
  }
}, 5000).unref();

// Warms what a fresh container otherwise pays for on the FIRST real
// request instead of at boot: crm_contacts.json (~190MB -- readJson's own
// mtime-cache means this is a genuine no-op on every later call, but the
// very first parse after a deploy has nothing to hit) and opening the
// SQLite conversations DB (sqliteInboxAvailable's schema-check/ALTER
// TABLE statements). Both cheap (a few seconds), so worth paying BEFORE
// .listen() -- the server isn't reachable at all yet regardless, so this
// adds no real downtime.
function warmCaches() {
  const t0 = Date.now();
  try {
    readJson(CONTACTS_FILE, []);
    sqliteInboxAvailable();
    console.log(`[warmup] caches primed in ${Date.now() - t0}ms`);
  } catch (e) {
    console.error("[warmup] failed (non-fatal, first real request will just pay the cost instead):", e.message);
  }
}
warmCaches();

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const reqId = ++_reqCounter;
  _inFlightRequests.set(reqId, { method: req.method, url: req.url, startedAt: Date.now() });
  // Logged the instant the request STARTS, synchronously, before any route
  // handler runs -- the interval-based watchdog above needs the event loop
  // to be free to fire, but tonight's freezes are total: it never fires
  // once, meaning whatever's stuck never yields at all. This line runs
  // before that point every time, so `railway logs` shows the last request
  // that started right before a freeze, even when nothing else can log.
  console.log(`[req-start] #${reqId} ${req.method} ${req.url}`);
  res.on("finish", () => _inFlightRequests.delete(reqId));
  res.on("close", () => _inFlightRequests.delete(reqId));

  // Feature modules each own their own /api/* route group and return true
  // once they've handled a request — server.js is just the dispatch chain
  // plus the static-file fallback below. Adding a feature (Phase 2+) means
  // adding one more line here, nothing else changes.
  if (await handleAuthRequest(req, res, url)) return;
  if (await handleContactsRequest(req, res, url)) return;
  if (await handleStatusesRequest(req, res, url)) return;
  if (await handleEmailRequest(req, res, url)) return;
  if (await handleCampaignsRequest(req, res, url)) return;
  if (await handleAutomationsRequest(req, res, url)) return;
  if (await handleSmsRequest(req, res, url)) return;
  if (await handleWorkflowsRequest(req, res, url)) return;
  if (await handleInboxRequest(req, res, url)) return;
  if (await handleReportingRequest(req, res, url)) return;
  if (await handleImportRequest(req, res, url)) return;
  if (await handleFacebookRequest(req, res, url)) return;
  if (await handleTrackingRequest(req, res, url)) return;
  if (await handleFormsRequest(req, res, url)) return;
  if (await handleSchedulingRequest(req, res, url)) return;
  if (await handleIntegrationsRequest(req, res, url)) return;
  if (await handleUploadsRequest(req, res, url)) return;
  if (await handleAdsRequest(req, res, url)) return;
  if (await handleFlowsRequest(req, res, url)) return;
  if (await handleDuplicatesRequest(req, res, url)) return;
  if (await handleAiAgentsRequest(req, res, url)) return;
  if (await handleAiActiveRequest(req, res, url)) return;
  if (await handleConversionsRequest(req, res, url)) return;
  if (await handleMeetingsRequest(req, res, url)) return;
  if (await handleGmailRequest(req, res, url)) return;

  // Static file serving — this app is its own Railway service (unlike
  // chat-app, which shares a domain/nav with sibling apps), so there's no
  // URL prefix to strip.
  let pathname = url.pathname;
  const rootPage = process.env.DEV_SKIP_LOGIN === "1" ? "inbox.html" : "login.html";
  let filePath = join(__dirname, pathname === "/" ? rootPage : pathname);
  if (!existsSync(filePath)) {
    res.writeHead(404); res.end("Not found"); return;
  }
  const ext = extname(filePath);
  const mime = MIME[ext] || "application/octet-stream";
  const noCacheExts = [".html", ".js", ".css"];
  if (noCacheExts.includes(ext)) res.setHeader("Cache-Control", "no-store");
  res.writeHead(200, { "Content-Type": mime });
  res.end(readFileSync(filePath));
}).listen(PORT, () => console.log(`crm-app running on port ${PORT}`));

startScheduler();

// Warms the SQLite DB file's OS page cache on its own thread -- see
// warmup_worker.js's own comment for why this (not the query-level
// attempt it replaces) is the version that actually can't block the main
// thread: worker_threads runs on a real separate OS thread, so however
// long the cold disk read takes, this thread alone pays it. By the time a
// real user opens the Inbox (rarely within seconds of a redeploy), the
// file's pages are already resident and the main thread's own later
// synchronous query hits warm cache instead of cold disk.
new Worker(join(__dirname, "warmup_worker.js"), { workerData: { dbPath: join(DATA_DIR, "crm_prototype.db") } })
  .on("error", (e) => console.error("[warmup-worker] crashed:", e.message));
