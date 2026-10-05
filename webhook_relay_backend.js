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

const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
const WORKER_REPLY_TIMEOUT_MS = 45_000;

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

  // ses_notification prefers the dedicated send-worker thread, not the
  // background-worker -- confirmed live (2026-10-05): a real backlog of
  // 60k+ queued SES notification events (opens/clicks/deliveries from
  // tonight's campaigns) relayed through background_worker.js the same
  // way twilio_inbound does, and because that thread processes dispatches
  // one at a time regardless of which type arrives when, an individual
  // slow SES-notification call left a correctly-prioritized, newly
  // arrived twilio_inbound message (a live reply to an AI Coverage agent)
  // stuck waiting its turn behind it anyway -- the receiver's own
  // oldest/type-priority ordering only controls what it sends NEXT, not
  // what order an already-dispatched backlog finishes processing on the
  // one thread receiving it. Same reasoning as moving AI Active's batch
  // processing there earlier: bulk, non-latency-sensitive work doesn't
  // belong sharing a thread with anything a real person is waiting on.
  // Falls back to the background-worker if the send-worker isn't up
  // (SEND_WORKER unset) rather than refusing the event outright.
  const worker = (body.type === "ses_notification" && getSendWorker()) || getBackgroundWorker();
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
