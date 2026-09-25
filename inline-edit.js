// inline-edit.js
// Shared right-click (table cells) / left-click (badges) inline editor for
// a small set of well-known contact fields. Used by contacts.html (176k-row
// table -- one delegated listener, not one per cell) and inbox.html (single
// badge next to the contact's name). PATCHes /api/contacts/:id, which
// already accepts these fields -- no new backend endpoint needed.

let _statusOptionsCache = null;
async function _getStatusOptions() {
  if (_statusOptionsCache) return _statusOptionsCache;
  try {
    const r = await fetch('/api/statuses');
    const data = await r.json();
    const list = Array.isArray(data) ? data : (data.statuses || []);
    _statusOptionsCache = list.map(s => ({ value: s.label, label: s.label }));
  } catch {
    _statusOptionsCache = [];
  }
  return _statusOptionsCache;
}

// label stays lowercase (the actual stored value) -- .pra-badge's own CSS
// (text-transform: uppercase) is what makes it READ as "ONLINE"/"GYM",
// same as every other programType badge in the app. Hardcoding the label
// as already-uppercase text here just meant this one menu didn't match.
const _PROGRAM_TYPE_OPTIONS = [
  { value: 'online', label: 'online', badge: true },
  { value: 'gym', label: 'gym', badge: true },
];
const _OPT_OUT_OPTIONS = [
  { value: false, label: 'Not opted out' },
  { value: true, label: 'Opted out' },
];

const INLINE_EDIT_FIELDS = {
  status: { getOptions: _getStatusOptions },
  programType: { getOptions: async () => _PROGRAM_TYPE_OPTIONS },
  emailOptOut: { getOptions: async () => _OPT_OUT_OPTIONS },
  smsOptOut: { getOptions: async () => _OPT_OUT_OPTIONS },
};

