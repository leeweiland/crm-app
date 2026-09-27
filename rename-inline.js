// Shared double-click-to-rename behavior for list-table Name cells across
// forms.html, scheduling.html, campaigns.html, automations.html,
// workflows.html, ai-agents.html, flows.html -- one small helper instead of
// seven near-identical copies. A plain single click still does whatever it
// always did (follow the link, or ai-agents.html's location.href jump);
// double-click swaps the cell into an editable text input instead. Since a
// single click and the first click of a double-click are indistinguishable
// until a second click either arrives or doesn't, a single click's own
// action is delayed by CLICK_DELAY ms and cancelled if a second click
// arrives in time (dblclick) -- the standard fix for this ambiguity.
// Modifier-clicked (ctrl/cmd/shift) or middle-clicked links -- "open in new
// tab" -- are left completely alone, only a plain left click is ever
// delayed/intercepted.
(function () {
  const CLICK_DELAY = 250;
  // opts.getValue()          -> current name to show/edit (string)
  // opts.navigate()          -> called on a confirmed single click
  // opts.save(newName)       -> async; PATCHes the rename. Return
  //                             {ok:false, error} to reject and revert --
  //                             anything else (including undefined) counts
  //                             as success.
  // opts.onRenamed(newName)  -> called after a successful save, so the
  //                             caller can update its own cache array and
  //                             any other DOM referencing the old name
  //                             (e.g. a data-name attribute elsewhere in
  //                             the same row).
  function wireRenameCell(el, opts) {
    let clickTimer = null;
    function startEdit() {
      const current = opts.getValue();
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'rename-inline-input';
      input.value = current;
      el.textContent = '';
      el.appendChild(input);
      input.focus();
      input.select();
      let settled = false;
      function revert() { if (settled) return; settled = true; el.textContent = current; }
      async function commit() {
        if (settled) return;
        const next = input.value.trim();
        if (!next || next === current) { revert(); return; }
        settled = true;
        el.textContent = next;
        const result = await opts.save(next);
        if (result && result.ok === false) {
          el.textContent = current;
          alert(result.error || 'Could not rename.');
          return;
        }
        if (opts.onRenamed) opts.onRenamed(next);
      }
      input.addEventListener('blur', commit);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
        else if (e.key === 'Escape') { e.preventDefault(); revert(); input.blur(); }
      });
      // preventDefault, not just stopPropagation -- el is often an <a href>,
      // and clicking inside the input to reposition the cursor still counts
      // as a click landing inside that ancestor link. A browser follows an
      // anchor's href based on whether the click's default action was
      // prevented ANYWHERE it was seen, regardless of stopPropagation (which
      // only stops OTHER LISTENERS from seeing the event, not the browser's
      // own native default action) -- without this, every click meant to
      // just move the cursor re-triggered navigation.
      input.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); });
      input.addEventListener('dblclick', (e) => { e.preventDefault(); e.stopPropagation(); });
    }
    el.addEventListener('click', (e) => {
      if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; return; }
      clickTimer = setTimeout(() => { clickTimer = null; opts.navigate(); }, CLICK_DELAY);
    });
    el.addEventListener('dblclick', (e) => {
      e.preventDefault();
      if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
      startEdit();
    });
  }
  window.wireRenameCell = wireRenameCell;
})();
