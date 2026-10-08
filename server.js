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
import { handleWebhookRelayRequest, handleBulkDrainTriggerRequest } from "./webhook_relay_backend.js";
import { handleCallsRequest } from "./calls_backend.js";
import { handleCallsSheetRequest } from "./calls_sheet_backend.js";
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
import { handleAdsRequest, startCallsSyncTimer } from "./ads_backend.js";
import { handleFlowsRequest } from "./flows_backend.js";
import { handleDuplicatesRequest } from "./duplicates_backend.js";
import { handleAiAgentsRequest, handleCacheRequest } from "./ai_agents_backend.js";
import { handleAiActiveRequest } from "./ai_active_backend.js";
import { handleBehavioralTriggersRequest } from "./behavioral_triggers_backend.js";
import { handleConversionsRequest } from "./conversions_backend.js";
import { handleMeetingsRequest } from "./meetings_backend.js";
import { handleGmailRequest } from "./gmail_backend.js";
import { handleYoutubeRequest } from "./youtube_backend.js";
import { handleAppSummaryRequest } from "./app_summary_backend.js";
import { startScheduler } from "./scheduler.js";
import { setBackgroundWorker } from "./background_worker_handle.js";
import { setSendWorker } from "./send_worker_handle.js";
import { setSmsWorker } from "./sms_worker_handle.js";
import { setSesNotificationWorker, SES_NOTIFICATION_POOL_SIZE } from "./ses_notification_worker_handle.js";
import { setAutomationNotificationWorker } from "./automation_notification_worker_handle.js";
import { setSequenceNotificationWorker } from "./sequence_notification_worker_handle.js";
import { readJson, DATA_DIR, removeStaleTmpFiles } from "./auth_backend.js";
import { loadContactsCache, getAllContacts } from "./contacts_db.js";
import { sqliteInboxAvailable, contactsIndexCount, backfillContactsIndex, backfillRenewalDates } from "./sqlite_inbox.js";
import { runRecentInternationalPhoneFix } from "./phone_backfill.js";
import { seedKickoffForms } from "./seed_kickoff_forms.js";
import { runInferredAttributionBackfill } from "./attribution_backfill.js";
import { seedKickoffFlows } from "./seed_kickoff_flows.js";
import { seedEnrollFlow } from "./seed_enroll_flow.js";
import { syncKickoffFlows } from "./sync_kickoff_flows.js";
import { runEmailFontSize16Migration } from "./email_font_size_migration.js";

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
    // Server-Sent Events connections (inbox_backend.js's live-sync stream)
    // are deliberately held open for as long as the tab is -- hours, not a
    // stuck computation -- and never hit res.finish/close to clear this map
    // entry until the tab closes. Without this exemption every open Inbox
    // tab would spam this exact "stuck request" alarm forever, drowning out
    // a genuine one.
    if (info.url === "/api/inbox/events") continue;
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
    const contacts = getAllContacts();
    sqliteInboxAvailable();
    // One-time bulk populate for contacts_idx (the Contacts page/single-
    // contact-lookup fast path, see contacts_backend.js and sqlite_inbox.js's
    // CREATE TABLE comment) -- every contact that existed before this
    // feature shipped has no row there yet, only ones some other write
    // touches from here on. Gated on count vs length (not "table just got
    // created") so a container that crashed/restarted mid-backfill --or an
    // index that's fallen behind for any other reason -- catches up on the
    // next boot too, not just the very first one. Reuses the `contacts`
    // array this function already paid to parse, so backfilling costs
    // nothing beyond the 176k inserts themselves (one transaction, see
    // backfillContactsIndex) -- and runs here, before .listen(), rather
    // than as a separate script sharing this container with the live
    // server, which is exactly what destabilized production earlier this
    // session (see compliance_backend.js's status-migration history).
    if (contacts.length && contactsIndexCount() < contacts.length) {
      const bt0 = Date.now();
      const n = backfillContactsIndex(contacts);
      console.log(`[warmup] contacts_idx backfilled (${n} rows) in ${Date.now() - bt0}ms`);
    }
    // Renewal alerts (see sqlite_inbox.js): stamps each conversation with its student's END DATE.
    const stamped = backfillRenewalDates(contacts);
    if (stamped) console.log(`[warmup] renewal end dates stamped on ${stamped} contact(s)`);
    console.log(`[warmup] caches primed in ${Date.now() - t0}ms`);
  } catch (e) {
    console.error("[warmup] failed (non-fatal, first real request will just pay the cost instead):", e.message);
  }
}
// Contacts now read from this in-memory cache (contacts_db.js), sourced
// from Postgres -- must finish before warmCaches() and everything below it
// runs, since all of them (and every request once the server is live) read
// contacts synchronously against this cache, not the JSON file directly.
// Fatal if this fails -- unlike the try/catch'd steps below, there's no
// safe fallback behavior for "contacts never loaded."
await loadContactsCache();
warmCaches();
try { runRecentInternationalPhoneFix(); runRecentInternationalPhoneFix("2026-09-19-v2"); } catch (e) { console.error("[phone-fix] failed (non-fatal, will retry next boot):", e.message); }
try { runInferredAttributionBackfill(); } catch (e) { console.error("[attribution-inference] failed (non-fatal):", e.message); }
removeStaleTmpFiles();
try { seedKickoffForms(); } catch (e) { console.error("[seed] kickoff forms failed (non-fatal):", e.message); }
try { seedKickoffFlows(); } catch (e) { console.error("[seed] kickoff flows failed (non-fatal):", e.message); }
try { seedEnrollFlow(); } catch (e) { console.error("[seed] enroll flow failed (non-fatal):", e.message); }
try { syncKickoffFlows(); } catch (e) { console.error("[sync] kickoff flows failed (non-fatal):", e.message); }
try { runEmailFontSize16Migration(); } catch (e) { console.error("[migration] email font size failed (non-fatal, will retry next boot):", e.message); }

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
  if (await handleWebhookRelayRequest(req, res, url)) return;
  if (await handleBulkDrainTriggerRequest(req, res, url)) return;
  if (await handleAuthRequest(req, res, url)) return;
  if (await handleContactsRequest(req, res, url)) return;
  if (await handleStatusesRequest(req, res, url)) return;
  if (await handleEmailRequest(req, res, url)) return;
  if (await handleCampaignsRequest(req, res, url)) return;
  if (await handleAutomationsRequest(req, res, url)) return;
  if (await handleSmsRequest(req, res, url)) return;
  if (await handleCallsRequest(req, res, url)) return;
  if (await handleCallsSheetRequest(req, res, url)) return;
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
  if (await handleCacheRequest(req, res, url)) return;
  if (await handleAiActiveRequest(req, res, url)) return;
  if (await handleBehavioralTriggersRequest(req, res, url)) return;
  if (await handleConversionsRequest(req, res, url)) return;
  if (await handleMeetingsRequest(req, res, url)) return;
  if (await handleGmailRequest(req, res, url)) return;
  if (await handleYoutubeRequest(req, res, url)) return;
  if (await handleAppSummaryRequest(req, res, url)) return;

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

