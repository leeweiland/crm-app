// Shared pool handle so webhook_relay_backend.js and email_backend.js can
// hand SES notification processing off to its own dedicated threads (see
// ses_notification_worker.js) without a circular import back to server.js,
// which is the only place that actually spawns them. Same exact pattern as
// background_worker_handle.js/send_worker_handle.js/sms_worker_handle.js --
// holds nothing when the worker isn't enabled, every caller checks
// getSesNotificationWorker()/getSesNotificationWorkerByKey() and falls back
// to the next thread down the chain, so this file changes no behavior by
// itself.
//
// Pool, not a single worker (2026-10-07) -- confirmed live the backlog
// drained at only ~2.5/sec fully sequential on one thread, even after
// fixing the one algorithmic O(N) bug (Delivery's full-file rewrite).
// Per-notification work is now mostly bounded (a few small synchronous
// writes to that ONE contact's own files), so multiple OS threads
// genuinely can make independent progress at once on DIFFERENT contacts'
// files -- unlike the earlier, different mistake (Promise.all dispatching
// many requests to this SAME single thread, which only piled up work a
// lone thread still had to do one at a time; see webhook_relay_backend.js's
// own comment on that). getSesNotificationWorker() (no key) keeps
// returning the first live slot, for callers (email_backend.js's direct
// webhook route) that don't need load-spread, just a worker.
const POOL_SIZE = 4;
const pool = new Array(POOL_SIZE).fill(null);
export const SES_NOTIFICATION_POOL_SIZE = POOL_SIZE;

export function setSesNotificationWorker(index, worker) { pool[index] = worker; }
export function getSesNotificationWorker() { return pool.find(w => w) || null; }

// Deterministic, not random -- same key always maps to the same slot, so
// repeated retries of the identical queued row (webhook-receiver's own
// retry-on-failure loop) keep landing on the same thread instead of
// scattering, which doesn't matter for correctness here but keeps
// behavior predictable to reason about. Falls back to any live worker if
// the chosen slot hasn't spawned yet (process just started) or crashed
// and hasn't respawned this instant, rather than silently dropping the
// request -- same "degrade gracefully" shape as every other fallback in
// this chain.
export function getSesNotificationWorkerByKey(key) {
  let h = 0;
  const s = String(key || "");
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  const idx = Math.abs(h) % POOL_SIZE;
  return pool[idx] || pool.find(w => w) || null;
}
