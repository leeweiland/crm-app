// Settings > Financials: the payment processors behind Reporting's True ROAS.
// PayPal, Wise and Kurv connect with API credentials; SwipeSimple (no API)
// comes from its sale-notification emails in a CRM-connected Gmail inbox;
// Google Sheets cover anything else. Everything here syncs automatically
// every 3 hours (financials_backend.js).
(function () {
  const panel = document.getElementById('tab-financials');
  if (!panel) return;
  const esc = (s) => { const d = document.createElement('div'); d.textContent = String(s ?? ''); return d.innerHTML; };
  const PROVIDER_LABELS = { kurv: 'Kurv', swipesimple: 'SwipeSimple', other: 'Other' };
  const FIELD_LABELS = { date: 'Date', time: 'Time (if separate)', amount: 'Amount', id: 'Transaction ID', email: 'Payer email', name: 'Payer name', status: 'Status', type: 'Type (sale/refund)', description: 'Description', currency: 'Currency' };
  let state = { paypal: [], wise: [], kurv: [], emails: [], inboxes: [], sheets: [], ownNames: [], states: [], syncing: false };

  function statusLine(key) {
    const st = state.states.find(s => s.key === key);
    if (!st) return '<span class="pra-muted">Not synced yet.</span>';
    const when = st.last_sync_at ? new Date(st.last_sync_at).toLocaleString() : '';
    return st.last_error
      ? `<span style="color:var(--pra-red,#e5484d)">Last sync failed: ${esc(st.last_error)}</span> <span class="pra-muted">(${esc(when)})</span>`
      : `<span class="pra-muted">Synced ${esc(when)}${st.last_count != null ? ` · ${st.last_count} rows` : ''}</span>`;
  }
  function tabOptions(a) {
    if (!a._tabs) return a.tab ? `<option selected>${esc(a.tab)}</option>` : '<option value="">(enter the sheet first)</option>';
    const missing = a.tab && !a._tabs.includes(a.tab);
    return (a.tab && !missing ? '' : `<option value="" selected>${missing ? `"${esc(a.tab)}" isn't in this sheet -- pick a tab` : '— pick a tab —'}</option>`)
      + a._tabs.map(t => `<option${t === a.tab ? ' selected' : ''}>${esc(t)}</option>`).join('');
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

      <div class="pra-h2" style="font-size:1rem;margin:24px 0 4px">Kurv</div>
      <div class="pra-muted" style="font-size:.78rem;margin-bottom:10px">developer.kurv.app → Apply (sign up) → create an app → connect it to the Pacific Rim Athletics merchant account and publish it → enable the app in your Kurv merchant dashboard → copy its live access key (starts with <code>kp_live_</code>).</div>
      ${state.kurv.map((a, i) => `
        <div class="pra-panel" style="padding:12px 14px;margin-bottom:10px">
          <div style="display:grid;grid-template-columns:1fr 2fr auto;gap:8px;align-items:end">
            <div><label class="pra-label">Name</label><input class="pra-input" data-kurv="${i}" data-f="label" value="${esc(a.label)}" placeholder="Kurv"/></div>
            <div><label class="pra-label">Live access key</label><input class="pra-input" type="password" data-kurv="${i}" data-f="key" value="" autocomplete="new-password" placeholder="${a.keySet ? 'saved -- leave blank to keep' : 'kp_live_...'}"/></div>
            ${removeBtn('kurv', i)}
          </div>
          <div style="font-size:.78rem;margin-top:6px">${a.id ? statusLine('kurv:' + a.id) : '<span class="pra-muted">Save to connect.</span>'}</div>
        </div>`).join('')}
      <button class="pra-btn pra-btn-outline pra-btn-sm" id="finAddKurv">+ Add Kurv account</button>

      <div class="pra-h2" style="font-size:1rem;margin:24px 0 4px">Sale emails (SwipeSimple)</div>
      <div class="pra-muted" style="font-size:.78rem;margin-bottom:10px">SwipeSimple has no API, so the CRM reads its per-sale notification emails. Turn on SwipeSimple's email for every transaction, forward those emails to an inbox connected under Connect Email, and pick that inbox here. Each email becomes one sale ("refund"/"void" in the subject = a refund, "declined" is skipped).</div>
      ${state.emails.map((a, i) => `
        <div class="pra-panel" style="padding:12px 14px;margin-bottom:10px">
          <div style="display:grid;grid-template-columns:1fr .8fr 1.4fr 1.4fr auto;gap:8px;align-items:end">
            <div><label class="pra-label">Name</label><input class="pra-input" data-em="${i}" data-f="label" value="${esc(a.label)}" placeholder="SwipeSimple"/></div>
            <div><label class="pra-label">Processor</label><select class="pra-select pra-input" data-em="${i}" data-f="provider">${Object.entries(PROVIDER_LABELS).map(([v, l]) => `<option value="${v}"${a.provider === v ? ' selected' : ''}>${l}</option>`).join('')}</select></div>
            <div><label class="pra-label">Inbox</label><select class="pra-select pra-input" data-em="${i}" data-f="inbox">${state.inboxes.map(x => `<option${x === a.inbox ? ' selected' : ''}>${esc(x)}</option>`).join('') || '<option value="">(connect a Gmail first)</option>'}</select></div>
            <div><label class="pra-label">Gmail search</label><input class="pra-input" data-em="${i}" data-f="query" value="${esc(a.query || 'swipesimple')}"/></div>
            ${removeBtn('emails', i)}
          </div>
          <div style="font-size:.78rem;margin-top:6px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">
            ${a.id ? statusLine('email:' + a.id) : '<span class="pra-muted">Not saved yet.</span>'}
            <button class="pra-btn pra-btn-ghost pra-btn-sm" data-email-preview="${i}">Preview emails</button>
          </div>
          <div data-email-box="${i}"></div>
        </div>`).join('')}
      <button class="pra-btn pra-btn-outline pra-btn-sm" id="finAddEmail">+ Add sale-email source</button>

      <div class="pra-h2" style="font-size:1rem;margin:24px 0 4px">Google Sheets (anything else)</div>
      <div class="pra-muted" style="font-size:.78rem;margin-bottom:10px">For a processor with neither an API nor sale emails: its transaction export in a Google Sheet tab, one row per transaction, headers in row 1. The CRM reads it on the same schedule; rows added, changed or deleted in the sheet follow automatically.</div>
      ${state.sheets.map((a, i) => `
        <div class="pra-panel" style="padding:12px 14px;margin-bottom:10px" data-sheet-card="${i}">
          <div style="display:grid;grid-template-columns:1fr .8fr 2fr 1.1fr auto;gap:8px;align-items:end">
            <div><label class="pra-label">Name</label><input class="pra-input" data-sh="${i}" data-f="label" value="${esc(a.label)}" placeholder="Kurv"/></div>
            <div><label class="pra-label">Processor</label><select class="pra-select pra-input" data-sh="${i}" data-f="provider">${Object.entries(PROVIDER_LABELS).map(([v, l]) => `<option value="${v}"${a.provider === v ? ' selected' : ''}>${l}</option>`).join('')}</select></div>
            <div><label class="pra-label">Sheet URL or ID</label><input class="pra-input" data-sh="${i}" data-f="sheetId" value="${esc(a.sheetId)}" placeholder="https://docs.google.com/spreadsheets/d/..."/></div>
            <div><label class="pra-label">Tab</label><select class="pra-select pra-input" data-sh="${i}" data-f="tab">${tabOptions(a)}</select></div>
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
    panel.querySelectorAll('[data-kurv]').forEach(el => el.oninput = () => { state.kurv[+el.dataset.kurv][el.dataset.f] = el.value; });
    panel.querySelectorAll('[data-em]').forEach(el => el.oninput = el.onchange = () => { state.emails[+el.dataset.em][el.dataset.f] = el.value; });
    panel.querySelectorAll('[data-email-preview]').forEach(b => b.onclick = () => previewEmails(+b.dataset.emailPreview));
    document.getElementById('finAddKurv').onclick = () => { state.kurv.push({ label: 'Kurv', key: '' }); render(); };
    document.getElementById('finAddEmail').onclick = () => { state.emails.push({ label: 'SwipeSimple', provider: 'swipesimple', inbox: state.inboxes[0] || '', query: 'swipesimple' }); render(); };
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
    if (!a.label) a.label = PROVIDER_LABELS[a.provider] || '';
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

  async function previewEmails(i) {
    const a = state.emails[i];
    const box = panel.querySelector(`[data-email-box="${i}"]`);
    box.innerHTML = '<div class="pra-muted" style="font-size:.8rem;margin-top:8px">Searching the inbox…</div>';
    const r = await fetch('/api/financials/email-preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ inbox: a.inbox, query: a.query }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { box.innerHTML = `<div style="color:var(--pra-red,#e5484d);font-size:.8rem;margin-top:8px">${esc(j.error || 'Could not search the inbox')}</div>`; return; }
    box.innerHTML = j.emails.length ? `<div style="overflow-x:auto;margin-top:8px"><table class="data-table" style="font-size:.78rem"><thead><tr><th>Date</th><th>Subject</th><th>Read as</th></tr></thead><tbody>
      ${j.emails.map(m => `<tr><td style="white-space:nowrap">${esc(new Date(m.date).toLocaleDateString())}</td><td>${esc(m.subject)}<div class="pra-muted" style="font-size:.7rem">${esc(m.from)}</div></td><td>${m.skip ? `<span class="pra-muted">skipped (${esc(m.skip)})</span>` : `${esc(m.kind)} $${esc(m.amount.toFixed(2))} ${esc(m.payerName || '')} ${esc(m.payerEmail || '')}`}</td></tr>`).join('')}
      </tbody></table></div>` : '<div class="pra-muted" style="font-size:.8rem;margin-top:8px">No matching emails in the last 30 days yet.</div>';
  }
  function msg(t) { const el = document.getElementById('finMsg'); if (el) el.textContent = t || ''; }
  async function save() {
    msg('Saving…');
    const body = {
      paypal: state.paypal.map(({ id, label, clientId, clientSecret }) => ({ id, label, clientId, clientSecret })),
      wise: state.wise.map(({ id, label, token }) => ({ id, label, token })),
      kurv: state.kurv.map(({ id, label, key }) => ({ id, label, key })),
      emails: state.emails.map(({ id, label, provider, inbox, query }) => ({ id, label, provider, inbox, query })),
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
    state = { ...j, paypal: j.paypal.map(a => ({ ...a, clientSecret: '' })), wise: j.wise.map(a => ({ ...a, token: '' })), kurv: j.kurv.map(a => ({ ...a, key: '' })), emails: j.emails.map(a => ({ ...a })), sheets: j.sheets.map(s => ({ ...s, mapping: s.mapping || {}, _tabs: keepTabs?.get(s.id) })) };
    render();
    for (const s of state.sheets) if (s.sheetId && !s._tabs) loadTabs(s);
  }

  document.querySelector('[data-tab="financials"]')?.addEventListener('click', () => { if (!panel.dataset.loaded) { panel.dataset.loaded = '1'; load(); } });
  if (location.hash === '#financials') document.querySelector('[data-tab="financials"]')?.click();
})();
