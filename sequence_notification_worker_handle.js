// Tiny shared singleton, same exact pattern as every other worker handle
// in this codebase -- holds nothing when the worker isn't enabled, every
// caller checks getSequenceNotificationWorker() and falls back to the
// next thread down the chain.
let workerRef = null;
export function setSequenceNotificationWorker(worker) { workerRef = worker; }
export function getSequenceNotificationWorker() { return workerRef; }
