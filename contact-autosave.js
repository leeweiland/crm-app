// Shared by contact-detail.html and the Inbox's contact-details overlay:
// decides WHEN edits to a contact are saved and WHAT gets sent.
//
// Both panels used to save only on an input's "change" event (fired when the
// field loses focus). Two ways that silently lost edits:
//   1. Leaving with the cursor still in a field -- browser Back, closing the
//      tab, refresh, Esc -- never fires "change" at all. Reproduced live:
//      typed an End Date, pressed Back, the old value was still saved.
//   2. Every save sent the WHOLE contact object, which always carries
//      ownerId, and the server rejects any request containing ownerId from a
//      non-admin (403) -- so the CRM's non-admin staff could not save from
//      these panels at all.
//
// So now:
//   * dirty tracking -- a save sends only the fields that differ from what
//     the server is known to hold (ownerId only if someone changed it), and
//     custom fields go as customFieldsPatch (merged server-side) so editing
//     END DATE can't overwrite another field that changed elsewhere meanwhile;
//   * saves fire on blur/change immediately and ~1.5s after typing stops;
//   * one request at a time. A contact PATCH costs ~5s on the server (it
//     rewrites the whole contacts file, blocking everything), so edits made
//     while one is in flight coalesce into a single follow-up instead of
//     piling up;
//   * leaving the page (pagehide / tab hidden / beforeunload) sends whatever
//     is still unsaved with fetch keepalive so it survives the navigation.
//
// create({ read, onSaved, onError, statusEl, delay }) -> { reset, watch, schedule, flush, leave, hasUnsaved }
//   read():   current form values -- any of first/last/accountName/email/phone/
//             status/emailOptOut/smsOptOut/testContact (scalars), tags/listIds
//             (arrays), customFields ({fieldId: value}); trimmed as the page wants.
//   reset(id): call after the form is populated for a contact; that snapshot is
//             the baseline "what the server holds". reset(null) disables saving.
//   watch(els): wire input/change listeners on the given form elements.
//   flush():  save now (resolves when the queue is empty). Call it before
//             closing/switching a panel.
(function () {
  const SCALARS = ['first', 'last', 'accountName', 'email', 'phone', 'status', 'emailOptOut', 'smsOptOut', 'testContact'];
  const LISTS = ['tags', 'listIds'];
  const NON_TEXT = ['checkbox', 'radio', 'button', 'file', 'range', 'color', 'submit', 'reset'];
  const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));
  const listKey = (a) => JSON.stringify([...(a || [])].sort());
  const sameValue = (a, b) => (a ?? '') === (b ?? '') || JSON.stringify(a ?? '') === JSON.stringify(b ?? '');

  function diff(values, base) {
    const body = {};
    for (const k of SCALARS) if (k in values && values[k] !== base[k]) body[k] = values[k];
    for (const k of LISTS) if (k in values && listKey(values[k]) !== listKey(base[k])) body[k] = [...values[k]];
    if (values.customFields) {
      const was = base.customFields || {}, patch = {};
      for (const [id, v] of Object.entries(values.customFields)) if (!sameValue(v, was[id])) patch[id] = v ?? '';
      if (Object.keys(patch).length) body.customFieldsPatch = patch;
    }
    return body;
  }
  function applyToBase(base, body) {
    for (const k of SCALARS) if (k in body) base[k] = body[k];
    for (const k of LISTS) if (k in body) base[k] = [...body[k]];
    if (body.customFieldsPatch) base.customFields = { ...(base.customFields || {}), ...body.customFieldsPatch };
  }

  const STATE_TEXT = { pending: 'Unsaved changes…', saving: 'Saving…', saved: 'Saved ✓', error: 'Not saved' };

  function create(opts) {
    const delay = opts.delay ?? 2000;
    const bases = new Map();   // contactId -> what the server is believed to hold (same shape as read())
    const busy = new Set();    // contact ids with a queued or in-flight save
    let currentId = null;      // contact whose form is on screen
    let timer = null, clearTimer = null;
    let desired = null;        // latest captured form snapshot {id, values} waiting to be sent
    let pump = null;           // promise of the current/last send loop
    let running = false;       // (not derived from `pump`: the loop can finish synchronously, before `pump` is assigned)
    let inflight = null;       // {id, body} of the request currently on the wire
    let lastLeave = { json: '', t: 0 };

    function setState(state, msg) {
      const el = opts.statusEl;
      if (el) {
        clearTimeout(clearTimer);
        el.textContent = state === 'idle' ? '' : STATE_TEXT[state];
        el.title = state === 'error' && msg ? msg : '';
        el.dataset.state = state;
        if (state === 'saved') clearTimer = setTimeout(() => { if (el.dataset.state === 'saved') { el.textContent = ''; el.dataset.state = 'idle'; } }, 2500);
      }
      if (opts.onState) { try { opts.onState(state, msg); } catch (e) { /* cosmetic */ } }
    }

    function capture() {
      if (!currentId) return null;
      try { return { id: currentId, values: opts.read() }; } catch (e) { return null; }
    }

    function reset(id) {
      clearTimeout(timer); timer = null;
      currentId = id || null;
      if (!currentId) return;
      try { bases.set(currentId, clone(opts.read())); } catch (e) { currentId = null; return; }
      for (const k of [...bases.keys()]) if (k !== currentId && !busy.has(k)) bases.delete(k);
      setState('idle');
    }

    function schedule() {
      if (!currentId) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        // A save is still in flight (they take ~5s and block the server): wait out another quiet
        // period rather than chaining a follow-up straight behind it. Blur/close still flush at once.
        if (running) schedule(); else flush();
      }, delay);
      setState('pending');
    }

    function flush() {
      clearTimeout(timer); timer = null;
      const snap = capture();
      if (!snap) return pump || Promise.resolve();
      desired = snap; busy.add(snap.id);
      return run();
    }

    // The single send loop. `desired` is a full snapshot captured synchronously
    // (while the form on screen still belongs to that contact), so later
    // switching to another contact can't confuse a save that's still queued;
    // repeated flushes just replace it (latest wins), which is the coalescing.
    function run() {
      if (running) return pump;
      running = true;
      pump = (async () => {
        try {
          while (desired) {
            const { id, values } = desired; desired = null;
            const base = bases.get(id);
            const body = base ? diff(values, base) : {};
            if (!Object.keys(body).length) continue;
            setState('saving');
            try {
              const payload = JSON.stringify(body);
              inflight = { id, body };
              // keepalive so a request already sent isn't cancelled if the page navigates away meanwhile
              // (skipped for very large bodies: keepalive requests share a 64KB quota).
              const r = await fetch('/api/contacts/' + encodeURIComponent(id), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: payload, keepalive: payload.length < 30000 });
              if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Could not save');
              const j = await r.json().catch(() => ({}));
              const b = bases.get(id); if (b) applyToBase(b, body);
              inflight = null;
              if (!desired) setState('saved');
              if (opts.onSaved) { try { opts.onSaved(j.contact, body); } catch (e) { console.error('[contact-autosave] onSaved failed:', e); } }
            } catch (e) {
              // Baseline NOT advanced, so the next edit/blur/leave retries the same diff.
              inflight = null;
              setState('error', e.message);
              if (opts.onError) { try { opts.onError(e.message); } catch (e2) { /* cosmetic */ } }
            }
          }
        } finally { busy.clear(); running = false; }
      })();
      return pump;
    }

    // The page is going away (or being hidden): send what's still unsaved with
    // keepalive so the request outlives the navigation. pagehide, beforeunload
    // and visibilitychange all fire on one navigation, hence the dedupe. The
    // baseline only advances once the server confirms, so if the page turns
    // out to be staying (tab switch) nothing is lost or marked saved early.
    function leave() {
      clearTimeout(timer); timer = null;
      const snap = capture(); if (!snap) return;
      const base = bases.get(snap.id); if (!base) return;
      let effective = base;
      if (inflight && inflight.id === snap.id) { effective = clone(base); applyToBase(effective, inflight.body); }
      const body = diff(snap.values, effective);
      if (!Object.keys(body).length) return;
      const json = snap.id + JSON.stringify(body), now = Date.now();
      if (json === lastLeave.json && now - lastLeave.t < 3000) return;
      lastLeave = { json, t: now };
      const url = '/api/contacts/' + encodeURIComponent(snap.id);
      const init = { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
      const done = (r) => { if (r && r.ok) { const b = bases.get(snap.id); if (b) applyToBase(b, body); } };
      let p;
      try { p = fetch(url, { ...init, keepalive: true }); }
      catch (e) { try { p = fetch(url, init); } catch (e2) { return; } } // keepalive caps the body at 64KB
      if (p && p.then) p.then(done, () => {});
    }

    function watch(els) {
      for (const el of els || []) {
        if (!el || !el.addEventListener || (el.dataset && el.dataset.autosaveWired)) continue;
        if (el.dataset) el.dataset.autosaveWired = '1';
        el.addEventListener('change', () => flush());
        const type = String(el.type || '').toLowerCase();
        if (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && !NON_TEXT.includes(type))) el.addEventListener('input', schedule);
      }
    }

    function hasUnsaved() {
      const snap = capture(); const base = snap && bases.get(snap.id);
      return !!base && Object.keys(diff(snap.values, base)).length > 0;
    }

    if (typeof window !== 'undefined') {
      window.addEventListener('pagehide', leave);
      window.addEventListener('beforeunload', leave);
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') leave(); });
    }

    return { reset, watch, schedule, flush, leave, hasUnsaved };
  }

  window.PRAContactAutosave = { create, _diff: diff };
})();