function _escapeInlineEdit(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let _inlineEditMenuEl = null;
let _inlineEditMenuOwner = null; // the trigger element the open menu belongs to, so a second click on the SAME trigger can toggle it closed instead of just rebuilding it open
function closeInlineEditMenu() {
  if (_inlineEditMenuEl) { _inlineEditMenuEl.remove(); _inlineEditMenuEl = null; }
  _inlineEditMenuOwner = null;
  document.removeEventListener('click', closeInlineEditMenu);
  document.removeEventListener('keydown', _onInlineEditEsc);
}
function _onInlineEditEsc(e) { if (e.key === 'Escape') closeInlineEditMenu(); }

async function openInlineEditMenu({ x, y, field, contactId, currentValue, onSaved, owner }) {
  closeInlineEditMenu();
  const cfg = INLINE_EDIT_FIELDS[field];
  if (!cfg) return;
  const options = await cfg.getOptions();
  if (!options.length) return;
  // currentValue arrives as a DOM dataset string ("true"/"false" for the
  // boolean opt-out fields) -- match it back to that option's own typed
  // .value so a rollback restores a real boolean, not the literal string
  // "false" (which render(contact)'s own `contact.emailOptOut ? ... : ...`
  // would read as truthy).
  const typedCurrentValue = currentValue === undefined ? undefined : (options.find(o => String(o.value) === String(currentValue))?.value ?? currentValue);

  const menu = document.createElement('div');
  menu.className = 'inline-edit-menu';
  _inlineEditMenuOwner = owner || null;
  const vw = window.innerWidth, vh = window.innerHeight;
  // Same panel treatment as crm-nav.js's .mobile-select-menu (CSS variables,
  // not one-off hex values) so this reads as the same app, not a bolted-on
  // widget -- see crm-design-system.css.
  menu.style.cssText = `position:fixed; top:${Math.min(y, vh - 40)}px; left:${Math.min(x, vw - 180)}px; max-height:min(320px,${vh - 20}px);`;
  menu.innerHTML = options.map((o, i) =>
    `<div class="inline-edit-opt" data-i="${i}">${o.badge ? `<span class="pra-badge pra-badge-${_escapeInlineEdit(o.value)}">${_escapeInlineEdit(o.label)}</span>` : _escapeInlineEdit(o.label)}</div>`
  ).join('');
  document.body.appendChild(menu);
  _inlineEditMenuEl = menu;

  menu.querySelectorAll('.inline-edit-opt').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const opt = options[Number(el.dataset.i)];
      closeInlineEditMenu();
      // Status -> ENROLLED is never applied here at all -- the contact only
      // actually becomes Enrolled once the popup's own Save succeeds (see
      // enroll-popup.js's own top comment), so onSaved is deliberately not
      // called yet; its value would just be the un-committed "ENROLLED"
      // otherwise, showing on the cell/badge before it's real.
      if (field === 'status' && String(opt.value).toUpperCase() === 'ENROLLED' && window.EnrollPopup) {
        window.EnrollPopup.open(contactId, { onCommitted: () => onSaved && onSaved(opt.value) });
        return;
      }
      // Optimistic -- a contact PATCH costs ~5s on the server (rewrites the
      // whole contacts file; see contact-autosave.js's own comment on this
      // same cost), which used to mean nothing here -- the cell/badge --
      // appeared until that round trip came back. Update now, PATCH in the
      // background, revert (using the value this menu opened with) + toast
      // only if it actually fails.
      onSaved && onSaved(opt.value);
      fetch(`/api/contacts/${contactId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [field]: opt.value }),
      })
        .then(r => { if (!r.ok) throw new Error('save failed'); })
        .catch(() => {
          if (typedCurrentValue !== undefined) onSaved && onSaved(typedCurrentValue);
          if (window.showToast) showToast('Could not save -- try again', true);
          else alert('Could not save change');
        });
    });
  });

  setTimeout(() => {
    document.addEventListener('click', closeInlineEditMenu);
    document.addEventListener('keydown', _onInlineEditEsc);
  }, 0);
}

// One delegated listener per table (not per cell) -- editable cells must
// carry data-inline-field + data-contact-id. Safe at any row count since
// it's a single listener on the container, not N listeners.
function wireInlineEditTable(containerEl, { onSaved } = {}) {
  // Capture phase so this runs BEFORE the row's own onclick (which navigates
  // to the contact page) -- a bubble-phase listener on the container would
  // fire after the row had already started navigating away. Left-click is
  // the discoverable path; right-click below still works too.
  containerEl.addEventListener('click', (e) => {
    const cell = e.target.closest('[data-inline-field]');
    if (!cell) return;
    e.preventDefault();
    e.stopPropagation();
    if (_inlineEditMenuOwner === cell) { closeInlineEditMenu(); return; }
    const rect = cell.getBoundingClientRect();
    openInlineEditMenu({
      x: rect.left,
      y: rect.bottom + 4,
      field: cell.dataset.inlineField,
      contactId: cell.dataset.contactId,
      currentValue: cell.dataset.currentValue,
      onSaved: (value) => onSaved && onSaved(cell, value),
      owner: cell,
    });
  }, true);
  containerEl.addEventListener('contextmenu', (e) => {
    const cell = e.target.closest('[data-inline-field]');
    if (!cell) return;
    e.preventDefault();
    e.stopPropagation();
    openInlineEditMenu({
      x: e.clientX,
      y: e.clientY,
      field: cell.dataset.inlineField,
      contactId: cell.dataset.contactId,
      currentValue: cell.dataset.currentValue,
      onSaved: (value) => onSaved && onSaved(cell, value),
    });
  });
}

// Single-element left-click handler (used by inbox.html's contact-name badge).
function wireInlineEditClick(el, { field, contactId, currentValue, onSaved }) {
  el.style.cursor = 'pointer';
  el.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    // Clicking the SAME trigger that's already open closes it, same toggle
    // behavior the status/assigned selects already have -- previously this
    // always reopened (closeInlineEditMenu() then a fresh menu), so a
    // second click looked like nothing happened rather than closing it.
    if (_inlineEditMenuOwner === el) { closeInlineEditMenu(); return; }
    const rect = el.getBoundingClientRect();
    openInlineEditMenu({ x: rect.left, y: rect.bottom + 4, field, contactId, currentValue, onSaved, owner: el });
  });
}
