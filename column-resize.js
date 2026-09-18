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
  }

  function repositionHandles() {
    const tableLeft = table.getBoundingClientRect().left;
    table.querySelectorAll(':scope > .col-resize-handle').forEach(handle => {
      const r = handle._th.getBoundingClientRect();
      handle.style.left = Math.round(r.right - tableLeft - 3) + 'px';
    });
  }

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
