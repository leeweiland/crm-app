// Shared resizable-columns utility -- one drag strip on the right edge of
// each <th data-col-key> (or data-col, for pages that already used that
// name), resizing the whole column via a scoped <style> keyed by nth-child
// position rather than per-cell attributes, so body <td>s don't need their
// own column-key markup to follow along.
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

  function colKeyOf(th) { return th.dataset.colKey || th.dataset.col; }

  function applyWidths(widths) {
    const ths = [...headRow.children];
    const rules = ths.map((th, i) => {
      const w = widths[colKeyOf(th)];
      if (!w) return '';
      // nth-child position, not a per-cell attribute -- so <td>s follow
      // along without needing their own column-key markup, and this stays
      // correct even after contacts.html's drag-to-reorder changes order.
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

  const savedWidths = window.crmMe?.preferences?.[prefKey] || {};
  applyWidths(savedWidths);

  headRow.querySelectorAll('th').forEach(th => {
    const key = colKeyOf(th);
    if (!key || th.querySelector(':scope > .col-resize-handle')) return;
    // The handle is positioned absolute against the nearest positioned
    // ancestor -- .data-table th already sets position:relative, but not
    // every table on the site uses that class (reporting.html's Ads Report
    // table uses its own .pra-table), so force it here rather than assume.
    if (getComputedStyle(th).position === 'static') th.style.position = 'relative';
    const handle = document.createElement('span');
    handle.className = 'col-resize-handle';
    // reporting.html's Ads Report header cells are draggable="true" (native
    // HTML5 drag-to-reorder) -- without this, starting a drag gesture from
    // inside the handle would hijack the resize into a column reorder.
    handle.setAttribute('draggable', 'false');
    th.appendChild(handle);
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
        applyWidths(liveWidths);
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
};
