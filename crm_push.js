// Native push for the "PRA Inbox" Android app (a Capacitor shell around
// /inbox.html, see crm-nav.js's app mode). The app registers its FCM token
// here (bell icon in the Inbox header); every inbound SMS then pushes to
// each registered device. Sending goes straight to FCM's HTTP v1 API with a
// self-signed service-account JWT -- no firebase-admin dependency. The
// service account is the same Firebase project the PRA student app uses
// (env FIREBASE_SERVICE_ACCOUNT_JSON, copied from the chat-app service).
//
// Runs on whichever thread processes the inbound message (sms_worker,
// background_worker, or main) -- everything here is a small JSON file read
// plus a fetch, nothing heavy.
import { createSign } from "crypto";
import { readJson, writeJson, readJsonBody, sendJson, getSessionUser } from "./auth_backend.js";

const TOKENS_FILE = "crm_push_tokens.json";

let _sa; // parsed service account (undefined = not tried yet, null = missing/bad)
function serviceAccount() {
  if (_sa !== undefined) return _sa;
  try { _sa = process.env.FIREBASE_SERVICE_ACCOUNT_JSON ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON) : null; }
  catch (e) { console.error("[crm_push] FIREBASE_SERVICE_ACCOUNT_JSON parse failed:", e.message); _sa = null; }
  return _sa;
}

let _access = { token: null, exp: 0 };
async function accessToken() {
  if (_access.token && Date.now() < _access.exp - 60_000) return _access.token;
  const sa = serviceAccount();
  if (!sa) throw new Error("Firebase not configured");
  const now = Math.floor(Date.now() / 1000);
  const b64 = o => Buffer.from(JSON.stringify(o)).toString("base64url");
  const unsigned = b64({ alg: "RS256", typ: "JWT" }) + "." + b64({
    iss: sa.client_email, scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600,
  });
  const sig = createSign("RSA-SHA256").update(unsigned).sign(sa.private_key, "base64url");
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: unsigned + "." + sig }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error("token exchange failed: " + (j.error_description || j.error || r.status));
  _access = { token: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return _access.token;
}

function getTokens() { return readJson(TOKENS_FILE, []); }

async function sendOne(token, { title, body, data }) {
  const sa = serviceAccount();
  const r = await fetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
    method: "POST",
    headers: { Authorization: "Bearer " + await accessToken(), "Content-Type": "application/json" },
    body: JSON.stringify({ message: {
      token, notification: { title, body }, data,
      // high priority + explicit sound: a normal-priority message can be
      // deferred/silenced by Doze on a backgrounded app.
      android: { priority: "high", notification: { sound: "default", visibility: "private", color: "#009BFF", tag: data.contactId || undefined } },
    } }),
  });
  if (r.ok) return { ok: true };
  const j = await r.json().catch(() => ({}));
  const code = j?.error?.details?.find?.(d => d.errorCode)?.errorCode || j?.error?.status;
  const msg = j?.error?.message || String(r.status);
  // Only a token FCM says is gone/invalid gets pruned -- not a payload error.
  return { ok: false, dead: r.status === 404 || code === "UNREGISTERED" || (code === "INVALID_ARGUMENT" && /registration token/i.test(msg)), error: msg };
}

// One push to every device a single staff user registered (e.g. "your text
// to X failed"). Never throws.
export async function pushToUser(userId, payload) {
  try {
    const targets = getTokens().filter(t => t.userId === userId);
    if (!targets.length || !serviceAccount()) return;
    const dead = [];
    await Promise.all(targets.map(async t => {
      const res = await sendOne(t.token, payload).catch(e => ({ ok: false, error: e.message }));
      if (!res.ok) { console.error("[crm_push] send failed for user", t.userId, res.error); if (res.dead) dead.push(t.token); }
    }));
    if (dead.length) writeJson(TOKENS_FILE, getTokens().filter(t => !dead.includes(t.token)));
  } catch (e) {
    console.error("[crm_push] pushToUser failed:", e.message);
  }
}

// Fire-and-forget from processTwilioInboundMessage. Never throws.
export async function pushInboundSms({ contact, from, body }) {
  try {
    const targets = getTokens();
    if (!targets.length || !serviceAccount()) return;
    const name = contact ? [contact.first, contact.last].filter(Boolean).join(" ") || contact.phone || from : from;
    const payload = {
      title: name || "New text",
      body: String(body || "").slice(0, 180) || "(no text)",
      data: { contactId: contact?.id ? String(contact.id) : "", phone: String(from || "") }, // "from" is reserved by FCM
    };
    const dead = [];
    await Promise.all(targets.map(async t => {
      const res = await sendOne(t.token, payload).catch(e => ({ ok: false, error: e.message }));
      if (!res.ok) {
        console.error("[crm_push] send failed for user", t.userId, res.error);
        if (res.dead) dead.push(t.token);
      }
    }));
    if (dead.length) writeJson(TOKENS_FILE, getTokens().filter(t => !dead.includes(t.token)));
  } catch (e) {
    console.error("[crm_push] pushInboundSms failed:", e.message);
  }
}

export async function handlePushRequest(req, res, url) {
  const p = url.pathname;
  if (!p.startsWith("/api/push/")) return false;
  const me = getSessionUser(req);
  if (!me) return sendJson(res, 401, { error: "Not logged in" });

  if (p === "/api/push/register" && req.method === "POST") {
    const { token, platform } = await readJsonBody(req);
    if (!token || typeof token !== "string") return sendJson(res, 400, { error: "token is required" });
    const rest = getTokens().filter(t => t.token !== token);
    rest.push({ token, platform: platform || "android", userId: me.id, userName: [me.first, me.last].filter(Boolean).join(" "), createdAt: new Date().toISOString() });
    writeJson(TOKENS_FILE, rest);
    return sendJson(res, 200, { ok: true, configured: !!serviceAccount() });
  }
  if (p === "/api/push/unregister" && req.method === "POST") {
    const { token } = await readJsonBody(req);
    writeJson(TOKENS_FILE, getTokens().filter(t => t.token !== token));
    return sendJson(res, 200, { ok: true });
  }
  if (p === "/api/push/status" && req.method === "GET") {
    const token = url.searchParams.get("token") || "";
    return sendJson(res, 200, { registered: !!token && getTokens().some(t => t.token === token), configured: !!serviceAccount() });
  }
  if (p === "/api/push/test" && req.method === "POST") {
    const mine = getTokens().filter(t => t.userId === me.id);
    if (!serviceAccount()) return sendJson(res, 500, { error: "Firebase not configured" });
    const results = await Promise.all(mine.map(t => sendOne(t.token, { title: "PRA Inbox", body: "Notifications are on.", data: { contactId: "" } }).catch(e => ({ ok: false, error: e.message }))));
    return sendJson(res, 200, { sent: results.filter(r => r.ok).length, results });
  }
  return false;
}