// Keeps the ads sheet's sales columns current from CALLS TRACKING (production only -- it writes to the live sheet)
if (process.env.RAILWAY_ENVIRONMENT) startCallsSyncTimer();

// BACKGROUND_WORKER (2026-09-16, off by default): runs the whole scheduler
// tick and all Twilio/SES webhook processing on a separate OS thread
// instead of inline on this one -- see background_worker.js's own comment
// for why. Deliberately opt-in: this changes nothing about current
// behavior until the env var is set, so it can ship and sit inert while
// it's verified, then get switched on with a config change alone (no
// redeploy needed at cutover time).
if (process.env.BACKGROUND_WORKER === "1") {
  let consecutiveCrashes = 0;
  function spawnBackgroundWorker() {
    const worker = new Worker(join(__dirname, "background_worker.js"), { env: process.env });
    const startedAt = Date.now();
    worker.on("error", (e) => console.error("[background-worker] crashed:", e.message));
    worker.on("exit", (code) => {
      console.error(`[background-worker] exited with code ${code} after ${Date.now() - startedAt}ms -- respawning`);
      // A worker that dies within seconds of starting, repeatedly, means
      // something's fundamentally broken (a bad import, a missing env var)
      // -- respawning it in a tight loop would just spin forever without
      // ever actually recovering, so this backs off instead of giving up
      // entirely (silently losing every background job -- sends, wait-step
      // advancement, reminders -- is worse than a loud, slow retry).
      consecutiveCrashes = (Date.now() - startedAt < 10000) ? consecutiveCrashes + 1 : 0;
      setTimeout(spawnBackgroundWorker, Math.min(30000, 1000 * 2 ** consecutiveCrashes));
    });
    setBackgroundWorker(worker);
  }
  spawnBackgroundWorker();
  console.log("[server] BACKGROUND_WORKER=1 -- scheduler tick and webhook processing running off the main thread");
} else {
  startScheduler();
}

