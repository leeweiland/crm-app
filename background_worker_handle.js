// Tiny shared singleton so a request handler on the main thread (e.g. the
// Twilio/SES webhook endpoints) can hand work off to the background worker
// thread (see background_worker.js) without a circular import back to
// server.js, which is the only place that actually spawns it. Holds
// nothing when BACKGROUND_WORKER isn't enabled -- every caller checks
// getBackgroundWorker() and falls back to processing inline, so this file
// changes no behavior by itself.
let workerRef = null;
export function setBackgroundWorker(worker) { workerRef = worker; }
export function getBackgroundWorker() { return workerRef; }
