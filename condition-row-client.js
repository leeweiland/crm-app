// Shared segment/automation-condition row builder -- factored out of
// contacts.html (where this used to be inline-only) so campaign-builder.html
// can build+save a new segment without leaving the page, using the exact
// same field/operator/value UI. Browser global, same convention as
// window.BlockEditor: this file runs in the browser and can't import
// segments_shared.js's ESM module directly, so the op/field vocabulary here
// is hand-kept in sync with it (see segments_shared.js's own doc comment).
window.ConditionRowBuilder = (function () {
  function escapeHtml(s) { const d = document.createElement('div'); d.textContent = String(s ?? ''); return d.innerHTML; }

  let allStatuses = [], allTags = [], allLists = [], allCustomFields = [];
  function init(refData) {
    allStatuses = refData?.statuses || [];
    allTags = refData?.tags || [];
    allLists = refData?.lists || [];
    allCustomFields = refData?.customFields || [];
  }

  const ARRAY_FIELDS = ["tags", "listIds"];
  const BOOL_FIELDS = ["smsOptOut", "emailOptOut", "emailOpened", "emailClicked"];
  // Single-valued fields that can still usefully be matched against a SET
  // of options ("status is any of Potential/Application/Booked" -- a
  // cohort filter). No "all of" here (unlike ARRAY_FIELDS) -- a contact
  // only ever has one status, so "is all of X, Y" could never match more
  // than a single selected value and would silently return nothing for
  // any real multi-value selection.
  const SCALAR_MULTI_FIELDS = ["status"];

  function fieldOptionsHtml() {
    return `
      <option value="status">Status</option>
      <option value="programType">Type (Online/Gym)</option>
      <option value="smsOptOut">SMS Opt-Out</option>
      <option value="emailOptOut">Email Opt-Out</option>
      <option value="tags">Tag</option>
      <option value="listIds">List</option>
      <option value="emailOpened">Opened Email</option>
      <option value="emailClicked">Clicked Email</option>
      <option value="visitedPage">Visited Webpage</option>
      ${allCustomFields.map(f => `<option value="customFields.${f.id}">${escapeHtml(f.label)}</option>`).join('')}
    `;
  }
  // legacyOp: when editing an existing row whose stored op is one of the old
  // includes/excludes codes, that exact option is appended too (selected),
  // so opening an old segment for editing doesn't silently change its op --
  // it's just not offered as a choice for a brand-new row.
  function opOptionsHtml(field, legacyOp) {
    if (field === "visitedPage") return `<option value="eq">Is</option><option value="neq">Is not</option><option value="contains">Contains</option>`;
    if (ARRAY_FIELDS.includes(field)) {
      const legacy = (legacyOp === "includes") ? `<option value="includes">Includes (legacy)</option>` : (legacyOp === "excludes") ? `<option value="excludes">Excludes (legacy)</option>` : "";
      return `<option value="any_of">Is any of</option><option value="all_of">Is all of</option><option value="not_any_of">Is not any of</option><option value="not_all_of">Is not all of</option>${legacy}`;
    }
    if (SCALAR_MULTI_FIELDS.includes(field)) {
      return `<option value="eq">Is</option><option value="neq">Is not</option><option value="any_of">Is any of</option><option value="not_any_of">Is not any of</option>`;
    }
    if (field.startsWith("customFields.")) return `<option value="eq">Is</option><option value="neq">Is not</option><option value="exists">Is set</option>`;
    return `<option value="eq">Is</option><option value="neq">Is not</option>`;
  }

  // Minimal self-contained chip multi-select for the "is any of"/"is all
  // of" value input -- same look (via the shared .search-multiselect/.ms-*/
  // .tag-pill rules in crm-design-system.css) as campaign-builder.html's
  // list/tag/exclude pickers, but keeps its selected-ids array in a closure
  // instead of on a page-global object, so it can live inside an arbitrary
  // condition row.
  function renderMultiSelectInto(el, items, selected, onChange) {
    el.innerHTML = `<div class="ms-chips"></div><input class="pra-input ms-search" type="text" placeholder="Search..."/><div class="ms-dropdown"></div>`;
    const chipsEl = el.querySelector('.ms-chips');
    const searchEl = el.querySelector('.ms-search');
    const dropdownEl = el.querySelector('.ms-dropdown');
    function renderChips() {
      const sel = items.filter(i => selected.includes(i.id));
      chipsEl.innerHTML = sel.map(i => `<span class="tag-pill">${escapeHtml(i.name)}<button type="button" data-remove="${i.id}">&times;</button></span>`).join('');
      chipsEl.querySelectorAll('[data-remove]').forEach(btn => btn.onclick = () => {
        selected.splice(selected.indexOf(btn.dataset.remove), 1);
        renderChips(); onChange(selected);
      });
    }
    function showMatches() {
      const q = searchEl.value.trim().toLowerCase();
      const matches = items.filter(i => !selected.includes(i.id) && i.name.toLowerCase().includes(q)).slice(0, 30);
      dropdownEl.innerHTML = matches.length ? matches.map(i => `<div class="ms-option" data-id="${i.id}">${escapeHtml(i.name)}</div>`).join('') : `<div class="ms-option-empty">${items.length ? 'No matches' : 'None yet'}</div>`;
      dropdownEl.classList.add('open');
      dropdownEl.querySelectorAll('.ms-option').forEach(opt => opt.onclick = () => {
        selected.push(opt.dataset.id);
        searchEl.value = '';
        dropdownEl.classList.remove('open');
        renderChips(); onChange(selected);
      });
    }
    searchEl.addEventListener('input', showMatches);
    searchEl.addEventListener('focus', showMatches);
    searchEl.addEventListener('blur', () => setTimeout(() => dropdownEl.classList.remove('open'), 150));
    renderChips();
  }

  const MULTI_VALUE_OPS = ["any_of", "all_of", "not_any_of", "not_all_of"];

  function valueInputHtml(field, op) {
    if (op === 'exists') return `<input class="pra-input" data-cond-value disabled placeholder="(no value needed)"/>`;
    // Checked before the plain single-value <select> branches below, so
    // "is any of"/"is not any of" on a SCALAR_MULTI_FIELDS field (status)
    // gets the same chip multi-picker as an ARRAY_FIELDS field, instead of
    // falling through to the single-value <select>.
    if (MULTI_VALUE_OPS.includes(op) && (ARRAY_FIELDS.includes(field) || SCALAR_MULTI_FIELDS.includes(field))) return `<span data-cond-value-multi></span>`; // filled in by refreshValue() below
    if (field === 'type') return `<select class="pra-select" data-cond-value><option value="lead">Lead</option><option value="contact">Contact</option></select>`; // legacy field, kept only so a pre-existing saved segment still renders correctly
    if (field === 'programType') return `<select class="pra-select" data-cond-value><option value="online">Online</option><option value="gym">Gym</option></select>`;
    if (BOOL_FIELDS.includes(field)) return `<select class="pra-select" data-cond-value><option value="true">Yes</option><option value="false">No</option></select>`;
    if (field === 'status') return `<select class="pra-select" data-cond-value>${allStatuses.map(s => `<option value="${escapeHtml(s.label)}">${escapeHtml(s.label)}</option>`).join('')}</select>`;
    if (field === 'visitedPage') return `<input class="pra-input" data-cond-value placeholder="/some-page"/>`;
    if (field === 'tags') return `<select class="pra-select" data-cond-value>${allTags.map(t => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join('')}</select>`;
    if (field === 'listIds') return `<select class="pra-select" data-cond-value>${allLists.map(l => `<option value="${l.id}">${escapeHtml(l.name)}</option>`).join('')}</select>`;
    return `<input class="pra-input" data-cond-value placeholder="Value..."/>`;
  }

  function addRow(containerEl, initial) {
    const row = document.createElement('div');
    row.className = 'cond-row';
    row.innerHTML = `
      <select class="pra-select" data-cond-field>${fieldOptionsHtml()}</select>
      <select class="pra-select" data-cond-op></select>
      <span data-cond-value-wrap></span>
      <button class="pra-btn pra-btn-sm pra-btn-danger" type="button" data-remove-cond>&times;</button>
    `;
    containerEl.appendChild(row);
    row._msSelected = Array.isArray(initial?.value) ? [...initial.value] : [];
    const fieldSel = row.querySelector('[data-cond-field]');
    const opSel = row.querySelector('[data-cond-op]');
    const valueWrap = row.querySelector('[data-cond-value-wrap]');
    function refreshOps() { opSel.innerHTML = opOptionsHtml(fieldSel.value, initial && initial.field === fieldSel.value ? initial.op : null); }
    function refreshValue() {
      valueWrap.innerHTML = valueInputHtml(fieldSel.value, opSel.value);
      const multiHost = valueWrap.querySelector('[data-cond-value-multi]');
      if (multiHost) {
        const items = fieldSel.value === 'tags' ? allTags
          : fieldSel.value === 'listIds' ? allLists
          : fieldSel.value === 'status' ? allStatuses.map(s => ({ id: s.label, name: s.label })) // status has no separate id -- its label IS the stored value
          : [];
        if (!row._msSelected.length && initial && initial.field === fieldSel.value && Array.isArray(initial.value)) row._msSelected = [...initial.value];
        renderMultiSelectInto(multiHost, items, row._msSelected, (sel) => { row._msSelected = sel; });
      }
    }
    fieldSel.onchange = () => { row._msSelected = []; refreshOps(); refreshValue(); };
    opSel.onchange = refreshValue;
    refreshOps(); refreshValue();
    if (initial) {
      fieldSel.value = initial.field; refreshOps();
      opSel.value = initial.op; refreshValue();
      if (!MULTI_VALUE_OPS.includes(initial.op)) {
        const valEl = row.querySelector('[data-cond-value]');
        if (valEl) valEl.value = initial.value ?? '';
      }
    }
    row.querySelector('[data-remove-cond]').onclick = () => row.remove();
    return row;
  }

  function buildFilter(containerEl, matchMode) {
    const conds = [...containerEl.children].map(row => {
      const field = row.querySelector('[data-cond-field]').value;
      const op = row.querySelector('[data-cond-op]').value;
      let value;
      if (op === 'exists') value = undefined;
      else if (MULTI_VALUE_OPS.includes(op)) value = row._msSelected || [];
      else value = row.querySelector('[data-cond-value]')?.value;
      return { field, op, value };
    }).filter(c => c.op === 'exists' || (Array.isArray(c.value) ? c.value.length > 0 : (c.value !== undefined && c.value !== '')));
    if (!conds.length) return null;
    return matchMode === 'any' ? { any: conds } : { all: conds };
  }

  const FIELD_LABELS = {
    type: 'Type (Lead/Contact)', status: 'Status', programType: 'Type', smsOptOut: 'SMS Opt-Out', emailOptOut: 'Email Opt-Out',
    tags: 'Tag', listIds: 'List', emailOpened: 'Opened Email', emailClicked: 'Clicked Email', visitedPage: 'Visited Webpage',
  };
  const OP_LABELS = {
    eq: 'is', neq: 'is not', includes: 'includes', excludes: 'excludes', exists: 'is set', contains: 'contains',
    any_of: 'is any of', all_of: 'is all of', not_any_of: 'is not any of', not_all_of: 'is not all of',
  };
  function describeCondition(cond) {
    const fieldLabel = FIELD_LABELS[cond.field] || (cond.field.startsWith('customFields.') ? (allCustomFields.find(f => f.id === cond.field.slice(13))?.label || 'Custom field') : cond.field);
    const opLabel = OP_LABELS[cond.op] || cond.op;
    let valueLabel = cond.value;
    if (Array.isArray(cond.value)) {
      const items = cond.field === 'tags' ? allTags : cond.field === 'listIds' ? allLists : null;
      valueLabel = items ? cond.value.map(id => items.find(i => i.id === id)?.name || id).join(', ') : cond.value.join(', ');
    } else {
      if (cond.field === 'tags') valueLabel = allTags.find(t => t.id === cond.value)?.name || cond.value;
      if (cond.field === 'listIds') valueLabel = allLists.find(l => l.id === cond.value)?.name || cond.value;
    }
    return `${fieldLabel} ${opLabel}${cond.op === 'exists' ? '' : ' ' + escapeHtml(String(valueLabel ?? ''))}`;
  }
  function describeFilter(filter) {
    if (!filter) return '';
    const conds = filter.all || filter.any || [];
    const joiner = filter.all ? ' AND ' : ' OR ';
    return conds.map(describeCondition).join(joiner);
  }

  return { init, addRow, buildFilter, describeCondition, describeFilter };
})();
