// Settings > Financials: the payment processors behind Reporting's True ROAS.
// PayPal and Wise connect with read-only API credentials; Kurv/SwipeSimple
// (no merchant API) come from Google Sheets of their exports. Everything
// here syncs automatically every 3 hours (financials_backend.js).
(function () {
  const panel = document.getElementById('tab-financials');
  if (!panel) return;
  const esc = (s) => { const d = document.createElement('div'); d.textContent = String(s ?? ''); return d.innerHTML; };
  const PROVIDER_LABELS = { kurv: 'Kurv', swipesimple: 'SwipeSimple', other: 'Other' };
  const FIELD_LABELS = { date: 'Date', time: 'Time (if separate)', amount: 'Amount', id: 'Transaction ID', email: 'Payer email', name: 'Payer name', status: 'Status', type: 'Type (sale/refund)', description: 'Description', currency: 'Currency' };
  let state = { paypal: [], wise: [], sheets: [], ownNames: [], states: [], syncing: false };

  function statusLine(key) {
    const st = state.states.find(s => s.key === key);
    if (!st) return '<span class="pra-muted">Not synced yet.</span>';
    const when = st.last_sync_at ? new Date(st.last_sync_at).toLocaleString() : '';
    return st.last_error
      ? `<span style="color:var(--pra-red,#e5484d)">Last sync failed: ${esc(st.last_error)}</span> <span class="pra-muted">(${esc(when)})</span>`
      : `<span class="pra-muted">Synced ${esc(when)}${st.last_count != null ? ` · ${st.last_count} rows` : ''}</span>`;
  }
  function removeBtn(kind, i) { return `<button class="pra-btn pra-btn-ghost pra-btn-sm" data-remove="${kind}" data-i="${i}">Remove</button>`; }

  function render() {
    panel.innerHTML = `
      <div class="pra-h2" style="margin-bottom:6px">Financials</div>
      <div class="pra-muted" style="font-size:.82rem;margin-bottom:18px">Real cash from your payment processors, for the Financials page and the True ROAS line in Reporting. Everything syncs automatically every 3 hours; payments are matched to contacts by payer email, then by exact full name.</div>

      <div class="pra-h2" style="font-size:1rem;margin:0 0 4px">PayPal</div>
      <div class="pra-muted" style="font-size:.78rem;margin-bottom:10px">developer.paypal.com → Apps &amp; Credentials (Live) → your app → Client ID and Secret. The app needs "Transaction search" ticked.</div>
      ${state.paypal.map((a, i) => `
        <div class="pra-panel" style="padding:12px 14px;margin-bottom:10px">
          <div style="display:grid;grid-template-columns:1fr 1.4fr 1.2fr auto;gap:8px;align-items:end">
            <div><label class="pra-label">Name</label><input class="pra-input" data-pp="${i}" data-f="label" value="${esc(a.label)}" placeholder="PayPal (ymail)"/></div>
            <div><label class="pra-label">Client ID</label><input class="pra-input" data-pp="${i}" data-f="clientId" value="${esc(a.clientId)}" autocomplete="off"/></div>
            <div><label class="pra-label">Secret</label><input class="pra-input" type="password" data-pp="${i}" data-f="clientSecret" value="" autocomplete="new-password" placeholder="${a.secretSet ? 'saved -- leave blank to keep' : 'paste secret'}"/></div>
            ${removeBtn('paypal', i)}
          </div>
          <div style="font-size:.78rem;margin-top:6px">${a.id ? statusLine('paypal:' + a.id) : '<span class="pra-muted">Save to connect.</span>'}</div>
        </div>`).join('')}
      <button class="pra-btn pra-btn-outline pra-btn-sm" id="finAddPaypal">+ Add PayPal account</button>

      <div class="pra-h2" style="font-size:1rem;margin:24px 0 4px">Wise</div>
      <div class="pra-muted" style="font-size:.78rem;margin-bottom:10px">wise.com → Settings → Integrations and tools → API tokens → a Read only token.</div>
      ${state.wise.map((a, i) => `
        <div class="pra-panel" style="padding:12px 14px;margin-bottom:10px">
          <div style="display:grid;grid-template-columns:1fr 2fr auto;gap:8px;align-items:end">
            <div><label class="pra-label">Name</label><input class="pra-input" data-wise="${i}" data-f="label" value="${esc(a.label)}" placeholder="Wise"/></div>
            <div><label class="pra-label">API token</label><input class="pra-input" type="password" data-wise="${i}" data-f="token" value="" autocomplete="new-password" placeholder="${a.tokenSet ? 'saved -- leave blank to keep' : 'paste token'}"/></div>
            ${removeBtn('wise', i)}
          </div>
          <div style="font-size:.78rem;margin-top:6px">${a.id ? statusLine('wise:' + a.id) : '<span class="pra-muted">Save to connect.</span>'}</div>
        </div>`).join('')}
      <button class="pra-btn pra-btn-outline pra-btn-sm" id="finAddWise">+ Add Wise account</button>

      <div class="pra-h2" style="font-size:1rem;margin:24px 0 4px">Google Sheets (Kurv, SwipeSimple, anything else)</div>
      <div class="pra-muted" style="font-size:.78rem;margin-bottom:10px">Kurv and SwipeSimple have no API for merchants, so their transaction exports go in a Google Sheet tab -- one row per transaction, headers in row 1. The CRM reads it on the same schedule; rows added, changed or deleted in the sheet follow automatically. Uses the same Google login as the Ads Tracking Sheet.</div>
      ${state.sheets.map((a, i) => `
        <div class="pra-panel" style="padding:12px 14px;margin-bottom:10px" data-sheet-card="${i}">
          <div style="display:grid;grid-template-columns:1fr .8fr 2fr 1.1fr auto;gap:8px;align-items:end">
            <div><label class="pra-label">Name</label><input class="pra-input" data-sh="${i}" data-f="label" value="${esc(a.label)}" placeholder="Kurv"/></div>
            <div><label class="pra-label">Processor</label><select class="pra-select pra-input" data-sh="${i}" data-f="provider">${Object.entries(PROVIDER_LABELS).map(([v, l]) => `<option value="${v}"${a.provider === v ? ' selected' : ''}>${l}</option>`).join('')}</select></div>
            <div><label class="pra-label">Sheet URL or ID</label><input class="pra-input" data-sh="${i}" data-f="sheetId" value="${esc(a.sheetId)}" placeholder="https://docs.google.com/spreadsheets/d/..."/></div>
            <div><label class="pra-label">Tab</label><select class="pra-select pra-input" data-sh="${i}" data-f="tab">${(a._tabs || (a.tab ? [a.tab] : [])).map(t => `<option${t === a.tab ? ' selected' : ''}>${esc(t)}</option>`).join('') || '<option value="">(enter the sheet first)</option>'}</select></div>
            ${removeBtn('sheets', i)}
          </div>
          <div style="font-size:.78rem;margin-top:6px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">
            ${a.id ? statusLine('sheet:' + a.id) : '<span class="pra-muted">Not saved yet.</span>'}
            <button class="pra-btn pra-btn-ghost pra-btn-sm" data-preview="${i}">Columns &amp; preview</button>
          </div>
          <div data-preview-box="${i}"></div>
        </div>`).join('')}
      <button class="pra-btn pra-btn-outline pra-btn-sm" id="finAddSheet">+ Add Google Sheet</button>

      <div class="pra-h2" style="font-size:1rem;margin:24px 0 4px">Our own accounts</div>
      <div class="pra-muted" style="font-size:.78rem;margin-bottom:8px">Money in from these names or emails is a transfer between our own accounts, not a sale (comma-separated, any part of the name/email).</div>
      <input class="pra-input" id="finOwnNames" value="${esc(state.ownNames.join(', '))}"/>

      <div style="display:flex;gap:8px;margin-top:22px;align-items:center">
        <button class="pra-btn" id="finSaveBtn">Save</button>
        <button class="pra-btn pra-btn-outline" id="finSyncBtn"${state.syncing ? ' disabled' : ''}>${state.syncing ? 'Syncing…' : 'Sync now'}</button>
        <a class="pra-link" href="/financials.html" style="font-size:.85rem">Open Financials →</a>
        <span class="pra-muted" id="finMsg" style="font-size:.8rem"></span>
      </div>`;
    wire();
  }

  // Inputs write straight back into state, so re-renders keep what was typed.
  function wire() {
    panel.querySelectorAll('[data-pp]').forEach(el => el.oninput = () => { state.paypal[+el.dataset.pp][el.dataset.f] = el.value; });
    panel.querySelectorAll('[data-wise]').forEach(el => el.oninput = () => { state.wise[+el.dataset.wise][el.dataset.f] = el.value; });
    panel.querySelectorAll('[data-sh]').forEach(el => {
      const a = state.sheets[+el.dataset.sh];
      el.oninput = el.onchange = () => { a[el.dataset.f] = el.value; };
      if (el.dataset.f === 'sheetId') el.onchange = () => { a.sheetId = el.value; loadTabs(a); };
    });
    panel.querySelectorAll('[data-remove]').forEach(b => b.onclick = () => { state[b.dataset.remove].splice(+b.dataset.i, 1); render(); });
    panel.querySelectorAll('[data-preview]').forEach(b => b.onclick = () => preview(+b.dataset.preview));
    document.getElementById('finAddPaypal').onclick = () => { state.paypal.push({ label: '', clientId: '', clientSecret: '' }); render(); };
    document.getElementById('finAddWise').onclick = () => { state.wise.push({ label: '', token: '' }); render(); };
    document.getElementById('finAddSheet').onclick = () => { state.sheets.push({ label: '', provider: 'kurv', sheetId: '', tab: '', mapping: {} }); render(); };
    document.getElementById('finOwnNames').oninput = (e) => { state.ownNames = e.target.value.split(',').map(s => s.trim()).filter(Boolean); };
    document.getElementById('finSaveBtn').onclick = save;
    document.getElementById('finSyncBtn').onclick = syncNow;
  }

  async function loadTabs(a) {
    if (!a.sheetId) return;
    const r = await fetch('/api/financials/sheet-tabs?sheetId=' + encodeURIComponent(a.sheetId));
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { msg(j.error || 'Could not open that sheet'); return; }
    a._tabs = j.tabs;
    if (!a.tab || !j.tabs.includes(a.tab)) a.tab = j.tabs[0] || '';
    if (!a.label && j.title) a.label = j.title;
    render();
  }

  async function preview(i) {
    const a = state.sheets[i];
    const box = panel.querySelector(`[data-preview-box="${i}"]`);
    if (!a.sheetId || !a.tab) { box.innerHTML = '<div class="pra-muted" style="font-size:.8rem;margin-top:8px">Pick the sheet and tab first.</div>'; return; }
    box.innerHTML = '<div class="pra-muted" style="font-size:.8rem;margin-top:8px">Reading the sheet…</div>';
    const r = await fetch('/api/financials/sheet-preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(a) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { box.innerHTML = `<div style="color:var(--pra-red,#e5484d);font-size:.8rem;margin-top:8px">${esc(j.error || 'Could not read the sheet')}</div>`; return; }
    a.mapping = { ...j.mapping };
    const opt = (f) => `<select class="pra-select pra-input" data-map="${f}" style="padding:4px 6px"><option value="">—</option>${j.headers.map(h => `<option${j.mapping[f] === h ? ' selected' : ''}>${esc(h)}</option>`).join('')}</select>`;
    box.innerHTML = `
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:8px;margin-top:10px">
        ${j.fields.map(f => `<div><label class="pra-label" style="font-size:.72rem">${FIELD_LABELS[f]}</label>${opt(f)}</div>`).join('')}
      </div>
      <div style="font-size:.8rem;margin:10px 0 6px"><b>${j.count}</b> transactions, <b>$${j.revenue.toLocaleString()}</b> net${j.skipped ? ` · ${j.skipped} rows skipped (declined/failed or no date/amount)` : ''}. Save to start syncing it.</div>
      <div style="overflow-x:auto"><table class="data-table" style="font-size:.78rem"><thead><tr><th>Date</th><th>Payer</th><th>Kind</th><th style="text-align:right">Amount</th></tr></thead><tbody>
        ${j.preview.map(p => `<tr><td>${esc(new Date(p.occurredAt).toLocaleString())}</td><td>${esc(p.payerName || '')} ${esc(p.payerEmail || '')}</td><td>${esc(p.kind)}</td><td style="text-align:right">${esc(p.amount.toFixed(2))} ${esc(p.currency)}</td></tr>`).join('')}
      </tbody></table></div>`;
    box.querySelectorAll('[data-map]').forEach(sel => sel.onchange = () => { a.mapping[sel.dataset.map] = sel.value; preview(i); });
  }

  function msg(t) { const el = document.getElementById('finMsg'); if (el) el.textContent = t || ''; }
  async function save() {
    msg('Saving…');
    const body = {
      paypal: state.paypal.map(({ id, label, clientId, clientSecret }) => ({ id, label, clientId, clientSecret })),
      wise: state.wise.map(({ id, label, token }) => ({ id, label, token })),
      sheets: state.sheets.map(({ id, label, provider, sheetId, tab, mapping }) => ({ id, label, provider, sheetId, tab, mapping })),
      ownNames: state.ownNames,
    };
    const r = await fetch('/api/financials/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { msg(j.error || 'Save failed'); return; }
    await load();
    msg('Saved -- syncing now.');
    pollWhileSyncing();
  }
  async function syncNow() {
    await fetch('/api/financials/sync', { method: 'POST' });
    state.syncing = true; render(); msg('Syncing…');
    pollWhileSyncing();
  }
  let pollTimer = null;
  function pollWhileSyncing() {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(async () => {
      const keepTabs = new Map(state.sheets.map(s => [s.id, s._tabs]));
      await load(keepTabs);
      if (state.syncing) pollWhileSyncing(); else msg('Sync finished.');
    }, 4000);
  }
  async function load(keepTabs) {
    const r = await fetch('/api/financials/settings');
    if (!r.ok) { panel.innerHTML = '<div class="pra-muted">Admins only.</div>'; return; }
    const j = await r.json();
    state = { ...j, paypal: j.paypal.map(a => ({ ...a, clientSecret: '' })), wise: j.wise.map(a => ({ ...a, token: '' })), sheets: j.sheets.map(s => ({ ...s, mapping: s.mapping || {}, _tabs: keepTabs?.get(s.id) })) };
    render();
  }

  document.querySelector('[data-tab="financials"]')?.addEventListener('click', () => { if (!panel.dataset.loaded) { panel.dataset.loaded = '1'; load(); } });
  if (location.hash === '#financials') document.querySelector('[data-tab="financials"]')?.click();
})();
