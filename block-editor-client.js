// Drag-and-drop-ish email block editor -- shared by campaign-builder.html
// (Phase 2) and, in Phase 3, the automation "send email" step's config
// panel. Mirrors block_editor_shared.js's render algorithm by hand (this
// file runs in the browser, that one's an ESM server module) so the live
// preview always matches what actually gets sent.
window.BlockEditor = (function () {
  function uid() { return 'b' + Math.random().toString(36).slice(2, 10); }

  function styleAttr(style) {
    if (!style) return '';
    const parts = [];
    if (style.background) parts.push(`background:${style.background}`);
    if (style.border) parts.push(`border:${style.border}`);
    if (style.margin) parts.push(`margin:${style.margin}`);
    if (style.padding) parts.push(`padding:${style.padding}`);
    return parts.length ? ` style="${parts.join(';')}"` : '';
  }
  function renderBlockHtml(block) {
    if (block.type === 'text') return `<div${styleAttr(block.style)}>${block.html || ''}</div>`;
    if (block.type === 'image') {
      const img = `<img src="${block.src || ''}" width="${block.width || 600}" style="max-width:100%;display:block;border:0"/>`;
      return `<div${styleAttr(block.style)}>${block.link ? `<a href="${block.link}">${img}</a>` : img}</div>`;
    }
    if (block.type === 'button') {
      return `<div${styleAttr(block.style)}><a href="${block.link || '#'}" style="display:inline-block;background:#009bff;color:#fff;padding:12px 26px;border-radius:6px;text-decoration:none;font-weight:bold;font-family:sans-serif">${block.text || 'Click here'}</a></div>`;
    }
    return '';
  }
  function renderBlocksToHtml(blocks) {
    return `<div style="background:#ffffff;padding:24px 0;font-family:Arial,Helvetica,sans-serif"><div style="max-width:650px;margin:0 auto">${(blocks || []).map(renderBlockHtml).join('')}</div></div>`;
  }

  function init(rootEl, initialBlocks, onChange) {
    let blocks = (initialBlocks || []).map(b => ({ ...b, id: b.id || uid() }));
    let selectedId = blocks[0]?.id || null;

    rootEl.innerHTML = `
      <div class="be-shell">
        <div class="be-canvas-wrap">
          <div class="be-toolbar" id="beToolbar" style="display:none">
            <button type="button" data-cmd="bold"><b>B</b></button>
            <button type="button" data-cmd="italic"><i>I</i></button>
            <button type="button" data-cmd="underline"><u>U</u></button>
            <button type="button" data-cmd="justifyLeft">&#8676;</button>
            <button type="button" data-cmd="justifyCenter">&#8596;</button>
            <button type="button" data-cmd="justifyRight">&#8677;</button>
            <input type="color" id="beColor" title="Text color"/>
            <select id="beFontSize"><option value="2">Small</option><option value="3" selected>Normal</option><option value="5">Large</option><option value="7">XL</option></select>
            <button type="button" id="beLinkBtn">Link</button>
            <select id="bePersonalize"><option value="">Personalize...</option><option value="%FIRSTNAME%">First name</option><option value="%LASTNAME%">Last name</option><option value="%EMAIL%">Email</option></select>
          </div>
          <div class="be-canvas" id="beCanvas"></div>
          <div class="be-add-row">
            <button type="button" class="pra-btn pra-btn-ghost pra-btn-sm" data-add="text">+ Text</button>
            <button type="button" class="pra-btn pra-btn-ghost pra-btn-sm" data-add="image">+ Image</button>
            <button type="button" class="pra-btn pra-btn-ghost pra-btn-sm" data-add="button">+ Button</button>
          </div>
        </div>
        <div class="be-style-panel" id="beStylePanel"></div>
      </div>
    `;

    const canvas = rootEl.querySelector('#beCanvas');
    const stylePanel = rootEl.querySelector('#beStylePanel');
    const toolbar = rootEl.querySelector('#beToolbar');

    function emit() { if (onChange) onChange(blocks); }

    function renderStylePanel() {
      const block = blocks.find(b => b.id === selectedId);
      if (!block) { stylePanel.innerHTML = '<div class="pra-muted" style="font-size:.82rem">Select a block to edit its style.</div>'; return; }
      const s = block.style || {};
      stylePanel.innerHTML = `
        <div class="pra-label" style="margin-bottom:8px">Block Style</div>
        <div class="field"><label class="pra-label">Background</label><input class="pra-input" type="text" id="styleBg" placeholder="#ffffff" value="${s.background || ''}"/></div>
        <div class="field"><label class="pra-label">Border</label><input class="pra-input" type="text" id="styleBorder" placeholder="1px solid #eee" value="${s.border || ''}"/></div>
        <div class="field"><label class="pra-label">Margin</label><input class="pra-input" type="text" id="styleMargin" placeholder="0" value="${s.margin || ''}"/></div>
        <div class="field"><label class="pra-label">Padding</label><input class="pra-input" type="text" id="stylePadding" placeholder="10px" value="${s.padding || ''}"/></div>
        ${block.type === 'image' ? `
          <div class="field"><label class="pra-label">Image URL</label><input class="pra-input" type="text" id="imgSrc" value="${block.src || ''}"/></div>
          <div class="field"><label class="pra-label">Link (optional)</label><input class="pra-input" type="text" id="imgLink" value="${block.link || ''}"/></div>
          <div class="field"><label class="pra-label">Width (px)</label><input class="pra-input" type="number" id="imgWidth" value="${block.width || 600}"/></div>
        ` : ''}
        ${block.type === 'button' ? `
          <div class="field"><label class="pra-label">Button text</label><input class="pra-input" type="text" id="btnText" value="${block.text || ''}"/></div>
          <div class="field"><label class="pra-label">Link URL</label><input class="pra-input" type="text" id="btnLink" value="${block.link || ''}"/></div>
        ` : ''}
      `;
      const bind = (id, key, target) => { const el = stylePanel.querySelector('#' + id); if (el) el.addEventListener('input', () => { target[key] = el.value; render(); emit(); }); };
      bind('styleBg', 'background', block.style = block.style || {});
      bind('styleBorder', 'border', block.style);
      bind('styleMargin', 'margin', block.style);
      bind('stylePadding', 'padding', block.style);
      if (block.type === 'image') { bind('imgSrc', 'src', block); bind('imgLink', 'link', block); bind('imgWidth', 'width', block); }
      if (block.type === 'button') { bind('btnText', 'text', block); bind('btnLink', 'link', block); }
    }

    function render() {
      canvas.innerHTML = blocks.map((b, i) => `
        <div class="be-block${b.id === selectedId ? ' selected' : ''}" data-id="${b.id}">
          <div class="be-block-actions">
            <span class="pra-muted" style="font-size:.7rem;text-transform:uppercase">${b.type}</span>
            <button type="button" data-move="up" data-id="${b.id}" ${i === 0 ? 'disabled' : ''}>&uarr;</button>
            <button type="button" data-move="down" data-id="${b.id}" ${i === blocks.length - 1 ? 'disabled' : ''}>&darr;</button>
            <button type="button" data-remove="${b.id}">&times;</button>
          </div>
          <div class="be-block-body" data-id="${b.id}" ${b.type === 'text' ? 'contenteditable="true"' : ''}>${renderBlockHtml(b)}</div>
        </div>
      `).join('') || '<div class="pra-muted" style="padding:30px;text-align:center">No blocks yet — add one below.</div>';

      canvas.querySelectorAll('.be-block').forEach(el => {
        el.addEventListener('click', (e) => {
          if (e.target.closest('[data-move],[data-remove]')) return;
          selectedId = el.dataset.id;
          toolbar.style.display = blocks.find(b => b.id === selectedId)?.type === 'text' ? 'flex' : 'none';
          render(); renderStylePanel();
        });
      });
      canvas.querySelectorAll('[contenteditable="true"]').forEach(el => {
        el.addEventListener('input', () => {
          const block = blocks.find(b => b.id === el.dataset.id);
          if (block) { block.html = el.innerHTML; emit(); }
        });
      });
      canvas.querySelectorAll('[data-move]').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const idx = blocks.findIndex(b => b.id === btn.dataset.id);
          const dir = btn.dataset.move === 'up' ? -1 : 1;
          const swapIdx = idx + dir;
          if (swapIdx < 0 || swapIdx >= blocks.length) return;
          [blocks[idx], blocks[swapIdx]] = [blocks[swapIdx], blocks[idx]];
          render(); emit();
        });
      });
      canvas.querySelectorAll('[data-remove]').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          blocks = blocks.filter(b => b.id !== btn.dataset.remove);
          if (selectedId === btn.dataset.remove) selectedId = null;
          render(); renderStylePanel(); emit();
        });
      });
    }

    rootEl.querySelectorAll('[data-add]').forEach(btn => {
      btn.addEventListener('click', () => {
        const type = btn.dataset.add;
        const block = type === 'text' ? { id: uid(), type, html: 'New text block', style: { padding: '10px' } }
          : type === 'image' ? { id: uid(), type, src: '', link: '', width: 600, style: { padding: '10px' } }
          : { id: uid(), type, text: 'Click here', link: '', style: { padding: '10px', margin: '0 auto' } };
        blocks.push(block);
        selectedId = block.id;
        toolbar.style.display = type === 'text' ? 'flex' : 'none';
        render(); renderStylePanel(); emit();
      });
    });

    toolbar.querySelectorAll('[data-cmd]').forEach(btn => {
      btn.addEventListener('click', () => { document.execCommand(btn.dataset.cmd, false, null); syncSelectedText(); });
    });
    toolbar.querySelector('#beColor').addEventListener('input', (e) => { document.execCommand('foreColor', false, e.target.value); syncSelectedText(); });
    toolbar.querySelector('#beFontSize').addEventListener('change', (e) => { document.execCommand('fontSize', false, e.target.value); syncSelectedText(); });
    toolbar.querySelector('#beLinkBtn').addEventListener('click', () => {
      const url = prompt('Link URL:', 'https://');
      if (url) { document.execCommand('createLink', false, url); syncSelectedText(); }
    });
    toolbar.querySelector('#bePersonalize').addEventListener('change', (e) => {
      if (!e.target.value) return;
      document.execCommand('insertText', false, e.target.value);
      e.target.value = '';
      syncSelectedText();
    });
    function syncSelectedText() {
      const el = canvas.querySelector(`[data-id="${selectedId}"].be-block-body`);
      const block = blocks.find(b => b.id === selectedId);
      if (el && block) { block.html = el.innerHTML; emit(); }
    }

    render(); renderStylePanel();
    return {
      getBlocks: () => blocks,
      setBlocks: (newBlocks) => { blocks = (newBlocks || []).map(b => ({ ...b, id: b.id || uid() })); selectedId = blocks[0]?.id || null; render(); renderStylePanel(); },
      previewHtml: () => renderBlocksToHtml(blocks),
    };
  }

  return { init, renderBlocksToHtml };
})();
