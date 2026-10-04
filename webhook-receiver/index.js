// crm-webhook-receiver -- a small, intentionally-boring service whose only
// job is to never lose a Twilio/SES webhook, even while the main crm-app
// is mid-redeploy (crm-app runs on a volume-attached Railway service, so
// its own deploys always have a sequential swap gap -- see railway.json's
// healthcheckPath comment in the main repo for why that gap exists at
// all). This service deploys far less often than crm-app and carries no
// volume, so it should rarely if ever be the thing that's down when a
// webhook arrives.
//
// Design: every incoming event is durably written to a `webhook_queue`
// table in the SAME Postgres database crm-app already mirrors contacts
// into, acknowledged back to Twilio/SES immediately, and only THEN
// relayed to crm-app's /internal/webhook-relay endpoint. If crm-app is
// unreachable, the event just sits in the queue as "pending" and a retry
// loop keeps trying it with backoff until crm-app comes back -- nothing
// is ever dropped on the floor because crm-app happened to be down for a
// minute during a deploy.
//
// This service does none of the actual business logic itself (no contact
// matching, no compliance checks, no cache writes) -- it only validates,
// queues, and relays. crm-app's existing processTwilioStatusUpdate /
// processTwilioInboundMessage / processSesNotificationMessage functions
// are still the ONLY code that ever touches contacts/message_log, so
// there is exactly one writer of that data, same as before this service
// existed.
import { createServer } from "http";
import { createHmac, randomUUID } from "crypto";
import pg from "pg";
import twilio from "twilio";

const PORT = process.env.PORT || 8080;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "";
const RELAY_SECRET = process.env.WEBHOOK_RELAY_SECRET || "";
const CRM_APP_URL = process.env.CRM_APP_URL || ""; // e.g. https://crm-app-production-eb8f.up.railway.app
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || ""; // this service's own public URL, for Twilio signature validation
const RELAY_INTERVAL_MS = 10_000;
const MAX_BACKOFF_MS = 5 * 60_000;
const MAX_SES_BODY_BYTES = 256 * 1024; // SES/SNS envelopes are a few KB; see crm-app's email_backend.js for the incident this mirrors

if (!TWILIO_AUTH_TOKEN) console.error("[webhook-receiver] WARNING: TWILIO_AUTH_TOKEN not set -- all Twilio signature checks will fail closed");
if (!RELAY_SECRET) console.error("[webhook-receiver] WARNING: WEBHOOK_RELAY_SECRET not set -- relay to crm-app will always be rejected");
if (!CRM_APP_URL) console.error("[webhook-receiver] WARNING: CRM_APP_URL not set -- nothing will ever be relayed, queue will grow unbounded");

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 5 });

