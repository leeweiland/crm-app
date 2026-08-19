import { getCookie } from "./auth_backend.js";
import { fireTrigger } from "./automations_backend.js";
import { fireWorkflowTrigger } from "./workflows_backend.js";
import { getPublicBaseUrl } from "./integrations_backend.js";

// Simplified page-visit tracking: rather than a fully anonymous
// visitor-identity system (cookie sync before a contact is even known),
// this piggybacks on identity we already establish elsewhere -- every
// tracked email-link click (email_backend.js's /api/email/click) sets a
// crm_cid cookie on the clicker's browser. Once that cookie exists,
// subsequent pageviews on the Framer site (via the /track.js snippet
// below) can be attributed to a known contact and fire "page_visit"
// automation triggers. Visitors who never click a tracked email link stay
// anonymous -- consistent with not having a Framer-side identity cookie
// system to build against.
const TRACK_SNIPPET = `(function(){
  function getCookie(name){var m=document.cookie.match(new RegExp('(?:^|; )'+name+'=([^;]*)'));return m?decodeURIComponent(m[1]):null;}
  var cid = getCookie('crm_cid');
  if (!cid) return;
  fetch('${"__BASE_URL__"}/api/track/pageview', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ cid: cid, path: location.pathname })
  }).catch(function(){});
})();`;

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
    if (cid) {
      fireTrigger("page_visit", { contactId: cid, path: parsed.path || "" });
      fireWorkflowTrigger("page_visit", { contactId: cid, path: parsed.path || "" });
    }
    res.writeHead(204); res.end();
    return true;
  }

  return false;
}
