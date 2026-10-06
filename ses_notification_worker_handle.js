// Tiny shared singleton so webhook_relay_backend.js and email_backend.js can
// hand SES notification processing off to its own dedicated thread (see
// ses_notification_worker.js) without a circular import back to server.js,
// which is the only place that actually spawns it. Same exact pattern as
// background_worker_handle.js/send_worker_handle.js/sms_worker_handle.js --
// holds nothing when the worker isn't enabled, every caller checks
// getSesNotificationWorker() and falls back to the next thread down the
// chain, so this file changes no behavior by itself.
let workerRef = null;
export function setSesNotificationWorker(worker) { workerRef = worker; }
export function getSesNotificationWorker() { return workerRef; }
