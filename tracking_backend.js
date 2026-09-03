import { readJson, writeJson, appendJsonRecordFast, getCookie } from "./auth_backend.js";
import { fireTrigger } from "./automations_backend.js";
import { fireWorkflowTrigger } from "./workflows_backend.js";
import { getPublicBaseUrl } from "./integrations_backend.js";
import { markContactVisitedPage } from "./contacts_backend.js";

export const PAGE_VISITS_FILE = "crm_page_visits.json";
const IP_LOCATION_CACHE_FILE = "crm_ip_location_cache.json";

// Page-visit tracking, two layers of identity:
//   crm_cid ("contact id") -- set once a visitor is DEFINITELY a known
//     contact (clicked a tracked email link, or identified via a form/
//     booking -- see below). Every subsequent pageview fires "page_visit"
//     automation triggers for them.
//   crm_vid ("visitor id") -- set on literally every visit, identified or
//     not, so an anonymous visitor's journey (every ad click, every page,
//     in order) is never lost just because they haven't opted in yet. When
//     they DO opt in (form submission or booking -- the two events that
//     create/match a contact), that contact id gets "claimed" back onto
//     every PRIOR anonymous visit carrying the same crm_vid (see
//     claimVisitorHistory below) -- so the ad click that brought them here
//     shows up in their journey retroactively, not just from the moment
//     they opted in. This is what makes "which ad drove this booking"
//     answerable at all: without it, an ad click is permanently anonymous,
//     forever disconnected from whatever they did 10 minutes later.
//
// This has to run entirely on the FRAMER origin, not the CRM's -- a cookie
// set via a Set-Cookie header on a response FROM the CRM's own domain
// (crm-app-production-eb8f.up.railway.app) is invisible to document.cookie
// on the Framer site's domain; browsers scope cookies strictly per-origin
// unless a shared parent domain is explicitly declared, which isn't the
// case here. Confirmed live (2026-09-02): the CRM's own /api/email/click
// redirect was setting crm_cid via Set-Cookie on ITS OWN origin, which
// this script (running on the Framer origin) could never actually read --
// meaning email-click attribution had never worked. Fixed at both ends:
// - /api/email/click now passes crm_cid as a query param on the
//   destination URL instead of (only) a header -- plain text in a URL
//   crosses origins fine, and THIS script (already running on the
//   destination's own origin) picks it up and sets the cookie itself.
// - public-form.html/the booking widget (both iframes on the CRM's origin)
//   can't set a cookie the parent Framer page will see either, so on a
//   successful submission/booking they postMessage the contact id to the
//   parent window instead; this script listens for that and sets the
//   cookie the same way. The SAME cross-origin problem applies in reverse
//   for crm_vid -- the iframe needs to know the PARENT page's visitor id
//   to submit it along with the form/booking, so the widget embed scripts
//   (forms-widget.js, scheduling's equivalent) read crm_vid from THIS
//   page's cookie (same origin as this script) and append it as a query
//   param on the iframe's own src URL.
// Sends location.search too (not just the path) now -- with Hyros retired,
// this CRM is the only thing left reading the "el=..." tag on every link it
// (and ads/social/YouTube, tagged by hand) already carries, so the visit
// log is where that signal has to land to be useful for anything.
const TRACK_SNIPPET = `(function(){
  function getCookie(name){var m=document.cookie.match(new RegExp('(?:^|; )'+name+'=([^;]*)'));return m?decodeURIComponent(m[1]):null;}
  function setCid(id){document.cookie='crm_cid='+encodeURIComponent(id)+'; max-age=2592000; path=/; SameSite=Lax';}
  function randomId(){
    if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
    var s = ''; for (var i=0;i<32;i++) s += Math.floor(Math.random()*16).toString(16);
    return s;
  }
  var vid = getCookie('crm_vid');
  if (!vid) { vid = randomId(); document.cookie = 'crm_vid=' + vid + '; max-age=31536000; path=/; SameSite=Lax'; }
  var urlCid = new URLSearchParams(location.search).get('crm_cid');
  if (urlCid) setCid(urlCid);
  window.addEventListener('message', function(e){
    if (e.data && e.data.type === 'pf-identify' && e.data.contactId) setCid(e.data.contactId);
  });
  fetch('${"__BASE_URL__"}/api/track/pageview', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ cid: urlCid || getCookie('crm_cid'), vid: vid, path: location.pathname, search: location.search })
  }).catch(function(){});
})();`;

