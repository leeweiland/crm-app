// Shared sidebar nav — injected into any page with an empty <div id="appSidebar">,
// same "one shared script, injected per page" pattern chat-app uses for chat-header.js.
(async function () {
  const NAV_ITEMS = [
    { href: "/inbox.html", label: "Inbox" },
    { href: "/contacts.html", label: "Contacts" },
    { href: "/forms.html", label: "Forms" },
    { href: "/scheduling.html", label: "Scheduling" },
    { href: "/flows.html", label: "Connections & Flows" },
    { href: "/campaigns.html", label: "Email Campaigns" },
    { href: "/automations.html", label: "Email Automations" },
    { href: "/workflows.html", label: "SMS Sequences" },
    { href: "/reporting.html", label: "Reporting" },
    { href: "/settings.html", label: "Settings" },
  ];

  const sidebar = document.getElementById("appSidebar");
  if (!sidebar) return;

  const [meRes, siteRes] = await Promise.all([fetch("/api/auth/me"), fetch("/api/integrations/site")]);
  if (!meRes.ok) {
    location.href = "/login.html?next=" + encodeURIComponent(location.pathname);
    return;
  }
  const me = (await meRes.json()).user;
  const logoUrl = siteRes.ok ? (await siteRes.json()).logoUrl : "";
  // A logo replaces the text wordmark entirely rather than sitting next to
  // it -- matches how the booking page's branding works (logo present hides
  // the brand-name line there too).
  const logoHtml = logoUrl
    ? `<img class="app-sidebar-logo-img" src="${logoUrl}" alt="Pacific Rim Athletics"/>`
    : `Pacific Rim Athletics`;

  const path = location.pathname;
  sidebar.innerHTML = `
    <div class="app-sidebar-logo">${logoHtml}</div>
    <nav>
      ${NAV_ITEMS.map(item => `<a class="app-nav-link${path === item.href ? " active" : ""}" href="${item.href}">${item.label}</a>`).join("")}
    </nav>
    <div class="app-sidebar-footer">
      ${me.first} ${me.last}<br/>
      <span class="pra-badge pra-badge-${me.role}">${me.role}</span>
      <div style="margin-top:8px"><a class="pra-link" id="logoutLink" style="font-size:.8rem">Log out</a></div>
    </div>
  `;
  document.getElementById("logoutLink").onclick = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    location.href = "/login.html";
  };

  // Off-canvas sidebar toggle (tablet/mobile only, see crm-design-system.css)
  // -- injected once here rather than per-page, so every page gets it for
  // free just by including this script and the empty #appSidebar div.
  if (!document.getElementById("appSidebarToggleBtn")) {
    const toggleBtn = document.createElement("button");
    toggleBtn.id = "appSidebarToggleBtn";
    toggleBtn.className = "app-sidebar-toggle-btn";
    toggleBtn.setAttribute("aria-label", "Open menu");
    toggleBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none"><path d="M4 6h16M4 12h16M4 18h16" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
    const backdrop = document.createElement("div");
    backdrop.id = "appSidebarBackdrop";
    backdrop.className = "app-sidebar-backdrop";
    // Persistent top-center logo (tablet/mobile only) -- the in-sidebar
    // logo above is hidden at that breakpoint (crm-design-system.css) since
    // it's only ever visible while the off-canvas menu is slid open; this
    // stays visible whether the menu is open or closed.
    const mobileLogo = document.createElement("div");
    mobileLogo.id = "appMobileLogo";
    mobileLogo.className = "app-mobile-logo";
    mobileLogo.innerHTML = logoUrl
      ? `<img class="app-mobile-logo-img" src="${logoUrl}" alt="Pacific Rim Athletics"/>`
      : `<span style="font-family:var(--font-secondary);font-size:.85rem;color:var(--pra-white)">Pacific Rim Athletics</span>`;
    document.body.append(toggleBtn, backdrop, mobileLogo);

    const closeSidebar = () => { sidebar.classList.remove("open"); backdrop.classList.remove("show"); };
    toggleBtn.onclick = () => { sidebar.classList.toggle("open"); backdrop.classList.toggle("show"); };
    backdrop.onclick = closeSidebar;
    sidebar.querySelectorAll(".app-nav-link").forEach(link => link.addEventListener("click", closeSidebar));
  }

  window.crmMe = me;
})();

function showToast(message, isError) {
  let el = document.getElementById("crmToast");
  if (!el) {
    el = document.createElement("div");
    el.id = "crmToast";
    el.className = "toast";
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.className = "toast show" + (isError ? " error" : "");
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove("show"), 3000);
}
window.showToast = showToast;

// Click-outside-to-close for every .modal-backdrop on the site, so users
// aren't forced to hunt for a Cancel button -- clicking the dimmed
// backdrop (not the panel itself) closes whichever modal is open, same
// affordance as clicking the panel's own Cancel/Close button.
document.addEventListener("click", (e) => {
  if (e.target.classList && e.target.classList.contains("modal-backdrop")) {
    e.target.classList.remove("show");
  }
});
