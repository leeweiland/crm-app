import { readJson, writeJson, USERS_FILE } from "./auth_backend.js";
import { STAFF_ACTIVITY_FILE } from "./segments_shared.js";

// "Is a team member already in a conversation with this contact?" -- the
// signal behind segments that must leave out anyone Alexis (or Josh...) is
// already emailing or texting, so two people never work the same lead.
//
// Kept as its own small index ({ [userId]: { [contactId]: lastActivityISO } })
// instead of a field on each contact for two reasons: writing it never has to
// touch the ~190MB contacts file (a single-contact write costs ~5s on
// production), and evaluating a segment stays a plain lookup rather than a
// scan of the message log. logMessage() (message_log.js) feeds it live; the
// history before this existed is merged in once via mergeStaffActivity().
//
// What counts as "involving" a team member:
//   - a message they sent through the CRM's own inbox (email or SMS): the row's
//     sourceType is "inbox" and its sourceId is their user id
//   - any outbound email whose From address is theirs (their Gmail's own sent
//     mail, and Close-era emails imported from their old inbox)
//   - any inbound email addressed To their address
// An inbound SMS carries no team member (everyone shares one Twilio number),
// but it only ever lands on a thread someone already texted from, which the
// first rule has counted.

const ADDRESS_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
function addressesIn(header) { return (String(header || "").match(ADDRESS_RE) || []).map(a => a.toLowerCase()); }
function userEmails(u) { return [u.email, u.gmailEmail].filter(Boolean).map(e => e.toLowerCase()); }

// The user ids a logged message is a conversation with (usually 0 or 1).
export function staffUserIdsForMessage(row, users) {
  const ids = new Set();
  if (row.direction === "outbound" && row.sourceType === "inbox" && row.sourceId && users.some(u => u.id === row.sourceId)) ids.add(row.sourceId);
  if (row.channel === "email") {
    const addrs = new Set(addressesIn(row.direction === "outbound" ? row.from : row.to));
    if (addrs.size) for (const u of users) if (userEmails(u).some(e => addrs.has(e))) ids.add(u.id);
  }
  return [...ids];
}

// Called for every logged message (message_log.js). Must never throw or slow
// the send/receive it rides on, so it's fully guarded and only writes when the
// stored date would actually move forward.
export function noteStaffActivity(row) {
  try {
    if (!row.contactId || row.status === "failed") return;
    const users = readJson(USERS_FILE, []);
    const userIds = staffUserIdsForMessage(row, users);
    if (!userIds.length) return;
    const at = row.createdAt || new Date().toISOString();
    const idx = readJson(STAFF_ACTIVITY_FILE, {});
    let changed = false;
    for (const uid of userIds) {
      const mine = (idx[uid] = idx[uid] || {});
      if (!mine[row.contactId] || Date.parse(at) > Date.parse(mine[row.contactId])) { mine[row.contactId] = at; changed = true; }
    }
    if (changed) writeJson(STAFF_ACTIVITY_FILE, idx);
  } catch (e) { console.error("[staff_activity] note failed:", e.message); }
}

// entries: { [userId]: { [contactId]: lastActivityISO } } -- keeps whichever
// date is later, so re-running a history rebuild is harmless.
export function mergeStaffActivity(entries) {
  const idx = readJson(STAFF_ACTIVITY_FILE, {});
  let added = 0, moved = 0;
  for (const [uid, byContact] of Object.entries(entries || {})) {
    const mine = (idx[uid] = idx[uid] || {});
    for (const [cid, at] of Object.entries(byContact || {})) {
      if (isNaN(Date.parse(at))) continue;
      if (!mine[cid]) { mine[cid] = at; added++; }
      else if (Date.parse(at) > Date.parse(mine[cid])) { mine[cid] = at; moved++; }
    }
  }
  writeJson(STAFF_ACTIVITY_FILE, idx);
  return { added, moved, perUser: Object.fromEntries(Object.entries(idx).map(([u, m]) => [u, Object.keys(m).length])) };
}
