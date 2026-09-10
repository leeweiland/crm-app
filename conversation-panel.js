// conversation-panel.js
// Shared "conversation panel" (message thread + compose bar) -- extracted
// out of inbox.html so contact-detail.html can carry the EXACT same
// functionality (Summary tab, sparkle AI-draft buttons, Reply-To-Email with
// quote preview, Mark Done, Task/Note/Schedule popovers, drag-resize)
// instead of maintaining its own independently-drifted copy. Plain global-
// defining script, same convention as crm-nav.js/inline-edit.js -- NOT an
// ES module, no bundler, loaded via a plain <script src> tag before each
// page's own inline <script>.
//
// window.ConversationPanel.init(container, config) returns an instance
// bound to ONE contactId at a time (see instance.switchContact for the
// inbox case where the same panel gets reused across many conversations).
// See inbox.html/contact-detail.html for the two callers' config objects.
(function () {
  'use strict';

  function escapeHtml(s) { const d = document.createElement('div'); d.textContent = String(s ?? ''); return d.innerHTML; }
  function fmtDate(iso) { return iso ? new Date(iso).toLocaleString() : ''; }
  function fmtCreatedDate(iso) { return iso ? new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) : ''; }
  // Compact date -- toLocaleString() always includes a time, which reads as
  // noise ("12:00:00 AM") for a task/note that was only ever given a date.
  // Only shows a time when one was actually set (non-midnight).
  function fmtDueCompact(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const dateStr = d.toLocaleDateString();
    return (d.getHours() || d.getMinutes()) ? `${dateStr} ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : dateStr;
  }

  // Four-point sparkle -- AI draft buttons next to Send Email/Send SMS.
  const SPARKLE_ICON = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2c.6 5.4 2.2 7 7.6 7.6-5.4.6-7 2.2-7.6 7.6-.6-5.4-2.2-7-7.6-7.6C9.8 9 11.4 7.4 12 2Z"/><path d="M19 17c.25 1.9.85 2.5 2.75 2.75C19.85 20 19.25 20.6 19 22.5c-.25-1.9-.85-2.5-2.75-2.75C18.15 19.5 18.75 18.9 19 17Z"/></svg>';
  const COPY_ICON = '<svg viewBox="0 0 24 24" fill="none"><rect x="8" y="8" width="12" height="12" rx="2" stroke="currentColor" stroke-width="1.8"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" stroke="currentColor" stroke-width="1.8"/></svg>';
  const CALENDAR_ICON = '<svg viewBox="0 0 24 24" fill="none"><rect x="3.5" y="5" width="17" height="15.5" rx="2.5" stroke="currentColor" stroke-width="1.8"/><path d="M3.5 9.5h17M8 3v4M16 3v4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';

  // "Coach Lee <lee@pacificrimathletics.com>" -> "lee@pacificrimathletics.com"
  // -- item.from is a raw header string for Gmail-captured sends but a plain
  // address for SES sends, same two shapes server-side extractEmailAddress
  // already handles.
  function extractEmailAddr(raw) {
    const m = String(raw || '').match(/<([^>]+)>/);
    return (m ? m[1] : raw || '').trim();
  }
  function emailBubbleHtml(item, idx) {
    const clicked = (item.statusHistory || []).find(h => h.status === 'clicked');
    const opened = (item.statusHistory || []).find(h => h.status === 'opened') || clicked;
    return `
      <div class="bubble-row ${item.direction}">
        <div class="email-bubble" data-email-toggle="${idx}">
          <div class="email-bubble-head">
            <span class="email-bubble-icon">📧</span>
            <span class="email-bubble-subject">${escapeHtml(item.subject || '(no subject)')}</span>
            ${item.from ? `<span class="email-bubble-from">${escapeHtml(item.direction === 'outbound' ? 'From' : 'To')}: ${escapeHtml(extractEmailAddr(item.direction === 'outbound' ? item.from : item.to))}</span>` : ''}
            ${item.direction !== 'outbound' ? `<button type="button" class="email-bubble-reply-btn" data-reply-idx="${idx}" title="Reply">↩ Reply</button>` : ''}
          </div>
          <div class="email-bubble-preview">${escapeHtml((item.bodyPreview || '').replace(/<[^>]+>/g, ' ')).trim()}</div>
          <div class="email-bubble-body"><iframe data-src="${idx}" sandbox=""></iframe></div>
          <div class="email-bubble-meta">
            <span>${fmtDate(item.at)}</span>
            <span>${item.status || ''}</span>
            ${item.direction === 'outbound' ? `<span class="track-badge${opened ? ' on' : ''}">${opened ? 'Opened' : 'Not opened'}</span><span class="track-badge${clicked ? ' on' : ''}">${clicked ? 'Clicked' : 'Not clicked'}</span>` : ''}
          </div>
        </div>
      </div>
    `;
  }
  function smsBubbleHtml(item) {
    return `
      <div class="bubble-row ${item.direction}">
        <div class="bubble-content">
          <div class="sms-bubble">${escapeHtml(item.body || item.bodyPreview || '')}</div>
          <div class="bubble-time">${fmtDate(item.at)}</div>
        </div>
      </div>
    `;
  }
  function noteBubbleHtml(item) {
    const icon = item.channel === 'booking' ? '📅' : item.channel === 'meeting' ? '📆' : item.channel === 'activity' ? '📈' : '📝';
    return `
      <div class="bubble-row ${item.direction}">
        <div class="bubble-content note-bubble">
          <div class="note-bubble-head"><span>${icon}</span><span class="note-bubble-subject">${escapeHtml(item.subject || '')}</span></div>
          ${item.body ? `<div class="note-bubble-body">${escapeHtml(item.body)}</div>` : ''}
          <div class="bubble-time">${fmtDate(item.at)}</div>
        </div>
      </div>
    `;
  }
  function emailStatsHtml(items) {
    const sent = items.filter(i => i.itemType === 'email' && i.direction === 'outbound');
    if (!sent.length) return '';
    const opened = sent.filter(i => (i.statusHistory || []).some(h => h.status === 'opened' || h.status === 'clicked')).length;
    const clicked = sent.filter(i => (i.statusHistory || []).some(h => h.status === 'clicked')).length;
    const pct = (n) => Math.round((n / sent.length) * 100);
    return `
      <div class="track-summary">
        <span><b>${sent.length}</b> email${sent.length === 1 ? '' : 's'} sent</span>
        <span class="${opened ? 'on' : ''}"><b>${opened}</b> opened (${pct(opened)}%)</span>
        <span class="${clicked ? 'on' : ''}"><b>${clicked}</b> clicked (${pct(clicked)}%)</span>
      </div>
    `;
  }
  // Same badge markup used in every contact view that shows opt-out state.
  function optOutBadgesHtml(contact) {
    if (!contact) return '';
    const badge = (label) => `<span class="pra-badge" style="background:#3a1414;color:#ff6b6b;border:1px solid #ff6b6b55">${label}</span>`;
    return (contact.emailOptOut ? badge('EMAIL OPT-OUT') : '') + (contact.smsOptOut ? badge('SMS OPT-OUT') : '');
  }
  // Always the LOGGED-IN user's own Zoom link, never the assigned coach's or
  // the contact's -- whoever's actually in the conversation is who'd be
  // running the call. Full-layout only (part of the header sub-info line).
  function zoomLinkHtml(currentUser) {
    if (!currentUser?.zoomLink) return '';
    return `<span class="chat-zoom-link"><a class="pra-tel-link" href="${escapeHtml(currentUser.zoomLink)}" target="_blank" rel="noopener noreferrer">Zoom</a><button type="button" class="zoom-copy-btn" id="chatZoomCopyBtn" title="Copy Zoom link" data-zoom-link="${escapeHtml(currentUser.zoomLink)}">${COPY_ICON}</button></span>`;
  }

  // Delegated click handler for the Task/Note/Schedule popovers -- registered
  // once (not per instance/render), same reasoning as the original: the
  // popovers' own DOM is recreated on every render() call, so a direct
  // binding would go stale. Dispatches to whichever instance most recently
  // rendered, via a page-level "active instance" registry keyed by the
  // triggering element's closest panel root.
  const _instancesByRoot = new WeakMap();
  let _delegatedHandlerWired = false;
  function _wireDelegatedPopoverHandler() {
    if (_delegatedHandlerWired) return;
    _delegatedHandlerWired = true;
    document.addEventListener('click', (e) => {
      const root = e.target.closest('[data-convo-panel-root]');
      const inst = root ? _instancesByRoot.get(root) : null;
      if (!inst) return;
      if (e.target.id === 'taskPanelCancelBtn') { inst._toggleTaskPanel(false); return; }
      if (e.target.id === 'taskPanelAddBtn') { inst._submitNewTask(); return; }
      if (e.target.id === 'notePanelCancelBtn') { inst._toggleNotePanel(false); return; }
      if (e.target.id === 'notePanelAddBtn') { inst._submitNewNote(); return; }
      if (e.target.id === 'schedulePanelCancelBtn') { inst._toggleSchedulePanel(false); return; }
      if (e.target.id === 'schedulePanelAddBtn') { inst._submitNewMeeting(); return; }
      const taskPanel = root.querySelector('#taskPanel');
      if (taskPanel?.classList.contains('open') && !taskPanel.contains(e.target) && e.target.id !== 'chatAddTaskBtn') inst._toggleTaskPanel(false);
      const notePanel = root.querySelector('#notePanel');
      if (notePanel?.classList.contains('open') && !notePanel.contains(e.target) && e.target.id !== 'chatAddNoteBtn') inst._toggleNotePanel(false);
      const schedulePanel = root.querySelector('#schedulePanel');
      if (schedulePanel?.classList.contains('open') && !schedulePanel.contains(e.target) && e.target.id !== 'chatScheduleBtn' && !e.target.closest('#chatScheduleBtn')) inst._toggleSchedulePanel(false);
    });
  }

  function init(container, config) {
    _wireDelegatedPopoverHandler();
    container.classList.add('chat-panel');
    container.setAttribute('data-convo-panel-root', '');

    const isFull = config.layout === 'full';
    const state = {
      contactId: config.contactId || null,
      threadItems: [],
      composeChannel: config.initialChannel || 'email',
      composeView: 'compose', // 'compose' | 'summary'
      composeReplyTo: null, // { subject, quotedHtml, quotedMeta } | null
      aiAssistAvailable: false,
      composeBarHeight: null,
      // null = unknown/one-way (Mark Done always available, never shows
      // "Mark Not Done" until this instance itself has toggled it once) --
      // see contact-detail.html's config, which has no cheap way to look up
      // a single contact's current done-state without a new backend route.
      done: config.initialDone === undefined ? null : config.initialDone,
    };

    function getContact() { return config.getContact ? config.getContact() : null; }
    function markDoneLabel() { return state.done ? 'Mark Not Done' : 'Mark Done'; }

    // ── Task popover ────────────────────────────────────────────────────
    function taskPanelRowHtml(t) {
      return `
        <div class="task-panel-row${t.done ? ' done' : ''}" data-task-row="${t.id}">
          <button type="button" data-task-delete="${t.id}" title="Delete">&times;</button>
          ${t.dueAt ? `<span class="task-panel-due">${fmtDueCompact(t.dueAt)}</span>` : '<span class="task-panel-due">No date</span>'}
          <input type="text" data-task-title="${t.id}" value="${escapeHtml(t.title)}"/>
        </div>
      `;
    }
    function renderTaskPanel() {
      const list = container.querySelector('#taskPanelList');
      if (!list) return;
      const tasks = state.threadItems.filter(i => i.itemType === 'task').sort((a, b) => new Date(a.dueAt || a.createdAt) - new Date(b.dueAt || b.createdAt));
      list.innerHTML = tasks.length ? tasks.map(taskPanelRowHtml).join('') : '<div class="pra-muted" style="font-size:.78rem;padding:4px 0">No tasks yet.</div>';
      list.querySelectorAll('[data-task-title]').forEach(inp => {
        const commit = async () => {
          const id = inp.dataset.taskTitle;
          const title = inp.value.trim();
          if (!title) { inp.value = state.threadItems.find(i => i.id === id)?.title || ''; return; }
          await fetch('/api/tasks/' + id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title }) });
          const t = state.threadItems.find(i => i.id === id); if (t) t.title = title;
        };
        inp.addEventListener('blur', commit);
        inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') inp.blur(); });
      });
      list.querySelectorAll('[data-task-delete]').forEach(btn => btn.onclick = async () => {
        const id = btn.dataset.taskDelete;
        await fetch('/api/tasks/' + id, { method: 'DELETE' });
        state.threadItems = state.threadItems.filter(i => i.id !== id);
        renderTaskPanel();
      });
    }
    function _toggleTaskPanel(forceOpen) {
      const panel = container.querySelector('#taskPanel');
      if (!panel) return;
      const opening = forceOpen === undefined ? !panel.classList.contains('open') : !!forceOpen;
      panel.classList.toggle('open', opening);
      if (opening) {
        container.querySelector('#taskPanelTitle').value = '';
        container.querySelector('#taskPanelDate').value = '';
        container.querySelector('#taskPanelTime').value = '';
        renderTaskPanel();
      }
    }
    async function _submitNewTask() {
      const titleEl = container.querySelector('#taskPanelTitle');
      const title = titleEl.value.trim();
      if (!title) { showToast('Title is required', true); return; }
      const dateVal = container.querySelector('#taskPanelDate').value;
      const timeVal = container.querySelector('#taskPanelTime').value;
      const dueAt = dateVal ? new Date(`${dateVal}T${timeVal || '00:00'}`).toISOString() : null;
      const r = await fetch('/api/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'task', contactId: state.contactId, title, dueAt }) });
      const { task } = await r.json();
      state.threadItems.push({ ...task, itemType: 'task', at: task.dueAt || task.createdAt });
      titleEl.value = '';
      container.querySelector('#taskPanelDate').value = '';
      container.querySelector('#taskPanelTime').value = '';
      renderTaskPanel();
    }

    // ── Note popover ────────────────────────────────────────────────────
    function notePanelRowHtml(n) {
      return `
        <div class="task-panel-row" data-note-row="${n.id}">
          <button type="button" data-note-delete="${n.id}" title="Delete">&times;</button>
          <span class="task-panel-due">${fmtDueCompact(n.at)}</span>
          <input type="text" data-note-text="${n.id}" value="${escapeHtml(n.text)}"/>
        </div>
      `;
    }
    function renderNotePanel() {
      const list = container.querySelector('#notePanelList');
      if (!list) return;
      const notes = state.threadItems.filter(i => i.itemType === 'note').sort((a, b) => new Date(b.at) - new Date(a.at));
      list.innerHTML = notes.length ? notes.map(notePanelRowHtml).join('') : '<div class="pra-muted" style="font-size:.78rem;padding:4px 0">No notes yet.</div>';
      list.querySelectorAll('[data-note-text]').forEach(inp => {
        const commit = async () => {
          const id = inp.dataset.noteText;
          const text = inp.value.trim();
          if (!text) { inp.value = state.threadItems.find(i => i.id === id)?.text || ''; return; }
          await fetch('/api/notes/' + id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
          const n = state.threadItems.find(i => i.id === id); if (n) n.text = text;
        };
        inp.addEventListener('blur', commit);
        inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') inp.blur(); });
      });
      list.querySelectorAll('[data-note-delete]').forEach(btn => btn.onclick = async () => {
        const id = btn.dataset.noteDelete;
        await fetch('/api/notes/' + id, { method: 'DELETE' });
        state.threadItems = state.threadItems.filter(i => i.id !== id);
        renderNotePanel();
      });
    }
    function _toggleNotePanel(forceOpen) {
      const panel = container.querySelector('#notePanel');
      if (!panel) return;
      const opening = forceOpen === undefined ? !panel.classList.contains('open') : !!forceOpen;
      panel.classList.toggle('open', opening);
      if (opening) {
        container.querySelector('#notePanelText').value = '';
        renderNotePanel();
      }
    }
    async function _submitNewNote() {
      const textEl = container.querySelector('#notePanelText');
      const text = textEl.value.trim();
      if (!text) { showToast('Note text is required', true); return; }
      const r = await fetch('/api/notes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contactId: state.contactId, text }) });
      const { note } = await r.json();
      state.threadItems.push({ ...note, itemType: 'note', at: note.createdAt });
      textEl.value = '';
      renderNotePanel();
    }

    // ── Schedule-a-meeting popover ──────────────────────────────────────
    function schedulePanelRowHtml(m) {
      const when = new Date(m.startISO).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
      return `
        <div class="schedule-panel-row" data-meeting-row="${m.id}">
          <button type="button" data-meeting-cancel="${m.id}" title="Cancel meeting">&times;</button>
          <span class="schedule-panel-when">${escapeHtml(m.title)}<br>${when} · ${m.durationMinutes} min${m.calendarEventLink ? ` · <a href="${escapeHtml(m.calendarEventLink)}" target="_blank" rel="noopener noreferrer">View</a>` : ''}</span>
        </div>
      `;
    }
    async function renderSchedulePanel() {
      const list = container.querySelector('#schedulePanelList');
      if (!list) return;
      const contactId = state.contactId;
      if (!contactId) { list.innerHTML = '<div class="pra-muted" style="font-size:.78rem;padding:4px 0">Match this conversation to a contact first.</div>'; return; }
      list.innerHTML = '<div class="pra-muted" style="font-size:.78rem;padding:4px 0">Loading…</div>';
      const r = await fetch('/api/meetings?contactId=' + encodeURIComponent(contactId));
      const { meetings } = r.ok ? await r.json() : { meetings: [] };
      if (state.contactId !== contactId) return; // superseded by a later switchContact
      const upcoming = (meetings || []).filter(m => m.status === 'scheduled' && new Date(m.startISO).getTime() > Date.now());
      list.innerHTML = upcoming.length ? upcoming.map(schedulePanelRowHtml).join('') : '<div class="pra-muted" style="font-size:.78rem;padding:4px 0">No upcoming meetings.</div>';
      list.querySelectorAll('[data-meeting-cancel]').forEach(btn => btn.onclick = async () => {
        if (!confirm('Cancel this meeting?')) return;
        await fetch('/api/meetings/' + btn.dataset.meetingCancel, { method: 'DELETE' });
        showToast('Meeting cancelled');
        renderSchedulePanel();
        loadThread();
        config.onMeetingChanged?.(contactId);
      });
    }
    function _toggleSchedulePanel(forceOpen) {
      const panel = container.querySelector('#schedulePanel');
      if (!panel) return;
      const opening = forceOpen === undefined ? !panel.classList.contains('open') : !!forceOpen;
      panel.classList.toggle('open', opening);
      if (opening) {
        container.querySelector('#schedulePanelTitle').value = '';
        container.querySelector('#schedulePanelDate').value = '';
        container.querySelector('#schedulePanelTime').value = '';
        container.querySelector('#schedulePanelDuration').value = '30';
        renderSchedulePanel();
      }
    }
    async function _submitNewMeeting() {
      const contactId = state.contactId;
      if (!contactId) { showToast('Match this conversation to a contact first', true); return; }
      const dateVal = container.querySelector('#schedulePanelDate').value;
      const timeVal = container.querySelector('#schedulePanelTime').value;
      if (!dateVal || !timeVal) { showToast('Pick a date and time', true); return; }
      const startISO = new Date(`${dateVal}T${timeVal}`).toISOString();
      const durationMinutes = Number(container.querySelector('#schedulePanelDuration').value);
      const title = container.querySelector('#schedulePanelTitle').value.trim();
      const btn = container.querySelector('#schedulePanelAddBtn');
      btn.disabled = true; btn.textContent = 'Scheduling…';
      const r = await fetch('/api/meetings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contactId, startISO, durationMinutes, title: title || undefined }) });
      const d = await r.json();
      btn.disabled = false; btn.textContent = 'Schedule';
      if (!r.ok) { showToast(d.error || 'Could not schedule meeting', true); return; }
      showToast('Meeting scheduled');
      container.querySelector('#schedulePanelTitle').value = '';
      container.querySelector('#schedulePanelDate').value = '';
      container.querySelector('#schedulePanelTime').value = '';
      renderSchedulePanel();
      loadThread();
      config.onMeetingChanged?.(contactId);
    }

    // ── AI assist ───────────────────────────────────────────────────────
    async function generateAiContent(channel, btn) {
      const contactId = state.contactId;
      if (!contactId) return;
      btn.disabled = true;
      btn.classList.add('loading');
      try {
        const r = await fetch('/api/ai-agents/generate', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contactId, channel }),
        });
        const d = await r.json();
        if (!r.ok) { showToast(d.error || 'Could not generate', true); return; }
        if (d.status === 'skip') { showToast(d.reason || 'No response needed right now'); return; }
        if (d.status === 'escalate') { showToast('⚠️ ' + d.reason, true); return; }
        state.composeChannel = channel;
        state.composeView = 'compose';
        render();
        if (channel === 'email' && d.subject) container.querySelector('#composeSubject').value = d.subject;
        container.querySelector('#composeBody').value = d.body || '';
        if (d.buyingSignal) showToast('🔥 Buying signal detected — consider taking over');
      } catch {
        showToast('Could not generate', true);
      } finally {
        btn.disabled = false;
        btn.classList.remove('loading');
      }
    }
    async function loadAiSummary(contactId) {
      const panel = container.querySelector('#aiSummaryPanel');
      if (!panel) return;
      try {
        const r = await fetch('/api/ai-agents/summarize', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contactId }),
        });
        const d = await r.json();
        if (!r.ok) { panel.innerHTML = `<div class="pra-muted">${escapeHtml(d.error || 'Could not load summary')}</div>`; return; }
        panel.innerHTML = `
          <div class="ai-summary-row"><div class="ai-summary-label">Goal</div>${escapeHtml(d.goal || 'Unclear')}</div>
          <div class="ai-summary-row"><div class="ai-summary-label">Objections</div>${escapeHtml(d.objections || 'None raised')}</div>
          <div class="ai-summary-row"><div class="ai-summary-label">Recommendation</div>${escapeHtml(d.recommendation || '—')}</div>
          ${d.takeover ? `<div class="ai-summary-takeover">🔥 Consider taking over — ${escapeHtml(d.takeoverReason || '')}</div>` : ''}
        `;
      } catch { panel.innerHTML = '<div class="pra-muted">Could not load summary.</div>'; }
    }

    // ── Compose ─────────────────────────────────────────────────────────
    // Drag handle between chat-thread and compose-bar -- re-wired every
    // render() call since that replaces the container's innerHTML wholesale,
    // tearing down any listener attached to the old element. Uses pointer
    // capture on the handle itself so move/up keep firing even once the
    // pointer leaves the thin 8px strip, instead of needing document-level
    // listeners.
    function wireComposeResize() {
      const handle = container.querySelector('#composeResizeHandle');
      const composeBar = container.querySelector('#composeBar');
      const thread = container.querySelector('#chatThread');
      if (!handle || !composeBar || !thread) return;
      const MIN_COMPOSE = 90, MIN_THREAD = 100;
      handle.onpointerdown = (e) => {
        e.preventDefault();
        handle.setPointerCapture(e.pointerId);
        const startY = e.clientY;
        const startHeight = composeBar.getBoundingClientRect().height;
        const fixedChrome = container.clientHeight - thread.getBoundingClientRect().height - startHeight;
        handle.classList.add('dragging');
        const onMove = (ev) => {
          const delta = startY - ev.clientY; // dragging up (delta > 0) grows compose-bar
          const maxHeight = Math.max(MIN_COMPOSE, container.clientHeight - fixedChrome - MIN_THREAD);
          const next = Math.max(MIN_COMPOSE, Math.min(startHeight + delta, maxHeight));
          composeBar.style.height = next + 'px';
          composeBar.style.flex = `0 0 ${next}px`;
        };
        const onUp = () => {
          handle.releasePointerCapture(e.pointerId);
          handle.removeEventListener('pointermove', onMove);
          handle.removeEventListener('pointerup', onUp);
          handle.classList.remove('dragging');
          state.composeBarHeight = composeBar.getBoundingClientRect().height;
        };
        handle.addEventListener('pointermove', onMove);
        handle.addEventListener('pointerup', onUp);
      };
    }

    async function sendComposeMessage() {
      const contactId = state.contactId;
      const bodyEl = container.querySelector('#composeBody');
      const body = (bodyEl?.value || '').trim();
      if (!body || !contactId) return;
      const subject = state.composeChannel === 'email' ? container.querySelector('#composeSubject')?.value.trim() : undefined;
      const fromUserId = state.composeChannel === 'email' ? container.querySelector('#composeFromUserId')?.value : undefined;
      const btn = container.querySelector('#composeSendBtn');
      btn.disabled = true; btn.textContent = 'Sending…';
      const isReply = state.composeChannel === 'email' && state.composeReplyTo;
      const r = await fetch('/api/inbox/send', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contactId, channel: state.composeChannel, subject, body, fromUserId,
          quotedHtml: isReply ? state.composeReplyTo.quotedHtml : undefined,
          quotedMeta: isReply ? state.composeReplyTo.quotedMeta : undefined,
        }),
      });
      const d = await r.json();
      btn.disabled = false; btn.textContent = state.composeChannel === 'email' && state.composeReplyTo ? 'Reply' : 'Send';
      if (!r.ok) { showToast(d.error || 'Send failed', true); return; }
      showToast('Sent');
      state.composeReplyTo = null;
      // A real reply just went out -- THIS is what actually counts as
      // responding, not merely having opened the thread earlier. Marks
      // every prior unread inbound message done and moves the conversation
      // out of Unresponded (inbox) / clears the sidebar glow (contact-detail).
      await fetch(`/api/inbox/conversations/${contactId}/done`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ done: true }) });
      state.done = true;
      config.onDoneChanged?.(contactId, true);
      if (state.contactId !== contactId) return; // superseded by a later switchContact
      const threadRes = await fetch('/api/inbox/contact/' + contactId);
      state.threadItems = threadRes.ok ? (await threadRes.json()).items : [];
      if (state.contactId !== contactId) return;
      render();
      config.onThreadLoaded?.(state.threadItems);
    }

    // ── Full render ─────────────────────────────────────────────────────
    function render() {
      const contact = getContact();
      const contactId = state.contactId;
      const emailOk = contact?.email, smsOk = contact?.phone;
      const emailItems = state.threadItems.filter(i => i.itemType === 'email');
      const showToolbar = typeof config.showComposeToolbar === 'function' ? config.showComposeToolbar() : config.showComposeToolbar !== false;

      const headerHtml = isFull ? `
        <div class="chat-panel-header">
          ${config.onBack ? `<button class="chat-back-btn" id="chatBackBtn" title="Back to chats">&larr;</button>` : ''}
          <div>
            <span class="chat-panel-name-row">
              <span class="pra-badge pra-badge-${contact?.programType || ''}" id="chatPanelTypeBadge" title="Click to change">${contact?.programType ? escapeHtml(contact.programType) : 'SET TYPE'}</span>
              <a class="chat-panel-name" id="chatPanelNameLink">${escapeHtml(config.getDisplayName ? (config.getDisplayName() || '') : `${contact?.first || ''} ${contact?.last || ''}`.trim())}</a>
              ${contactId ? ownerFieldHtml(contact) : ''}
            </span>
            <div class="chat-panel-sub">${[
              contact?.email ? escapeHtml(contact.email) : '',
              contact?.phone ? `<a class="pra-tel-link" href="tel:${escapeHtml(contact.phone.replace(/[^\d+]/g, ''))}">${escapeHtml(contact.phone)}</a>` : '',
              zoomLinkHtml(config.currentUser),
              contact?.firstSeenAt ? `<span class="chat-panel-created" title="Earliest known date across Close/ActiveCampaign">Since ${fmtCreatedDate(contact.firstSeenAt)}</span>` : '',
            ].filter(Boolean).join(' · ')}</div>
          </div>
          ${contactId ? `<button class="pra-btn pra-btn-ghost pra-btn-sm" id="chatMarkDoneBtn" type="button" style="margin-left:auto" title="Mark as handled without replying">${markDoneLabel()}</button>` : ''}
        </div>
      ` : '';

      const actionsHtml = `
        <div class="chat-panel-actions">
          <div class="chat-panel-task-btn">
            <button class="pra-btn pra-btn-ghost pra-btn-sm" id="chatAddTaskBtn" type="button">Tasks</button>
            <div class="task-panel" id="taskPanel">
              <div class="task-panel-list" id="taskPanelList"></div>
              <div class="task-panel-add">
                <input class="pra-input" id="taskPanelTitle" placeholder="New task..."/>
                <div class="task-panel-add-row">
                  <input class="pra-input" type="date" id="taskPanelDate"/>
                  <input class="pra-input" type="time" id="taskPanelTime"/>
                </div>
              </div>
              <div class="task-panel-footer">
                <button class="pra-btn pra-btn-ghost pra-btn-sm" id="taskPanelCancelBtn" type="button">Cancel</button>
                <button class="pra-btn pra-btn-sm" id="taskPanelAddBtn" type="button" style="margin-left:8px">Add</button>
              </div>
            </div>
          </div>
          <div class="chat-panel-task-btn">
            <button class="pra-btn pra-btn-ghost pra-btn-sm" id="chatAddNoteBtn" type="button">Notes</button>
            <div class="task-panel" id="notePanel">
              <div class="task-panel-list" id="notePanelList"></div>
              <div class="task-panel-add">
                <input class="pra-input" id="notePanelText" placeholder="New note..."/>
              </div>
              <div class="task-panel-footer">
                <button class="pra-btn pra-btn-ghost pra-btn-sm" id="notePanelCancelBtn" type="button">Cancel</button>
                <button class="pra-btn pra-btn-sm" id="notePanelAddBtn" type="button" style="margin-left:8px">Add</button>
              </div>
            </div>
          </div>
          <div class="chat-panel-task-btn">
            <button class="pra-btn pra-btn-ghost pra-btn-sm" id="chatScheduleBtn" type="button" title="Schedule a meeting">${CALENDAR_ICON}</button>
            <div class="task-panel" id="schedulePanel">
              <div class="task-panel-list" id="schedulePanelList"></div>
              <div class="task-panel-add">
                <input class="pra-input" id="schedulePanelTitle" placeholder="Meeting title (optional)"/>
                <div class="task-panel-add-row">
                  <input class="pra-input" type="date" id="schedulePanelDate"/>
                  <input class="pra-input" type="time" id="schedulePanelTime"/>
                  <select class="pra-select" id="schedulePanelDuration">
                    <option value="15">15 min</option>
                    <option value="30" selected>30 min</option>
                    <option value="45">45 min</option>
                    <option value="60">60 min</option>
                  </select>
                </div>
              </div>
              <div class="task-panel-footer">
                <button class="pra-btn pra-btn-ghost pra-btn-sm" id="schedulePanelCancelBtn" type="button">Cancel</button>
                <button class="pra-btn pra-btn-sm" id="schedulePanelAddBtn" type="button" style="margin-left:8px">Schedule</button>
              </div>
            </div>
          </div>
          ${isFull ? `<select class="pra-select" id="chatStatusSelect" style="${config.statusGlowStyle ? config.statusGlowStyle(contact?.status) : ''}"><option value="">Change status...</option>${(config.allStatuses || []).map(s => `<option value="${escapeHtml(s.label)}" ${contact?.status === s.label ? 'selected' : ''}>${escapeHtml(s.label)}</option>`).join('')}</select>` : ''}
          ${isFull ? optOutBadgesHtml(contact) : ''}
          ${!isFull && contactId ? `<button class="pra-btn pra-btn-ghost pra-btn-sm" id="chatMarkDoneBtn" type="button" title="Mark as handled without replying">${markDoneLabel()}</button>` : ''}
        </div>
      `;

      container.innerHTML = `
        ${headerHtml}
        ${actionsHtml}
        ${emailStatsHtml(emailItems)}
        <div class="chat-thread" id="chatThread"></div>
        <div class="compose-resize-handle" id="composeResizeHandle" title="Drag to resize"></div>
        <div class="compose-bar" id="composeBar" style="${state.composeBarHeight ? `height:${state.composeBarHeight}px;flex:0 0 ${state.composeBarHeight}px;` : ''}">
          ${showToolbar ? `
            <div class="compose-toolbar-row">
              ${state.composeChannel === 'email' && (config.teamUsers || []).length > 1 && config.currentUser?.role === 'admin' ? `
                <select class="pra-select compose-from-select" id="composeFromUserId" title="Send this email as">
                  ${config.teamUsers.map(u => `<option value="${u.id}" ${config.currentUser && u.id === config.currentUser.id ? 'selected' : ''}>${escapeHtml(u.first)} ${escapeHtml(u.last)}</option>`).join('')}
                </select>
              ` : ''}
              <div class="compose-channel-toggle">
                <span class="compose-tab-group">
                  <button type="button" data-ch="email" class="${state.composeView === 'compose' && state.composeChannel === 'email' ? 'active' : ''} ${state.composeView === 'compose' && state.composeChannel === 'email' && state.composeReplyTo ? 'reply-mode' : ''}">${state.composeView === 'compose' && state.composeChannel === 'email' && state.composeReplyTo ? 'Reply To Email' : 'Send Email'}</button>
                  ${state.aiAssistAvailable ? `<button type="button" class="ai-gen-btn" data-ai-ch="email" title="Generate email with AI">${SPARKLE_ICON}</button>` : ''}
                </span>
                <span class="compose-tab-group">
                  <button type="button" data-ch="sms" class="${state.composeView === 'compose' && state.composeChannel === 'sms' ? 'active' : ''}">Send SMS</button>
                  ${state.aiAssistAvailable ? `<button type="button" class="ai-gen-btn" data-ai-ch="sms" title="Generate text with AI">${SPARKLE_ICON}</button>` : ''}
                </span>
                ${state.aiAssistAvailable ? `<button type="button" data-ch="summary" class="${state.composeView === 'summary' ? 'active' : ''}">Summary</button>` : ''}
              </div>
            </div>
          ` : ''}
          ${state.composeView === 'summary' ? `
            <div class="ai-summary-panel" id="aiSummaryPanel"><div class="pra-muted">Loading summary…</div></div>
          ` : `
            ${state.composeChannel === 'email' ? `<input class="pra-input" id="composeSubject" placeholder="Subject" style="margin-bottom:8px"/>` : ''}
            <div class="compose-row">
              <textarea class="pra-textarea" id="composeBody" placeholder="${state.composeChannel === 'email' ? 'Write an email…' : 'Write a text message…'}"></textarea>
              <button class="pra-btn ${state.composeChannel === 'email' && state.composeReplyTo ? 'reply-mode' : ''}" id="composeSendBtn">${state.composeChannel === 'email' && state.composeReplyTo ? 'Reply' : 'Send'}</button>
            </div>
            ${state.composeChannel === 'email' && state.composeReplyTo ? `
              <div class="compose-quote-preview">
                <div class="compose-quote-preview-head">
                  <span title="${escapeHtml(state.composeReplyTo.quotedMeta)}">${escapeHtml(state.composeReplyTo.quotedMeta)}</span>
                  <button type="button" id="composeQuoteRemoveBtn" title="Remove quoted text">✕</button>
                </div>
                <iframe id="composeQuoteFrame" sandbox=""></iframe>
              </div>
            ` : ''}
            ${state.composeChannel === 'email' && !emailOk ? '<div class="compose-hint">This contact has no email on file.</div>' : ''}
            ${state.composeChannel === 'sms' && !smsOk ? '<div class="compose-hint">This contact has no phone number on file.</div>' : ''}
          `}
        </div>
      `;

      const items = [...state.threadItems].filter(i => ['email', 'sms', 'form', 'booking', 'activity', 'meeting'].includes(i.itemType)).sort((a, b) => new Date(a.at) - new Date(b.at));
      const threadEl = container.querySelector('#chatThread');
      threadEl.innerHTML = items.length ? items.map((item, idx) => item.itemType === 'email' ? emailBubbleHtml(item, idx) : item.itemType === 'sms' ? smsBubbleHtml(item) : noteBubbleHtml(item)).join('') : '<div class="pra-muted" style="text-align:center;padding:30px">No messages yet.</div>';
      threadEl.querySelectorAll('[data-email-toggle]').forEach(el => el.onclick = () => {
        const wasExpanded = el.classList.contains('expanded');
        el.classList.toggle('expanded');
        if (!wasExpanded) {
          const iframe = el.querySelector('iframe');
          const item = items[Number(el.dataset.emailToggle)];
          if (iframe && !iframe.srcdoc) iframe.srcdoc = `<style>body,*{font-family:Arial,Helvetica,sans-serif!important;}</style>${item.body || '<p style="color:#888">(no content stored)</p>'}`;
        }
      });
      threadEl.querySelectorAll('[data-reply-idx]').forEach(el => el.onclick = (e) => {
        e.stopPropagation();
        const item = items[Number(el.dataset.replyIdx)];
        const c2 = getContact();
        const fromAddr = extractEmailAddr(item.from) || (c2 ? `${c2.first || ''} ${c2.last || ''}`.trim() : '') || 'they';
        state.composeReplyTo = {
          subject: /^re:/i.test(item.subject || '') ? item.subject : `Re: ${item.subject || ''}`,
          quotedHtml: item.body || `<p style="color:#888">${escapeHtml(item.bodyPreview || '(no content stored)')}</p>`,
          quotedMeta: `On ${fmtDate(item.at)}, ${fromAddr} wrote:`,
        };
        state.composeChannel = 'email';
        state.composeView = 'compose';
        render();
        const subjEl = container.querySelector('#composeSubject');
        const bodyEl = container.querySelector('#composeBody');
        if (subjEl) subjEl.value = state.composeReplyTo.subject;
        if (bodyEl) { bodyEl.value = ''; bodyEl.focus(); }
      });
      threadEl.scrollTop = threadEl.scrollHeight;

      if (showToolbar) {
        container.querySelectorAll('.compose-channel-toggle [data-ch]').forEach(btn => btn.onclick = () => {
          state.composeReplyTo = null; // manually switching tabs exits reply mode
          if (btn.dataset.ch === 'summary') state.composeView = 'summary';
          else { state.composeChannel = btn.dataset.ch; state.composeView = 'compose'; }
          render();
        });
        container.querySelectorAll('.ai-gen-btn').forEach(btn => btn.onclick = () => generateAiContent(btn.dataset.aiCh, btn));
      }
      if (state.composeChannel === 'email' && state.composeReplyTo) {
        const quoteFrame = container.querySelector('#composeQuoteFrame');
        if (quoteFrame) quoteFrame.srcdoc = `<style>body{font-family:Arial,Helvetica,sans-serif;margin:0;padding:8px;color:#333}</style>${state.composeReplyTo.quotedHtml}`;
        const quoteRemoveBtn = container.querySelector('#composeQuoteRemoveBtn');
        if (quoteRemoveBtn) quoteRemoveBtn.onclick = () => { state.composeReplyTo = null; render(); };
      }
      if (state.composeView === 'summary') { if (contactId) loadAiSummary(contactId); }
      else { const sendBtn = container.querySelector('#composeSendBtn'); if (sendBtn) sendBtn.onclick = sendComposeMessage; }
      const backBtn = container.querySelector('#chatBackBtn');
      if (backBtn) backBtn.onclick = () => config.onBack?.();
      wireComposeResize();
      const zoomCopyBtn = container.querySelector('#chatZoomCopyBtn');
      if (zoomCopyBtn) zoomCopyBtn.onclick = (e) => {
        e.preventDefault();
        navigator.clipboard.writeText(zoomCopyBtn.dataset.zoomLink)
          .then(() => showToast('Zoom link copied'))
          .catch(() => showToast('Could not copy', true));
      };
      container.querySelector('#chatAddTaskBtn').onclick = (e) => { e.stopPropagation(); _toggleTaskPanel(); };
      container.querySelector('#chatAddNoteBtn').onclick = (e) => { e.stopPropagation(); _toggleNotePanel(); };
      container.querySelector('#chatScheduleBtn').onclick = (e) => { e.stopPropagation(); _toggleSchedulePanel(); };
      const nameLink = container.querySelector('#chatPanelNameLink');
      if (nameLink && contactId) nameLink.onclick = () => config.onOpenContactOverlay?.(contactId);
      if (isFull) {
        wireOwnerFields(container, (id, ownerId) => {
          const c2 = getContact();
          if (c2) c2.ownerId = ownerId;
          config.onOwnerChanged?.(id, ownerId);
        });
      }
      const markDoneBtn = container.querySelector('#chatMarkDoneBtn');
      if (markDoneBtn) {
        markDoneBtn.onclick = async () => {
          const nextDone = !state.done;
          await fetch(`/api/inbox/conversations/${contactId}/done`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ done: nextDone }) });
          state.done = nextDone;
          config.onDoneChanged?.(contactId, nextDone);
          showToast(nextDone ? 'Marked done' : 'Marked not done');
          render();
        };
      }
      if (isFull && contactId) {
        const typeBadge = container.querySelector('#chatPanelTypeBadge');
        if (typeBadge && typeof window.wireInlineEditClick === 'function') {
          window.wireInlineEditClick(typeBadge, {
            field: 'programType',
            contactId,
            onSaved: (value) => {
              const c2 = getContact();
              if (c2) c2.programType = value;
              const badge = container.querySelector('#chatPanelTypeBadge');
              if (badge) { badge.className = `pra-badge pra-badge-${value || ''}`; badge.textContent = value ? value : 'SET TYPE'; }
              config.onProgramTypeChanged?.(contactId, value);
            },
          });
        }
      }
      const statusSel = container.querySelector('#chatStatusSelect');
      if (statusSel) {
        statusSel.addEventListener('change', async (e) => {
          const status = e.target.value;
          if (!contactId) return;
          await fetch('/api/contacts/' + contactId, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) });
          showToast('Status updated');
          e.target.setAttribute('style', config.statusGlowStyle ? config.statusGlowStyle(status) : '');
          config.onStatusChanged?.(contactId, status);
        });
      }

      // Just VIEWING a thread is deliberately NOT the same as responding to
      // it -- see sendComposeMessage/Mark Done above for the only two things
      // that actually count as responding. /opened still fires on every
      // render, though, and clears the row's visual glow immediately.
      if (contactId) {
        fetch(`/api/inbox/conversations/${contactId}/opened`, { method: 'POST' });
        config.onOpened?.(contactId);
      }
    }

    // ── Public instance API ─────────────────────────────────────────────
    async function loadThread() {
      const contactId = state.contactId;
      if (!contactId) { state.threadItems = []; state.aiAssistAvailable = false; render(); return; }
      const contact = getContact();
      const [threadRes, matchRes] = await Promise.all([
        fetch('/api/inbox/contact/' + contactId),
        fetch('/api/ai-agents/matches?contactId=' + encodeURIComponent(contactId) + '&status=' + encodeURIComponent(contact?.status || '') + '&programType=' + encodeURIComponent(contact?.programType || '')),
      ]);
      // Discard a stale response -- switchContact() may have moved this
      // instance on to a different conversation while this fetch was still
      // in flight (inbox: clicking a different row before the first one
      // finished loading).
      if (state.contactId !== contactId) return;
      state.threadItems = threadRes.ok ? (await threadRes.json()).items : [];
      state.aiAssistAvailable = matchRes.ok ? (await matchRes.json()).match : false;
      if (state.contactId !== contactId) return;
      render();
      config.onThreadLoaded?.(state.threadItems);
    }

    function switchContact(contactId, opts) {
      opts = opts || {};
      state.contactId = contactId || null;
      state.threadItems = [];
      state.composeReplyTo = null;
      state.composeView = 'compose';
      state.aiAssistAvailable = false;
      state.done = opts.done === undefined ? null : opts.done;
    }

    function handleRemoteUpdate(data) {
      if (!state.contactId || !data || data.contactId !== state.contactId) return;
      if (data.type === 'new_message') { loadThread(); return; }
      if (data.type === 'done') {
        state.done = data.done;
        // Cheap DOM patch, not a full render() -- deliberately, so an
        // in-progress compose draft in another tab/window isn't blown away
        // just because a teammate marked this same conversation done.
        const btn = container.querySelector('#chatMarkDoneBtn');
        if (btn) btn.textContent = markDoneLabel();
      }
    }

    const instance = {
      loadThread,
      getThreadItems: () => state.threadItems,
      handleRemoteUpdate,
      switchContact,
      render,
      get contactId() { return state.contactId; },
      get done() { return state.done; },
    };
    _instancesByRoot.set(container, instance);
    return instance;
  }

  window.ConversationPanel = { init };
})();
