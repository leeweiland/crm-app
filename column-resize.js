// Shared resizable-columns utility -- one drag strip per column boundary,
// running the FULL height of the table (not just the header cell) so a
// column can be grabbed and resized from any row, not only by scrolling
// back up to the header. Resizing the whole column via a scoped <style>
// keyed by nth-child position rather than per-cell attributes, so body
// <td>s don't need their own column-key markup to follow along.
//
// Widths persist server-side per-user (same /api/auth/me/preferences
// pattern contacts.html's column order/visibility already uses -- see its
// saveColumnPreferences()) so Lee, Alexis, and Josh each keep their own
// widths across tabs, navigation, and browser restarts, on any device.
//
// Call wireColumnResize(headRowSelector, prefKey) once for a page whose
// header row is static HTML. For a page whose header row is rebuilt on
// every render (contacts.html's renderContactsTable(), reporting.html's
// renderAdsReportHeader()), call it again after each rebuild -- same reason
// those pages already re-wire their own drag/sort listeners post-render.
window.wireColumnResize = function (headRowSelector, prefKey) {
  const headRow = document.querySelector(headRowSelector);
  if (!headRow) return;
  const table = headRow.closest('table');
  if (!table) return;
  if (!table.id) table.id = 'col-resize-tbl-' + prefKey;
  // The handles are appended directly to <table> (valid via DOM APIs even
  // though a literal <table>innerHTML couldn't hold a stray <span> -- the
  // HTML parser's foster-parenting rule doesn't apply to appendChild) so
  // that a plain top:0;bottom:0 stretches each handle to the table's own
  // CURRENT rendered height with no JS height tracking -- it stays correct
  // as rows are added/removed, since position:absolute takes the handle
  // out of the flow that determines the table's own height in the first
  // place.
  if (getComputedStyle(table).position === 'static') table.style.position = 'relative';

  function colKeyOf(th) { return th.dataset.colKey || th.dataset.col; }

  function applyColumnWidths(widths) {
    const ths = [...headRow.children];
    const rules = ths.map((th, i) => {
      const w = widths[colKeyOf(th)];
      if (!w) return '';
      return `#${table.id} > thead > tr > th:nth-child(${i + 1}), #${table.id} > tbody > tr > td:nth-child(${i + 1}) { width:${w}px; min-width:${w}px; max-width:${w}px; }`;
    }).filter(Boolean).join('\n');
    let styleTag = document.getElementById('col-resize-style-' + prefKey);
    if (!styleTag) {
      styleTag = document.createElement('style');
      styleTag.id = 'col-resize-style-' + prefKey;
      document.head.appendChild(styleTag);
    }
    styleTag.textContent = rules;
    // Sticky ("frozen-col-N", contacts.html) columns carry hard-coded `left`
    // offsets in the page CSS, worked out for their DEFAULT widths. Once one
    // is resized the next would sit at the wrong offset and, on horizontal
    // scroll, cover part of it -- so recompute each offset from the real
    // widths (measured after the width rules above are in place).
    let left = 0;
    const leftRules = [];
    [...headRow.children].forEach((th, i) => {
      if (!/\bfrozen-col-\d\b/.test(th.className)) return;
      leftRules.push(`#${table.id} > thead > tr > th:nth-child(${i + 1}), #${table.id} > tbody > tr > td:nth-child(${i + 1}) { left:${left}px; }`);
      left += th.getBoundingClientRect().width;
    });
    if (leftRules.length) styleTag.textContent = rules + '\n' + leftRules.join('\n');
  }

  const isFrozen = th => /\bfrozen-col-\d\b/.test(th.className);

  // Handle positions are derived from where each <th> actually IS, so this
  // has to re-run whenever that can change (see the observers below) -- not
  // just once after render. Measuring once left every line to the right of
  // the Timezone column 54-68px off (its live clock text changes that
  // column's width after the handles were placed), and made the sticky
  // First/Last lines drift by exactly the scroll distance.
  function repositionHandles() {
    const tableRect = table.getBoundingClientRect();
    const headRect = headRow.getBoundingClientRect();
    const top = Math.round(headRect.top - tableRect.top);
    const height = Math.round(headRect.height);
    let frozenEdge = -Infinity;
    [...headRow.children].forEach(th => { if (isFrozen(th)) frozenEdge = Math.max(frozenEdge, th.getBoundingClientRect().right); });
    table.querySelectorAll(':scope > .col-resize-handle').forEach(handle => {
      const th = handle._th;
      if (!th.isConnected) return;
      const r = th.getBoundingClientRect();
      handle.style.left = Math.round(r.right - tableRect.left - 3) + 'px';
      handle.style.top = top + 'px';
      handle.style.height = height + 'px';
      // A column scrolled underneath the pinned First/Last columns is hidden
      // there, so its line must not float over them.
      handle.style.visibility = !isFrozen(th) && r.right - 3 < frozenEdge ? 'hidden' : '';
    });
  }

  // Re-measure on anything that moves a column edge: any header cell (or the
  // table) changing size -- data/fonts loading, the Timezone clock text, a
  // resize -- horizontal scroll (pinned columns move relative to the table),
  // and window resizes. Torn down and rebuilt on every call so re-rendering
  // pages don't pile up observers/listeners.
  if (table._colResizeTeardown) table._colResizeTeardown();
  // rAF for smooth tracking while scrolling, plus a timer fallback: a
  // backgrounded tab pauses rAF entirely, and lines must still be right the
  // moment it's shown again.
  let raf = 0, timer = 0;
  const schedule = () => {
    if (raf) return;
    const run = () => { cancelAnimationFrame(raf); clearTimeout(timer); raf = timer = 0; repositionHandles(); };
    raf = requestAnimationFrame(run);
    timer = setTimeout(run, 120);
  };
  let scroller = table.parentElement;
  while (scroller && scroller !== document.body && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowX)) scroller = scroller.parentElement;
  const ro = new ResizeObserver(schedule);
  ro.observe(table);
  [...headRow.children].forEach(th => ro.observe(th));
  scroller?.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('resize', schedule);
  document.fonts?.ready.then(schedule);
  table._colResizeTeardown = () => {
    ro.disconnect();
    scroller?.removeEventListener('scroll', schedule);
    window.removeEventListener('resize', schedule);
    cancelAnimationFrame(raf); clearTimeout(timer); raf = timer = 0;
  };

  // Clear + rebuild handles fresh every call -- the header <tr> may have
  // just been rebuilt (contacts.html/reporting.html Ads Report re-render
  // their thead on every sort/drag/order change), which would otherwise
  // leave stale handles pointing at detached <th> elements.
  table.querySelectorAll(':scope > .col-resize-handle').forEach(h => h.remove());

  const savedWidths = window.crmMe?.preferences?.[prefKey] || {};
  applyColumnWidths(savedWidths);

  [...headRow.children].forEach(th => {
    const key = colKeyOf(th);
    if (!key) return;
    const handle = document.createElement('span');
    handle.className = 'col-resize-handle';
    handle._th = th;
    // reporting.html's Ads Report header cells are draggable="true" (native
    // HTML5 drag-to-reorder) -- without this, starting a drag gesture from
    // inside the handle would hijack the resize into a column reorder.
    handle.setAttribute('draggable', 'false');
    table.appendChild(handle);
    handle.onclick = (e) => e.stopPropagation(); // don't toggle sort on a plain click
    handle.onpointerdown = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const startWidth = th.getBoundingClientRect().width;
      handle.classList.add('resizing');
      handle.setPointerCapture(e.pointerId);
      const liveWidths = { ...(window.crmMe?.preferences?.[prefKey] || {}) };
      const onMove = (e2) => {
        const w = Math.max(50, Math.round(startWidth + (e2.clientX - startX)));
        liveWidths[key] = w;
        applyColumnWidths(liveWidths);
        repositionHandles();
      };
      const onUp = () => {
        handle.classList.remove('resizing');
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        window.crmMe.preferences = { ...(window.crmMe.preferences || {}), [prefKey]: liveWidths };
        fetch('/api/auth/me/preferences', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ [prefKey]: liveWidths }),
        });
      };
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp, { once: true });
    };
  });
  repositionHandles();
};
