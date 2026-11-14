// Runs in Ads Manager's own page context (world: MAIN) for one job: Meta's
// table rows carry no ad/ad set/campaign ID in the HTML, but each Name cell's
// React props do (objectID). This stamps it onto the cell as data-pra-id /
// data-pra-type so content.js (which can't see React props) knows exactly
// which object each visible row is -- no matching by name, so duplicated
// names can't be mixed up.
(() => {
  const TYPES = { CAMPAIGN_GROUP: "campaign", CAMPAIGN: "adset", ADGROUP: "ad" };
  const PREFIX = "forObjectType(name,";
  const fiberOf = (el) => { for (const k in el) if (k.startsWith("__reactFiber")) return el[k]; return null; };
  function nameProps(el) {
    let f = fiberOf(el);
    for (let i = 0; i < 6 && f; i++) {
      const p = f.memoizedProps;
      if (p && p.objectID && typeof p.id === "string" && p.id.startsWith(PREFIX)) return p;
      f = f.return;
    }
    return null;
  }
  function stamp(cell, p) {
    const id = String(p.objectID), typ = TYPES[p.id.slice(PREFIX.length, -1)] || "ad";
    if (cell.dataset.praId !== id) cell.dataset.praId = id;
    if (cell.dataset.praType !== typ) cell.dataset.praType = typ;
  }
  function scan() {
    const table = document.querySelector('[role="table"]');
    if (!table) return;
    let cells = table.querySelectorAll("._1b33");
    let hits = 0;
    for (const c of cells) {
      const p = nameProps(c);
      if (p) { stamp(c, p); hits++; }
      else if (c.dataset.praId) { delete c.dataset.praId; delete c.dataset.praType; }
    }
    if (hits) return;
    // Fallback if Meta renames its cell class: the outermost element whose own props name the row.
    for (const c of table.querySelectorAll("div")) {
      if (c.parentElement && nameProps(c.parentElement)) continue;
      const p = nameProps(c);
      if (p && c.getBoundingClientRect().height > 20) stamp(c, p);
    }
  }
  // Second job: hold the Name column at the width content.js remembered
  // (data-pra-name-w on <html>). Meta keeps that width per tab and forgets it on
  // navigation/refresh; this calls the table's own resize callback -- the same
  // one a drag of the column edge calls -- once per table/tab/width.
  const applied = new WeakMap();
  function holdWidth() {
    const root = document.documentElement;
    const want = Number(root.dataset.praNameW || 0);
    if (!want || root.dataset.praMouseDown === "1") return;
    const table = document.querySelector('[role="table"]');
    const cell = table && table.querySelector("[data-pra-id]");
    if (!cell) return;
    let f = fiberOf(table), props = null;
    for (let i = 0; i < 12 && f; i++) { if (f.memoizedProps && f.memoizedProps.onColumnResizeEndCallback) { props = f.memoizedProps; break; } f = f.return; }
    if (!props || props.isColumnResizing) return;
    const nameKey = [].concat(props.children || []).flat(3).map(k => k && k.props && k.props.columnKey).find(k => typeof k === "string" && k.startsWith(PREFIX));
    if (!nameKey) return;
    const sig = location.pathname + "|" + nameKey + "|" + want;
    if (applied.get(table) === sig) return;
    applied.set(table, sig);
    const cr = cell.getBoundingClientRect();
    const head = [...table.querySelectorAll('[role="columnheader"]')].find(h => { const r = h.getBoundingClientRect(); return r.left <= cr.left + 14 && r.right >= cr.right - 14; });
    const headW = head ? head.getBoundingClientRect().width : cr.width;
    if (Math.abs(headW - want) <= 4) return;
    props.onColumnResizeEndCallback(Math.round(want - (headW - cr.width)), nameKey);
  }

  let queued = false;
  const kick = () => { if (queued) return; queued = true; setTimeout(() => { queued = false; try { scan(); holdWidth(); } catch { /* keep going */ } }, 150); };
  new MutationObserver(kick).observe(document.documentElement, { childList: true, subtree: true });
  setInterval(kick, 1500);
  kick();
})();
