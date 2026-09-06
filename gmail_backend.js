import { readJson, writeJson, sendJson, getSessionUser, isAdmin, USERS_FILE } from "./auth_backend.js";
import { CONTACTS_FILE } from "./segments_shared.js";
import { logMessage, PROVIDER_ID_INDEX_FILE } from "./message_log.js";
import { checkConversionGoal } from "./workflows_backend.js";
import { sqliteInboxAvailable, findContactIdByEmail } from "./sqlite_inbox.js";

// Per-user Gmail connection for capturing inbound email replies -- same
// idea as Close's "just add it as a user", not a domain-level SES/MX setup:
// each staff member connects their OWN Gmail via OAuth (Settings > My
// Account), and this polls THEIR mailbox for mail from known contacts,
// same 30s scheduler tick every other timed feature in this app already
// uses. Zero risk to the real pacificrimathletics.com mail flow -- nothing
// about DNS or where mail actually gets delivered changes; this only ever
// reads a copy via the Gmail API, same as Close did.
//
// Scope is gmail.readonly -- this never sends, modifies, or deletes
// anything in a connected mailbox, only lists/reads messages.
const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const REDIRECT_PATH = "/api/auth/gmail/callback";

// Deliberately its own OAuth client (GOOGLE_GMAIL_CLIENT_ID/_SECRET), NOT
// scheduling_backend.js's GOOGLE_CLIENT_ID/_SECRET -- that one is a
// "Desktop app" OAuth client (see get_calendar_token.js), which Google
// only allows localhost-loopback redirect URIs for, by policy, with no
// way to register a real HTTPS one at all (confirmed live: the Cloud
// Console UI for that client type has no "Authorized redirect URIs"
// field to add one to). A per-user web OAuth flow with a real callback
// URL needs a "Web application" type client instead, which supports
// arbitrary HTTPS redirect URIs -- see the Settings > My Account "Connect
// Gmail" button's own setup instructions for creating one.
function googleConfigured() {
  return !!(process.env.GOOGLE_GMAIL_CLIENT_ID && process.env.GOOGLE_GMAIL_CLIENT_SECRET);
}
function redirectUri(req) {
  // Railway terminates TLS in front of the app -- req itself sees plain
  // HTTP, so this can't just read req's own protocol. Same reasoning as
  // getPublicBaseUrl()'s callers elsewhere; hardcoded here rather than
  // importing that (this module has no other dependency on integrations_
  // backend.js and the CRM only runs at this one domain).
  return "https://crm-app-production-eb8f.up.railway.app" + REDIRECT_PATH;
}

async function exchangeCodeForTokens(code, req) {
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code, client_id: process.env.GOOGLE_GMAIL_CLIENT_ID, client_secret: process.env.GOOGLE_GMAIL_CLIENT_SECRET,
      redirect_uri: redirectUri(req), grant_type: "authorization_code",
    }),
  });
  const d = await r.json();
  if (!d.refresh_token) throw new Error(d.error_description || d.error || "No refresh token returned");
  return d;
}
// Every Gmail/OAuth call the scheduler's tick makes gets a hard timeout --
// these all used to hang indefinitely on a slow/unresponsive Google
// endpoint, which (combined with everything being sequential on one
// shared tick) could stall the poll, and everything queued behind it,
// for as long as Google felt like taking. 10s is generous for a real
// Google API call but still bounded.
const GMAIL_FETCH_TIMEOUT_MS = 10000;
function gmailFetchTimeout() { return AbortSignal.timeout(GMAIL_FETCH_TIMEOUT_MS); }

async function getAccessToken(refreshToken) {
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_GMAIL_CLIENT_ID, client_secret: process.env.GOOGLE_GMAIL_CLIENT_SECRET,
      refresh_token: refreshToken, grant_type: "refresh_token",
    }),
    signal: gmailFetchTimeout(),
  });
  const d = await r.json();
  if (!d.access_token) throw new Error("Gmail token refresh failed: " + JSON.stringify(d));
  return d.access_token;
}

