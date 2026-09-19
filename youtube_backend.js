import { readJson, writeJson, sendJson, getSessionUser } from "./auth_backend.js";

// YouTube connection for Flows' "New YouTube video" trigger and "Add video to
// playlist" step. Reads (spotting a new upload) need no login at all -- the
// channel's public RSS feed. Only WRITING to a playlist needs OAuth, and it has
// to be the Google identity that OWNS that channel (a personal login can't
// touch a brand channel's playlists), so this keeps its own refresh token
// instead of reusing GOOGLE_REFRESH_TOKEN_LW (that one is the "Lee Weiland"
// channel). It rides the same Web OAuth client + already-registered redirect
// URI as the Gmail connect (gmail_backend.js hands "yt:"-prefixed states here),
// since a new redirect URI would mean another trip into Google Cloud Console.
export const YT_AUTH_FILE = "crm_youtube_auth.json";
const YT_SCOPE = "https://www.googleapis.com/auth/youtube";
const REDIRECT_URI = "https://crm-app-production-eb8f.up.railway.app/api/auth/gmail/callback";
const API = "https://www.googleapis.com/youtube/v3";
const CALL_TIMEOUT_MS = 15000;

function oauthClient() {
  return { id: process.env.GOOGLE_GMAIL_CLIENT_ID, secret: process.env.GOOGLE_GMAIL_CLIENT_SECRET };
}
export function youtubeOAuthConfigured() {
  const c = oauthClient();
  return !!(c.id && c.secret);
}
function readAuth() { return readJson(YT_AUTH_FILE, {}) || {}; }

function apiError(body, status) {
  const e = body?.error;
  const msg = e?.message || e?.errors?.[0]?.message || `HTTP ${status}`;
  return e?.errors?.[0]?.reason ? `${msg} (${e.errors[0].reason})` : msg;
}

async function getAccessToken() {
  const auth = readAuth();
  if (!auth.refreshToken) throw new Error("YouTube isn't connected yet -- connect it from the flow's YouTube step.");
  const c = oauthClient();
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: c.id, client_secret: c.secret, refresh_token: auth.refreshToken, grant_type: "refresh_token" }),
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  });
  const d = await r.json();
  if (!d.access_token) {
    // Google revoked/expired the grant (an OAuth app still in "Testing" expires
    // refresh tokens after 7 days) -- flag it so the builder says "reconnect"
    // instead of every run silently failing.
    if (d.error === "invalid_grant") writeJson(YT_AUTH_FILE, { ...auth, invalid: true });
    throw new Error("YouTube token refresh failed: " + (d.error_description || d.error || JSON.stringify(d)) + " -- reconnect YouTube.");
  }
  if (auth.invalid) writeJson(YT_AUTH_FILE, { ...auth, invalid: false });
  return d.access_token;
}

