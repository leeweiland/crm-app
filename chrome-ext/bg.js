// Fetches from the CRM on behalf of the content script. Runs here (not in the
// Ads Manager page) so the CRM login cookie is sent and the page's own
// security rules don't block the request.
const DEFAULT_CRM = "https://crm-app-production-eb8f.up.railway.app";

chrome.runtime.onMessage.addListener((msg, _sender, send) => {
  if (msg?.type !== "crm") return;
  (async () => {
    try {
      const { crmUrl } = await chrome.storage.sync.get({ crmUrl: DEFAULT_CRM });
      const r = await fetch(crmUrl.replace(/\/+$/, "") + msg.path, { credentials: "include" });
      const text = await r.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* not JSON */ }
      send({ status: r.status, json, crmUrl });
    } catch (e) {
      send({ status: 0, error: e.message });
    }
  })();
  return true;
});