export async function handleGmailRequest(req, res, url) {
  const p = url.pathname;

  if (p === "/api/auth/gmail/connect" && req.method === "GET") {
    const me = getSessionUser(req);
    if (!me) return sendJson(res, 401, { error: "Not logged in" });
    if (!googleConfigured()) return sendJson(res, 400, { error: "Google OAuth isn't configured (GOOGLE_GMAIL_CLIENT_ID/GOOGLE_GMAIL_CLIENT_SECRET missing)" });
    // state carries which CRM user this connection belongs to -- the
    // callback below can't rely on the session cookie (Google's redirect
    // back is a fresh top-level navigation from google.com, not guaranteed
    // to be treated as "same site" by every browser/cookie setting the
    // same way this app's own navigations are).
    const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?` +
      `client_id=${encodeURIComponent(process.env.GOOGLE_GMAIL_CLIENT_ID)}&redirect_uri=${encodeURIComponent(redirectUri(req))}` +
      `&response_type=code&scope=${encodeURIComponent(GMAIL_SCOPE)}&access_type=offline&prompt=consent&state=${encodeURIComponent(me.id)}`;
    res.writeHead(302, { Location: authUrl });
    res.end();
    return true;
  }

  if (p === REDIRECT_PATH && req.method === "GET") {
    const code = url.searchParams.get("code");
    const userId = url.searchParams.get("state");
    const users = readJson(USERS_FILE, []);
    const user = users.find(u => u.id === userId);
    const fail = (msg) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!DOCTYPE html><html><body style="font-family:sans-serif;text-align:center;padding:60px 20px"><h2>Couldn't connect Gmail</h2><p>${msg}</p><p><a href="/settings.html">Back to Settings</a></p></body></html>`);
    };
    if (!code || !user) { fail("Missing authorization code or unknown user."); return true; }
    try {
      const tokens = await exchangeCodeForTokens(code, req);
      const profileRes = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", { headers: { Authorization: `Bearer ${tokens.access_token}` } });
      const profile = await profileRes.json();
      user.gmailRefreshToken = tokens.refresh_token;
      user.gmailEmail = profile.emailAddress || null;
      // Seed the watermark at the CURRENT historyId -- polling starts from
      // here, so connecting an account never backfills someone's entire
      // existing inbox into the CRM, only mail that arrives from now on.
      user.gmailHistoryId = profile.historyId || null;
      writeJson(USERS_FILE, users);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!DOCTYPE html><html><body style="font-family:sans-serif;text-align:center;padding:60px 20px"><h2>Gmail connected</h2><p>${profile.emailAddress || ""}</p><p><a href="/settings.html">Back to Settings</a></p></body></html>`);
    } catch (e) {
      fail(e.message);
    }
    return true;
  }

  if (p === "/api/auth/gmail/status" && req.method === "GET") {
    const me = getSessionUser(req);
    if (!me) return sendJson(res, 401, { error: "Not logged in" });
    const user = readJson(USERS_FILE, []).find(u => u.id === me.id);
    return sendJson(res, 200, { connected: !!user?.gmailRefreshToken, email: user?.gmailEmail || null });
  }

  // Admin-only roster of who on the team has connected Gmail -- lets an
  // admin see at a glance whose replies are actually flowing into the
  // Inbox without having to ask each person individually.
  if (p === "/api/auth/gmail/team-status" && req.method === "GET") {
    const me = getSessionUser(req);
    if (!me) return sendJson(res, 401, { error: "Not logged in" });
    if (!isAdmin(me)) return sendJson(res, 403, { error: "Admins only" });
    const team = readJson(USERS_FILE, []).filter(u => !u.archived).map(u => ({
      id: u.id, first: u.first, last: u.last, email: u.email,
      connected: !!u.gmailRefreshToken, gmailEmail: u.gmailEmail || null,
    }));
    return sendJson(res, 200, { team });
  }

  if (p === "/api/auth/gmail/disconnect" && req.method === "POST") {
    const me = getSessionUser(req);
    if (!me) return sendJson(res, 401, { error: "Not logged in" });
    const users = readJson(USERS_FILE, []);
    const user = users.find(u => u.id === me.id);
    if (user) { delete user.gmailRefreshToken; delete user.gmailEmail; delete user.gmailHistoryId; writeJson(USERS_FILE, users); }
    return sendJson(res, 200, { ok: true });
  }

  // Manual recovery tool for exactly the gap reconcileRecentOutboundGmail
  // exists for -- the poller's historyId diff permanently drops anything
  // past MAX_MESSAGES_PER_TICK or a stale watermark, so an admin needs a
  // way to force a re-check without waiting for someone to individually
  // open every affected conversation. Runs IN this request handler (the
  // server's own process/DB connection), not a separate script -- a
  // second process opening its own SQLite connection loses the write-lock
  // race against this server's live traffic every time (confirmed live
  // twice already tonight, see sqlite_inbox.js's backfillPreviewText
  // comment for the first).
  if (p === "/api/auth/gmail/reconcile-recent" && (req.method === "POST" || req.method === "GET")) {
    const me = getSessionUser(req);
    if (!me) return sendJson(res, 401, { error: "Not logged in" });
    if (!isAdmin(me)) return sendJson(res, 403, { error: "Admins only" });
    const hours = Number(url.searchParams.get("hours")) || 24;
    try {
      const results = await reconcileRecentOutboundGmail(hours);
      return sendJson(res, 200, { ok: true, results });
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  return false;
}

// ── Base64url MIME decoding + plain-text extraction ─────────────────────
function b64urlDecode(s) {
  return Buffer.from(String(s || "").replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}
// Gmail messages are a tree of parts (multipart/alternative, multipart/
// mixed with attachments, etc.) -- walks it depth-first for the first
// text/plain part, falling back to a tag-stripped text/html part (same
// "plain text preferred, HTML stripped as fallback" shape chat-app's own
// inbound handling would need, kept simple since Inbox bubbles are plain
// text either way -- see noteBubbleHtml/smsBubbleHtml in inbox.html).
function extractBody(payload) {
  let plain = null, html = null;
  function walk(part) {
    if (!part) return;
    if (part.mimeType === "text/plain" && part.body?.data && !plain) plain = b64urlDecode(part.body.data);
    else if (part.mimeType === "text/html" && part.body?.data && !html) html = b64urlDecode(part.body.data);
    (part.parts || []).forEach(walk);
  }
  walk(payload);
  if (plain) return plain.trim();
  if (html) return html.replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return "";
}
function headerValue(headers, name) {
  return (headers || []).find(h => h.name.toLowerCase() === name.toLowerCase())?.value || "";
}
// "Coach Lee <lee@pacificrimathletics.com>" -> "lee@pacificrimathletics.com"
function extractEmailAddress(headerVal) {
  const m = String(headerVal || "").match(/<([^>]+)>/);
  return (m ? m[1] : headerVal).trim().toLowerCase();
}

let contactsByEmailCache = null;
let contactsByEmailCacheBuiltAt = 0;
// How long the full-contacts-file fallback cache stays valid before a poll
// is willing to pay for rebuilding it. This USED to be wiped at the start
// of every single checkGmailInbox() call (see that function's own history)
// -- meaning any tick that saw a genuinely new sender (common: contacts
// have altEmails the SQLite fast path below doesn't index) paid for a full
// synchronous JSON.parse of the ~190MB contacts file, on the live
// server's one and only thread, every 30 seconds. Confirmed live: this is
// what froze the entire app repeatedly on 2026-09-05 -- every other
// request queues up behind that one parse until it finishes. 10 minutes
// bounds a brand-new contact being briefly unmatched by a poll that
// happens to land right after they're created, which is a far cheaper
// mistake than freezing the whole app on a 30-second cadence.
const CONTACTS_EMAIL_CACHE_TTL_MS = 10 * 60 * 1000;
function getContactIdByEmail(email) {
  if (!email) return null;
  // Fast path: the sidebar's own SQLite snapshot already has an email
  // column for every conversation that exists -- covers "a known lead
  // replied," the overwhelmingly common case, without ever touching the
  // ~190MB contacts file. Only a genuinely new sender (no conversation
  // yet) falls through to a real contacts lookup, and that one full read
  // is cached for the rest of THIS poll cycle (not re-read per message)
  // since a single tick can easily process several new emails at once.
  if (sqliteInboxAvailable()) {
    const id = findContactIdByEmail(email);
    if (id) return id;
  }
  if (!contactsByEmailCache || Date.now() - contactsByEmailCacheBuiltAt > CONTACTS_EMAIL_CACHE_TTL_MS) {
    contactsByEmailCache = new Map();
    for (const c of readJson(CONTACTS_FILE, [])) {
      if (c.email) contactsByEmailCache.set(c.email.toLowerCase(), c.id);
      for (const alt of c.altEmails || []) contactsByEmailCache.set(alt.toLowerCase(), c.id);
    }
    contactsByEmailCacheBuiltAt = Date.now();
  }
  return contactsByEmailCache.get(email) || null;
}

// Shared by the 30s poll tick below AND the two on-demand reconciliation
// entry points further down (reconcileRecentGmailForContact/
// reconcileRecentOutboundGmail) -- those don't go through the historyId
// diff at all (they re-derive truth straight from a Gmail search instead,
// since historyId is exactly what silently dropped messages when the
// poller was paused/capped -- see MAX_MESSAGES_PER_TICK's own comment), so
// the same message can genuinely be handed to this function twice by two
// different callers. providerMessageId is Gmail's own message id, globally
// unique per mailbox, so it's the one thing safe to dedupe against
// regardless of which path found it.
async function processGmailMessage(user, msg) {
  if (readJson(PROVIDER_ID_INDEX_FILE, {})[msg.id]) return; // already logged, by this path or another
  const fromHeader = headerValue(msg.payload?.headers, "From");
  const fromEmail = extractEmailAddress(fromHeader);
  if (!fromEmail) return;
  const isFromMe = fromEmail === user.gmailEmail?.toLowerCase();
  const subject = headerValue(msg.payload?.headers, "Subject");
  const body = extractBody(msg.payload);
  // Gmail's own record of when the message actually landed/was sent, not
  // whenever this happens to run -- load-bearing for reconciliation, which
  // can discover a message hours after the fact and needs it to sort into
  // its true place in the thread instead of jumping to the top.
  const createdAt = msg.internalDate ? new Date(Number(msg.internalDate)).toISOString() : undefined;

  if (isFromMe) {
    const toHeader = headerValue(msg.payload?.headers, "To");
    const toEmail = extractEmailAddress(toHeader);
    const contactId = toEmail ? getContactIdByEmail(toEmail) : null;
    if (!contactId) return; // sent to someone who isn't a known lead -- not the CRM's concern
    logMessage({
      channel: "email", direction: "outbound", contactId,
      sourceType: "gmail_sent", sourceId: null, providerMessageId: msg.id,
      to: toHeader, from: fromHeader, subject, body, bodyPreview: body.slice(0, 140),
      status: "sent", createdAt,
    });
    return;
  }

  const contactId = getContactIdByEmail(fromEmail);
  if (!contactId) return; // not a known lead/contact -- not the CRM's concern
  logMessage({
    channel: "email", direction: "inbound", contactId,
    sourceType: "inbound", sourceId: null, providerMessageId: msg.id,
    to: user.gmailEmail, from: fromHeader, subject, body, bodyPreview: body.slice(0, 140),
    status: "received", createdAt,
  });
  checkConversionGoal("incoming_email", contactId);
}

// Re-derives truth straight from a Gmail search instead of trusting
// historyId -- used both by the one-time last-24h catch-up (see
// reconcileRecentOutboundGmail) and by the per-contact on-open check
// below. `q` is a normal Gmail search query string.
async function fetchAndProcessGmailQuery(user, accessToken, q) {
  const auth = { Authorization: `Bearer ${accessToken}` };
  const listRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(q)}&maxResults=100`, { headers: auth, signal: gmailFetchTimeout() });
  const list = await listRes.json();
  if (!listRes.ok || !list.messages?.length) return 0;
  let found = 0;
  for (const { id } of list.messages) {
    try {
      const msgRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`, { headers: auth, signal: gmailFetchTimeout() });
      const msg = await msgRes.json();
      if (!msgRes.ok) continue;
      const already = readJson(PROVIDER_ID_INDEX_FILE, {})[msg.id];
      await processGmailMessage(user, msg);
      if (!already) found++;
    } catch (e) {
      console.error(`[gmail] reconcile: processing message ${id} failed:`, e.message);
    }
  }
  return found;
}

// On-demand, single-contact reconciliation -- fired (fire-and-forget, see
// inbox_backend.js's /opened route) every time someone actually opens a
// conversation, instead of a scheduled sweep across all ~176k contacts.
// A contact nobody looks at costs nothing; one that's open gets checked
// against every connected mailbox for anything the 30s poll's historyId
// diff might have missed (a paused poller, a capped backlog -- see
// MAX_MESSAGES_PER_TICK) at the moment someone would actually notice a gap.
export async function reconcileRecentGmailForContact(contactId, windowDays = 14) {
  const contact = readJson(CONTACTS_FILE, []).find(c => c.id === contactId);
  const emails = [contact?.email, ...(contact?.altEmails || [])].filter(Boolean);
  if (!emails.length) return;
  const users = readJson(USERS_FILE, []).filter(u => u.gmailRefreshToken);
  if (!users.length) return;
  const participantQ = `(${emails.map(e => `to:${e} OR from:${e}`).join(" OR ")}) newer_than:${windowDays}d`;
  for (const user of users) {
    try {
      const accessToken = await getAccessToken(user.gmailRefreshToken);
      await fetchAndProcessGmailQuery(user, accessToken, participantQ);
    } catch (e) {
      console.error(`[gmail] per-contact reconcile failed for ${user.gmailEmail || user.id}:`, e.message);
    }
  }
}

// One-time (2026-09-06) catch-up: recovers whatever the 30s poller dropped
// while it was being repeatedly paused/resumed for load testing tonight --
// historyId already advanced past the gap (see MAX_MESSAGES_PER_TICK's own
// comment on why that's permanent for the diff path), so this re-derives
// straight from each connected mailbox's own Sent folder instead of
// trusting that watermark. Scoped to the last day and to Sent only
// (the reported gap is specifically missing outbound replies), not a
// history-of-everything trawl.
export async function reconcileRecentOutboundGmail(hours = 24) {
  const users = readJson(USERS_FILE, []).filter(u => u.gmailRefreshToken);
  const results = [];
  for (const user of users) {
    try {
      const accessToken = await getAccessToken(user.gmailRefreshToken);
      const days = Math.max(1, Math.ceil(hours / 24));
      const found = await fetchAndProcessGmailQuery(user, accessToken, `in:sent newer_than:${days}d`);
      results.push({ user: user.gmailEmail || user.email, recovered: found });
    } catch (e) {
      results.push({ user: user.gmailEmail || user.email, error: e.message });
    }
  }
  return results;
}

// ── Poll (scheduler tick) ────────────────────────────────────────────────
// Gmail's history API is incremental (only what changed since a watermark
// historyId), same "never re-scan everything" principle as this app's own
// per-contact message files -- so a mailbox with thousands of messages
// costs the same O(new mail since last tick) every poll, not O(mailbox size).
export async function checkGmailInbox() {
  // Read the FULL roster and filter down to a separate list to iterate --
  // the loop below mutates entries in place and, when anything changed,
  // writes `allUsers` (every user) back, never the filtered subset. This
  // used to filter and reassign `users` to the connected-only subset, then
  // write THAT back to USERS_FILE -- silently deleting every user who
  // hadn't connected Gmail (an admin's own historyId update was enough to
  // trigger the write) on every 30s tick where it happened to fire.
  // Confirmed live: this is what wiped crm_users.json down to a single
  // account, repeatedly, on 2026-09-03.
  const allUsers = readJson(USERS_FILE, []);
  const users = allUsers.filter(u => u.gmailRefreshToken);
  if (!users.length) return;
  // NOT reset per tick anymore -- see getContactIdByEmail's own cache/TTL
  // comment above for why forcing a rebuild here, every 30 seconds, is
  // exactly what froze the app.
  let usersChanged = false;

  for (const user of users) {
    try {
      const accessToken = await getAccessToken(user.gmailRefreshToken);
      const auth = { Authorization: `Bearer ${accessToken}` };
      if (!user.gmailHistoryId) continue; // shouldn't happen post-connect, but nothing to diff against

      // No &labelId=INBOX filter -- confirmed live that a message archived
      // shortly after arriving still surfaces fine either way (Gmail's
      // history API reflects the label the message carried AT the add
      // event, not its current state), but a message a Gmail FILTER
      // auto-archives on arrival (skip-the-inbox rules) never gets the
      // INBOX label at all and would be silently missed by that filter.
      // Unfiltered costs nothing extra (same result set in the normal
      // case) and closes that gap.
      const histRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/history?startHistoryId=${encodeURIComponent(user.gmailHistoryId)}&historyTypes=messageAdded`, { headers: auth, signal: gmailFetchTimeout() });
      const hist = await histRes.json();
      if (!histRes.ok) {
        // historyId too old (Gmail only retains ~1 week of history) --
        // re-seed from the current one rather than erroring forever; any
        // mail older than that point is simply not backfilled, same as
        // the original connect-time seed already accepted.
        if (hist.error?.code === 404) {
          const profileRes = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", { headers: auth, signal: gmailFetchTimeout() });
          const profile = await profileRes.json();
          user.gmailHistoryId = profile.historyId || user.gmailHistoryId;
          usersChanged = true;
        } else {
          console.error(`[gmail] history fetch failed for ${user.gmailEmail}:`, hist.error?.message);
        }
        continue;
      }

      const messageIds = new Set();
      for (const h of hist.history || []) {
        for (const added of h.messagesAdded || []) messageIds.add(added.message.id);
      }
      // Hard cap per tick -- each id below costs a real Gmail API round
      // trip plus a logMessage() write, all sequential and all on the
      // scheduler's one shared tick. A normal 30s poll sees a handful of
      // new messages at most; the FIRST poll after enabling outbound
      // capture (or after historyId was stale) can see a real backlog and
      // try to process all of it in one go -- confirmed live as a full
      // server freeze on 2026-09-05, severe enough that even a restart
      // re-triggered the same backlog on the next tick (historyId hadn't
      // advanced past it yet). Truncating means a handful of one-time
      // backlog messages can go uncaptured, which is a far better trade
      // than repeatedly freezing the entire app.
      // historyId still advances to the newest value below regardless (not
      // re-attempted next tick) -- there's no per-message-id memory here to
      // resume from safely, and retrying the same batch forever is exactly
      // the freeze-restart-freeze loop this cap exists to prevent. A
      // dropped one-time backlog message is recoverable by hand; a
      // permanently wedged server isn't.
      const MAX_MESSAGES_PER_TICK = 20;
      const idsToProcess = [...messageIds].slice(0, MAX_MESSAGES_PER_TICK);
      if (messageIds.size > MAX_MESSAGES_PER_TICK) {
        console.error(`[gmail] ${messageIds.size} new messages for ${user.gmailEmail} in one poll -- processing first ${MAX_MESSAGES_PER_TICK} only, the rest are being skipped this tick (see comment above)`);
      }
      // A message the connected account itself sent (a native reply typed
      // straight into Gmail, not through this app's own Send Email box)
      // is captured too, not just genuine inbound replies -- otherwise a
      // coach who replied from their real Gmail app instead of the CRM's
      // compose panel left their half of the conversation invisible here,
      // even though the lead's side of the SAME thread showed up fine. No
      // double-logging risk against this app's own sendEmail: that goes
      // out through SES, which never touches the coach's actual Gmail
      // account, so it never appears in THIS history feed at all -- these
      // are two genuinely distinct send paths, not two views of the same
      // one. (See processGmailMessage above -- shared with the on-demand
      // reconciliation paths below, which is also why it dedupes by
      // providerMessageId even though this diff-based path alone would
      // never hand it the same id twice.)
      for (const messageId of idsToProcess) {
        try {
          const msgRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=full`, { headers: auth, signal: gmailFetchTimeout() });
          const msg = await msgRes.json();
          if (!msgRes.ok) continue;
          await processGmailMessage(user, msg);
        } catch (e) {
          console.error(`[gmail] processing message ${messageId} failed:`, e.message);
        }
      }
      if (hist.historyId && hist.historyId !== user.gmailHistoryId) { user.gmailHistoryId = hist.historyId; usersChanged = true; }
    } catch (e) {
      console.error(`[gmail] poll failed for ${user.gmailEmail || user.id}:`, e.message);
    }
  }
  if (usersChanged) writeJson(USERS_FILE, allUsers);
}