// Video ID -> title, for labelling y=<video id> link tags in Reporting. Uses
// YouTube's public oEmbed endpoint: no login, no API key, no quota, and it
// works for unlisted videos too. Titles are cached for 30 days; a video that
// can't be found (private/deleted/not actually an ID) is cached as a miss for
// 7 days so a bad tag can't cost a request per report load. Never throws --
// anything unresolved just isn't in the returned Map.
const YT_TITLES_FILE = "crm_youtube_titles.json";
export const isYouTubeVideoId = (s) => /^[A-Za-z0-9_-]{11}$/.test(String(s || ""));
export async function lookupVideoTitles(ids) {
  const cache = readJson(YT_TITLES_FILE, {});
  const now = Date.now();
  const titles = new Map();
  const missing = [];
  for (const id of new Set(ids.filter(isYouTubeVideoId))) {
    const hit = cache[id];
    const ttl = hit && (hit.title ? 30 : 7) * 86400000;
    if (hit && now - hit.at < ttl) { if (hit.title) titles.set(id, hit.title); } else missing.push(id);
  }
  if (!missing.length) return titles;
  await Promise.all(missing.map(async (id) => {
    let title = null;
    try {
      const r = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}&format=json`, { signal: AbortSignal.timeout(5000) });
      if (r.ok) title = (await r.json())?.title || null;
      else if (r.status !== 400 && r.status !== 401 && r.status !== 403 && r.status !== 404) return; // transient (5xx/429) -- retry next load, don't cache
    } catch { return; }
    cache[id] = { title, at: now };
    if (title) titles.set(id, title);
  }));
  writeJson(YT_TITLES_FILE, cache);
  return titles;
}

// A channel's public uploads feed (newest first, ~15 entries) -- no API key,
// no quota. Public videos only, which is what "new video in channel" means.
function decodeXml(s) {
  return String(s || "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/&amp;/g, "&");
}
export async function fetchChannelFeed(channelId) {
  const r = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`, { signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
  if (!r.ok) throw new Error(`YouTube feed returned HTTP ${r.status} for channel ${channelId}`);
  const xml = await r.text();
  const videos = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(m => {
    const pick = (re) => (m[1].match(re) || [])[1] || "";
    return {
      videoId: pick(/<yt:videoId>([^<]+)<\/yt:videoId>/),
      title: decodeXml(pick(/<title>([^<]*)<\/title>/)),
      publishedAt: pick(/<published>([^<]+)<\/published>/),
    };
  }).filter(v => v.videoId);
  const channelTitle = decodeXml((xml.match(/<author>\s*<name>([^<]*)<\/name>/) || [])[1] || "");
  return { channelTitle, videos };
}

export async function listMyPlaylists() {
  const token = await getAccessToken();
  const out = [];
  let pageToken = "";
  for (let i = 0; i < 6; i++) {
    const r = await fetch(`${API}/playlists?part=snippet,contentDetails&mine=true&maxResults=50${pageToken ? `&pageToken=${pageToken}` : ""}`, {
      headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(apiError(d, r.status));
    for (const p of d.items || []) out.push({ id: p.id, title: p.snippet?.title || p.id, itemCount: p.contentDetails?.itemCount ?? null });
    if (!d.nextPageToken) break;
    pageToken = d.nextPageToken;
  }
  return out;
}

// Idempotent: a playlist happily holds the same video twice, and the flow
// engine is at-least-once (a stale-run resume re-runs the step it died on),
// so look first and only insert when it isn't already there.
export async function addVideoToPlaylist(playlistId, videoId) {
  const token = await getAccessToken();
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const chk = await fetch(`${API}/playlistItems?part=id&playlistId=${encodeURIComponent(playlistId)}&videoId=${encodeURIComponent(videoId)}&maxResults=1`, { headers, signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
  const cj = await chk.json();
  if (!chk.ok) throw new Error(apiError(cj, chk.status));
  if ((cj.items || []).length) return { ok: true, alreadyThere: true };
  const ins = await fetch(`${API}/playlistItems?part=snippet`, {
    method: "POST", headers, signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    body: JSON.stringify({ snippet: { playlistId, resourceId: { kind: "youtube#video", videoId } } }),
  });
  const ij = await ins.json();
  if (!ins.ok) throw new Error(apiError(ij, ins.status));
  return { ok: true, alreadyThere: false, playlistItemId: ij.id };
}

function resultPage(res, title, detail, ok) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  res.end(`<!DOCTYPE html><html><body style="font-family:sans-serif;text-align:center;padding:60px 20px"><h2 style="color:${ok ? "#0a7d33" : "#b00020"}">${esc(title)}</h2><p>${esc(detail)}</p><p><a href="/flows.html">Back to Flows</a></p></body></html>`);
}

// Called by gmail_backend.js's callback route when state starts with "yt:".
export async function handleYoutubeCallback(req, res, url) {
  const code = url.searchParams.get("code");
  if (!code) { resultPage(res, "Couldn't connect YouTube", url.searchParams.get("error") || "Missing authorization code.", false); return; }
  try {
    const c = oauthClient();
    const tr = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code, client_id: c.id, client_secret: c.secret, redirect_uri: REDIRECT_URI, grant_type: "authorization_code" }),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    const tokens = await tr.json();
    if (!tokens.refresh_token) throw new Error(tokens.error_description || tokens.error || "Google returned no refresh token");
    const cr = await fetch(`${API}/channels?part=snippet&mine=true`, { headers: { Authorization: `Bearer ${tokens.access_token}` }, signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
    const cj = await cr.json();
    if (!cr.ok) throw new Error(apiError(cj, cr.status));
    const channel = (cj.items || [])[0];
    if (!channel) throw new Error("That Google account has no YouTube channel -- pick the account/brand that owns the channel.");
    writeJson(YT_AUTH_FILE, {
      refreshToken: tokens.refresh_token, scope: tokens.scope || "", channelId: channel.id, channelTitle: channel.snippet?.title || "",
      connectedAt: new Date().toISOString(), invalid: false,
    });
    resultPage(res, "YouTube connected", `Connected as "${channel.snippet?.title || channel.id}". You can close this tab.`, true);
  } catch (e) {
    resultPage(res, "Couldn't connect YouTube", e.message, false);
  }
}

export async function handleYoutubeRequest(req, res, url) {
  const p = url.pathname;
  if (!p.startsWith("/api/youtube/")) return false;
  const me = getSessionUser(req);
  if (!me) return sendJson(res, 401, { error: "Not logged in" });

  if (p === "/api/youtube/connect" && req.method === "GET") {
    if (!youtubeOAuthConfigured()) return sendJson(res, 400, { error: "Google OAuth isn't configured (GOOGLE_GMAIL_CLIENT_ID/GOOGLE_GMAIL_CLIENT_SECRET missing)" });
    // select_account: someone who runs a brand channel has to be able to pick
    // WHICH channel identity this grant is for.
    const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${encodeURIComponent(oauthClient().id)}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
      `&response_type=code&scope=${encodeURIComponent(YT_SCOPE)}&access_type=offline&prompt=${encodeURIComponent("select_account consent")}&state=${encodeURIComponent("yt:" + me.id)}`;
    res.writeHead(302, { Location: authUrl });
    res.end();
    return true;
  }
  if (p === "/api/youtube/status" && req.method === "GET") {
    const a = readAuth();
    return sendJson(res, 200, { configured: youtubeOAuthConfigured(), connected: !!a.refreshToken && !a.invalid, needsReconnect: !!a.refreshToken && !!a.invalid, channelId: a.channelId || null, channelTitle: a.channelTitle || null });
  }
  if (p === "/api/youtube/playlists" && req.method === "GET") {
    try { return sendJson(res, 200, { playlists: await listMyPlaylists() }); }
    catch (e) { return sendJson(res, 200, { playlists: [], error: e.message }); }
  }
  return false;
}
