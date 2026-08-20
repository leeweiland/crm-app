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

// ── Mobile select enhancer ───────────────────────────────────────────────
// Android's native <select> renders a full-screen "tap Done" list picker
// once there are more than a few options -- this is what the "I have to
// press Done just to pick a status" complaints are about. Every <select>
// on every page gets wrapped with a lightweight custom trigger + popover
// that selects and closes on a single tap; crm-design-system.css only
// shows it at <=900px, so desktop keeps the normal native dropdown
// untouched. The real <select> stays in the DOM (just hidden on mobile)
// and remains the one source of truth for .value/.selectedIndex/'change',
// so no other page's code has to change to get this for free -- including
// code that sets .value directly without dispatching 'change' (caught via
// a per-instance property override below) and code that repopulates the
// option list later via .innerHTML (caught via a MutationObserver).
function escapeHtmlForMobileSelect(s) { const d = document.createElement("div"); d.textContent = String(s ?? ""); return d.innerHTML; }
function enhanceSelectForMobile(sel) {
  if (sel.dataset.mobileEnhanced || sel.multiple) return;
  sel.dataset.mobileEnhanced = "1";

  const wrap = document.createElement("span");
  wrap.className = "mobile-select-wrap";
  sel.parentNode.insertBefore(wrap, sel);
  wrap.appendChild(sel);
  sel.classList.add("mobile-select-native");

  const anchor = document.createElement("span");
  anchor.className = (sel.className || "").replace("mobile-select-native", "").trim() + " mobile-select-anchor";
  if (sel.id) anchor.id = sel.id; // deliberately duplicate -- see below
  if (sel.getAttribute("style")) anchor.setAttribute("style", sel.getAttribute("style"));
  wrap.appendChild(anchor);

  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "mobile-select-trigger";
  trigger.innerHTML = '<span class="mobile-select-trigger-label"></span><span class="mobile-select-trigger-caret">&#9662;</span>';
  anchor.appendChild(trigger);
  const label = trigger.querySelector(".mobile-select-trigger-label");

  const menu = document.createElement("div");
  menu.className = "mobile-select-menu";
  anchor.appendChild(menu);

  function renderTrigger() {
    const opt = sel.options[sel.selectedIndex];
    label.textContent = opt ? opt.textContent : "";
    trigger.disabled = sel.disabled;
  }
  function renderMenu() {
    menu.innerHTML = Array.from(sel.options).map((opt, i) => `
      <div class="mobile-select-option${i === sel.selectedIndex ? " selected" : ""}" data-i="${i}">${escapeHtmlForMobileSelect(opt.textContent)}</div>
    `).join("");
    menu.querySelectorAll(".mobile-select-option").forEach(item => item.onclick = (e) => {
      e.stopPropagation();
      sel.selectedIndex = Number(item.dataset.i);
      sel.dispatchEvent(new Event("change", { bubbles: true }));
      closeMenu();
    });
  }
  function openMenu() {
    if (sel.disabled) return;
    renderMenu();
    menu.classList.add("open");
    document.addEventListener("mousedown", onOutsideClick, true);
  }
  function closeMenu() {
    menu.classList.remove("open");
    document.removeEventListener("mousedown", onOutsideClick, true);
  }
  function onOutsideClick(e) { if (!anchor.contains(e.target)) closeMenu(); }
  trigger.onclick = (e) => {
    e.stopPropagation();
    menu.classList.contains("open") ? closeMenu() : openMenu();
  };

  sel.addEventListener("change", renderTrigger);
  new MutationObserver(renderTrigger).observe(sel, { childList: true, attributes: true, attributeFilter: ["disabled"] });

  // Some pages assign `select.value = x` / `.selectedIndex = i` directly
  // without dispatching 'change' -- shadow the accessor on this one
  // instance so the trigger label stays in sync with those too. Only
  // affects JS reading/writing the property; the browser's own native
  // picker (still fully functional on desktop) mutates state at the
  // platform level and fires a real 'change' event either way, which the
  // listener above already handles.
  ["value", "selectedIndex"].forEach(prop => {
    const desc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, prop);
    Object.defineProperty(sel, prop, {
      configurable: true,
      get() { return desc.get.call(sel); },
      set(v) { desc.set.call(sel, v); renderTrigger(); },
    });
  });

  renderTrigger();
}
function enhanceAllSelectsForMobile(root) {
  (root || document).querySelectorAll("select:not(.mobile-select-native)").forEach(enhanceSelectForMobile);
}
enhanceAllSelectsForMobile();
new MutationObserver((records) => {
  for (const r of records) {
    r.addedNodes.forEach(node => {
      if (node.nodeType !== 1) return;
      if (node.matches && node.matches("select")) enhanceSelectForMobile(node);
      if (node.querySelectorAll) node.querySelectorAll("select").forEach(enhanceSelectForMobile);
    });
  }
}).observe(document.body, { childList: true, subtree: true });