async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS webhook_queue (
      id UUID PRIMARY KEY,
      type TEXT NOT NULL,
      payload JSONB NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INT NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_attempt_at TIMESTAMPTZ,
      delivered_at TIMESTAMPTZ
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS webhook_queue_pending_idx ON webhook_queue (status, last_attempt_at) WHERE status <> 'delivered'`);
}

async function enqueue(type, payload) {
  const id = randomUUID();
  await pool.query(`INSERT INTO webhook_queue (id, type, payload) VALUES ($1, $2, $3)`, [id, type, JSON.stringify(payload)]);
  return id;
}

function signRelayBody(rawBody) {
  const timestamp = Date.now();
  const signature = createHmac("sha256", RELAY_SECRET).update(`${timestamp}.${rawBody}`).digest("hex");
  return { timestamp, signature };
}

async function relayOne(row) {
  const rawBody = JSON.stringify({ type: row.type, ...row.payload });
  const { timestamp, signature } = signRelayBody(rawBody);
  const res = await fetch(`${CRM_APP_URL}/internal/webhook-relay`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-relay-timestamp": String(timestamp), "x-relay-signature": signature },
    body: rawBody,
  });
  if (!res.ok) throw new Error(`crm-app returned ${res.status}`);
}

// Guards against overlapping passes -- setInterval fires on a fixed
// schedule regardless of whether the previous call finished, and a batch
// of up to 25 rows relayed one at a time can take longer than
// RELAY_INTERVAL_MS to drain (confirmed live: catching up on over an
// hour of backlog after a pause). Without this, multiple passes run
// concurrently, each sending its own relay calls, piling concurrent
// requests onto crm-app's single background-worker thread at once --
// same class of bug as scheduler.js's own "previous tick still running"
// guard on the crm-app side, just in this service instead.
let relayLoopRunning = false;
async function runRelayLoop() {
  if (!CRM_APP_URL || !RELAY_SECRET) return;
  if (relayLoopRunning) return;
  relayLoopRunning = true;
  try {
    // Oldest-first, skip anything attempted in the last 10s (lets a fresh
    // failure's own imminent retry own the row instead of double-firing).
    const { rows } = await pool.query(
      `SELECT * FROM webhook_queue WHERE status IN ('pending','failed') AND (last_attempt_at IS NULL OR last_attempt_at < now() - interval '10 seconds') ORDER BY created_at ASC LIMIT 25`
    );
    for (const row of rows) {
      try {
        await relayOne(row);
        await pool.query(`UPDATE webhook_queue SET status='delivered', delivered_at=now(), last_attempt_at=now() WHERE id=$1`, [row.id]);
      } catch (e) {
        await pool.query(`UPDATE webhook_queue SET status='failed', attempts=attempts+1, last_error=$2, last_attempt_at=now() WHERE id=$1`, [row.id, e.message]);
        console.error(`[webhook-receiver] relay failed for ${row.id} (attempt ${row.attempts + 1}):`, e.message);
      }
    }
  } catch (e) {
    console.error("[webhook-receiver] relay loop error:", e.message);
  } finally {
    relayLoopRunning = false;
  }
}

function readRawBody(req, maxBytes = Infinity) {
  return new Promise((resolve) => {
    let body = "";
    let bytes = 0;
    let done = false;
    req.on("data", (d) => {
      if (done) return;
      bytes += d.length;
      if (bytes > maxBytes) { done = true; req.destroy(); resolve(null); return; }
      body += d;
    });
    req.on("end", () => { if (!done) resolve(body); });
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === "/health" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "text/plain" }); res.end("ok"); return;
  }

  if (url.pathname === "/webhooks/twilio/inbound" && req.method === "POST") {
    const raw = await readRawBody(req);
    const params = Object.fromEntries(new URLSearchParams(raw));
    const signature = req.headers["x-twilio-signature"];
    const fullUrl = PUBLIC_BASE_URL + url.pathname;
    if (!TWILIO_AUTH_TOKEN || !twilio.validateRequest(TWILIO_AUTH_TOKEN, signature, fullUrl, params)) {
      res.writeHead(403); res.end(); return;
    }
    await enqueue("twilio_inbound", { from: params.From, body: params.Body || "" });
    res.writeHead(200, { "Content-Type": "text/xml" });
    res.end("<Response></Response>");
    return;
  }

  if (url.pathname === "/webhooks/twilio/status" && req.method === "POST") {
    const raw = await readRawBody(req);
    const params = Object.fromEntries(new URLSearchParams(raw));
    const signature = req.headers["x-twilio-signature"];
    const fullUrl = PUBLIC_BASE_URL + url.pathname;
    if (!TWILIO_AUTH_TOKEN || !twilio.validateRequest(TWILIO_AUTH_TOKEN, signature, fullUrl, params)) {
      res.writeHead(403); res.end(); return;
    }
    const statusMap = { queued: "queued", sent: "sent", delivered: "delivered", undelivered: "failed", failed: "failed" };
    if (params.MessageSid && statusMap[params.MessageStatus]) {
      await enqueue("twilio_status", { sid: params.MessageSid, status: statusMap[params.MessageStatus] });
    }
    res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (url.pathname === "/webhooks/ses" && req.method === "POST") {
    const raw = await readRawBody(req, MAX_SES_BODY_BYTES);
    if (raw === null) { res.writeHead(413); res.end(); return; }
    let body;
    try { body = JSON.parse(raw); } catch { res.writeHead(400); res.end(); return; }
    if (body.Type === "SubscriptionConfirmation" && body.SubscribeURL) {
      try { await fetch(body.SubscribeURL); } catch {}
      res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: true })); return;
    }
    if (body.Type === "Notification") {
      await enqueue("ses_notification", { raw: body.Message });
    }
    res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: true }));
    return;
  }

  res.writeHead(404); res.end();
});

ensureSchema()
  .then(() => {
    server.listen(PORT, () => console.log(`[webhook-receiver] listening on ${PORT}`));
    setInterval(runRelayLoop, RELAY_INTERVAL_MS);
  })
  .catch((e) => { console.error("[webhook-receiver] schema setup failed, exiting:", e.message); process.exit(1); });