// Railway (and most hosts) sit behind a proxy -- the real visitor IP
// arrives via x-forwarded-for (first entry in the comma-separated chain,
// since a proxy may append its own), not the raw socket address, which
// would just be the proxy's own IP.
export function clientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (fwd) return String(fwd).split(",")[0].trim();
  return req.socket?.remoteAddress || "";
}

// Rough city/region lookup, not precise geolocation -- used only as a
// possible-duplicate-contact signal (see duplicates_backend.js), never
// shown as an exact address. ip-api.com's free tier needs no API key,
// which matches this app's "settings-configured or falls back to nothing"
// pattern for every other integration -- except here, there's nothing to
// configure at all, so it either works or a lookup silently no-ops.
// Cached per IP on disk since the same visitor's IP repeats across every
// pageview in a session.
export async function lookupIpLocation(ip) {
  if (!ip || ip === "127.0.0.1" || ip === "::1") return null;
  const cache = readJson(IP_LOCATION_CACHE_FILE, {});
  if (ip in cache) return cache[ip];
  let location = null;
  try {
    const r = await fetch(`http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,city,regionName,country`);
    if (r.ok) {
      const d = await r.json();
      if (d.status === "success") location = { city: d.city || "", region: d.regionName || "", country: d.country || "" };
    }
  } catch { /* lookup is best-effort -- a failed/rate-limited call just means no location signal for this visit, not a broken pageview log */ }
  cache[ip] = location;
  writeJson(IP_LOCATION_CACHE_FILE, cache);
  return location;
}

export async function handleTrackingRequest(req, res, url) {
  const p = url.pathname;

  if (p === "/track.js" && req.method === "GET") {
    const baseUrl = getPublicBaseUrl() || `${url.protocol}//${url.host}`;
    res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-store" });
    res.end(TRACK_SNIPPET.replace("__BASE_URL__", baseUrl));
    return true;
  }

  if (p === "/api/track/pageview" && req.method === "POST") {
    let body = "";
    await new Promise(resolve => { req.on("data", d => body += d); req.on("end", resolve); });
    let parsed = {};
    try { parsed = JSON.parse(body || "{}"); } catch { /* ignore malformed beacon */ }
    const cid = parsed.cid || getCookie(req, "crm_cid");
    // "page_visit" automation/workflow triggers only make sense for a KNOWN
    // contact -- an anonymous visit has nothing to enroll or advance.
    if (cid) {
      markContactVisitedPage(cid, parsed.path || "");
      fireTrigger("page_visit", { contactId: cid, path: parsed.path || "" });
      fireWorkflowTrigger("page_visit", { contactId: cid, path: parsed.path || "" });
    }

    // The visit itself is logged either way -- el= on an anonymous visit is
    // still a real signal (which send/ad/social post drove it), even
    // before/without a contact identified yet. visitorId is stamped on
    // EVERY visit (see TRACK_SNIPPET) so an anonymous one can be claimed
    // later -- see claimVisitorHistory.
    let el = null;
    try { el = new URLSearchParams(parsed.search || "").get("el"); } catch { /* malformed search string -- no el signal for this visit */ }
    const ip = clientIp(req);
    const location = await lookupIpLocation(ip);
    // appendJsonRecordFast, not readJson+push+writeJson -- this file is
    // small today but gets a write on every single pageview, so it's
    // built the same way message_log.js's live-send path had to be fixed
    // to be (see that file's history) rather than repeating the mistake
    // of finding out the hard way once traffic grows.
    appendJsonRecordFast(PAGE_VISITS_FILE, { contactId: cid || null, visitorId: parsed.vid || null, path: parsed.path || "", el, ip, location, at: new Date().toISOString() });

    res.writeHead(204); res.end();
    return true;
  }

  return false;
}

// Called when a form submission or booking identifies a visitor (creates
// or matches a contact) -- retroactively attributes every PRIOR anonymous
// visit carrying the same crm_vid to that contact, so an ad click 10
// minutes (or 10 days) before someone opts in still shows up in their
// journey instead of being permanently orphaned. Safe to call with a
// missing/unknown vid (e.g. an older browser, or the widget embed script
// hasn't been updated on every page yet) -- just finds nothing to claim.
export function claimVisitorHistory(vid, contactId) {
  if (!vid || !contactId) return 0;
  const visits = readJson(PAGE_VISITS_FILE, []);
  let claimed = 0;
  for (const v of visits) {
    if (v.visitorId === vid && !v.contactId) { v.contactId = contactId; claimed++; }
  }
  if (claimed) writeJson(PAGE_VISITS_FILE, visits);
  return claimed;
}
