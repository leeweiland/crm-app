// Tiny shared singleton so campaigns_backend.js's sendCampaignNow can hand
// a send off to the dedicated send worker thread (see send_worker.js)
// without a circular import back to server.js, which is the only place
// that actually spawns it. Same exact pattern as background_worker_handle.js
// -- holds nothing when SEND_WORKER isn't enabled, every caller checks
// getSendWorker() and falls back to the existing background worker (or
// inline), so this file changes no behavior by itself.
let workerRef = null;
export function setSendWorker(worker) { workerRef = worker; }
export function getSendWorker() { return workerRef; }
