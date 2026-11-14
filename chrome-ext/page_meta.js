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
  let queued = false;
  const kick = () => { if (queued) return; queued = true; setTimeout(() => { queued = false; try { scan(); } catch { /* keep going */ } }, 150); };
  new MutationObserver(kick).observe(document.documentElement, { childList: true, subtree: true });
  setInterval(kick, 1500);
  kick();
})();
