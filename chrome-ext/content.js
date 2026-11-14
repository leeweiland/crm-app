// PRA Ads Columns: draws the CRM columns inside the ad platform's own table.
// Meta: a dark block at the right edge of the Name column (widen the Name
// column to make room), a header block in the Name header, and a totals block
// in the "Results from ..." footer. Row IDs come from page_meta.js.
// Data: one CRM request per date range / attribution model (the CRM caches it;
// the refresh button forces a new one). Nothing polls.
(() => {
  const PLATFORM = location.hostname === "ads.google.com" ? "google" : "meta";
  const COLS = window.PRA_COLUMNS, FMT = window.PRA_FMT;
  const BY_KEY = Object.fromEntries(COLS.map(c => [c.k, c]));
  const COL_W = 88;
  const DEFAULTS = { cols: window.PRA_DEFAULT_COLS.slice(), model: "first" };
  let settings = { ...DEFAULTS };
  let data = null, dataKey = null, loading = false, error = null, crmUrl = "https://crm-app-production-eb8f.up.railway.app";
  let ver = 1, range = null, narrowWarned = false;

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const activeCols = () => settings.cols.map(k => BY_KEY[k]).filter(Boolean);
  try {
    chrome.storage.sync.get(DEFAULTS, (s) => { settings = { cols: s.cols?.length ? s.cols : DEFAULTS.cols, model: s.model || "first" }; ver++; });
  } catch { /* extension reloaded */ }
  const save = () => { try { chrome.storage.sync.set({ cols: settings.cols, model: settings.model }); } catch { /* ignore */ } ver++; };

  // ── Date range from the page ──
  const MON = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };
  const DATE_RE = /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.? (\d{1,2})(?:, (\d{4}))?/g;
  function parseRangeText(t) {
    const hits = [...t.matchAll(DATE_RE)];
    if (!hits.length) return null;
    const year = hits.map(h => h[3]).filter(Boolean).pop();
    if (!year) return null;
    const ymd = (h) => `${h[3] || year}-${String(MON[h[1]]).padStart(2, "0")}-${String(h[2]).padStart(2, "0")}`;
    let start = ymd(hits[0]), end = ymd(hits[hits.length - 1]);
    if (start > end && !hits[0][3]) start = `${Number(year) - 1}${start.slice(4)}`; // "Dec 20 – Jan 5, 2027"
    return { start, end, label: t.trim() };
  }
  function findRangeText() {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let best = null;
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const t = n.nodeValue;
      if (!t || t.length > 90 || !/\d{4}/.test(t)) continue;
      DATE_RE.lastIndex = 0;
      if (!DATE_RE.test(t)) continue;
      const el = n.parentElement;
      if (!el || el.closest(".pra-block, .pra-pop, .pra-modal")) continue;
      const r = el.getBoundingClientRect();
      if (!r.width || r.top > 320) continue;
      if (!best || r.top < best.top) best = { t: el.closest("[role=button]")?.innerText || t, top: r.top };
    }
    return best ? parseRangeText(best.t.replace(/\s+/g, " ")) : null;
  }

  // ── Platform adapters ──
  const meta = {
    rows() { return [...document.querySelectorAll('[role="table"] [data-pra-id]')].map(cell => ({ host: cell, id: cell.dataset.praId, type: cell.dataset.praType })); },
    header(first) {
      if (!first) return null;
      const r = first.getBoundingClientRect();
      return [...document.querySelectorAll('[role="table"] [role="columnheader"]')].find(h => { const hr = h.getBoundingClientRect(); return hr.left <= r.left + 14 && hr.right >= r.right - 14; }) || null;
    },
    footer(first) {
      if (!first) return null;
      const table = document.querySelector('[role="table"]');
      const walker = document.createTreeWalker(table, NodeFilter.SHOW_TEXT);
      const r = first.getBoundingClientRect();
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (!/^\s*Results from/.test(n.nodeValue || "")) continue;
        for (let el = n.parentElement; el && el !== table; el = el.parentElement) {
          const er = el.getBoundingClientRect();
          if (Math.abs(er.left - r.left) < 16 && Math.abs(er.width - r.width) < 16) return el;
          if (er.width > r.width + 40) break;
        }
      }
      return null;
    },
    level(rows) {
      if (rows[0]?.type) return rows[0].type;
      const p = location.pathname;
      return /campaigns/.test(p) ? "campaign" : /adsets/.test(p) ? "adset" : "ad";
    },
    selection() {
      const u = new URL(location.href);
      const ids = (k) => (u.searchParams.get(k) || "").split(",").filter(Boolean);
      return { campaigns: ids("selected_campaign_ids"), adsets: ids("selected_adset_ids") };
    },
  };
  // Google Ads: the page has no IDs in its table. A row's ID comes from the
  // "Campaign ID" / "Ad group ID" / "Ad ID" column when that column is shown,
  // otherwise campaigns and ad groups are matched by name (the CRM sends the
  // names; campaign names are unique per account, a duplicated ad group name is
  // left blank rather than guessed). The Ads tab needs the Ad ID column.
  const ID_HEADER = { campaign: /^Campaign ID\b/i, adset: /^Ad group ID\b/i, ad: /^Ad ID\b/i };
  let nameIndex = { at: null };
  function idByName(level, name) {
    if (!data?.names || level === "ad") return null;
    if (nameIndex.at !== data) {
      nameIndex = { at: data };
      for (const lvl of ["campaign", "adset"]) {
        const m = new Map();
        for (const [id, n] of Object.entries(data.names[lvl] || {})) m.set(n, m.has(n) ? null : id);
        nameIndex[lvl] = m;
      }
    }
    return nameIndex[level]?.get(name) || null;
  }
  const google = {
    table() { return document.querySelector('ess-table[debugid="main-ess-table"]') || document.querySelector("ess-table"); },
    level() { const p = location.pathname; return /\/aw\/adgroups/.test(p) ? "adset" : /\/aw\/ads\b/.test(p) ? "ad" : "campaign"; },
    headers(t) { return [...t.querySelectorAll('[role="columnheader"]')]; },
    nameHeader(t) { const hs = this.headers(t); return hs.find(h => h.classList.contains("last-frozen-column")) || hs.find(h => h.getAttribute("essfield") === "name") || null; },
    rows() {
      const t = this.table();
      if (!t) return [];
      const nh = this.nameHeader(t);
      if (!nh) return [];
      const lvl = this.level();
      const nf = nh.getAttribute("essfield");
      const idf = this.headers(t).find(h => ID_HEADER[lvl].test(h.innerText.trim()))?.getAttribute("essfield");
      const out = [];
      for (const r of t.querySelectorAll(".particle-table-row")) {
        if (r.classList.contains("particle-table-summary-row")) continue;
        const host = r.querySelector(`ess-cell[essfield="${CSS.escape(nf)}"]`);
        if (!host) continue;
        let id = idf ? (r.querySelector(`ess-cell[essfield="${CSS.escape(idf)}"]`)?.innerText || "").replace(/\D/g, "") : "";
        if (!id) id = idByName(lvl, (host.innerText || "").split("\n")[0].trim());
        // Rows not matched yet still get a block (dots until the CRM answers), so the header and totals appear.
        out.push({ host, id: id || "", type: lvl });
      }
      return out;
    },
    header() { const t = this.table(); return t ? this.nameHeader(t) : null; },
    footer() {
      const t = this.table(), nh = t && this.nameHeader(t);
      const sr = nh && t.querySelector(".particle-table-summary-row");
      return sr ? sr.querySelector(`ess-cell[essfield="${CSS.escape(nh.getAttribute("essfield"))}"]`) : null;
    },
    selection() {
      const u = new URL(location.href);
      return { campaigns: [u.searchParams.get("campaignId")].filter(Boolean), adsets: [u.searchParams.get("adGroupId")].filter(Boolean) };
    },
  };
  const A = PLATFORM === "meta" ? meta : google;

  // ── Data ──
  function ensureData(force) {
    if (!range) return;
    const key = `${PLATFORM}|${range.start}|${range.end}|${settings.model}`;
    if (!force && (key === dataKey || loading)) return;
    loading = true; error = null; ver++;
    const path = `/api/reporting/ext-columns?platform=${PLATFORM}&start=${range.start}&end=${range.end}&model=${settings.model}${force ? "&fresh=1" : ""}`;
    try {
      chrome.runtime.sendMessage({ type: "crm", path }, (res) => {
        loading = false; dataKey = key;
        if (chrome.runtime.lastError || !res) error = "The extension was reloaded: refresh this page";
        else if (res.status === 401) error = "login";
        else if (res.status === 0) error = "Can't reach the CRM (" + (res.error || "network") + ")";
        else if (res.status !== 200 || !res.json || res.json.error) error = (res.json && res.json.error) || "CRM error " + res.status;
        else { data = res.json; if (res.crmUrl) crmUrl = res.crmUrl; }
        ver++;
      });
    } catch { loading = false; error = "The extension was reloaded: refresh this page"; ver++; }
  }

  const ZERO = { spend: 0, impressions: 0, clicks: 0, linkClicks: 0, leads: 0, emailsOnline: 0, emailsGym: 0, bookings: 0, applications: 0, calls: 0, enrollments: 0, revenue: 0, cash: 0, customers: 0, c: { leads: [], calls: [], enrollments: [], cash: [] } };
  const NUM_KEYS = Object.keys(ZERO).filter(k => k !== "c");
  function sum(list) {
    const t = { ...ZERO, c: { leads: [], calls: [], enrollments: [], cash: [] } };
    for (const m of list) {
      for (const k of NUM_KEYS) t[k] += m[k] || 0;
      for (const l of Object.keys(t.c)) for (const id of m.c?.[l] || []) if (!t.c[l].includes(id)) t.c[l].push(id);
    }
    return t;
  }
  function totalsFor(level) {
    if (!data) return null;
    const sel = A.selection();
    if (!sel.campaigns.length && !sel.adsets.length) return data.totals;
    const pick = Object.entries(data[level] || {}).filter(([id]) => {
      if (level === "campaign") return !sel.campaigns.length || sel.campaigns.includes(id);
      if (level === "adset") return sel.adsets.length ? sel.adsets.includes(id) : sel.campaigns.includes(data.parents?.adset?.[id]);
      const p = data.parents?.ad?.[id];
      if (!p) return false;
      return sel.adsets.length ? sel.adsets.includes(p[0]) : sel.campaigns.includes(p[1]);
    }).map(([, m]) => m);
    return sum(pick);
  }

  // ── Drawing ──
  function block(host, kind) {
    let b = host.querySelector(":scope > .pra-block");
    if (!b) {
      if (getComputedStyle(host).position === "static") host.style.position = "relative";
      b = document.createElement("div");
      b.className = "pra-block pra-" + kind;
      b.addEventListener("click", onClick);
      b.addEventListener("dragstart", onDragStart);
      b.addEventListener("dragover", onDragOver);
      b.addEventListener("drop", onDrop);
      for (const ev of ["mousedown", "mouseup", "click", "dblclick", "pointerdown", "pointerup", "dragstart", "dragover", "dragenter", "drop", "keydown"]) b.addEventListener(ev, e => e.stopPropagation());
      host.appendChild(b);
    }
    return b;
  }
  function valueCell(col, m, ref) {
    const v = m ? col.get(m) : null;
    const txt = m ? FMT(col.fmt, v) : "·";
    let cls = "pra-c";
    if (m && (col.k === "profit" || col.k === "roi") && v) cls += v > 0 ? " pra-pos" : " pra-neg";
    const drill = m && col.drill && v > 0 && ref;
    return `<div class="${cls}" style="width:${COL_W}px">${drill ? `<a class="pra-d" data-d="${col.drill}" data-ref="${esc(ref)}" data-l="${esc(col.label)}">${esc(txt)}</a>` : esc(txt)}</div>`;
  }
  const ICON_GEAR = '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M19.4 13a7.5 7.5 0 0 0 0-2l2.1-1.6-2-3.5-2.5 1a7.6 7.6 0 0 0-1.7-1L15 3h-4l-.4 2.9a7.6 7.6 0 0 0-1.7 1l-2.5-1-2 3.5L6.6 11a7.5 7.5 0 0 0 0 2l-2.1 1.6 2 3.5 2.5-1a7.6 7.6 0 0 0 1.7 1L11 21h4l.4-2.9a7.6 7.6 0 0 0 1.7-1l2.5 1 2-3.5zM13 15.5A3.5 3.5 0 1 1 13 8.5a3.5 3.5 0 0 1 0 7z"/></svg>';
  const ICON_REFRESH = '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M17.7 6.3A8 8 0 1 0 20 12h-2a6 6 0 1 1-1.8-4.2L13 11h7V4z"/></svg>';

  function headerHtml() {
    const tools = `<div class="pra-tools"><button class="pra-btn" data-act="cfg" title="Configure columns">${ICON_GEAR}</button><button class="pra-btn" data-act="refresh" title="Refresh CRM numbers">${ICON_REFRESH}</button></div>`;
    if (error === "login") return tools + `<div class="pra-msg">Not logged in to the CRM. <a data-act="login">Log in</a>, then refresh.</div>`;
    if (error) return tools + `<div class="pra-msg pra-err" title="${esc(error)}">${esc(error)}</div>`;
    const cols = activeCols().map((c, i) => `<div class="pra-h" draggable="true" data-i="${i}" style="width:${COL_W}px" title="${esc(c.tip || c.label)} (drag to reorder)">${esc(c.label)}</div>`).join("");
    return tools + cols + (loading ? `<div class="pra-loading"></div>` : "");
  }
  function widthNeeded() { return activeCols().length * COL_W + 34; }

  function render() {

    const rows = A.rows();
    if (!rows.length) return;
    const now = findRangeTextThrottled();
    if (now && (!range || now.start !== range.start || now.end !== range.end)) range = now;
    ensureData(false); // no-op unless the range or attribution model changed
    const level = A.level(rows);
    const fresh = data && dataKey === `${PLATFORM}|${range?.start}|${range?.end}|${settings.model}`;
    // Every block's right edge sits 10px inside the Name column's right edge (the
    // 10px keeps Meta's column-resize handle grabbable), measured against the
    // header so rows, header and totals line up even when their cells differ.
    const head = A.header(rows[0].host);
    const headRight = head ? head.getBoundingClientRect().right : null;
    const align = (b, host) => {
      if (headRight == null) return;
      const want = Math.round(host.getBoundingClientRect().right - headRight + 10) + "px";
      if (b.style.right !== want) b.style.right = want;
    };
    for (const { host, id, type } of rows) {
      const b = block(host, "row");
      align(b, host);
      const key = `${id}|${ver}`;
      if (b.dataset.key === key) continue;
      b.dataset.key = key;
      const m = fresh && id ? (data[type]?.[id] || ZERO) : null;
      b.innerHTML = `<div class="pra-tools-sp"></div>` + activeCols().map(c => valueCell(c, m, `${type}:${id}`)).join("");
    }
    if (head) {
      const hb = block(head, "head");
      if (hb.dataset.key !== String(ver)) { hb.dataset.key = String(ver); hb.innerHTML = headerHtml(); }
      if (!narrowWarned && rows[0].host.getBoundingClientRect().width < widthNeeded() + 190) { narrowWarned = true; toast("Drag the right edge of the Name column wider to make room for the CRM columns."); }
    }
    const foot = A.footer(rows[0].host);
    if (foot) {
      const fb = block(foot, "foot");
      align(fb, foot);
      const fkey = `${ver}|${location.search}`;
      if (fb.dataset.key !== fkey) {
        fb.dataset.key = fkey;
        const t = fresh ? totalsFor(level) : null;
        fb.innerHTML = `<div class="pra-tools-sp"></div>` + activeCols().map(c => valueCell(c, t, `total:${level}`)).join("");
      }
    }
  }
  let lastRangeAt = 0, lastRange = null;
  function findRangeTextThrottled() {
    if (Date.now() - lastRangeAt < 1500) return lastRange;
    lastRangeAt = Date.now();
    lastRange = findRangeText() || lastRange;
    return lastRange;
  }

  // ── Clicks ──
  function onClick(e) {
    const a = e.target.closest("[data-act], .pra-d");
    if (!a) return;
    e.preventDefault();
    if (a.dataset.act === "cfg") return openConfig();
    if (a.dataset.act === "refresh") { range = findRangeText() || range; return ensureData(true); }
    if (a.dataset.act === "login") return window.open(crmUrl + "/login.html", "_blank");
    if (a.classList.contains("pra-d")) return openDrill(a, e);
  }
  function peopleFor(ref, list) {
    const [type, id] = ref.split(":");
    const m = type === "total" ? totalsFor(id) : data?.[type]?.[id];
    return (m?.c?.[list] || []).map(cid => ({ id: cid, ...(data.people?.[cid] || { n: cid }) }));
  }
  const LIST_TITLE = { leads: "Lead details", calls: "Call details (bookings + applications)", enrollments: "Enrollment details", cash: "Sale details (cash collected)" };
  function openDrill(a, e) {
    closePop();
    const people = peopleFor(a.dataset.ref, a.dataset.d);
    const pop = document.createElement("div");
    pop.className = "pra-pop";
    pop.innerHTML = `<div class="pra-pop-h">${esc(LIST_TITLE[a.dataset.d] || a.dataset.l)} <span>${people.length}</span><button class="pra-x" data-act="close">×</button></div>
      <div class="pra-pop-b">${people.map(p => `<a href="${esc(crmUrl)}/contact-detail.html?id=${encodeURIComponent(p.id)}" target="_blank" rel="noopener"><b>${esc(p.n)}</b><span>${esc(p.e || "")}${p.p ? " · " + esc(p.p) : ""}</span></a>`).join("") || "<div class='pra-empty'>No contacts</div>"}</div>
      <div class="pra-pop-f">${data?.model === "last" ? "Last click" : "First click"} · ${esc(data?.start)} to ${esc(data?.end)}</div>`;
    document.body.appendChild(pop);
    const r = a.getBoundingClientRect();
    pop.style.left = Math.max(8, Math.min(window.innerWidth - 340, r.left - 150)) + "px";
    pop.style.top = Math.min(window.innerHeight - 340, r.bottom + 6) + "px";
    pop.addEventListener("click", ev => { if (ev.target.closest("[data-act=close]")) closePop(); ev.stopPropagation(); });
    setTimeout(() => document.addEventListener("click", closePop, { once: true }), 0);
  }
  function closePop() { document.querySelectorAll(".pra-pop").forEach(p => p.remove()); }
  document.addEventListener("keydown", e => { if (e.key === "Escape") { closePop(); closeConfig(); } });

  // ── Reorder by dragging header labels ──
  let dragFrom = null;
  function onDragStart(e) { const h = e.target.closest(".pra-h"); if (!h) return; dragFrom = Number(h.dataset.i); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", "pra"); }
  function onDragOver(e) { if (dragFrom != null && e.target.closest(".pra-h")) e.preventDefault(); }
  function onDrop(e) {
    const h = e.target.closest(".pra-h");
    if (!h || dragFrom == null) return;
    e.preventDefault();
    const to = Number(h.dataset.i), cols = activeCols().map(c => c.k);
    const [moved] = cols.splice(dragFrom, 1);
    cols.splice(to, 0, moved);
    dragFrom = null;
    settings.cols = cols; save();
  }

  // ── Configure columns ──
  function closeConfig() { document.querySelectorAll(".pra-modal").forEach(m => m.remove()); }
  function openConfig() {
    closeConfig();
    let order = [...settings.cols, ...COLS.map(c => c.k).filter(k => !settings.cols.includes(k))];
    const on = new Set(settings.cols);
    let model = settings.model;
    const m = document.createElement("div");
    m.className = "pra-modal";
    const draw = () => {
      m.innerHTML = `<div class="pra-card">
        <div class="pra-card-h">CRM columns</div>
        <div class="pra-sub">Tick the columns to show, drag to reorder.</div>
        <div class="pra-list">${order.map((k, i) => `<label class="pra-opt" draggable="true" data-i="${i}"><span class="pra-grip">⋮⋮</span><input type="checkbox" data-k="${k}" ${on.has(k) ? "checked" : ""}><span class="pra-lbl">${esc(BY_KEY[k].label)}</span><span class="pra-tip">${esc(BY_KEY[k].tip || "")}</span></label>`).join("")}</div>
        <div class="pra-sub">Attribution</div>
        <div class="pra-models"><label><input type="radio" name="pra-model" value="first" ${model === "first" ? "checked" : ""}> First click</label><label><input type="radio" name="pra-model" value="last" ${model === "last" ? "checked" : ""}> Last click</label></div>
        <div class="pra-card-f"><button class="pra-b2" data-act="reset">Reset</button><span></span><button class="pra-b2" data-act="cancel">Cancel</button><button class="pra-b1" data-act="save">Save</button></div>
      </div>`;
    };
    draw();
    let from = null;
    m.addEventListener("dragstart", e => { const r = e.target.closest(".pra-opt"); if (r) { from = Number(r.dataset.i); e.dataTransfer.setData("text/plain", "pra"); } });
    m.addEventListener("dragover", e => { if (from != null && e.target.closest(".pra-opt")) e.preventDefault(); });
    m.addEventListener("drop", e => { const r = e.target.closest(".pra-opt"); if (!r || from == null) return; e.preventDefault(); const [k] = order.splice(from, 1); order.splice(Number(r.dataset.i), 0, k); from = null; draw(); });
    m.addEventListener("change", e => {
      if (e.target.dataset.k) { e.target.checked ? on.add(e.target.dataset.k) : on.delete(e.target.dataset.k); }
      if (e.target.name === "pra-model") model = e.target.value;
    });
    m.addEventListener("click", e => {
      if (e.target === m) return closeConfig();
      const act = e.target.closest("[data-act]")?.dataset.act;
      if (act === "cancel") closeConfig();
      if (act === "reset") { order = [...DEFAULTS.cols, ...COLS.map(c => c.k).filter(k => !DEFAULTS.cols.includes(k))]; on.clear(); DEFAULTS.cols.forEach(k => on.add(k)); model = "first"; draw(); }
      if (act === "save") {
        const modelChanged = model !== settings.model;
        settings.cols = order.filter(k => on.has(k));
        settings.model = model;
        save(); closeConfig();
        narrowWarned = false;
        if (modelChanged) ensureData(false);
      }
    });
    for (const ev of ["mousedown", "click", "keydown", "pointerdown"]) m.addEventListener(ev, e => e.stopPropagation());
    document.body.appendChild(m);
  }

  function toast(msg) {
    const t = document.createElement("div");
    t.className = "pra-toast";
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 7000);
  }

  setInterval(() => { try { render(); } catch (e) { console.warn("[PRA Ads Columns]", e); } }, 400);
})();
