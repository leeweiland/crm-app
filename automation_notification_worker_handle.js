// Tiny shared singleton, same exact pattern as every other worker handle
// in this codebase -- holds nothing when the worker isn't enabled, every
// caller checks getAutomationNotificationWorker() and falls back to the
// next thread down the chain.
let workerRef = null;
export function setAutomationNotificationWorker(worker) { workerRef = worker; }
export function getAutomationNotificationWorker() { return workerRef; }
