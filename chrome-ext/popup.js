const DEFAULT_CRM = "https://crm-app-production-eb8f.up.railway.app";
const st = document.getElementById("st"), url = document.getElementById("url");
async function check() {
  const { crmUrl } = await chrome.storage.sync.get({ crmUrl: DEFAULT_CRM });
  url.value = crmUrl;
  st.textContent = "Checking the CRM…";
  chrome.runtime.sendMessage({ type: "crm", path: "/api/ads/periods" }, (res) => {
    if (res?.status === 200) st.innerHTML = '<span class="ok">Connected to the CRM.</span>';
    else if (res?.status === 401) st.innerHTML = `<span class="bad">Not logged in.</span> <a href="${crmUrl}/login.html" target="_blank">Log in to the CRM</a>, then reopen this.`;
    else st.innerHTML = `<span class="bad">Can't reach the CRM${res?.error ? " (" + res.error + ")" : ""}.</span>`;
  });
}
url.addEventListener("change", async () => { await chrome.storage.sync.set({ crmUrl: url.value.trim().replace(/\/+$/, "") || DEFAULT_CRM }); check(); });
check();