// SEND_WORKER (2026-10-04, off by default): runs campaign/SMS sends on
// their OWN dedicated thread, separate from background_worker.js's
// scheduler-tick thread -- see send_worker.js's own comment for why
// (a slow scheduler phase, like Gmail polling backlog, stalling an
// in-flight send just because they happened to share a thread). Same
// opt-in-and-verify-before-cutover pattern as BACKGROUND_WORKER itself:
// campaigns_backend.js's sendCampaignNow only routes to this worker when
// it's actually running, and falls back to the existing background
// worker (or inline) otherwise -- so this can ship and be verified
// before anything real sends through it.
if (process.env.SEND_WORKER === "1") {
  let consecutiveSendWorkerCrashes = 0;
  function spawnSendWorker() {
    const worker = new Worker(join(__dirname, "send_worker.js"), { env: process.env });
    const startedAt = Date.now();
    worker.on("error", (e) => console.error("[send-worker] crashed:", e.message));
    worker.on("exit", (code) => {
      console.error(`[send-worker] exited with code ${code} after ${Date.now() - startedAt}ms -- respawning`);
      consecutiveSendWorkerCrashes = (Date.now() - startedAt < 10000) ? consecutiveSendWorkerCrashes + 1 : 0;
      setTimeout(spawnSendWorker, Math.min(30000, 1000 * 2 ** consecutiveSendWorkerCrashes));
    });
    setSendWorker(worker);
  }
  spawnSendWorker();
  console.log("[server] SEND_WORKER=1 -- campaign/SMS sends running on their own dedicated thread");

  // SMS_WORKER rides the same opt-in flag as SEND_WORKER -- both are part
  // of the same "real dedicated-thread topology" cutover, not two
  // independent features, so there's no reason to make this a second env
  // var the user has to separately remember to set. Dedicated OS thread
  // for Twilio webhook processing ONLY (inbound SMS + status callbacks) --
  // see sms_worker.js's own comment for why this needed to be fully
  // isolated, not just moved to whichever other thread happened to be
  // least busy at the time. webhook_relay_backend.js/sms_backend.js route
  // to this worker when it's up, falling back to the background worker
  // otherwise, same opt-in-and-verify-before-cutover pattern as every
  // other worker here.
  let consecutiveSmsWorkerCrashes = 0;
  function spawnSmsWorker() {
    const worker = new Worker(join(__dirname, "sms_worker.js"), { env: process.env });
    const startedAt = Date.now();
    worker.on("error", (e) => console.error("[sms-worker] crashed:", e.message));
    worker.on("exit", (code) => {
      console.error(`[sms-worker] exited with code ${code} after ${Date.now() - startedAt}ms -- respawning`);
      consecutiveSmsWorkerCrashes = (Date.now() - startedAt < 10000) ? consecutiveSmsWorkerCrashes + 1 : 0;
      setTimeout(spawnSmsWorker, Math.min(30000, 1000 * 2 ** consecutiveSmsWorkerCrashes));
    });
    setSmsWorker(worker);
  }
  spawnSmsWorker();
  console.log("[server] SEND_WORKER=1 -- Twilio webhook processing also running on its own dedicated thread");

  // Same flag, same reasoning as every other worker here -- email
  // notifications (delivery/open/click/bounce) belonging to an automation
  // step get their OWN thread, separate from the campaign-notification
  // pool, so one source's volume can never starve the other's (2026-10-07).
  // webhook_relay_backend.js/email_backend.js route here by looking up
  // each notification's sourceType before dispatch.
  let consecutiveAutomationNotificationWorkerCrashes = 0;
  function spawnAutomationNotificationWorker() {
    const worker = new Worker(join(__dirname, "automation_notification_worker.js"), { env: process.env });
    const startedAt = Date.now();
    worker.on("error", (e) => console.error("[automation-notification-worker] crashed:", e.message));
    worker.on("exit", (code) => {
      console.error(`[automation-notification-worker] exited with code ${code} after ${Date.now() - startedAt}ms -- respawning`);
      consecutiveAutomationNotificationWorkerCrashes = (Date.now() - startedAt < 10000) ? consecutiveAutomationNotificationWorkerCrashes + 1 : 0;
      setTimeout(spawnAutomationNotificationWorker, Math.min(30000, 1000 * 2 ** consecutiveAutomationNotificationWorkerCrashes));
    });
    setAutomationNotificationWorker(worker);
  }
  spawnAutomationNotificationWorker();
  console.log("[server] SEND_WORKER=1 -- automation-step email notifications also running on their own dedicated thread, separate from campaign notifications");

  // Same flag, same reasoning -- SMS status callbacks belonging to a
  // workflow (sequence) step get their OWN thread, separate from
  // sms_worker.js's own thread (which keeps handling inbound replies
  // always, plus status callbacks for every OTHER source).
  let consecutiveSequenceNotificationWorkerCrashes = 0;
  function spawnSequenceNotificationWorker() {
    const worker = new Worker(join(__dirname, "sequence_notification_worker.js"), { env: process.env });
    const startedAt = Date.now();
    worker.on("error", (e) => console.error("[sequence-notification-worker] crashed:", e.message));
    worker.on("exit", (code) => {
      console.error(`[sequence-notification-worker] exited with code ${code} after ${Date.now() - startedAt}ms -- respawning`);
      consecutiveSequenceNotificationWorkerCrashes = (Date.now() - startedAt < 10000) ? consecutiveSequenceNotificationWorkerCrashes + 1 : 0;
      setTimeout(spawnSequenceNotificationWorker, Math.min(30000, 1000 * 2 ** consecutiveSequenceNotificationWorkerCrashes));
    });
    setSequenceNotificationWorker(worker);
  }
  spawnSequenceNotificationWorker();
  console.log("[server] SEND_WORKER=1 -- workflow-step SMS status callbacks also running on their own dedicated thread, separate from other SMS");

  // Same flag, same reasoning as sms-worker above. Confirmed live
  // (2026-10-06) why this needs splitting OFF send_worker.js, not just
  // onto it: a real campaign showed send calls with a near-zero AWS retry
  // delay still taking 20-66+ seconds end to end, with a whole batch of
  // concurrent sends all resolving within the same ~100ms window after a
  // stall -- the event loop being starved by something ELSE on that
  // thread, not the sends themselves being slow. SES notification
  // processing (moved onto send_worker.js earlier the same night, to get
  // it off the sms-worker thread) was that something -- its relay batch
  // size was separately raised to 500 the same night, enough synchronous
  // back-to-back work to delay an already-answered send from actually
  // resolving. Giving it its own thread means a send call's resolution is
  // never waiting behind anything but other send calls on its own thread,
  // the same guarantee SMS already has.
  // Pool of SES_NOTIFICATION_POOL_SIZE threads, not one (2026-10-07) --
  // confirmed live the backlog drained at only ~2.5/sec fully sequential
  // on a single thread. Each slot respawns independently into its OWN
  // pool index on crash -- a crash in slot 2 never touches slots 0/1/3,
  // same isolation guarantee every other worker in this file gets, just
  // replicated per slot instead of once.
  for (let slot = 0; slot < SES_NOTIFICATION_POOL_SIZE; slot++) {
    let consecutiveCrashes = 0;
    function spawnSesNotificationWorker() {
      const worker = new Worker(join(__dirname, "ses_notification_worker.js"), { env: process.env });
      const startedAt = Date.now();
      worker.on("error", (e) => console.error(`[ses-notification-worker:${slot}] crashed:`, e.message));
      worker.on("exit", (code) => {
        console.error(`[ses-notification-worker:${slot}] exited with code ${code} after ${Date.now() - startedAt}ms -- respawning`);
        consecutiveCrashes = (Date.now() - startedAt < 10000) ? consecutiveCrashes + 1 : 0;
        setTimeout(spawnSesNotificationWorker, Math.min(30000, 1000 * 2 ** consecutiveCrashes));
      });
      setSesNotificationWorker(slot, worker);
    }
    spawnSesNotificationWorker();
  }
  console.log(`[server] SEND_WORKER=1 -- SES notification processing running on a pool of ${SES_NOTIFICATION_POOL_SIZE} dedicated threads, separate from campaign/SMS sends`);

  // Same flag, same reasoning as every other worker above. Confirmed live
  // (2026-10-06): AI Active's own 30s batch check was sharing send_worker.js
  // with the actual campaign send loop -- it ended up there purely because
  // "that's where sends happen," never because it needed to be on that
  // SPECIFIC thread the way checkCampaigns does (see send_worker.js's own
  // comment on why that one stays). A real campaign showed send calls
  // with near-zero AWS retry delay still taking 10-29+ seconds in
  // recurring clusters roughly every 20-30 seconds -- the exact cadence
  // of this interval sharing that thread. No handle/setter needed --
  // nothing ever dispatches a message TO this worker, it's purely
  // self-driven, so there's nothing for another file to look up.
  let consecutiveAiActiveWorkerCrashes = 0;
  function spawnAiActiveWorker() {
    const worker = new Worker(join(__dirname, "ai_active_worker.js"), { env: process.env });
    const startedAt = Date.now();
    worker.on("error", (e) => console.error("[ai-active-worker] crashed:", e.message));
    worker.on("exit", (code) => {
      console.error(`[ai-active-worker] exited with code ${code} after ${Date.now() - startedAt}ms -- respawning`);
      consecutiveAiActiveWorkerCrashes = (Date.now() - startedAt < 10000) ? consecutiveAiActiveWorkerCrashes + 1 : 0;
      setTimeout(spawnAiActiveWorker, Math.min(30000, 1000 * 2 ** consecutiveAiActiveWorkerCrashes));
    });
  }
  spawnAiActiveWorker();
  console.log("[server] SEND_WORKER=1 -- AI Active's batch check also running on its own dedicated thread, separate from campaign/SMS sends");

  // Same flag, same reasoning, same self-driven shape as AI Active above --
  // email automations' own 30s enrollment check was sharing a thread with
  // everything else background_worker.js's tick does, purely because
  // nobody had isolated it yet (2026-10-07).
  let consecutiveAutomationSendWorkerCrashes = 0;
  function spawnAutomationSendWorker() {
    const worker = new Worker(join(__dirname, "automation_send_worker.js"), { env: process.env });
    const startedAt = Date.now();
    worker.on("error", (e) => console.error("[automation-send-worker] crashed:", e.message));
    worker.on("exit", (code) => {
      console.error(`[automation-send-worker] exited with code ${code} after ${Date.now() - startedAt}ms -- respawning`);
      consecutiveAutomationSendWorkerCrashes = (Date.now() - startedAt < 10000) ? consecutiveAutomationSendWorkerCrashes + 1 : 0;
      setTimeout(spawnAutomationSendWorker, Math.min(30000, 1000 * 2 ** consecutiveAutomationSendWorkerCrashes));
    });
  }
  spawnAutomationSendWorker();
  console.log("[server] SEND_WORKER=1 -- email automations' enrollment check also running on its own dedicated thread");

  // Same flag, same reasoning, same self-driven shape -- SMS sequences'
  // (workflows_backend.js) own 30s enrollment check, same gap as email
  // automations just above.
  let consecutiveSequenceSendWorkerCrashes = 0;
  function spawnSequenceSendWorker() {
    const worker = new Worker(join(__dirname, "sequence_send_worker.js"), { env: process.env });
    const startedAt = Date.now();
    worker.on("error", (e) => console.error("[sequence-send-worker] crashed:", e.message));
    worker.on("exit", (code) => {
      console.error(`[sequence-send-worker] exited with code ${code} after ${Date.now() - startedAt}ms -- respawning`);
      consecutiveSequenceSendWorkerCrashes = (Date.now() - startedAt < 10000) ? consecutiveSequenceSendWorkerCrashes + 1 : 0;
      setTimeout(spawnSequenceSendWorker, Math.min(30000, 1000 * 2 ** consecutiveSequenceSendWorkerCrashes));
    });
  }
  spawnSequenceSendWorker();
  console.log("[server] SEND_WORKER=1 -- SMS sequences' enrollment check also running on its own dedicated thread");
}

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
