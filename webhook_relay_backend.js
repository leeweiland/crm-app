// Internal endpoint the separate crm-webhook-receiver Railway service calls
// to hand off a Twilio/SES event it already durably queued and ack'd on its
// own end. This exists so that service can accept webhooks (and hold them
// in its own queue, retrying) even while THIS app is mid-redeploy -- see
// webhook-receiver/README for the full design. Never called by Twilio or
// SES directly (they still hit the existing /api/webhooks/* routes on this
// app until the receiver service is proven and cut over).
//
// Processing is dispatched to the background-worker thread (see
// background_worker.js), never run inline on the main thread -- the
// original 2026-09-16 incident this whole codebase is built around was
// exactly this class of bug (webhook processing blocking the thread
// serving real page requests), and a route that re-introduces it on the
// main thread just because it's "internal" would be the same mistake
// again. Confirmed live on 2026-10-04: a burst of relayed events run
// inline here stalled the whole app the same way. The receiver's retry
// logic needs a real success/failure answer (unlike Twilio/SES hitting
// /api/webhooks/* directly, which never waited on one), so this
// round-trips a correlated reply from the worker instead of firing and
// forgetting.
//
// Auth is HMAC request-signing, not a bare shared-secret header -- same
// shape as Twilio's own x-twilio-signature validation elsewhere in this
// codebase (see sms_backend.js). The caller signs `${timestamp}.${rawBody}`
// with WEBHOOK_RELAY_SECRET (set on both this app and the receiver
// service) and sends the timestamp + signature as headers; this side
// recomputes the same HMAC and compares it in constant time. The
// timestamp is part of the signed material specifically so a captured
// request can't be replayed later -- anything older than 5 minutes is
// rejected outright, signature valid or not.
//
// Deliberately rejects every request when the secret isn't configured, so
// this route can ship inert (same pattern as BACKGROUND_WORKER) with zero
// behavior change until it's set.
import { randomUUID, createHmac, timingSafeEqual } from "crypto";
import { sendJson } from "./auth_backend.js";
import { processTwilioStatusUpdate, processTwilioInboundMessage } from "./sms_backend.js";
import { processSesNotificationMessage } from "./email_backend.js";
import { getBackgroundWorker } from "./background_worker_handle.js";
import { getSendWorker } from "./send_worker_handle.js";
import { getSmsWorker } from "./sms_worker_handle.js";
import { getSesNotificationWorkerByKey } from "./ses_notification_worker_handle.js";

const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
// Raised from 45s (2026-10-06) -- confirmed live during a real disk-
// pressure spike that calls were completing right around 45-46s, just
// past the old ceiling, not hanging indefinitely. A timeout here doesn't
// cancel the in-flight work on the worker thread -- postMessage has no
// way to abort what it already started -- so a call that times out right
// before finishing keeps running to completion ANYWAY, uselessly, while
// the receiver's retry logic ALSO re-dispatches the same event as a new
// attempt. Every near-miss timeout was doubling real load on an already
// -saturated disk instead of just waiting the extra few seconds for the
// original attempt to land. Still bounded (a genuinely hung worker still
// times out, just later), not removed.
const WORKER_REPLY_TIMEOUT_MS = 90_000;

function readRawBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (d) => body += d);
    req.on("end", () => resolve(body));
  });
}

