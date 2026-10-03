// Internal endpoint the separate crm-webhook-receiver Railway service calls
// to hand off a Twilio/SES event it already durably queued and ack'd on its
// own end. This exists so that service can accept webhooks (and hold them
// in its own queue, retrying) even while THIS app is mid-redeploy -- see
// webhook-receiver/README for the full design. Never called by Twilio or
// SES directly (they still hit the existing /api/webhooks/* routes on this
// app until the receiver service is proven and cut over).
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
import { createHmac, timingSafeEqual } from "crypto";
import { sendJson } from "./auth_backend.js";
import { processTwilioStatusUpdate, processTwilioInboundMessage } from "./sms_backend.js";
import { processSesNotificationMessage } from "./email_backend.js";

const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

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

export async function handleWebhookRelayRequest(req, res, url) {
  if (url.pathname !== "/internal/webhook-relay" || req.method !== "POST") return false;

  const secret = process.env.WEBHOOK_RELAY_SECRET;
  const raw = await readRawBody(req);
  if (!secret || !validSignature(secret, req.headers["x-relay-timestamp"], raw, req.headers["x-relay-signature"])) {
    res.writeHead(403); res.end(); return true;
  }

  let body;
  try { body = JSON.parse(raw); } catch { return sendJson(res, 400, { ok: false, error: "invalid json" }); }

  try {
    if (body.type === "twilio_status" && body.sid && body.status) {
      processTwilioStatusUpdate(body.sid, body.status);
    } else if (body.type === "twilio_inbound" && body.from) {
      processTwilioInboundMessage(body.from, body.body || "");
    } else if (body.type === "ses_notification" && body.raw) {
      processSesNotificationMessage(body.raw);
    } else {
      return sendJson(res, 400, { ok: false, error: "unknown or incomplete event" });
    }
    return sendJson(res, 200, { ok: true });
  } catch (e) {
    console.error("[webhook-relay] processing failed:", e.message);
    // 500 tells the receiver's retry loop to try again later -- never
    // acknowledge an event that didn't actually get applied.
    return sendJson(res, 500, { ok: false, error: e.message });
  }
}
