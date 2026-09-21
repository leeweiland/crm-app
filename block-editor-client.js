// Drag-and-drop email block editor -- shared by campaign-builder.html and
// the automation "send email" step's config panel, so it's built once, not
// twice. Mirrors block_editor_shared.js's render algorithm by hand (this
// file runs in the browser, that one's an ESM server module) so the live
// preview always matches what actually gets sent.
window.BlockEditor = (function () {
  function uid() { return 'b' + Math.random().toString(36).slice(2, 10); }

  // Mirrors block_editor_shared.js's DEFAULT_THEME by hand (this file can't
  // import that server module) -- keeps a theme-less email rendering
  // identically in both the editor's own canvas and the actual sent HTML.
  const DEFAULT_THEME = {
    background: '#ffffff', maxWidth: 650, fontFamily: 'Arial, Helvetica, sans-serif',
    fontSize: 16, textColor: '#222222', linkColor: '#009bff', lineHeight: 1.5, bodyPadding: 24,
  };

  // One consistent line-icon language (Feather-style: 16x16, currentColor
  // stroke) everywhere the editor used to mix Unicode arrows with colorful
  // emoji (camera, radio button) -- the emoji in particular rendered taller
  // than their button's fixed padding could contain, which is why they
  // looked "cut off" as well as visually mismatched.
  const ICON = {
    grip: '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><circle cx="5" cy="3" r="1.3"/><circle cx="11" cy="3" r="1.3"/><circle cx="5" cy="8" r="1.3"/><circle cx="11" cy="8" r="1.3"/><circle cx="5" cy="13" r="1.3"/><circle cx="11" cy="13" r="1.3"/></svg>',
    up: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg>',
    down: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>',
    close: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
    image: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>',
    button: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="7" width="18" height="10" rx="3"/></svg>',
    text: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 7 4 4 20 4 20 7"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/></svg>',
    gear: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
    alignLeft: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="15" y2="12"/><line x1="3" y1="18" x2="18" y2="18"/></svg>',
    alignCenter: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="7" y1="12" x2="17" y2="12"/><line x1="5" y1="18" x2="19" y2="18"/></svg>',
    alignRight: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="9" y1="12" x2="21" y2="12"/><line x1="6" y1="18" x2="21" y2="18"/></svg>',
  };

  function styleAttr(style) {
    if (!style) return '';
    const parts = [];
    if (style.background) parts.push(`background:${style.background}`);
    if (style.border) parts.push(`border:${style.border}`);
    if (style.margin) parts.push(`margin:${style.margin}`);
    if (style.padding) parts.push(`padding:${style.padding}`);
    if (style.textAlign) parts.push(`text-align:${style.textAlign}`);
    return parts.length ? ` style="${parts.join(';')}"` : '';
  }
  // Client copy of block_editor_shared.js's cleanPastedHtml -- see its comment
  // for why (pasted ActiveCampaign HTML carries invalid --tw-* style
  // declarations that mail clients punish by dropping the whole style attribute).
  function cleanPastedHtml(html) {
    if (!html) return '';
    return String(html)
      .replace(/<!--\s*(?:Start|End)Fragment\s*-->/gi, '')
      .replace(/\s(?:class="ac-designer-copy"|readability="[^"]*")/gi, '')
      .replace(/\sstyle\s*=\s*(["'])([\s\S]*?)\1/gi, (m, q, v) => {
        if (!v.includes('--') || /url\(/i.test(v)) return m;
        const kept = v.split(';').map(d => d.trim()).filter(d => d && !d.startsWith('--'));
        return kept.length ? ` style=${q}${kept.join('; ')}${q}` : '';
      });
  }
  function renderBlockHtml(block) {
    if (block.type === 'text') return `<div${styleAttr(block.style)}>${cleanPastedHtml(block.html)}</div>`;
    if (block.type === 'image') {
      const img = `<img src="${block.src || ''}" width="${block.width || 600}" style="max-width:100%;display:inline-block;border:0"/>`;
      return `<div${styleAttr(block.style)}>${block.link ? `<a href="${block.link}">${img}</a>` : img}</div>`;
    }
    if (block.type === 'button') {
      return `<div${styleAttr(block.style)}><a href="${block.link || '#'}" style="display:inline-block;background:#009bff;color:#fff;padding:12px 26px;border-radius:6px;text-decoration:none;font-weight:bold;font-family:sans-serif">${block.text || 'Click here'}</a></div>`;
    }
    return '';
  }
  function renderBlocksToHtml(blocks, theme) {
    const t = { ...DEFAULT_THEME, ...(theme || {}) };
    const body = (blocks || []).map(renderBlockHtml).join('');
    return `<div style="background:${t.background};padding:${t.bodyPadding}px 0;font-family:${t.fontFamily};font-size:${t.fontSize}px;line-height:${t.lineHeight};color:${t.textColor}"><div style="max-width:${t.maxWidth}px;margin:0 auto;background:#ffffff">${body}</div></div>`;
  }

  // ── Hex-first color picker ─────────────────────────────────────────────
  // A native <input type="color"> opens the browser's own picker, which no
  // page can control the layout of -- Chrome's always opens on RGB, burying
  // hex behind a format toggle. So clicking a swatch opens this instead: a hex
  // box first (focused, ready to type or paste), then a saturation/brightness
  // square and hue bar, plus an eyedropper where the browser has one. The
  // native <input type="color"> stays in the DOM as the value store/event
  // source (it also draws the swatch), so everything that reads or sets
  // swatch.value keeps working untouched.
  const EYE_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m2 22 1-1h3l9-9"/><path d="M3 21v-3l9-9"/><path d="m15 6 3.4-3.4a2.1 2.1 0 1 1 3 3L18 9l.4.4a2.1 2.1 0 1 1-3 3l-3.8-3.8a2.1 2.1 0 1 1 3-3l.4.4Z"/></svg>';
  function normalizeHex(str) {
    let s = String(str || '').trim().toLowerCase();
    if (!s) return null;
    if (s[0] !== '#') s = '#' + s;
    if (/^#[0-9a-f]{3}$/.test(s)) s = '#' + s[1] + s[1] + s[2] + s[2] + s[3] + s[3];
    return /^#[0-9a-f]{6}$/.test(s) ? s : null;
  }
  function hexToHsv(hex) {
    const n = parseInt(hex.slice(1), 16);
    const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
    const max = Math.max(r, g, b), d = max - Math.min(r, g, b);
    let h = 0;
    if (d) {
      if (max === r) h = ((g - b) / d) % 6;
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60; if (h < 0) h += 360;
    }
    return [h, max ? d / max : 0, max];
  }
  function hsvToHex(h, s, v) {
    const f = (n) => { const k = (n + h / 60) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
    return '#' + [f(5), f(3), f(1)].map(x => Math.round(x * 255).toString(16).padStart(2, '0')).join('');
  }

  let colorPicker = null; // { swatch, close(applyPending) } for the one picker that can be open at a time
  function closeColorPicker(applyPending) { if (colorPicker) colorPicker.close(applyPending); }

  // restoreSelection: for the text-color swatch, whose result is applied with
  // document.execCommand -- that acts on the editor's selection, which moves
  // when the hex box takes focus, so the selection is snapshotted on open and
  // put back right before each apply. Off for every other swatch: putting the
  // editor selection back there would fire selectionchange and overwrite
  // whatever was just typed into the Link URL field.
  function openColorPicker(swatch, restoreSelection) {
    closeColorPicker(false);
    let hex = normalizeHex(swatch.value) || '#000000';
    let [h, s, v] = hexToHsv(hex);
    const editableOf = (node) => { const el = node && (node.nodeType === 1 ? node : node.parentElement); return el ? el.closest('[contenteditable="true"]') : null; };
    const grabRange = () => { const sel = window.getSelection(); return restoreSelection && sel.rangeCount && editableOf(sel.anchorNode) ? sel.getRangeAt(0).cloneRange() : null; };
    let snap = grabRange();
    let pending = null;     // a typed hex that hasn't been applied yet
    let lastApplied = null;

    const pop = document.createElement('div');
    pop.className = 'be-cp';
    pop.innerHTML = `
      <div class="be-cp-hexrow">
        <input type="text" class="be-cp-hex" maxlength="7" spellcheck="false" autocomplete="off" aria-label="Hex color" placeholder="#000000"/>
        ${window.EyeDropper ? `<button type="button" class="be-cp-eye" title="Pick a color from the screen">${EYE_ICON}</button>` : ''}
      </div>
      <div class="be-cp-sv"><div class="be-cp-knob"></div></div>
      <div class="be-cp-hue"><div class="be-cp-knob"></div></div>`;
    document.body.appendChild(pop);
    const hexInput = pop.querySelector('.be-cp-hex');
    const sv = pop.querySelector('.be-cp-sv'), svKnob = sv.querySelector('.be-cp-knob');
    const hue = pop.querySelector('.be-cp-hue'), hueKnob = hue.querySelector('.be-cp-knob');

    // leaveHexBox: the hex box's own typing handler passes true so repainting
    // doesn't rewrite (and re-format) what the user is in the middle of typing;
    // every other repaint (dragging, eyedropper, first open) refreshes it.
    function paint(shownHex, leaveHexBox) {
      hex = shownHex || hsvToHex(h, s, v);
      sv.style.background = `linear-gradient(to top,#000,transparent),linear-gradient(to right,#fff,hsl(${h},100%,50%))`;
      svKnob.style.left = (s * 100) + '%'; svKnob.style.top = ((1 - v) * 100) + '%'; svKnob.style.background = hex;
      hueKnob.style.left = (h / 360 * 100) + '%'; hueKnob.style.background = `hsl(${h},100%,50%)`;
      if (!leaveHexBox) hexInput.value = hex;
    }
    function setFromHex(nh) {
      const [nh_h, nh_s, nh_v] = hexToHsv(nh);
      if (nh_s > 0 && nh_v > 0) h = nh_h; // a gray/black has no hue of its own -- keep the current one so the hue bar doesn't jump to red
      s = nh_s; v = nh_v;
    }
    function applyColor(value) {
      if (snap) { const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(snap); }
      swatch.value = value;
      swatch.dispatchEvent(new Event('input', { bubbles: true }));
      snap = grabRange() || snap; // execCommand may have rewritten the DOM under the old range
      pending = null;
      lastApplied = value;
    }

    // Square/bar drags update the picker live and apply once on release --
    // applying on every pointermove would fire execCommand hundreds of times
    // per drag for the text-color swatch.
    function dragOn(el, onPos) {
      const pos = (e) => { const r = el.getBoundingClientRect(); onPos(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))); paint(); };
      el.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        el.setPointerCapture(e.pointerId);
        pos(e);
        const up = () => { el.removeEventListener('pointermove', pos); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up); applyColor(hex); };
        el.addEventListener('pointermove', pos); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
      });
    }
    dragOn(sv, (x, y) => { s = x; v = 1 - y; });
    dragOn(hue, (x) => { h = x * 360; });

    hexInput.addEventListener('input', () => {
      const nh = normalizeHex(hexInput.value);
      if (nh) { pending = nh; setFromHex(nh); paint(nh, true); }
    });
    // Typed hex applies on Enter or when the picker closes, not per keystroke:
    // applying restores the editor selection, which pulls focus out of this
    // box mid-typing and would send the next Backspace into the email text.
    hexInput.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      close(true);
    });
    const eye = pop.querySelector('.be-cp-eye');
    if (eye) eye.addEventListener('click', async () => {
      try {
        const nh = normalizeHex((await new EyeDropper().open()).sRGBHex);
        if (nh) { setFromHex(nh); paint(nh); applyColor(nh); }
      } catch { /* picking was cancelled */ }
    });
    // Keep the editor's focus/selection for every pointer interaction except
    // clicking into the hex box itself.
    pop.addEventListener('mousedown', (e) => { if (e.target !== hexInput) e.preventDefault(); });

    const onDocDown = (e) => { if (!pop.contains(e.target) && e.target !== swatch) close(true); };
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(false); } };
    const onScroll = (e) => { if (!pop.contains(e.target)) close(true); };
    document.addEventListener('mousedown', onDocDown, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    function close(applyPending) {
      if (applyPending && pending && pending !== lastApplied) applyColor(pending);
      pop.remove();
      document.removeEventListener('mousedown', onDocDown, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
      colorPicker = null;
    }
    colorPicker = { swatch, close };

    paint(hex);
    const rect = swatch.getBoundingClientRect();
    pop.style.left = Math.min(Math.max(8, rect.left), window.innerWidth - pop.offsetWidth - 8) + 'px';
    let top = rect.bottom + 6;
    if (top + pop.offsetHeight > window.innerHeight - 8) top = Math.max(8, rect.top - pop.offsetHeight - 6);
    pop.style.top = top + 'px';
    hexInput.focus();
    hexInput.select();
  }

  // Pairs a plain hex text field (typed or pasted -- the primary way to set a
  // color) with the swatch that opens the picker above, synced both ways.
  function hexColorFieldHtml(id, value) {
    const swatchVal = /^#[0-9a-fA-F]{6}$/.test(value || '') ? value : '#000000';
    return `<span class="be-hex-color"><input type="text" class="pra-input" id="${id}" placeholder="#000000" value="${value || ''}" maxlength="7"/><input type="color" id="${id}Swatch" tabindex="-1" value="${swatchVal}"/></span>`;
  }
  function wireHexColorField(scope, id, onChange, opts) {
    const text = scope.querySelector('#' + id);
    const swatch = scope.querySelector('#' + id + 'Swatch');
    const commit = (v) => { if (/^#[0-9a-fA-F]{6}$/i.test(v)) { swatch.value = v; onChange(v); } };
    text.addEventListener('input', () => commit(text.value.trim()));
    swatch.addEventListener('input', () => { text.value = swatch.value; onChange(swatch.value); });
    // mousedown is blocked so clicking the swatch doesn't pull focus/selection
    // out of the editor; click is blocked so the browser's own picker never opens.
    swatch.addEventListener('mousedown', (e) => e.preventDefault());
    swatch.addEventListener('click', (e) => {
      e.preventDefault();
      if (colorPicker && colorPicker.swatch === swatch) closeColorPicker(true);
      else openColorPicker(swatch, !!(opts && opts.restoreSelection));
    });
    return text;
  }

  // Rewrites every run of blank lines inside `root` (in place) to one gap
  // size, and zeroes <p> margins. Pasted content (Google Docs especially)
  // ends up with the gap doubled: Docs separates paragraphs with a <br>
  // blank line AND gives each <p> margin:0pt, which the paste handler strips
  // along with all other margins -- so browser-default <p> margins come back
  // on top of the blank line. mode: 'none' | 'small' | 'line'.
  const BLOCK_TAGS = new Set(['P', 'DIV', 'UL', 'OL', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'TABLE', 'HR']);
  const isBlankText = (t) => !t.replace(/[\s ​]/g, '');
  function isEmptyBlock(el) {
    if (el.nodeType !== 1 || (el.tagName !== 'P' && el.tagName !== 'DIV')) return false;
    if (el.querySelector('img,hr,table,ul,ol,a,iframe')) return false;
    return isBlankText(el.textContent);
  }
  function normalizeBlankLines(root, mode) {
    // Docs wraps everything in one inline <b>/<span id="docs-internal-guid-*">
    // containing block-level <p>s; re-inserting that as-is makes the browser
    // split the wrapper and leave stray empty <p>s (with default margins).
    root.querySelectorAll('[id^="docs-internal-guid"]').forEach(w => w.replaceWith(...w.childNodes));
    root.querySelectorAll('p').forEach(p => { p.style.margin = '0'; });
    const gapNode = (kind) => {
      const d = document.createElement('div');
      if (kind === 'small') { d.style.cssText = 'height:8px;line-height:8px;font-size:8px'; d.innerHTML = '&nbsp;'; }
      else d.innerHTML = '<br>';
      return d;
    };
    (function process(container) {
      // Children first, so wrappers (e.g. Docs' <span id="docs-internal-guid">
      // around all its <p>s) get their own runs handled at their own level.
      [...container.children].forEach(child => { if (!isEmptyBlock(child) && child.tagName !== 'BR') process(child); });
      const kids = [...container.childNodes];
      const kindOf = (n) => (n.nodeType === 1 && (n.tagName === 'BR' || isEmptyBlock(n))) ? 'blank' : (n.nodeType === 3 && isBlankText(n.textContent)) ? 'ws' : 'other';
      let i = 0;
      while (i < kids.length) {
        if (kindOf(kids[i]) !== 'blank') { i++; continue; }
        // Extend the run over blanks and whitespace-only text between them.
        let j = i, lastBlank = i;
        while (j < kids.length && kindOf(kids[j]) !== 'other') { if (kindOf(kids[j]) === 'blank') lastBlank = j; j++; }
        const run = kids.slice(i, lastBlank + 1);
        const prev = kids.slice(0, i).reverse().find(n => kindOf(n) !== 'ws') || null;
        const next = kids.slice(lastBlank + 1).find(n => kindOf(n) !== 'ws') || null;
        const prevIsBlock = !prev || (prev.nodeType === 1 && BLOCK_TAGS.has(prev.tagName));
        const brCount = run.filter(n => n.tagName === 'BR').length;
        const emptyBlocks = run.filter(n => n.tagName !== 'BR' && n.nodeType === 1).length;
        // After inline text, a leading <br> just ends that line -- only the
        // ones beyond it are blank lines. (A lone <br> between two words is
        // an ordinary line break and is left completely alone.)
        const terminator = !prevIsBlock && run[0].tagName === 'BR';
        const lines = brCount - (terminator ? 1 : 0) + emptyBlocks;
        if (lines > 0) {
          const anchor = run[run.length - 1].nextSibling;
          run.forEach(n => n.remove());
          // Leading/trailing blank lines are just wasted space (the block's
          // own padding handles distance to its neighbours).
          if (prev && next && mode !== 'none') {
            if (terminator) container.insertBefore(document.createElement('br'), anchor);
            if (terminator && mode === 'line') container.insertBefore(document.createElement('br'), anchor);
            else container.insertBefore(gapNode(mode), anchor);
          } else if (prev && next && terminator) {
            container.insertBefore(document.createElement('br'), anchor);
          }
        }
        i = lastBlank + 1;
      }
    })(root);
  }

  // initialState: { blocks: [...], theme: {background, maxWidth} }
  // onChange receives the full { blocks, theme } state on every body edit.
  // onFooterChange (optional) receives { blocks: footerBlocks } on every
  // footer edit -- kept separate from onChange since footer content isn't
  // part of this campaign/step's own saved state, it belongs to the shared
  // footer template (see setFooter/getFooterState below).
  // opts.extraPersonalizeOptions (optional): [{value, label}] appended to
  // the Personalize dropdown below the built-in contact tokens -- lets a
  // caller outside the campaign/automation context (e.g. booking
  // confirmations) offer its own tokens through the same UI.
  function init(rootEl, initialState, onChange, onFooterChange, opts) {
    initialState = initialState || {};
    opts = opts || {};
    let blocks = (initialState.blocks || []).map(b => ({ ...b, id: b.id || uid() }));
    let theme = { ...DEFAULT_THEME, ...(initialState.theme || {}) };
    let selectedId = null;
    let showingThemePanel = false;
    let footerBlocks = [];
    let footerMeta = null; // {id, name, ...} set via setFooter() -- null means "no footer selected"
    let footerDirty = false;
    let allTags = [];
    let dragSourceId = null;   // set when dragging an existing block's handle (reorder)
    let draggingNewType = null; // set when dragging a palette item (insert)

    // Body blocks and footer blocks are two separate arrays edited by the
    // same UI -- this is the one place that knows how to find a block by id
    // regardless of which array it lives in, so the rest of the file doesn't
    // need an if/else at every lookup.
    function findBlock(id) {
      let idx = blocks.findIndex(b => b.id === id);
      if (idx !== -1) return { block: blocks[idx], array: blocks, index: idx, isFooter: false };
      idx = footerBlocks.findIndex(b => b.id === id);
      if (idx !== -1) return { block: footerBlocks[idx], array: footerBlocks, index: idx, isFooter: true };
      return { block: null, array: null, index: -1, isFooter: false };
    }
    function notifyChange(isFooter) {
      if (isFooter) { footerDirty = true; if (onFooterChange) onFooterChange({ blocks: footerBlocks }); }
      else if (onChange) onChange({ blocks, theme });
    }

    // Shared by both upload entry points (the sidebar's Upload Image button
    // and clicking directly on the image block in the canvas) so there's
    // one upload code path instead of two copies drifting apart.
    function uploadImageFile(file, onStart, onDone) {
      if (!file) return;
      if (onStart) onStart();
      const reader = new FileReader();
      reader.onload = () => {
        fetch('/api/uploads/image', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dataUrl: reader.result }),
        })
          .then(r => r.json().then(d => ({ ok: r.ok, d })))
          .then(({ ok, d }) => onDone(ok ? null : (d.error || 'Upload failed'), ok ? d.url : null))
          .catch(() => onDone('Upload failed', null));
      };
      reader.readAsDataURL(file);
    }

    function newBlock(type) {
      return type === 'text' ? { id: uid(), type, html: 'New text block', style: {} }
        : type === 'image' ? { id: uid(), type, src: '', link: '', width: 600, style: {}, linkAction: null }
        : { id: uid(), type, text: 'Click here', link: '', style: { textAlign: 'center' }, linkAction: null };
    }
    function selectBlock(block) {
      showingThemePanel = false;
      selectedId = block.id;
      toolbar.style.display = block.type === 'text' ? 'flex' : 'none';
      render(); renderStylePanel();
      notifyChange(footerBlocks.some(fb => fb.id === block.id));
    }

    fetch('/api/tags').then(r => r.json()).then(d => { allTags = d.tags || []; if (selectedId) renderStylePanel(); }).catch(() => {});

    rootEl.innerHTML = `
      <div class="be-shell">
        <div class="be-canvas-wrap">
          <div class="be-toolbar" id="beToolbar" style="display:none">
            <button type="button" data-cmd="bold"><b>B</b></button>
            <button type="button" data-cmd="italic"><i>I</i></button>
            <button type="button" data-cmd="underline"><u>U</u></button>
            <button type="button" data-cmd="justifyLeft">${ICON.alignLeft}</button>
            <button type="button" data-cmd="justifyCenter">${ICON.alignCenter}</button>
            <button type="button" data-cmd="justifyRight">${ICON.alignRight}</button>
            ${hexColorFieldHtml('beColor', '')}
            <select id="beFontFamily" title="Font">
              <option value="">Font...</option>
              <option value="Arial, Helvetica, sans-serif">Arial</option>
              <option value="'Century Gothic', 'Apple Gothic', sans-serif">Century Gothic</option>
              <option value="'Century Gothic Bold', 'Century Gothic', sans-serif" style="font-weight:bold">Century Gothic Bold</option>
              <option value="Aldrich, Arial, sans-serif">Aldrich</option>
            </select>
            <select id="beFontSize" title="Font size"><option value="">Size...</option><option value="8">8</option><option value="10">10</option><option value="12">12</option><option value="14">14</option><option value="16">16</option><option value="18">18</option><option value="20">20</option><option value="24">24</option><option value="28">28</option><option value="32">32</option><option value="36">36</option><option value="48">48</option></select>
            <select id="beSpacing" title="Gaps between paragraphs -- fixes doubled blank lines from pasted text (applies to this whole text block)"><option value="">Spacing...</option><option value="none">No gaps</option><option value="small">Small gaps</option><option value="line">One blank line</option></select>
            <select id="bePersonalize"><option value="">Personalize...</option><option value="%FIRSTNAME%">First name</option><option value="%LASTNAME%">Last name</option><option value="%EMAIL%">Email</option><option value="%UNSUBSCRIBE%">Unsubscribe link</option>${(opts.extraPersonalizeOptions || []).map(o => `<option value="${o.value}">${o.label}</option>`).join('')}</select>
            <span class="be-link-popover" id="beLinkPopover">
              <input type="text" id="beLinkUrl" placeholder="Link URL (select text first)" title="Type or paste a URL -- it's applied to the selected text automatically. Clear it to remove the link."/>
              ${hexColorFieldHtml('beLinkColor', '')}
            </span>
          </div>
          <div class="be-canvas-toprow">
            <button type="button" class="pra-btn pra-btn-ghost pra-btn-sm" id="beThemeBtn">${ICON.gear} Email Settings</button>
          </div>
          <div class="be-canvas" id="beCanvas">
            <div class="be-canvas-inner" id="beCanvasInner"></div>
          </div>
        </div>
        <div class="be-side-panel">
          <div class="be-palette-panel">
            <div class="pra-label" style="margin-bottom:8px">Drag onto the email, or click to add at the end</div>
            <div class="be-add-row">
              <button type="button" class="pra-btn pra-btn-ghost pra-btn-sm be-palette-item" draggable="true" data-add="text">${ICON.text} Text</button>
              <button type="button" class="pra-btn pra-btn-ghost pra-btn-sm be-palette-item" draggable="true" data-add="image">${ICON.image} Image</button>
              <button type="button" class="pra-btn pra-btn-ghost pra-btn-sm be-palette-item" draggable="true" data-add="button">${ICON.button} Button</button>
            </div>
          </div>
          <div class="be-style-panel" id="beStylePanel"></div>
        </div>
      </div>
    `;

    const canvas = rootEl.querySelector('#beCanvas');
    const canvasInner = rootEl.querySelector('#beCanvasInner');
    const stylePanel = rootEl.querySelector('#beStylePanel');
    const toolbar = rootEl.querySelector('#beToolbar');

    function renderStylePanel() {
      if (showingThemePanel) {
        stylePanel.innerHTML = `
          <div class="pra-label" style="margin-bottom:8px">Email Settings</div>
          <div class="field"><label class="pra-label">Background</label>${hexColorFieldHtml('themeBg', theme.background)}</div>
          <div class="field"><label class="pra-label">Content Width (px)</label><input class="pra-input" type="number" id="themeWidth" value="${theme.maxWidth}"/></div>
          <div class="field"><label class="pra-label">Font</label>
            <select class="pra-select" id="themeFontFamily">
              <option value="Arial, Helvetica, sans-serif">Arial</option>
              <option value="'Century Gothic', 'Apple Gothic', sans-serif">Century Gothic</option>
              <option value="'Century Gothic Bold', 'Century Gothic', sans-serif">Century Gothic Bold</option>
              <option value="Aldrich, Arial, sans-serif">Aldrich</option>
            </select>
          </div>
          <div class="field"><label class="pra-label">Font Size (px)</label><input class="pra-input" type="number" id="themeFontSize" value="${theme.fontSize}"/></div>
          <div class="field"><label class="pra-label">Text Color</label>${hexColorFieldHtml('themeTextColor', theme.textColor)}</div>
          <div class="field"><label class="pra-label">Link Color</label>${hexColorFieldHtml('themeLinkColor', theme.linkColor)}</div>
          <div class="field"><label class="pra-label">Padding (px)</label><input class="pra-input" type="number" id="themeBodyPadding" value="${theme.bodyPadding}"/></div>
          <button type="button" class="pra-btn pra-btn-ghost pra-btn-sm" id="themeResetBtn" style="width:100%;margin-top:6px">Reset to default</button>
          <div class="pra-muted" id="themeResetMsg" style="font-size:.74rem;margin-top:4px;min-height:1em"></div>
        `;
        wireHexColorField(stylePanel, 'themeBg', (v) => { theme.background = v; renderPreviewBg(); notifyChange(false); });
        wireHexColorField(stylePanel, 'themeTextColor', (v) => { theme.textColor = v; render(); notifyChange(false); });
        wireHexColorField(stylePanel, 'themeLinkColor', (v) => { theme.linkColor = v; render(); notifyChange(false); });
        stylePanel.querySelector('#themeWidth').addEventListener('input', (e) => { theme.maxWidth = Number(e.target.value) || 650; render(); notifyChange(false); });
        stylePanel.querySelector('#themeFontSize').addEventListener('input', (e) => { theme.fontSize = Number(e.target.value) || DEFAULT_THEME.fontSize; render(); notifyChange(false); });
        stylePanel.querySelector('#themeBodyPadding').addEventListener('input', (e) => { theme.bodyPadding = Number(e.target.value) || 0; notifyChange(false); });
        const fontSel = stylePanel.querySelector('#themeFontFamily');
        fontSel.value = theme.fontFamily;
        if (fontSel.value !== theme.fontFamily) { const opt = document.createElement('option'); opt.value = theme.fontFamily; opt.textContent = theme.fontFamily; fontSel.insertBefore(opt, fontSel.firstChild); fontSel.value = theme.fontFamily; }
        fontSel.addEventListener('change', (e) => { theme.fontFamily = e.target.value; render(); notifyChange(false); });
        stylePanel.querySelector('#themeResetBtn').addEventListener('click', async () => {
          const msg = stylePanel.querySelector('#themeResetMsg');
          msg.textContent = 'Loading...';
          try {
            const r = await fetch('/api/integrations/email-theme');
            const d = await r.json();
            theme = { ...DEFAULT_THEME, ...d.theme };
            render(); renderStylePanel(); notifyChange(false);
          } catch { msg.textContent = 'Could not load the default theme.'; }
        });
        return;
      }
      const { block, isFooter } = findBlock(selectedId);
      if (!block) { stylePanel.innerHTML = '<div class="pra-muted" style="font-size:.82rem">Select a block to edit its style, or click Email Settings above.</div>'; return; }
      const s = block.style || {};
      const linkAction = block.linkAction || null;
      stylePanel.innerHTML = `
        ${isFooter ? '<div class="pra-muted" style="font-size:.76rem;margin-bottom:10px">Editing a footer block -- see the Footer panel to save these changes.</div>' : ''}
        <div class="pra-label" style="margin-bottom:8px">Block Style</div>
        <div class="field"><label class="pra-label">Alignment</label>
          <div style="display:flex;gap:6px">
            <button type="button" class="pra-btn pra-btn-ghost pra-btn-sm" data-align="left">${ICON.alignLeft}</button>
            <button type="button" class="pra-btn pra-btn-ghost pra-btn-sm" data-align="center">${ICON.alignCenter}</button>
            <button type="button" class="pra-btn pra-btn-ghost pra-btn-sm" data-align="right">${ICON.alignRight}</button>
          </div>
        </div>
        <div class="field"><label class="pra-label">Background</label><input class="pra-input" type="text" id="styleBg" placeholder="#ffffff" value="${s.background || ''}"/></div>
        <div class="field"><label class="pra-label">Border</label><input class="pra-input" type="text" id="styleBorder" placeholder="1px solid #eee" value="${s.border || ''}"/></div>
        <div class="field"><label class="pra-label">Padding</label><input class="pra-input" type="text" id="stylePadding" placeholder="10px" value="${s.padding || ''}"/></div>
        ${block.type === 'image' ? `
          <div class="field">
            <label class="pra-label">Image</label>
            ${block.src ? `<img src="${block.src}" style="max-width:100%;border-radius:4px;margin-bottom:6px;display:block"/>` : ''}
            <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" id="imgUpload" style="display:none"/>
            <button type="button" class="pra-btn pra-btn-ghost pra-btn-sm" id="imgUploadBtn" style="width:100%">Upload Image</button>
            <div class="pra-muted" id="imgUploadStatus" style="font-size:.72rem;margin-top:4px;min-height:1em"></div>
          </div>
          <div class="field"><label class="pra-label">Image URL</label><input class="pra-input" type="text" id="imgSrc" value="${block.src || ''}"/></div>
          <div class="field"><label class="pra-label">Link (optional)</label><input class="pra-input" type="text" id="imgLink" value="${block.link || ''}"/></div>
          <div class="field"><label class="pra-label">Width (px)</label><input class="pra-input" type="number" id="imgWidth" value="${block.width || 600}"/></div>
        ` : ''}
        ${block.type === 'button' ? `
          <div class="field"><label class="pra-label">Button text</label><input class="pra-input" type="text" id="btnText" value="${block.text || ''}"/></div>
          <div class="field"><label class="pra-label">Link URL</label><input class="pra-input" type="text" id="btnLink" value="${block.link || ''}"/></div>
        ` : ''}
        ${block.type === 'image' || block.type === 'button' ? `
          <div class="field"><label class="pra-label">When clicked</label>
            <select class="pra-select" id="linkActionType">
              <option value="">Just open the link</option>
              <option value="add_tag" ${linkAction?.type === 'add_tag' ? 'selected' : ''}>Add a tag</option>
            </select>
          </div>
          <div class="field" id="linkActionTagField" style="${linkAction?.type === 'add_tag' ? '' : 'display:none'}">
            <label class="pra-label">Tag</label>
            <select class="pra-select" id="linkActionTag">${allTags.map(t => `<option value="${t.id}" ${linkAction?.tagId === t.id ? 'selected' : ''}>${t.name}</option>`).join('')}</select>
          </div>
        ` : ''}
      `;
      const bind = (id, key, target) => { const el = stylePanel.querySelector('#' + id); if (el) el.addEventListener('input', () => { target[key] = el.value; render(); notifyChange(isFooter); }); };
      bind('styleBg', 'background', block.style = block.style || {});
      bind('styleBorder', 'border', block.style);
      bind('stylePadding', 'padding', block.style);
      if (block.type === 'image') {
        bind('imgSrc', 'src', block); bind('imgLink', 'link', block); bind('imgWidth', 'width', block);
        const uploadBtn = stylePanel.querySelector('#imgUploadBtn');
        const uploadInput = stylePanel.querySelector('#imgUpload');
        const uploadStatus = stylePanel.querySelector('#imgUploadStatus');
        uploadBtn.addEventListener('click', () => uploadInput.click());
        uploadInput.addEventListener('change', () => {
          uploadImageFile(uploadInput.files[0],
            () => { uploadStatus.textContent = 'Uploading...'; },
            (err, url) => {
              if (err) { uploadStatus.textContent = err; return; }
              block.src = url;
              uploadStatus.textContent = 'Uploaded.';
              render(); renderStylePanel(); notifyChange(isFooter);
            });
        });
      }
      if (block.type === 'button') { bind('btnText', 'text', block); bind('btnLink', 'link', block); }
      stylePanel.querySelectorAll('[data-align]').forEach(btn => btn.onclick = () => { block.style = block.style || {}; block.style.textAlign = btn.dataset.align; render(); notifyChange(isFooter); });
      const actionTypeSel = stylePanel.querySelector('#linkActionType');
      const tagField = stylePanel.querySelector('#linkActionTagField');
      if (actionTypeSel) {
        actionTypeSel.addEventListener('change', () => {
          if (!actionTypeSel.value) { block.linkAction = null; tagField.style.display = 'none'; }
          else { block.linkAction = { type: actionTypeSel.value, tagId: allTags[0]?.id || null }; tagField.style.display = ''; }
          notifyChange(isFooter);
        });
        const tagSel = stylePanel.querySelector('#linkActionTag');
        if (tagSel) tagSel.addEventListener('change', () => { block.linkAction = { type: 'add_tag', tagId: tagSel.value }; notifyChange(isFooter); });
      }
    }

    // Mirrors block_editor_shared.js's actual structure -- a themed outer
    // strip around a fixed-width WHITE content card -- so the live editor
    // never shows something the real send wouldn't (the earlier version
    // colored the entire canvas with theme.background, which made default
    // dark block text invisible the moment someone picked a dark theme
    // color, since there was no white card underneath it like the real
    // email has).
    function renderPreviewBg() {
      canvas.style.background = theme.background;
    }

    // A drop-zone is a thin bar between blocks (and one before the first,
    // one after the last) -- this is what makes drag-and-drop actually
    // position-accurate, matching AC's builder, instead of just swapping
    // with whatever block you happen to drop on. Body blocks only -- footer
    // blocks use simple up/down + add-row buttons instead (see
    // footerSectionHtml), a deliberately smaller interaction since a
    // footer's a handful of blocks at most, not a whole email layout.
    function dropZoneHtml(index) {
      return `<div class="be-dropzone" data-zone="${index}">
        <div class="be-dropzone-add" data-zone-add="${index}">
          <button type="button" data-zone-add-type="text" data-zone="${index}" title="Add text">${ICON.text}</button>
          <button type="button" data-zone-add-type="image" data-zone="${index}" title="Add image">${ICON.image}</button>
          <button type="button" data-zone-add-type="button" data-zone="${index}" title="Add button">${ICON.button}</button>
        </div>
      </div>`;
    }

    // Image blocks get an editor-only affordance renderBlockHtml() can't
    // provide (that function's output has to stay identical to the real
    // send-time HTML) -- an empty block shows a click-to-upload placeholder.
    // A filled block renders plain: clicking it just selects the block (via
    // the block-level click handler below) so the sidebar's Image fields
    // show up; only the sidebar's own Upload Image button re-uploads it.
    function blockBodyPreviewHtml(b) {
      if (b.type !== 'image') return renderBlockHtml(b);
      if (!b.src) return `<div class="be-image-upload-placeholder" data-upload-for="${b.id}">${ICON.image}<span>Click to upload image</span></div>`;
      return renderBlockHtml(b);
    }

    // Footer content is now genuinely editable here (not just a read-only
    // preview) -- same block markup/behavior as the body (click-to-edit
    // text, click-to-upload images, style panel), just without drag/drop
    // reordering. footerMeta is set via setFooter() by the host page
    // (campaign-builder.html / automation-builder.html), which also owns
    // deciding whether edits get PATCHed back to the shared footer template
    // or saved as a new one -- see getFooterState().
    function footerSectionHtml() {
      if (!footerMeta) return '';
      const blocksHtml = footerBlocks.map((b, i) => `
        <div class="be-block be-footer-block${b.id === selectedId && !showingThemePanel ? ' selected' : ''}" data-id="${b.id}">
          <div class="be-block-actions">
            <button type="button" data-move="up" data-id="${b.id}" title="Move up" ${i === 0 ? 'disabled' : ''}>${ICON.up}</button>
            <button type="button" data-move="down" data-id="${b.id}" title="Move down" ${i === footerBlocks.length - 1 ? 'disabled' : ''}>${ICON.down}</button>
            <button type="button" data-remove="${b.id}" title="Delete">${ICON.close}</button>
          </div>
          <div class="be-block-body" data-id="${b.id}" ${b.type === 'text' ? 'contenteditable="true"' : ''}>${blockBodyPreviewHtml(b)}</div>
        </div>
      `).join('');
      return `
        <div class="be-footer-section">
          <div class="be-footer-preview-label">Footer &mdash; ${footerMeta.name || 'Untitled'}</div>
          ${blocksHtml || '<div class="be-footer-empty">No footer content blocks yet -- add one below.</div>'}
          <div class="be-footer-add-row">
            <button type="button" class="be-footer-add-btn" data-footer-add="text">${ICON.text} Text</button>
            <button type="button" class="be-footer-add-btn" data-footer-add="image">${ICON.image} Image</button>
            <button type="button" class="be-footer-add-btn" data-footer-add="button">${ICON.button} Button</button>
          </div>
        </div>
      `;
    }

    function render() {
      canvasInner.style.maxWidth = theme.maxWidth + 'px';
      canvasInner.style.fontFamily = theme.fontFamily;
      canvasInner.style.fontSize = theme.fontSize + 'px';
      canvasInner.style.lineHeight = theme.lineHeight;
      canvasInner.style.color = theme.textColor;
      // Baseline for any link that hasn't been given its own explicit color
      // (see .be-canvas-inner a in crm-design-system.css) -- an inline
      // color from the Link popover still wins since inline styles always
      // beat a stylesheet rule, matching applyDefaultLinkColor's same
      // "only touch links without their own color" logic at send time.
      canvasInner.style.setProperty('--be-link-color', theme.linkColor);
      renderPreviewBg();
      const blockHtml = blocks.map((b, i) => `
        <div class="be-block${b.id === selectedId && !showingThemePanel ? ' selected' : ''}" data-id="${b.id}">
          <div class="be-block-actions">
            <span class="be-drag-handle" draggable="true" data-drag="${b.id}" title="Drag to reorder">${ICON.grip}</span>
            <button type="button" data-move="up" data-id="${b.id}" title="Move up" ${i === 0 ? 'disabled' : ''}>${ICON.up}</button>
            <button type="button" data-move="down" data-id="${b.id}" title="Move down" ${i === blocks.length - 1 ? 'disabled' : ''}>${ICON.down}</button>
            <button type="button" data-remove="${b.id}" title="Delete">${ICON.close}</button>
          </div>
          <div class="be-block-body" data-id="${b.id}" ${b.type === 'text' ? 'contenteditable="true"' : ''}>${blockBodyPreviewHtml(b)}</div>
        </div>
      `);
      canvasInner.innerHTML = blocks.length
        ? dropZoneHtml(0) + blockHtml.map((html, i) => html + dropZoneHtml(i + 1)).join('')
        : `<div class="be-dropzone be-dropzone-empty" data-zone="0">Drag a block here, or click one below</div>`;
      canvasInner.insertAdjacentHTML('beforeend', footerSectionHtml());

      canvas.querySelectorAll('[data-upload-for]').forEach(el => {
        el.addEventListener('click', (e) => {
          // Deliberately NOT stopping propagation -- the click still bubbles
          // up and selects the block too (so the sidebar's Image URL/Link/
          // Width fields are visible alongside the upload dialog), and a
          // detached <input type=file> isn't affected by the resulting
          // render() call the way an attached DOM node would be.
          const { block, isFooter } = findBlock(el.dataset.uploadFor);
          if (!block) return;
          const input = document.createElement('input');
          input.type = 'file'; input.accept = 'image/png,image/jpeg,image/gif,image/webp';
          input.addEventListener('change', () => {
            uploadImageFile(input.files[0], null, (err, url) => {
              if (err) return;
              block.src = url;
              render();
              if (selectedId === block.id) renderStylePanel();
              notifyChange(isFooter);
            });
          });
          input.click();
        });
      });

      canvas.querySelectorAll('.be-block').forEach(el => {
        el.addEventListener('click', (e) => {
          // A linked image or button is a live <a> in the canvas preview --
          // clicking it to select/edit the block was also following the link
          // (text blocks already guard this in their own handler below).
          if (e.target.closest('a')) e.preventDefault();
          if (e.target.closest('[data-move],[data-remove],[data-drag]')) return;
          // Already the selected block -- don't re-render. selectBlock()
          // rebuilds canvasInner.innerHTML from scratch, which (mid-click)
          // was destroying and recreating the contenteditable DOM node the
          // browser had just placed a cursor in or was mid-drag-selecting
          // inside, breaking both cursor placement and text selection on
          // every single click within an already-active text block.
          if (el.dataset.id === selectedId && !showingThemePanel) return;
          const { block } = findBlock(el.dataset.id);
          if (block) selectBlock(block);
        });
      });
      canvas.querySelectorAll('[data-zone-add-type]').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const index = Number(btn.dataset.zone);
          const block = newBlock(btn.dataset.zoneAddType);
          blocks.splice(index, 0, block);
          selectBlock(block);
        });
      });
      canvas.querySelectorAll('[data-footer-add]').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const block = newBlock(btn.dataset.footerAdd);
          footerBlocks.push(block);
          selectBlock(block);
        });
      });
      canvas.querySelectorAll('.be-dropzone').forEach(zone => {
        zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('drag-over'); });
        zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
        zone.addEventListener('drop', (e) => {
          e.preventDefault();
          zone.classList.remove('drag-over');
          let index = Number(zone.dataset.zone);
          if (draggingNewType) {
            const block = newBlock(draggingNewType);
            blocks.splice(index, 0, block);
            draggingNewType = null;
            selectBlock(block);
          } else if (dragSourceId) {
            const fromIdx = blocks.findIndex(b => b.id === dragSourceId);
            if (fromIdx === -1) return;
            const [moved] = blocks.splice(fromIdx, 1);
            if (fromIdx < index) index -= 1; // account for the shift from removing the source
            blocks.splice(index, 0, moved);
            dragSourceId = null;
            render(); notifyChange(false);
          }
        });
      });
      canvas.querySelectorAll('[data-drag]').forEach(handle => {
        handle.addEventListener('dragstart', (e) => { dragSourceId = handle.dataset.drag; e.dataTransfer.effectAllowed = 'move'; canvas.classList.add('dragging'); });
        handle.addEventListener('dragend', () => { dragSourceId = null; canvas.classList.remove('dragging'); canvas.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over')); });
      });
      canvas.querySelectorAll('[contenteditable="true"]').forEach(el => {
        el.addEventListener('input', () => {
          const { block, isFooter } = findBlock(el.dataset.id);
          if (block) { block.html = el.innerHTML; notifyChange(isFooter); }
        });
        // A real <a> inside contenteditable is still a live link -- clicking
        // one navigates/opens it instead of just placing the cursor there
        // to keep editing, which is what every other rich text editor does.
        // preventDefault leaves the click free to do its normal job of
        // positioning the caret; only following the href is what's stopped.
        el.addEventListener('click', (e) => {
          if (e.target.closest('a')) e.preventDefault();
        });
        // Pasted HTML (e.g. from an old ActiveCampaign template) often
        // carries its own inline padding/margin/border on wrapper elements.
        // Left in place, that becomes a second, hidden layout source the
        // style panel's Border/Margin/Padding fields don't control or even
        // show -- stacking with whatever the block's own style is set to
        // and looking like padding that "can't be removed". Stripping just
        // those three properties (not color/font/etc, which are wanted)
        // keeps paste useful while preventing that.
        el.addEventListener('paste', (e) => {
          e.preventDefault();
          const html = (e.clipboardData || window.clipboardData).getData('text/html');
          const text = (e.clipboardData || window.clipboardData).getData('text/plain');
          if (html) {
            const frag = document.createElement('div');
            frag.innerHTML = html;
            // Google Docs wraps every paragraph in one inline <b id="docs-
            // internal-guid-*"> -- inserting that as-is makes the browser
            // split the wrapper and leave stray empty <p>s, i.e. phantom
            // blank lines between paragraphs that had none.
            frag.querySelectorAll('[id^="docs-internal-guid"]').forEach(w => w.replaceWith(...w.childNodes));
            frag.querySelectorAll('[style]').forEach(node => {
              // Docs gives every <p> an explicit margin:0pt; merely stripping
              // it (below) would swap that for the browser's default 1em <p>
              // margins and double every gap, so a source-declared zero stays zero.
              const zeroMargin = node.tagName === 'P' && parseFloat(node.style.marginTop) === 0 && parseFloat(node.style.marginBottom) === 0;
              node.style.removeProperty('padding');
              ['padding-top', 'padding-right', 'padding-bottom', 'padding-left'].forEach(p => node.style.removeProperty(p));
              node.style.removeProperty('margin');
              ['margin-top', 'margin-right', 'margin-bottom', 'margin-left'].forEach(p => node.style.removeProperty(p));
              node.style.removeProperty('border');
              // Word processors stamp every span with its own explicit body
              // size (Docs' default is 11pt = ~14.7px, shown as 15), so pasted
              // text would ignore the email's default size and sit a hair
              // smaller than the text around it. Ordinary body-size values
              // (10.5-12.5pt / 14-16.7px) are dropped so the text inherits
              // the email's default; headings and fine print keep their size.
              const fs = node.style.fontSize;
              const fsPx = /pt$/.test(fs) ? parseFloat(fs) * 4 / 3 : /px$/.test(fs) ? parseFloat(fs) : NaN;
              if (fsPx >= 14 && fsPx <= 16.7) node.style.removeProperty('font-size');
              if (zeroMargin) node.style.margin = '0';
              if (!node.getAttribute('style')) node.removeAttribute('style');
            });
            document.execCommand('insertHTML', false, frag.innerHTML);
          } else {
            document.execCommand('insertText', false, text);
          }
        });
      });
      canvas.querySelectorAll('[data-move]').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const { array, index: idx, isFooter } = findBlock(btn.dataset.id);
          if (!array) return;
          const dir = btn.dataset.move === 'up' ? -1 : 1;
          const swapIdx = idx + dir;
          if (swapIdx < 0 || swapIdx >= array.length) return;
          [array[idx], array[swapIdx]] = [array[swapIdx], array[idx]];
          render(); notifyChange(isFooter);
        });
      });
      canvas.querySelectorAll('[data-remove]').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const { isFooter } = findBlock(btn.dataset.remove);
          if (isFooter) footerBlocks = footerBlocks.filter(b => b.id !== btn.dataset.remove);
          else blocks = blocks.filter(b => b.id !== btn.dataset.remove);
          if (selectedId === btn.dataset.remove) selectedId = null;
          render(); renderStylePanel(); notifyChange(isFooter);
        });
      });
    }

    rootEl.querySelector('#beThemeBtn').addEventListener('click', () => {
      // Was hardcoded to true -- clicking it a second time re-opened the
      // (already open) panel instead of closing it. Toggling off drops back
      // to "no block selected" rather than trying to restore whatever was
      // selected before, same as clicking empty canvas space would.
      showingThemePanel = !showingThemePanel;
      selectedId = null;
      toolbar.style.display = 'none';
      render(); renderStylePanel();
    });

    rootEl.querySelectorAll('.be-palette-item').forEach(btn => {
      btn.addEventListener('click', () => {
        const block = newBlock(btn.dataset.add);
        blocks.push(block);
        selectBlock(block);
      });
      btn.addEventListener('dragstart', (e) => { draggingNewType = btn.dataset.add; e.dataTransfer.effectAllowed = 'copy'; canvas.classList.add('dragging'); });
      btn.addEventListener('dragend', () => { draggingNewType = null; canvas.classList.remove('dragging'); canvas.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over')); });
    });

    toolbar.querySelectorAll('[data-cmd]').forEach(btn => {
      btn.addEventListener('click', () => { document.execCommand(btn.dataset.cmd, false, null); syncSelectedText(); });
    });
    wireHexColorField(toolbar, 'beColor', (v) => { document.execCommand('foreColor', false, v); syncSelectedText(); }, { restoreSelection: true });
    toolbar.querySelector('#beFontSize').addEventListener('change', (e) => {
      const px = e.target.value;
      if (!px) return;
      // execCommand('fontSize', ...) only ever accepts the legacy 1-7 HTML
      // scale (no direct way to pass a real px/pt value) and, worse,
      // produces a deprecated <font size="N"> attribute instead of real
      // CSS -- inconsistent across email clients. The standard workaround:
      // use size 7 (the max of that legacy scale, unlikely to already be
      // in use) purely as a marker to find what execCommand just wrapped,
      // then replace the attribute with a real inline font-size style.
      document.execCommand('fontSize', false, '7');
      canvas.querySelectorAll('font[size="7"]').forEach(el => {
        el.removeAttribute('size');
        el.style.fontSize = px + 'px';
      });
      // Deliberately not resetting the select back to "Size..." here -- it
      // now reflects the selection's actual size (see syncToolbarFromSelection
      // below), so leaving it showing what was just applied is correct.
      syncSelectedText();
    });
    toolbar.querySelector('#beFontFamily').addEventListener('change', (e) => {
      if (!e.target.value) return;
      document.execCommand('fontName', false, e.target.value);
      syncSelectedText();
    });
    toolbar.querySelector('#beSpacing').addEventListener('change', (e) => {
      const mode = e.target.value;
      e.target.value = '';
      const body = canvas.querySelector(`.be-block-body[data-id="${selectedId}"]`);
      if (!mode || !body) return;
      const clone = body.cloneNode(true);
      normalizeBlankLines(clone, mode);
      // insertHTML over the whole body (instead of assigning innerHTML) keeps
      // this one Ctrl+Z away from being undone.
      body.focus();
      const range = document.createRange();
      range.selectNodeContents(body);
      const sel = window.getSelection();
      sel.removeAllRanges(); sel.addRange(range);
      document.execCommand('insertHTML', false, clone.innerHTML);
      syncSelectedText();
    });
    // The Font, Size, and Link fields all reflect whatever's under the
    // current text selection (kept in sync by syncToolbarFromSelection
    // below) instead of needing a separate "open" action to see or edit any
    // of it -- matches how a native word processor's toolbar behaves.
    let savedRange = null;
    let linkColorTouched = false;
    const linkUrlInput = toolbar.querySelector('#beLinkUrl');
    const linkColorInput = toolbar.querySelector('#beLinkColor');
    const linkColorSwatch = toolbar.querySelector('#beLinkColorSwatch');
    const fontFamilySelect = toolbar.querySelector('#beFontFamily');
    const fontSizeSelect = toolbar.querySelector('#beFontSize');
    // Walks up from a selection node to find an enclosing <a>, stopping at
    // the canvas boundary -- used both to pre-fill the link fields from the
    // current selection, and to locate the anchor(s) Apply just created/updated.
    function findLinkAncestor(node) {
      while (node && node !== canvas) {
        if (node.nodeType === 1 && node.tagName === 'A') return node;
        node = node.parentNode;
      }
      return null;
    }
    function rgbToHex(rgb) {
      const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(rgb || '');
      if (!m) return '#0000ff';
      return '#' + [m[1], m[2], m[3]].map(n => Number(n).toString(16).padStart(2, '0')).join('');
    }
    // The browser's own text-selection highlight disappears the instant
    // focus moves to the URL/color fields, since selection rendering only
    // shows on whichever element actually has focus -- there's no way
    // around that with the real Selection object. The Custom Highlight API
    // paints an arbitrary Range's own highlight independent of focus/
    // selection, so this keeps a link's text visibly marked while its
    // fields have focus.
    function setLinkEditHighlight(range) {
      if (range && window.Highlight && CSS.highlights) CSS.highlights.set('be-link-edit', new Highlight(range));
      else if (CSS.highlights) CSS.highlights.delete('be-link-edit');
    }
    // Inserts/updates a one-off option so the select can show a real value
    // even when it doesn't match any preset (e.g. a font-family/size set
    // some other way) -- same pattern renderStylePanel's theme font
    // selector already uses. `matchValue` compares loosely (normalized)
    // against preset options so e.g. getComputedStyle's quoting doesn't
    // spuriously fail to match a preset that's really the same font.
    function reflectSelectValue(select, rawValue, matchValue) {
      const preset = [...select.options].find(o => o.value && !o.dataset.dynamic && matchValue(o.value) === matchValue(rawValue));
      let dyn = select.querySelector('option[data-dynamic]');
      if (preset) { if (dyn) dyn.remove(); select.value = preset.value; return; }
      if (!dyn) { dyn = document.createElement('option'); dyn.dataset.dynamic = '1'; select.insertBefore(dyn, select.firstChild); }
      dyn.value = rawValue; dyn.textContent = rawValue;
      select.value = rawValue;
    }
    const normFamily = (f) => (f || '').replace(/['"]/g, '').trim().toLowerCase();
    // Reflects the current selection's font, size, and link state into the
    // toolbar -- runs on every selection change inside the active block's
    // text so the toolbar always shows what's actually under the cursor.
    function syncToolbarFromSelection() {
      const sel = window.getSelection();
      if (!sel.rangeCount) return;
      const range = sel.getRangeAt(0);
      const container = range.startContainer;
      const el = container.nodeType === 1 ? container : container.parentElement;
      // Ignore selection changes outside this block's editable body (e.g.
      // focus moved to the URL/color input, or elsewhere on the page) --
      // keeps showing the last real selection state instead of blanking the
      // toolbar out from under whatever the user is doing there.
      if (!el || !el.closest(`.be-block-body[data-id="${selectedId}"]`)) return;
      savedRange = range;
      const cs = getComputedStyle(el);
      reflectSelectValue(fontSizeSelect, String(Math.round(parseFloat(cs.fontSize))), (v) => v);
      reflectSelectValue(fontFamilySelect, cs.fontFamily, normFamily);
      const existingLink = findLinkAncestor(container);
      linkColorTouched = false;
      linkUrlInput.value = existingLink ? (existingLink.getAttribute('href') || '') : '';
      linkColorInput.value = existingLink && existingLink.style.color ? rgbToHex(existingLink.style.color) : '';
      linkColorSwatch.value = existingLink && existingLink.style.color ? rgbToHex(existingLink.style.color) : '#0000ff';
      setLinkEditHighlight(existingLink ? range : null);
    }
    document.addEventListener('selectionchange', syncToolbarFromSelection);
    wireHexColorField(toolbar, 'beLinkColor', () => { linkColorTouched = true; scheduleLinkCommit('color', 150); });
    // A collapsed selection (just a cursor, no highlight) inside an existing
    // link can't be re-linked/unlinked as-is -- execCommand needs
    // characters selected. Expand to the whole link's text so Apply/Unlink
    // act on it, matching what a user placing the cursor there would expect.
    function rangeForLinkAction() {
      if (!savedRange) return null;
      const existingLink = findLinkAncestor(savedRange.startContainer);
      if (existingLink && savedRange.collapsed) {
        const range = document.createRange();
        range.selectNodeContents(existingLink);
        return range;
      }
      return savedRange;
    }
    // There are no Apply/Unlink buttons: whatever is in the URL/color fields
    // sticks. Typing or pasting a URL applies it to the selected text after
    // a short pause (and immediately on blur/Enter), clearing the field
    // removes the link, and picking a color re-applies the link with it.
    // reason: 'url' (from the URL field) or 'color'.
    let linkCommitTimer = null;
    function scheduleLinkCommit(reason, delay) {
      clearTimeout(linkCommitTimer);
      linkCommitTimer = setTimeout(() => commitLink(reason), delay);
    }
    function commitLink(reason) {
      clearTimeout(linkCommitTimer);
      const range = rangeForLinkAction();
      const bodyEl = canvas.querySelector(`.be-block-body[data-id="${selectedId}"]`);
      // savedRange can be stale (the block re-rendered since, e.g. another
      // block got selected) -- only act on a live range inside the block
      // currently being edited.
      if (!range || !bodyEl || !bodyEl.contains(range.commonAncestorContainer)) return;
      const url = linkUrlInput.value.trim();
      const existingLink = findLinkAncestor(range.startContainer) || findLinkAncestor(range.commonAncestorContainer);
      // Just a cursor in plain text: nothing to link (createLink would
      // insert the URL itself as new link text).
      if (range.collapsed && !existingLink) return;
      // Applying moves the document selection into the editor, which pulls
      // focus out of whichever field the user is typing in -- put it back
      // (caret included) so the next keystroke doesn't land in the email.
      const active = document.activeElement;
      const caret = active && typeof active.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd] : null;
      if (!url) {
        if (reason === 'url' && existingLink) unlinkRange(range);
      } else if (!(existingLink && existingLink.getAttribute('href') === url && !linkColorTouched)) {
        applyLinkToRange(range, url);
      }
      if (active && active !== document.body && document.activeElement !== active && active.isConnected) {
        active.focus({ preventScroll: true });
        if (caret && active.setSelectionRange) { try { active.setSelectionRange(caret[0], caret[1]); } catch { /* not a text field */ } }
      }
    }
    function unlinkRange(range) {
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      document.execCommand('unlink', false, null);
      syncSelectedText();
      syncToolbarFromSelection();
    }
    function applyLinkToRange(range, url) {
      // Captured before unlink/createLink mutate the DOM -- those can
      // replace the text nodes range pointed at, so the range itself isn't
      // safe to re-query afterward, but the containing block-body element
      // survives (only its contents change).
      const startContainer = range.startContainer;
      const startEl = startContainer.nodeType === 1 ? startContainer : startContainer.parentElement;
      const bodyEl = startEl ? startEl.closest('.be-block-body') : null;
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      // Re-targeting text that's already inside an <a> is unreliable
      // across browsers with createLink alone (it can silently no-op or
      // leave the old href in place) -- unlinking first makes this work
      // consistently whether the selection is plain text or an existing link.
      const wasBold = document.queryCommandState('bold');
      document.execCommand('unlink', false, null);
      document.execCommand('createLink', false, url);
      // unlink/createLink's DOM rewrite can drop sibling <b> formatting
      // depending on browser/selection boundaries -- confirmed live
      // (bold text losing its weight after Link Apply). queryCommandState
      // is toggle-aware, so this only re-asserts bold if it actually got
      // lost, never double-toggles it back off.
      if (wasBold && !document.queryCommandState('bold')) document.execCommand('bold', false, null);
      if (linkColorTouched) {
        // Primary: the live selection right after createLink still sits
        // inside the anchor it just made/updated in every tested browser
        // -- walking up from there avoids re-deriving a CSS selector from
        // an arbitrary URL string, which is fragile for quote/backslash
        // characters a real link could contain.
        const sel2 = window.getSelection();
        const liveNode = sel2.rangeCount ? sel2.getRangeAt(0).startContainer : null;
        const liveAnchor = liveNode ? findLinkAncestor(liveNode) : null;
        if (liveAnchor) {
          liveAnchor.style.color = linkColorInput.value;
        } else if (bodyEl) {
          bodyEl.querySelectorAll('a[href]').forEach(a => { if (a.getAttribute('href') === url) a.style.color = linkColorInput.value; });
        }
      }
      syncSelectedText();
      syncToolbarFromSelection();
    }
    linkUrlInput.addEventListener('input', () => scheduleLinkCommit('url', 600));
    linkUrlInput.addEventListener('change', () => commitLink('url'));
    linkUrlInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commitLink('url'); }
    });
    toolbar.querySelector('#bePersonalize').addEventListener('change', (e) => {
      if (!e.target.value) return;
      document.execCommand('insertText', false, e.target.value);
      e.target.value = '';
      syncSelectedText();
    });
    function syncSelectedText() {
      const el = canvas.querySelector(`[data-id="${selectedId}"].be-block-body`);
      const { block, isFooter } = findBlock(selectedId);
      if (el && block) { block.html = el.innerHTML; notifyChange(isFooter); }
    }

    render(); renderStylePanel();
    return {
      getState: () => ({ blocks, theme }),
      setState: (state) => {
        blocks = (state?.blocks || []).map(b => ({ ...b, id: b.id || uid() }));
        theme = { ...DEFAULT_THEME, ...(state?.theme || {}) };
        selectedId = null; showingThemePanel = false;
        render(); renderStylePanel();
      },
      previewHtml: () => renderBlocksToHtml(blocks, theme),
      // footer: the full footer template object ({id, name, blocks, theme,
      // physicalAddress, socialLinks, unsubscribeLinkText, ...}) or null/
      // undefined to show no footer at all. Resets the dirty flag -- call
      // this again after a save (with the freshly-saved footer) to clear it.
      setFooter: (footer) => {
        footerMeta = footer || null;
        footerBlocks = (footer?.blocks || []).map(b => ({ ...b, id: b.id || uid() }));
        footerDirty = false;
        if (selectedId && !blocks.some(b => b.id === selectedId) && !footerBlocks.some(b => b.id === selectedId)) selectedId = null;
        render(); renderStylePanel();
      },
      getFooterState: () => ({ blocks: footerBlocks, dirty: footerDirty }),
    };
  }

  // Mirrors email_backend.js's resolveFooterHtml -- kept here in case a host
  // page needs a rendered-HTML preview outside the editor itself (e.g. an
  // email preview modal); the editor's own canvas no longer uses this for
  // the footer section since that's genuinely editable blocks now, not a
  // static HTML preview.
  function renderFooterHtml(footer) {
    if (!footer) return '';
    const social = (footer.socialLinks || []).map(s => `<a href="${s.url}" style="margin:0 6px;color:#888">${s.platform}</a>`).join('');
    const content = (footer.blocks && footer.blocks.length) ? renderBlocksToHtml(footer.blocks, footer.theme) : (footer.html || '');
    return `
      <div style="margin-top:24px;padding-top:16px;border-top:1px solid #e5e5e5;font-size:11px;color:#888;text-align:center">
        ${content}
        ${footer.physicalAddress ? `<div style="margin-top:8px">${footer.physicalAddress}</div>` : ''}
        ${social ? `<div style="margin-top:8px">${social}</div>` : ''}
        <div style="margin-top:8px"><a href="#" style="color:#888">${footer.unsubscribeLinkText || 'Unsubscribe'}</a></div>
      </div>`;
  }

  return { init, renderBlocksToHtml, renderFooterHtml };
})();
