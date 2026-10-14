// Weekly-hours editor shared by every screen that edits a calendar's hours
// (scheduling-editor.html sidebar, scheduling.html Calendars tab, the
// form-builder calendar field). A day is null (closed) or { start, end }
// for its first time block plus optional extraBlocks: [{ start, end }] --
// scheduling_backend.js's dayBlocks() reads the same shape.
(function () {
  const STYLE = `
    .whe-day { display: flex; align-items: flex-start; gap: 8px; padding: 6px 0; border-bottom: 1px solid var(--pra-border); font-size: .76rem; }
    .whe-day:last-child { border-bottom: none; }
    .whe-label { width: 34px; flex-shrink: 0; color: var(--pra-dim); padding-top: 7px; }
    .whe-day > .toggle-switch { flex-shrink: 0; margin-top: 3px; }
    .whe-blocks { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 5px; }
    .whe-block { display: flex; align-items: center; gap: 5px; }
    .whe-block input[type=time] { flex: 1; min-width: 0; padding: 4px 6px; font-size: .72rem; }
    .whe-dash { color: var(--pra-dim); }
    .whe-del { background: none; border: none; color: var(--pra-dim); cursor: pointer; font-size: 1rem; line-height: 1; padding: 0 2px; width: 18px; flex-shrink: 0; }
    .whe-del:hover { color: #ef4444; }
    .whe-del-spacer { width: 18px; flex-shrink: 0; }
    .whe-add { align-self: flex-start; background: none; border: none; color: var(--pra-blue, #009bff); cursor: pointer; font-size: .72rem; padding: 2px 0; }
    .whe-closed { color: var(--pra-dim); padding-top: 7px; }
  `;
  function ensureStyle() {
    if (document.getElementById('whe-style')) return;
    const el = document.createElement('style');
    el.id = 'whe-style';
    el.textContent = STYLE;
    document.head.appendChild(el);
  }
  function blocksOf(rule) {
    if (!rule) return [];
    return [{ start: rule.start, end: rule.end }, ...(Array.isArray(rule.extraBlocks) ? rule.extraBlocks : [])];
  }
  function ruleOf(blocks) {
    if (!blocks.length) return null;
    const [first, ...rest] = blocks;
    return rest.length ? { start: first.start, end: first.end, extraBlocks: rest } : { start: first.start, end: first.end };
  }
  function addMinutes(hhmm, mins) {
    const [h, m] = String(hhmm || '09:00').split(':').map(Number);
    const t = Math.min(23 * 60 + 59, h * 60 + m + mins);
    return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
  }
  function esc(s) { return String(s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  // weekly: the calendar's availability.weekly object, edited in place.
  // onChange: called after every edit (save it). dayLabels: 7 labels, Sun first.
  function mount(wrap, weekly, onChange, dayLabels) {
    ensureStyle();
    function render() {
      wrap.innerHTML = dayLabels.map((label, d) => {
        const blocks = blocksOf(weekly[String(d)]);
        const on = blocks.length > 0;
        const rows = blocks.map((b, i) => `
          <div class="whe-block">
            <input class="pra-input" type="time" data-whe-start="${d}:${i}" value="${esc(b.start)}"/>
            <span class="whe-dash">&ndash;</span>
            <input class="pra-input" type="time" data-whe-end="${d}:${i}" value="${esc(b.end)}"/>
            ${blocks.length > 1 ? `<button type="button" class="whe-del" data-whe-del="${d}:${i}" title="Remove this time block">&times;</button>` : '<span class="whe-del-spacer"></span>'}
          </div>`).join('');
        return `
          <div class="whe-day">
            <div class="whe-label">${esc(label)}</div>
            <div class="toggle-switch ${on ? 'on' : ''}" data-whe-day="${d}" title="${on ? 'Open -- click to close this day' : 'Closed -- click to open this day'}"></div>
            <div class="whe-blocks">${on ? rows + `<button type="button" class="whe-add" data-whe-add="${d}">+ Add time block</button>` : '<div class="whe-closed">Closed</div>'}</div>
          </div>`;
      }).join('');
      const pair = s => s.split(':').map(Number);
      const update = (d, fn) => { const blocks = blocksOf(weekly[String(d)]); fn(blocks); weekly[String(d)] = ruleOf(blocks); };
      wrap.querySelectorAll('[data-whe-day]').forEach(sw => sw.onclick = () => {
        const d = sw.dataset.wheDay;
        weekly[d] = weekly[d] ? null : { start: '09:00', end: '17:00' };
        render(); onChange();
      });
      wrap.querySelectorAll('[data-whe-start]').forEach(inp => inp.onchange = () => {
        const [d, i] = pair(inp.dataset.wheStart);
        update(d, blocks => { blocks[i].start = inp.value; });
        onChange();
      });
      wrap.querySelectorAll('[data-whe-end]').forEach(inp => inp.onchange = () => {
        const [d, i] = pair(inp.dataset.wheEnd);
        update(d, blocks => { blocks[i].end = inp.value; });
        onChange();
      });
      wrap.querySelectorAll('[data-whe-del]').forEach(btn => btn.onclick = () => {
        const [d, i] = pair(btn.dataset.wheDel);
        update(d, blocks => { blocks.splice(i, 1); });
        render(); onChange();
      });
      wrap.querySelectorAll('[data-whe-add]').forEach(btn => btn.onclick = () => {
        const d = Number(btn.dataset.wheAdd);
        update(d, blocks => {
          const lastEnd = blocks[blocks.length - 1]?.end || '09:00';
          blocks.push({ start: lastEnd, end: addMinutes(lastEnd, 30) });
        });
        render(); onChange();
      });
    }
    render();
  }
  window.WeekHoursEditor = { mount };
})();
