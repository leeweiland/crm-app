// Live cross-tab/cross-user SSE broadcast for the Inbox sidebar -- split
// out from inbox_backend.js so message_log.js (the one place every inbound
// message, any channel, already passes through) can push a "new_message"
// event too, not just the "done" broadcast inbox_backend.js's own /done
// handler sends. message_log.js can't import inbox_backend.js directly --
// inbox_backend.js already imports FROM message_log.js, so that would be a
// straight A<->B cycle -- but both can safely import this tiny shared file.
//
// Plain Set of raw ServerResponse objects -- this app is a single Node
// process (no multi-instance/Redis fanout needed), so an in-memory registry
// is enough.
export const sseClients = new Set();
export function broadcastInboxUpdate(payload) {
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) {
    try { res.write(data); } catch { sseClients.delete(res); }
  }
}
