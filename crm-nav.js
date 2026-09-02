// Shared sidebar nav — injected into any page with an empty <div id="appSidebar">,
// same "one shared script, injected per page" pattern chat-app uses for chat-header.js.
//
// window.crmNavReady: this whole IIFE runs its fetches (me/team/etc) async,
// so window.crmMe/crmTeamUsers aren't guaranteed set by the time a page's
// OWN init code runs -- a page's rendering can easily resolve first (race,
// not sequence). Any code calling ownerFieldHtml/wireOwnerFields must
// `await window.crmNavReady` first so the shared globals it reads are
// actually populated, not silently render as "no admin, no team" on a page
// that happens to load fast.
window.crmNavReady = (async function () {
  const NAV_ITEMS = [
    { href: "/inbox.html", label: "Inbox" },
    { href: "/contacts.html", label: "Contacts" },
    { href: "/forms.html", label: "Forms" },
    { href: "/scheduling.html", label: "Calendars" },
    { href: "/flows.html", label: "Flows" },
    { href: "/campaigns.html", label: "Email Campaigns" },
    { href: "/automations.html", label: "Email Automations" },
    { href: "/workflows.html", label: "SMS Sequences" },
    { href: "/ai-agents.html", label: "AI Agents" },
    { href: "/reporting.html", label: "Reporting" },
    { href: "/connect-email.html", label: "Connect Email" },
    { href: "/settings.html", label: "Settings" },
  ];

  const sidebar = document.getElementById("appSidebar");
  if (!sidebar) return;

  const [meRes, siteRes, navPermRes, teamRes] = await Promise.all([
    fetch("/api/auth/me"), fetch("/api/integrations/site"), fetch("/api/integrations/nav-permissions"), fetch("/api/auth/team"),
  ]);
  if (!meRes.ok) {
    location.href = "/login.html?next=" + encodeURIComponent(location.pathname);
    return;
  }
  const me = (await meRes.json()).user;
  // Shared by every page's "assigned to" dropdown (inbox sidebar/chat panel,
  // contacts table, contact detail page) so each doesn't fetch its own copy.
  window.crmTeamUsers = teamRes.ok ? (await teamRes.json()).users : [];
  const logoUrl = siteRes.ok ? (await siteRes.json()).logoUrl : "";
  // Admin is never restricted (see integrations_backend.js's
  // getNavPermissions comment) -- user/superuser only see whichever tabs an
  // admin has allowed for their role from Settings > Users, defaulting to
  // just Inbox + Contacts.
  const navPerms = navPermRes.ok ? await navPermRes.json() : { user: [], superuser: [] };
  const allowedHrefs = me.role === "admin" ? null : new Set(navPerms[me.role] || []);
  const visibleItems = allowedHrefs ? NAV_ITEMS.filter(item => allowedHrefs.has(item.href)) : NAV_ITEMS;
  // A logo replaces the text wordmark entirely rather than sitting next to
  // it -- matches how the booking page's branding works (logo present hides
  // the brand-name line there too).
  const logoHtml = logoUrl
    ? `<img class="app-sidebar-logo-img" src="${logoUrl}" alt="Pacific Rim Athletics"/>`
    : `Pacific Rim Athletics`;

  const path = location.pathname;
  // Real enforcement, not just hiding the link -- a user/superuser landing
  // directly on a URL their role isn't allowed (typed in, bookmarked, an
  // old link) gets bounced to the first tab they DO have, same as an
  // expired session bouncing to login above.
  if (allowedHrefs && !allowedHrefs.has(path) && visibleItems.length) {
    location.href = visibleItems[0].href;
    return;
  }
  sidebar.innerHTML = `
    <div class="app-sidebar-logo">${logoHtml}</div>
    <nav>
      ${visibleItems.map(item => `<a class="app-nav-link${path === item.href ? " active" : ""}" href="${item.href}">${item.label}</a>`).join("")}
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

// ── "Assigned to" (contact.ownerId) -- shared across the Inbox sidebar/chat
// panel, the Contacts table, and the contact detail page, so all four stay
// visually/behaviorally consistent instead of four separate implementations.
// Admin-only to edit (contacts_backend.js's PATCH enforces this too, not
// just this UI) -- everyone else sees the current assignee as plain text.
function ownerFieldHtml(contact, extraClass) {
  const teamUsers = window.crmTeamUsers || [];
  const isAdmin = window.crmMe?.role === "admin";
  if (!isAdmin) {
    const owner = teamUsers.find(u => u.id === contact?.ownerId);
    return `<span class="owner-field-label${extraClass ? ' ' + extraClass : ''}">${owner ? escapeHtmlForOwnerField(owner.first) : 'Unassigned'}</span>`;
  }
  const options = `<option value="">Unassigned</option>` + teamUsers.map(u =>
    `<option value="${u.id}" ${contact?.ownerId === u.id ? 'selected' : ''}>${escapeHtmlForOwnerField(u.first)} ${escapeHtmlForOwnerField(u.last)}</option>`
  ).join('');
  return `<select class="pra-select owner-field-select${extraClass ? ' ' + extraClass : ''}" data-owner-contact="${contact?.id || ''}">${options}</select>`;
}
function escapeHtmlForOwnerField(s) { const d = document.createElement("div"); d.textContent = String(s ?? ""); return d.innerHTML; }
// Call once after inserting ownerFieldHtml() output into the DOM -- wires
// every unwired owner-field-select inside `root` (defaults to the whole
// page). No-op for non-admins (there's no <select> to wire, just the label).
function wireOwnerFields(root, onSaved) {
  (root || document).querySelectorAll('.owner-field-select:not([data-owner-wired])').forEach(sel => {
    sel.dataset.ownerWired = "1";
    sel.addEventListener('click', (e) => e.stopPropagation());
    sel.addEventListener('change', async (e) => {
      e.stopPropagation();
      const contactId = sel.dataset.ownerContact;
      if (!contactId) return;
      const r = await fetch(`/api/contacts/${contactId}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ownerId: sel.value || null }),
      });
      if (!r.ok) { showToast('Could not save assignment', true); return; }
      showToast('Assigned');
      if (onSaved) onSaved(contactId, sel.value || null);
    });
  });
}

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

  // Snapshot layout-relevant computed values before any DOM changes --
  // needed because plenty of pages size selects via descendant/type
  // selectors (e.g. ".chat-sidebar-filters select { flex:1 }") that only
  // ever match the real <select> tag, not the <span> anchor replacing it
  // visually. Copying className/id (below) covers class/id-based rules;
  // this covers type/descendant-selector rules the same way.
  const computed = getComputedStyle(sel);
  const layoutStyle = `flex:${computed.flex};min-width:${computed.minWidth};max-width:${computed.maxWidth};margin:${computed.margin};`;

  const wrap = document.createElement("span");
  wrap.className = "mobile-select-wrap";
  sel.parentNode.insertBefore(wrap, sel);
  wrap.appendChild(sel);
  sel.classList.add("mobile-select-native");

  const anchor = document.createElement("span");
  anchor.className = (sel.className || "").replace("mobile-select-native", "").trim() + " mobile-select-anchor";
  if (sel.id) anchor.id = sel.id; // deliberately duplicate -- see below
  anchor.setAttribute("style", layoutStyle + (sel.getAttribute("style") || ""));
  wrap.appendChild(anchor);

  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "mobile-select-trigger";
  trigger.innerHTML = '<span class="mobile-select-trigger-label"></span><span class="mobile-select-trigger-caret">&#9662;</span>';
  anchor.appendChild(trigger);
  const label = trigger.querySelector(".mobile-select-trigger-label");

  // Appended to <body> (not the anchor) and positioned with `fixed`
  // coordinates computed at open time -- some anchors sit inside a
  // scrollable/clipping ancestor (e.g. a horizontally-scrolling filter
  // row), and an absolutely-positioned child would get clipped to that
  // ancestor's bounds instead of floating freely over the page below it.
  const menu = document.createElement("div");
  menu.className = "mobile-select-menu";
  document.body.appendChild(menu);

  // Options may carry a data-color attribute (e.g. status dropdowns, set
  // by the page populating them) -- the closed trigger box itself glows
  // that color when selected, same "status at a glance" idea as the
  // colored avatar rings elsewhere in the app (no per-option dots).
  // The Inbox sidebar's status/assigned selects are deliberately this tiny
  // even before the mobile enhancer touches them (see inbox.html's own
  // max-width on .convo-status-select/.owner-field-select) -- an ellipsis
  // there just wastes width restating "there's more text" for a label
  // nobody's meant to read in full at that size (status's glow color and
  // the OPEN dropdown's full untruncated list already carry the real
  // information). First letter only, no dots, saves the space instead.
  // owner-field-select is the base class every assigned-user dropdown gets
  // (chat panel header, Contacts table, sidebar rows alike) -- convo-owner-
  // field is the EXTRA class ownerFieldHtml() only adds for the sidebar's
  // own tight rows (see inbox.html's ownerFieldHtml(c.contact, 'convo-
  // owner-field') call). Checking the bare base class here over-applied
  // this to every owner select app-wide, including the chat panel header
  // and Contacts table, where there's plenty of room for the full name.
  const isCompactTrigger = sel.classList.contains("convo-status-select") || sel.classList.contains("convo-owner-field");
  // The label text shrank to one letter, but the anchor was still stuck at
  // whatever max-width the full-text select had (e.g. owner-field-select's
  // 110px) -- shrink the box itself to match, not just what's inside it.
  if (isCompactTrigger) {
    anchor.style.setProperty("max-width", "34px", "important");
    // No room left for the caret once the box is this narrow -- it was
    // winning the space over the letter itself (flex-shrink:0 on the
    // caret, default shrink on the label), so the letter wasn't showing
    // at all. The letter alone is the whole point here; drop the caret
    // and just center what's left.
    trigger.querySelector(".mobile-select-trigger-caret").style.display = "none";
    trigger.style.justifyContent = "center";
  }
  function renderTrigger() {
    const opt = sel.options[sel.selectedIndex];
    const fullText = opt ? opt.textContent : "";
    label.textContent = isCompactTrigger ? (fullText.trim().charAt(0).toUpperCase() || "") : fullText;
    trigger.disabled = sel.disabled;
    const color = opt && opt.dataset.color;
    anchor.classList.toggle("has-color-glow", !!color);
    if (color) anchor.style.setProperty("--opt-color", color);
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
    const rect = anchor.getBoundingClientRect();
    menu.style.top = (rect.bottom + 4) + "px";
    menu.style.left = rect.left + "px";
    // min-width (not width) -- forcing the menu to the trigger's own width
    // meant a deliberately-shrunk trigger (e.g. the Inbox sidebar's compact
    // status/assigned selects) truncated every OPTION down to that same
    // narrow width too, not just the closed button. No fixed width lets it
    // size to its longest option's content instead; capped against the
    // viewport edge so it can't run off-screen to the right.
    menu.style.minWidth = rect.width + "px";
    menu.style.width = "max-content";
    menu.style.maxWidth = (window.innerWidth - rect.left - 12) + "px";
    menu.classList.add("open");
    document.addEventListener("mousedown", onOutsideClick, true);
  }
  function closeMenu() {
    menu.classList.remove("open");
    document.removeEventListener("mousedown", onOutsideClick, true);
  }
  function onOutsideClick(e) { if (!anchor.contains(e.target) && !menu.contains(e.target)) closeMenu(); }
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
