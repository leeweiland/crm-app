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

const _PROGRAM_TYPE_OPTIONS = [
  { value: 'online', label: 'ONLINE' },
  { value: 'gym', label: 'GYM' },
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
function closeInlineEditMenu() {
  if (_inlineEditMenuEl) { _inlineEditMenuEl.remove(); _inlineEditMenuEl = null; }
  document.removeEventListener('click', closeInlineEditMenu);
  document.removeEventListener('keydown', _onInlineEditEsc);
}
function _onInlineEditEsc(e) { if (e.key === 'Escape') closeInlineEditMenu(); }

async function openInlineEditMenu({ x, y, field, contactId, onSaved }) {
  closeInlineEditMenu();
  const cfg = INLINE_EDIT_FIELDS[field];
  if (!cfg) return;
  const options = await cfg.getOptions();
  if (!options.length) return;

  const menu = document.createElement('div');
  menu.className = 'inline-edit-menu';
  const vw = window.innerWidth, vh = window.innerHeight;
  menu.style.cssText = `position:fixed; top:${Math.min(y, vh - 40)}px; left:${Math.min(x, vw - 180)}px; z-index:9999; background:#1a1a1f; border:1px solid #333; border-radius:8px; padding:4px; min-width:160px; max-height:min(320px,${vh - 20}px); overflow-y:auto; box-shadow:0 8px 24px rgba(0,0,0,.45); font-family:inherit;`;
  menu.innerHTML = options.map((o, i) =>
    `<div class="inline-edit-opt" data-i="${i}" style="padding:7px 12px; border-radius:5px; cursor:pointer; font-size:.82rem; color:#eee; white-space:nowrap;">${_escapeInlineEdit(o.label)}</div>`
  ).join('');
  document.body.appendChild(menu);
  _inlineEditMenuEl = menu;

  menu.querySelectorAll('.inline-edit-opt').forEach(el => {
    el.addEventListener('mouseenter', () => (el.style.background = '#2a2a30'));
    el.addEventListener('mouseleave', () => (el.style.background = ''));
    el.addEventListener('click', async (e) => {
      e.stopPropagation();
      const opt = options[Number(el.dataset.i)];
      closeInlineEditMenu();
      try {
        const r = await fetch(`/api/contacts/${contactId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ [field]: opt.value }),
        });
        if (!r.ok) throw new Error('save failed');
        onSaved && onSaved(opt.value);
      } catch (err) {
        if (window.showToast) showToast('Could not save change', 'error');
        else alert('Could not save change');
      }
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
      onSaved: (value) => onSaved && onSaved(cell, value),
    });
  });
}

// Single-element left-click handler (used by inbox.html's contact-name badge).
function wireInlineEditClick(el, { field, contactId, onSaved }) {
  el.style.cursor = 'pointer';
  el.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const rect = el.getBoundingClientRect();
    openInlineEditMenu({ x: rect.left, y: rect.bottom + 4, field, contactId, onSaved });
  });
}
