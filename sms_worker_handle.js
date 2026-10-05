// Tiny shared singleton so webhook_relay_backend.js and sms_backend.js can
// hand Twilio webhook processing off to the dedicated SMS worker thread
// (see sms_worker.js) without a circular import back to server.js, which
// is the only place that actually spawns it. Same exact pattern as
// background_worker_handle.js/send_worker_handle.js -- holds nothing when
// the worker isn't enabled, every caller checks getSmsWorker() and falls
// back to the existing background worker (or inline), so this file
// changes no behavior by itself.
let workerRef = null;
export function setSmsWorker(worker) { workerRef = worker; }
export function getSmsWorker() { return workerRef; }
