import { readJson, writeJson, sendJson, getSessionUser, USERS_FILE } from "./auth_backend.js";
import { CONTACTS_FILE } from "./segments_shared.js";
import { logMessage } from "./message_log.js";
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
async function getAccessToken(refreshToken) {
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_GMAIL_CLIENT_ID, client_secret: process.env.GOOGLE_GMAIL_CLIENT_SECRET,
      refresh_token: refreshToken, grant_type: "refresh_token",
    }),
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

  if (p === "/api/auth/gmail/disconnect" && req.method === "POST") {
    const me = getSessionUser(req);
    if (!me) return sendJson(res, 401, { error: "Not logged in" });
    const users = readJson(USERS_FILE, []);
    const user = users.find(u => u.id === me.id);
    if (user) { delete user.gmailRefreshToken; delete user.gmailEmail; delete user.gmailHistoryId; writeJson(USERS_FILE, users); }
    return sendJson(res, 200, { ok: true });
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
  if (!contactsByEmailCache) {
    contactsByEmailCache = new Map();
    for (const c of readJson(CONTACTS_FILE, [])) {
      if (c.email) contactsByEmailCache.set(c.email.toLowerCase(), c.id);
    }
  }
  return contactsByEmailCache.get(email) || null;
}

// ── Poll (scheduler tick) ────────────────────────────────────────────────
// Gmail's history API is incremental (only what changed since a watermark
// historyId), same "never re-scan everything" principle as this app's own
// per-contact message files -- so a mailbox with thousands of messages
// costs the same O(new mail since last tick) every poll, not O(mailbox size).
export async function checkGmailInbox() {
  const users = readJson(USERS_FILE, []).filter(u => u.gmailRefreshToken);
  if (!users.length) return;
  contactsByEmailCache = null; // fresh per tick, reused across all messages/users within it
  let usersChanged = false;

  for (const user of users) {
    try {
      const accessToken = await getAccessToken(user.gmailRefreshToken);
      const auth = { Authorization: `Bearer ${accessToken}` };
      if (!user.gmailHistoryId) continue; // shouldn't happen post-connect, but nothing to diff against

      const histRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/history?startHistoryId=${encodeURIComponent(user.gmailHistoryId)}&historyTypes=messageAdded&labelId=INBOX`, { headers: auth });
      const hist = await histRes.json();
      if (!histRes.ok) {
        // historyId too old (Gmail only retains ~1 week of history) --
        // re-seed from the current one rather than erroring forever; any
        // mail older than that point is simply not backfilled, same as
        // the original connect-time seed already accepted.
        if (hist.error?.code === 404) {
          const profileRes = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", { headers: auth });
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
      for (const messageId of messageIds) {
        try {
          const msgRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=full`, { headers: auth });
          const msg = await msgRes.json();
          if (!msgRes.ok) continue;
          // Skip anything this same connected account itself sent (shows
          // up in history as "added to INBOX" for e.g. a self-CC) --
          // only genuine replies FROM someone else count as inbound.
          const fromHeader = headerValue(msg.payload?.headers, "From");
          const fromEmail = extractEmailAddress(fromHeader);
          if (!fromEmail || fromEmail === user.gmailEmail?.toLowerCase()) continue;
          const contactId = getContactIdByEmail(fromEmail);
          if (!contactId) continue; // not a known lead/contact -- not the CRM's concern (someone's personal inbox has plenty of mail that isn't)

          const subject = headerValue(msg.payload?.headers, "Subject");
          const body = extractBody(msg.payload);
          logMessage({
            channel: "email", direction: "inbound", contactId,
            sourceType: "inbound", sourceId: null, providerMessageId: msg.id,
            to: user.gmailEmail, from: fromHeader, subject, body, bodyPreview: body.slice(0, 140),
            status: "received",
          });
          checkConversionGoal("incoming_email", contactId);
        } catch (e) {
          console.error(`[gmail] processing message ${messageId} failed:`, e.message);
        }
      }
      if (hist.historyId && hist.historyId !== user.gmailHistoryId) { user.gmailHistoryId = hist.historyId; usersChanged = true; }
    } catch (e) {
      console.error(`[gmail] poll failed for ${user.gmailEmail || user.id}:`, e.message);
    }
  }
  if (usersChanged) writeJson(USERS_FILE, users);
}
