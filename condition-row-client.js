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
      <option value="firstSeenAt">Lead date (oldest of Hyros / Close / AC)</option>
      ${(window.crmTeamUsers || []).filter(u => !u.archived).map(u => `<option value="staffActivity:${escapeHtml(u.id)}">Emailed / texted with ${escapeHtml(u.first || u.email)}</option>`).join('')}
      ${allCustomFields.map(f => `<option value="customFields.${f.id}">${escapeHtml(f.label)}</option>`).join('')}
    `;
  }
  // legacyOp: when editing an existing row whose stored op is one of the old
  // includes/excludes codes, that exact option is appended too (selected),
  // so opening an old segment for editing doesn't silently change its op --
  // it's just not offered as a choice for a brand-new row.
  function opOptionsHtml(field, legacyOp) {
    if (field === "visitedPage") return `<option value="eq">Is</option><option value="neq">Is not</option><option value="contains">Contains</option>`;
    // "after" = a FIXED lower bound (segments_shared.js) -- e.g. "leads since
    // Sep 6, ongoing" -- as opposed to within_last_hours' rolling window.
    if (field === "firstSeenAt" || field === "createdAt") return `<option value="within_last_hours">Within the last (hours)</option><option value="after">Is on or after (date &amp; time)</option><option value="between">Is between (dates, inclusive)</option>`;
    // "Has emailed/texted with <team member> in the last N days" and its
    // opposite -- the second is what keeps another rep's leads out of a segment.
    if (field.startsWith("staffActivity:")) return `<option value="not_within_last_days">Has NOT in the last (days)</option><option value="within_last_days">Has, in the last (days)</option>`;
    if (ARRAY_FIELDS.includes(field)) {
      const legacy = (legacyOp === "includes") ? `<option value="includes">Includes (legacy)</option>` : (legacyOp === "excludes") ? `<option value="excludes">Excludes (legacy)</option>` : "";
      return `<option value="any_of">Is any of</option><option value="all_of">Is all of</option><option value="not_any_of">Is not any of</option><option value="not_all_of">Is not all of</option>${legacy}`;
    }
    if (SCALAR_MULTI_FIELDS.includes(field)) {
      return `<option value="eq">Is</option><option value="neq">Is not</option><option value="any_of">Is any of</option><option value="not_any_of">Is not any of</option>`;
    }
    // gt/gte/lt/lte compare numerically (segments_shared.js) -- for number-like
    // fields such as the estimated income; a non-numeric value never matches.
    if (field.startsWith("customFields.")) return `<option value="eq">Is</option><option value="neq">Is not</option><option value="exists">Is set</option><option value="gt">Is greater than</option><option value="gte">Is at least</option><option value="lt">Is less than</option><option value="lte">Is at most</option>`;
    // Opened/Clicked Email can also be windowed: "in the last N days" (latest
    // event, including the imported ActiveCampaign history).
    if (field === "emailOpened" || field === "emailClicked") return `<option value="eq">Is</option><option value="neq">Is not</option><option value="within_last_days">In the last (days)</option>`;
    return `<option value="eq">Is</option><option value="neq">Is not</option>`;
  }

  // Minimal self-contained chip multi-select for the "is any of"/"is all
  // of" value input -- same look (via the shared .search-multiselect/.ms-*/
  // .tag-pill rules in crm-design-system.css) as campaign-builder.html's
  // list/tag/exclude pickers, but keeps its selected-ids array in a closure
  // instead of on a page-global object, so it can live inside an arbitrary
  // condition row.
  function renderMultiSelectInto(el, items, selected, onChange) {
    // The host must be the dropdown's positioning context (.ms-dropdown is
    // position:absolute; top:100%). Without this the list opened at the
    // bottom-left of the page -- outside a modal's clipped box, so the Status
    // "is any of" picker showed no options at all.
    el.style.position = 'relative';
    el.style.display = 'block';
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
        // Stays open (re-filtered, this option now excluded) instead of
        // closing -- picking multiple values needs to be one pick after
        // another, not click-pick-reopen-pick-reopen for every one.
        renderChips(); onChange(selected); showMatches();
      });
    }
    searchEl.addEventListener('input', showMatches);
    searchEl.addEventListener('focus', showMatches);
    searchEl.addEventListener('blur', () => setTimeout(() => dropdownEl.classList.remove('open'), 150));
    renderChips();
    // Stays closed until the user actually clicks/types into the search
    // box (matches campaign-builder.html's own list/tag pickers) -- a
    // condition row is often just left at "Status"/"Tag" defaults without
    // ever touching the value picker, so it shouldn't open uninvited.
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
    if (op === 'within_last_days' || op === 'not_within_last_days') return `<input class="pra-input" type="number" min="1" data-cond-value placeholder="# of days, e.g. 30 (36500 = ever)"/>`;
    if (['gt', 'gte', 'lt', 'lte'].includes(op)) return `<input class="pra-input" type="number" data-cond-value placeholder="e.g. 60000"/>`;
    if (op === 'between') return `<span data-cond-range style="display:inline-flex;gap:6px;align-items:center"><input class="pra-input" type="date" data-cond-from title="First day (your local time)"/> and <input class="pra-input" type="date" data-cond-to title="Last day, included (your local time)"/></span>`;
    if (BOOL_FIELDS.includes(field)) return `<select class="pra-select" data-cond-value><option value="true">Yes</option><option value="false">No</option></select>`;
    if (field === 'status') return `<select class="pra-select" data-cond-value>${allStatuses.map(s => `<option value="${escapeHtml(s.label)}">${escapeHtml(s.label)}</option>`).join('')}</select>`;
    if (field === 'visitedPage') return `<input class="pra-input" data-cond-value placeholder="/some-page"/>`;
    if ((field === 'firstSeenAt' || field === 'createdAt') && op === 'after') return `<input class="pra-input" type="datetime-local" data-cond-value title="Your local time"/>`;
    if (field === 'firstSeenAt' || field === 'createdAt') return `<input class="pra-input" type="number" min="1" data-cond-value placeholder="e.g. 72"/>`;
    if (field === 'tags') return `<select class="pra-select" data-cond-value>${allTags.map(t => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join('')}</select>`;
    if (field === 'listIds') return `<select class="pra-select" data-cond-value>${allLists.map(l => `<option value="${l.id}">${escapeHtml(l.name)}</option>`).join('')}</select>`;
    return `<input class="pra-input" data-cond-value placeholder="Value..."/>`;
  }

  // "createdAt" and "firstSeenAt" are one condition server-side (both mean the
  // contact's lead date -- segments_shared.js leadDateMs), so older segments
  // saved with createdAt show up as the single "Lead date" option and are
  // written back as firstSeenAt. Same result either way; just one name.
  function normalizeCond(c) {
    return c && c.field === 'createdAt' && (c.op === 'within_last_hours' || c.op === 'after') ? { ...c, field: 'firstSeenAt' } : c;
  }

  // A stored ISO timestamp <-> the <input type=datetime-local> string (which
  // is wall-clock time in the viewer's own timezone, no zone suffix).
  function isoToLocalInput(iso) {
    const d = new Date(iso);
    if (!iso || isNaN(d)) return '';
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  // A between-window is whole LOCAL days: from = 00:00 of the first day,
  // to = 00:00 of the day AFTER the last (segments_shared.js treats `to` as
  // exclusive), so "Jan 1 and May 1" includes everyone who arrived on May 1.
  function dateInputToIso(v, addDays) {
    if (!v) return '';
    const [y, m, d] = v.split('-').map(Number);
    return new Date(y, m - 1, d + (addDays || 0)).toISOString();
  }
  function isoToDateInput(iso, addDays) {
    const d = new Date(iso);
    if (!iso || isNaN(d)) return '';
    d.setDate(d.getDate() + (addDays || 0));
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }
  function isLocalMidnight(iso) {
    const d = new Date(iso);
    return !isNaN(d) && d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0;
  }
  function localInputToIso(v) {
    const d = new Date(v);
    return !v || isNaN(d) ? '' : d.toISOString();
  }

  function addRow(containerEl, initial) {
    initial = normalizeCond(initial);
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
      if (initial.op === 'between' && initial.value) {
        row.querySelector('[data-cond-from]').value = isoToDateInput(initial.value.from, 0);
        row.querySelector('[data-cond-to]').value = isoToDateInput(initial.value.to, -1);
      } else if (!MULTI_VALUE_OPS.includes(initial.op)) {
        const valEl = row.querySelector('[data-cond-value]');
        if (valEl) valEl.value = initial.op === 'after' ? isoToLocalInput(initial.value) : (initial.value ?? '');
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
      else if (op === 'between') {
        const from = row.querySelector('[data-cond-from]')?.value, to = row.querySelector('[data-cond-to]')?.value;
        value = from && to ? { from: dateInputToIso(from, 0), to: dateInputToIso(to, 1) } : undefined;
      }
      else value = row.querySelector('[data-cond-value]')?.value;
      if (op === 'after') value = localInputToIso(value);
      return { field, op, value };
    // A blank value is meaningful for visitedPage's "contains" op --
    // matchesSegment (segments_shared.js) matches it against ANY visited
    // path (every string contains ""), i.e. "visited any page at all" --
    // so it can't be dropped here the way every other blank condition is.
    }).filter(c => c.op === 'exists' || (c.field === 'visitedPage' && c.op === 'contains') || (Array.isArray(c.value) ? c.value.length > 0 : (c.value !== undefined && c.value !== '')));
    if (!conds.length) return null;
    return matchMode === 'any' ? { any: conds } : { all: conds };
  }

  const FIELD_LABELS = {
    type: 'Type (Lead/Contact)', status: 'Status', programType: 'Type', smsOptOut: 'SMS Opt-Out', emailOptOut: 'Email Opt-Out',
    tags: 'Tag', listIds: 'List', emailOpened: 'Opened Email', emailClicked: 'Clicked Email', visitedPage: 'Visited Webpage',
    firstSeenAt: 'Lead date', createdAt: 'Lead date',
  };
  const OP_LABELS = {
    eq: 'is', neq: 'is not', includes: 'includes', excludes: 'excludes', exists: 'is set', contains: 'contains',
    any_of: 'is any of', all_of: 'is all of', not_any_of: 'is not any of', not_all_of: 'is not all of',
    within_last_hours: 'is within the last', within_last_days: 'in the last', after: 'is on or after', between: 'is between',
    not_within_last_days: 'not in the last', gt: 'is greater than', gte: 'is at least', lt: 'is less than', lte: 'is at most',
  };
  // Can this row builder faithfully show + re-save this stored condition? A
  // saved segment can hold conditions the UI never offered (field "id" for a
  // hand-picked contact list, op "between") -- editing must keep those
  // untouched rather than force them into a dropdown that can't represent them.
  function canRepresent(cond) {
    cond = normalizeCond(cond);
    if (!cond || typeof cond.field !== 'string' || typeof cond.op !== 'string') return false;
    const fieldSel = document.createElement('select');
    fieldSel.innerHTML = fieldOptionsHtml();
    if (![...fieldSel.options].some(o => o.value === cond.field)) return false;
    const opSel = document.createElement('select');
    opSel.innerHTML = opOptionsHtml(cond.field, cond.op);
    if (![...opSel.options].some(o => o.value === cond.op)) return false;
    if (cond.op === 'between') return !!cond.value && typeof cond.value === 'object' && isLocalMidnight(cond.value.from) && isLocalMidnight(cond.value.to);
    if (MULTI_VALUE_OPS.includes(cond.op)) return Array.isArray(cond.value);
    if (cond.op === 'exists') return true;
    if (Array.isArray(cond.value)) return false;
    // A single-value <select> (status/type/tag/list/yes-no) can only show a
    // value it has an option for -- e.g. a tag or list since deleted would
    // render blank and then be dropped as "empty" on save.
    const probe = document.createElement('div');
    probe.innerHTML = valueInputHtml(cond.field, cond.op);
    const sel = probe.querySelector('select[data-cond-value]');
    return !sel || [...sel.options].some(o => o.value === String(cond.value));
  }
  function describeCondition(cond) {
    const staffUser = cond.field.startsWith('staffActivity:') ? (window.crmTeamUsers || []).find(u => u.id === cond.field.slice(14)) : null;
    const fieldLabel = FIELD_LABELS[cond.field] || (staffUser ? `Emailed / texted with ${staffUser.first || staffUser.email}` : cond.field.startsWith('staffActivity:') ? 'Emailed / texted with a team member' : null) || (cond.field.startsWith('customFields.') ? (allCustomFields.find(f => f.id === cond.field.slice(13))?.label || 'Custom field') : cond.field);
    const opLabel = OP_LABELS[cond.op] || cond.op;
    let valueLabel = cond.value;
    if (Array.isArray(cond.value)) {
      const items = cond.field === 'tags' ? allTags : cond.field === 'listIds' ? allLists : null;
      valueLabel = items ? cond.value.map(id => items.find(i => i.id === id)?.name || id).join(', ') : cond.value.join(', ');
    } else {
      if (cond.field === 'tags') valueLabel = allTags.find(t => t.id === cond.value)?.name || cond.value;
      if (cond.field === 'listIds') valueLabel = allLists.find(l => l.id === cond.value)?.name || cond.value;
    }
    if (cond.op === 'within_last_hours') return `${fieldLabel} ${opLabel} ${escapeHtml(String(valueLabel ?? ''))} hours`;
    if (cond.op === 'within_last_days' || cond.op === 'not_within_last_days') return `${fieldLabel} ${opLabel} ${escapeHtml(String(valueLabel ?? ''))} days`;
    if (cond.op === 'after' && valueLabel && !isNaN(new Date(valueLabel))) valueLabel = new Date(valueLabel).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
    if (cond.op === 'between' && valueLabel && typeof valueLabel === 'object' && !Array.isArray(valueLabel)) {
      // Whole-day windows read as dates ("Jan 1, 2026 and May 1, 2026" -- the
      // stored end is the exclusive start of the NEXT day); anything else keeps its time.
      const wholeDays = isLocalMidnight(valueLabel.from) && isLocalMidnight(valueLabel.to);
      const fmt = (v, back) => { const d = new Date(v); if (isNaN(d)) return String(v ?? ''); if (wholeDays) { if (back) d.setDate(d.getDate() - 1); return d.toLocaleDateString([], { dateStyle: 'medium' }); } return d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }); };
      valueLabel = `${fmt(valueLabel.from)} and ${fmt(valueLabel.to, true)}`;
    }
    return `${fieldLabel} ${opLabel}${cond.op === 'exists' ? '' : ' ' + escapeHtml(String(valueLabel ?? ''))}`;
  }
  function describeFilter(filter) {
    if (!filter) return '';
    const conds = filter.all || filter.any || [];
    const joiner = filter.all ? ' AND ' : ' OR ';
    return conds.map(describeCondition).join(joiner);
  }

  return { init, addRow, buildFilter, describeCondition, describeFilter, canRepresent };
})();
