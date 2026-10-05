// Per-send timing/diagnostics log for email_backend.js's sendEmail and
// sms_backend.js's sendSms -- built to answer a concrete question (2026-10-04
// campaign crisis): the rate-limiter in campaigns_backend.js paces batches
// to SES_MAX_SEND_RATE correctly (confirmed by direct measurement -- batches
// that aren't stalled land right at the intended ~13/sec), but roughly half
// of all real batches stalled 5-45s anyway, eating 91% of total send time.
// Promise.all waits for the SLOWEST member of each 12-wide batch, so the
// leading hypothesis is per-call AWS retry/backoff on a subset of sends
// dragging the whole batch down -- this records enough per-call detail
// (duration, and for SES specifically, $metadata.attempts/totalRetryDelay,
// which directly exposes whether the AWS SDK silently retried a throttled
// call) to confirm or rule that out with real data instead of guessing
// again next time.
//
// Deliberately NOT using auth_backend.js's readJson/writeJson/withFileLock
// helpers -- those are under live suspicion as the cause of the scheduler's
// multi-day freeze (a legitimate multi-second write on crm_contacts.json,
// 194MB, can exceed the lock's own 10s stale-lock timeout and get its lock
// stolen mid-write; see that investigation). A raw appendFileSync needs no
// lock at all: POSIX guarantees an O_APPEND write under PIPE_BUF is atomic,
// and every line here is a complete, independent JSON value, so even a
// pathological interleaving at worst costs one unparseable line later --
// never a corrupted file, and never a send blocked waiting on a lock.
import { appendFileSync } from "fs";
import { join } from "path";
import { DATA_DIR } from "./auth_backend.js";

const SEND_TIMING_FILE = join(DATA_DIR, "crm_send_timing.jsonl");

export function recordSendTiming(record) {
  try {
    appendFileSync(SEND_TIMING_FILE, JSON.stringify({ ts: new Date().toISOString(), ...record }) + "\n");
  } catch (e) {
    console.error("[send-timing] failed to record:", e.message);
  }
}
