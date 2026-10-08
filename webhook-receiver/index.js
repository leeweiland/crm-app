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

// RELAY_FETCH_TIMEOUT_MS > crm-app's own WORKER_REPLY_TIMEOUT_MS
// (webhook_relay_backend.js) -- a legitimately slow-but-real response
// should never get aborted out from under crm-app before IT would have
// given up on its own. Raised from 60s to 100s (2026-10-06) alongside
// crm-app's own timeout going 45s->90s -- confirmed live during a real
// disk-pressure spike that calls were completing right around 45-46s,
// just past the OLD ceiling on both sides; every near-miss was wasted
// work (the worker thread keeps running after the caller gives up, then
// the retry re-dispatches the same event on top of it) instead of just
// waiting the extra few seconds. Confirmed live (2026-10-05) why this
// can't be left unbounded, though: this fetch had no timeout at all, and
// runRelayLoop's relayLoopRunning guard only resets in a finally block
// AFTER every row's relayOne() call settles -- a single request that
// hangs forever (a TCP connection accepted mid-redeploy, then the
// container torn down without ever actually closing it) never settles,
// so relayLoopRunning stays true forever and every future 10s tick just
// returns immediately, same shape as scheduler.js's own _tickRunning bug
// on the crm-app side. Only a manual restart (clearing the in-memory
// flag) got it moving again.
const RELAY_FETCH_TIMEOUT_MS = 100_000;
// "Connection: close" (2026-10-07) -- confirmed live this service's own
// long-lived fetch connection pool was the actual cause of a real,
// reproducible stall: the EXACT SAME queued row that timed out every
// time through this relay loop processed in 429ms when dispatched fresh
// (a one-off script, brand-new TCP connection, identical payload and
// signature). This process stays alive across many of crm-app's own
// redeploys tonight -- a kept-alive connection pinned to a now-replaced
// crm-app instance would hang exactly like this, and a plain fetch()
// with no explicit connection management reuses connections by default.
// Forcing a fresh connection per request costs one extra TCP handshake
// each time, trivial next to the alternative (silently stuck behind a
// dead connection until the fetch timeout, every single request).
async function relayOne(row) {
  const rawBody = JSON.stringify({ type: row.type, ...row.payload });
  const { timestamp, signature } = signRelayBody(rawBody);
  const res = await fetch(`${CRM_APP_URL}/internal/webhook-relay`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Connection": "close", "x-relay-timestamp": String(timestamp), "x-relay-signature": signature },
    body: rawBody,
    signal: AbortSignal.timeout(RELAY_FETCH_TIMEOUT_MS),
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
    // Three real priority tiers, oldest-first within each -- a simple
    // "SMS before SES" split (first version of this fix, same day) wasn't
    // enough: twilio_status (delivery confirmations) sat in the same tier
    // as twilio_inbound (actual replies and compliance opt-outs like
    // "Stop"), and confirmed live, a steady trickle of real-time status
    // callbacks from an active send kept replenishing that tier just as
    // fast as it drained -- a "Stop" sitting at 0 attempts a full minute
    // after ses_notification stopped being the problem, still starved by
    // twilio_status rows that happened to be older. A reply or an opt-out
    // is categorically more urgent than a delivery receipt, which is itself
    // more urgent than bulk open/click analytics -- rank them explicitly
    // instead of relying on which type happens to have less volume at any
    // given moment.
    // Raised from 25 to 500 (2026-10-05) to actually drain the 59k+
    // ses_notification backlog (campaign open/click/delivery analytics) in
    // a reasonable time instead of ~6-7 hours. Safe to raise now in a way
    // it wasn't a few hours earlier tonight: twilio_inbound/twilio_status
    // dispatch to their own dedicated sms-worker thread, ses_notification
    // dispatches to the send-worker, and neither path can trigger an LLM
    // call anymore regardless of volume (Kai's Behavioral Outbound toggle
    // is off, so queueBehavioralTrigger finds zero eligible agents and
    // does nothing) -- so a much bigger batch of pure-file-I/O SES
    // analytics can't block a live reply OR rack up API cost, the two
    // failure modes a bigger batch would have hit earlier tonight. Still
    // sequential, not concurrent -- that part stays exactly as reverted
    // (95c8870): concurrency didn't help throughput before (everything
    // still serialized on the one destination thread either way) and
    // only created a pile of simultaneous requests crm-app had to hold
    // open at once. A bigger sequential batch increases real throughput
    // without that risk -- relayLoopRunning above already lets a pass
    // longer than RELAY_INTERVAL_MS run back-to-back into the next one
    // instead of waiting out the full 10s, so this scales cleanly.
    // PAUSE_SES_NOTIFICATIONS (2026-10-06) -- real emergency valve, not a
    // tuning knob: confirmed live that a large active campaign's own
    // Delivery/Open/Click notification volume was enough on its own to
    // saturate the disk crm-app's worker threads share, well past
    // anything a timeout/query tweak could paper over. Twilio rows are
    // UNAFFECTED (a real reply or a compliance "Stop" must never wait on
    // this) -- only ses_notification is held back, and nothing here
    // deletes or drops a row, they just sit as 'pending' until this is
    // unset, same as the manual paused_disk_pressure sweep this replaces.
    const PAUSE_SES_NOTIFICATIONS = process.env.PAUSE_SES_NOTIFICATIONS === "1";
    const { rows } = await pool.query(
      `SELECT * FROM webhook_queue WHERE status IN ('pending','failed') AND (last_attempt_at IS NULL OR last_attempt_at < now() - interval '10 seconds') AND ($1::boolean IS FALSE OR type <> 'ses_notification') ORDER BY (CASE type WHEN 'twilio_inbound' THEN 0 WHEN 'twilio_status' THEN 1 ELSE 2 END) ASC, created_at ASC LIMIT 500`,
      [PAUSE_SES_NOTIFICATIONS]
    );
    // REVERTED same day (2026-10-05), RE-INTRODUCED 2026-10-08 for
    // ses_notification ONLY -- the original revert's reasoning was
    // correct for what existed then: every row funneled through crm-app's
    // SAME single background-worker thread, so firing many at once just
    // piled up concurrent requests one thread still had to process in
    // order anyway. That's no longer true for ses_notification -- it now
    // has a real 4-thread dedicated pool (see ses_notification_worker_handle.js),
    // and this loop was STILL dispatching to it one row at a time, so 3 of
    // those 4 threads sat completely idle while the backlog drained at a
    // fraction of its real capacity. twilio_inbound/twilio_status still go
    // through ONE dedicated thread (sms_worker.js) -- those stay fully
    // sequential, unchanged, since concurrency there would just recreate
    // the original 2026-10-05 problem on that one thread.
    const SES_CONCURRENCY = 8; // > the pool's own 4 slots so hash collisions still keep most slots busy
    const twilioRows = rows.filter((r) => r.type !== "ses_notification");
    const sesRows = rows.filter((r) => r.type === "ses_notification");

    async function relayAndRecord(row) {
      try {
        await relayOne(row);
        await pool.query(`UPDATE webhook_queue SET status='delivered', delivered_at=now(), last_attempt_at=now() WHERE id=$1`, [row.id]);
      } catch (e) {
        await pool.query(`UPDATE webhook_queue SET status='failed', attempts=attempts+1, last_error=$2, last_attempt_at=now() WHERE id=$1`, [row.id, e.message]);
        console.error(`[webhook-receiver] relay failed for ${row.id} (attempt ${row.attempts + 1}):`, e.message);
      }
    }

    for (const row of twilioRows) await relayAndRecord(row);
    for (let i = 0; i < sesRows.length; i += SES_CONCURRENCY) {
      await Promise.all(sesRows.slice(i, i + SES_CONCURRENCY).map(relayAndRecord));
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