function validSignature(secret, timestamp, rawBody, provided) {
  if (!provided || !timestamp) return false;
  const age = Date.now() - Number(timestamp);
  if (!Number.isFinite(age) || age < 0 || age > MAX_CLOCK_SKEW_MS) return false;
  const expected = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(provided, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

// One listener per worker INSTANCE, not just one overall -- ses_notification
// now dispatches to the send-worker while twilio_inbound/twilio_status stay
// on the background-worker (see handleWebhookRelayRequest below), so this
// needs to track attachment per-worker, not a single "the one worker"
// reference. Each worker is respawned on crash (see server.js) -- a Set
// keyed by the live worker object re-attaches naturally the next time
// getBackgroundWorker()/getSendWorker() returns a freshly spawned one,
// since a dead worker's object reference is simply never seen again.
const pendingReplies = new Map();
const listenersAttached = new Set();
function ensureReplyListener(worker) {
  if (listenersAttached.has(worker)) return;
  worker.on("message", (msg) => {
    if (msg?.type !== "relay_result" || !pendingReplies.has(msg.replyId)) return;
    const resolve = pendingReplies.get(msg.replyId);
    pendingReplies.delete(msg.replyId);
    resolve(msg);
  });
  listenersAttached.add(worker);
}

function dispatchToWorker(worker, payload) {
  return new Promise((resolve) => {
    const replyId = randomUUID();
    pendingReplies.set(replyId, resolve);
    setTimeout(() => {
      if (pendingReplies.has(replyId)) { pendingReplies.delete(replyId); resolve({ ok: false, error: "background worker did not respond in time" }); }
    }, WORKER_REPLY_TIMEOUT_MS);
    worker.postMessage({ ...payload, replyId });
  });
}

export async function handleWebhookRelayRequest(req, res, url) {
  if (url.pathname !== "/internal/webhook-relay" || req.method !== "POST") return false;

  const secret = process.env.WEBHOOK_RELAY_SECRET;
  const raw = await readRawBody(req);
  if (!secret || !validSignature(secret, req.headers["x-relay-timestamp"], raw, req.headers["x-relay-signature"])) {
    res.writeHead(403); res.end(); return true;
  }

  let body;
  try { body = JSON.parse(raw); } catch { return sendJson(res, 400, { ok: false, error: "invalid json" }); }

  const validPayload =
    (body.type === "twilio_status" && body.sid && body.status) ||
    (body.type === "twilio_inbound" && body.from) ||
    (body.type === "ses_notification" && body.raw);
  if (!validPayload) return sendJson(res, 400, { ok: false, error: "unknown or incomplete event" });

  // Five real channels now, not two, not four -- confirmed live
  // (2026-10-06) that even "ses_notification gets its own thread" (moved
  // onto send_worker.js earlier the same night) wasn't actually separating
  // it from anything: that thread is where campaign/SMS sends themselves
  // run, so email SENDING and email WEBHOOK PROCESSING ended up sharing a
  // thread -- the exact same mistake already fixed for SMS, just not
  // caught here at the time. A real campaign's send calls showed a
  // near-zero AWS retry delay but 20-66+ second total call times, with a
  // whole batch of concurrent sends all resolving within the same ~100ms
  // window after a stall -- the event loop being starved by the SES-
  // notification flood on that same thread, not the sends being slow
  // themselves. ses_notification now gets its own dedicated thread (see
  // ses_notification_worker.js), fully separate from send_worker.js.
  // twilio_inbound/twilio_status already have their own (sms_worker.js,
  // fixed earlier the same night for the identical reason, just one
  // channel over). Each falls back down the chain (dedicated worker ->
  // send/background worker) if its preferred one isn't up, rather than
  // refusing the event outright.
  // ses_notification spreads across a pool of threads by hashing the raw
  // SNS payload (2026-10-07) -- confirmed live a single dedicated thread
  // only drained the backlog at ~2.5/sec, fully sequential. Hashing the
  // raw string (not, say, the contact id) needs no parsing here at all;
  // it's a pure load-spread, not a correctness requirement -- different
  // messages landing on different threads is exactly the point, since
  // each one mostly touches only that ONE contact's own files.
  //
  // REVERTED same day (2026-10-07) -- tried classifying by sourceType
  // HERE, on the main thread, before picking a worker. Confirmed live
  // this was a serious regression, not an improvement: the lookup reads
  // crm_provider_id_index.json (20MB+ and growing, written on nearly
  // every send) through getProviderIndexCached's mtime-based cache, and
  // under real send/notification volume that file's mtime is changing
  // essentially continuously -- so the "cache" was re-reading and
  // re-parsing the entire 20MB+ file on nearly every single dispatch,
  // ON THE MAIN THREAD, stalling requests for 90+ seconds. The
  // classification itself is still sound (see automation_notification_worker.js/
  // sequence_notification_worker.js, both still built and spawned) --
  // it just needs to happen INSIDE a worker thread where a slow read
  // doesn't block an HTTP response, not here. Reverted to the plain hash-
  // based pool routing until that's done safely.
  const worker =
    (body.type === "ses_notification" && getSesNotificationWorkerByKey(body.raw)) ||
    ((body.type === "twilio_inbound" || body.type === "twilio_status") && getSmsWorker()) ||
    getSendWorker() ||
    getBackgroundWorker();
  if (worker) {
    ensureReplyListener(worker);
    const result = await dispatchToWorker(worker, body);
    if (result.ok) return sendJson(res, 200, { ok: true });
    console.error("[webhook-relay] processing failed:", result.error);
    // 500 tells the receiver's retry loop to try again later -- never
    // acknowledge an event that didn't actually get applied.
    return sendJson(res, 500, { ok: false, error: result.error });
  }

  // No background worker running at all (BACKGROUND_WORKER unset) -- fall
  // back to inline processing rather than refusing the request outright.
  // This is the one case where it's acceptable to run on the main thread:
  // without the worker, EVERYTHING already runs inline (see server.js),
  // so this isn't introducing new main-thread risk relative to today's
  // baseline.
  try {
    if (body.type === "twilio_status") processTwilioStatusUpdate(body.sid, body.status);
    else if (body.type === "twilio_inbound") processTwilioInboundMessage(body.from, body.body || "");
    else if (body.type === "ses_notification") processSesNotificationMessage(body.raw);
    return sendJson(res, 200, { ok: true });
  } catch (e) {
    console.error("[webhook-relay] inline processing failed:", e.message);
    return sendJson(res, 500, { ok: false, error: e.message });
  }
}

// One-time trigger for the ses_notification backlog bulk-drain
// (2026-10-08) -- see ses_notification_worker.js's own runBulkDrain for
// why this runs ON that existing dedicated thread instead of a separate
// script/process (a standalone script doing the same work caused real
// SQLite lock contention against the live app). Fire-and-forget on
// purpose -- a real backlog takes many minutes, far longer than
// dispatchToWorker's own 90s reply timeout, so this doesn't wait for
// completion; progress is visible in that worker's own logs and via the
// webhook_queue table directly. Same HMAC auth as the relay endpoint
// above, not a new trust boundary.
export async function handleBulkDrainTriggerRequest(req, res, url) {
  if (url.pathname !== "/internal/bulk-drain-ses-notifications" || req.method !== "POST") return false;

  const secret = process.env.WEBHOOK_RELAY_SECRET;
  const raw = await readRawBody(req);
  if (!secret || !validSignature(secret, req.headers["x-relay-timestamp"], raw, req.headers["x-relay-signature"])) {
    res.writeHead(403); res.end(); return true;
  }

  const worker = getSesNotificationWorkerByKey(String(Date.now()));
  if (!worker) return sendJson(res, 503, { ok: false, error: "ses-notification worker pool not up" });
  // Dropped from 2000 (2026-10-08) -- both the progress log AND the
  // webhook_queue "delivered" UPDATE in runBulkDrain only happen once per
  // FULL batch, after every row in it finishes. Under tonight's real,
  // confirmed (via /proc: path_openat/folio_wait_bit_common D-state,
  // /proc/pressure/io avg10 ~24-27%) disk contention, a single row can
  // now take anywhere from under a second to many seconds -- at 2000 rows
  // per batch that meant long stretches with ZERO visible progress (no
  // log line, no DB write) even while the loop was genuinely working,
  // indistinguishable from a hang. A smaller batch doesn't change how
  // much total work there is or skip anything -- the while(true) loop
  // keeps pulling batches until the backlog is empty either way -- it
  // only makes forward progress observable in seconds instead of minutes.
  worker.postMessage({ type: "bulk_drain_backlog", batchSize: 100 });
  return sendJson(res, 200, { ok: true, started: true });
}
