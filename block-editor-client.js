// Drag-and-drop email block editor -- shared by campaign-builder.html and
// the automation "send email" step's config panel, so it's built once, not
// twice. Mirrors block_editor_shared.js's render algorithm by hand (this
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
    if (style.textAlign) parts.push(`text-align:${style.textAlign}`);
    return parts.length ? ` style="${parts.join(';')}"` : '';
  }
  function renderBlockHtml(block) {
    if (block.type === 'text') return `<div${styleAttr(block.style)}>${block.html || ''}</div>`;
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
    const t = theme || {};
    const bg = t.background || '#f4f4f4';
    const maxWidth = t.maxWidth || 650;
    return `<div style="background:${bg};padding:24px 0;font-family:Arial,Helvetica,sans-serif"><div style="max-width:${maxWidth}px;margin:0 auto;background:#ffffff">${(blocks || []).map(renderBlockHtml).join('')}</div></div>`;
  }

  // initialState: { blocks: [...], theme: {background, maxWidth} }
  // onChange receives the full { blocks, theme } state on every edit.
  function init(rootEl, initialState, onChange) {
    initialState = initialState || {};
    let blocks = (initialState.blocks || []).map(b => ({ ...b, id: b.id || uid() }));
    let theme = { background: '#f4f4f4', maxWidth: 650, ...(initialState.theme || {}) };
    let selectedId = null;
    let showingThemePanel = false;
    let allTags = [];
    let dragSourceId = null;   // set when dragging an existing block's handle (reorder)
    let draggingNewType = null; // set when dragging a palette item (insert)

    function newBlock(type) {
      return type === 'text' ? { id: uid(), type, html: 'New text block', style: { padding: '10px' } }
        : type === 'image' ? { id: uid(), type, src: '', link: '', width: 600, style: { padding: '10px' }, linkAction: null }
        : { id: uid(), type, text: 'Click here', link: '', style: { padding: '10px', textAlign: 'center' }, linkAction: null };
    }
    function selectBlock(block) {
      showingThemePanel = false;
      selectedId = block.id;
      toolbar.style.display = block.type === 'text' ? 'flex' : 'none';
      render(); renderStylePanel(); emit();
    }

    fetch('/api/tags').then(r => r.json()).then(d => { allTags = d.tags || []; if (selectedId) renderStylePanel(); }).catch(() => {});

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
            <span class="be-link-popover" id="beLinkPopover" style="display:none">
              <input type="text" id="beLinkUrl" placeholder="https://"/>
              <button type="button" id="beLinkApply">Apply</button>
              <button type="button" id="beLinkCancel">Cancel</button>
            </span>
          </div>
          <div class="be-canvas-toprow">
            <button type="button" class="pra-btn pra-btn-ghost pra-btn-sm" id="beThemeBtn">&#9881; Email Settings</button>
          </div>
          <div class="be-canvas" id="beCanvas">
            <div class="be-canvas-inner" id="beCanvasInner"></div>
          </div>
          <div class="be-add-row">
            <span class="pra-muted" style="font-size:.72rem;margin-right:4px">Drag a block onto the email, or click to add at the end:</span>
            <button type="button" class="pra-btn pra-btn-ghost pra-btn-sm be-palette-item" draggable="true" data-add="text">&#9776; Text</button>
            <button type="button" class="pra-btn pra-btn-ghost pra-btn-sm be-palette-item" draggable="true" data-add="image">&#9776; Image</button>
            <button type="button" class="pra-btn pra-btn-ghost pra-btn-sm be-palette-item" draggable="true" data-add="button">&#9776; Button</button>
          </div>
        </div>
        <div class="be-style-panel" id="beStylePanel"></div>
      </div>
    `;

    const canvas = rootEl.querySelector('#beCanvas');
    const canvasInner = rootEl.querySelector('#beCanvasInner');
    const stylePanel = rootEl.querySelector('#beStylePanel');
    const toolbar = rootEl.querySelector('#beToolbar');

    function emit() { if (onChange) onChange({ blocks, theme }); }

    function renderStylePanel() {
      if (showingThemePanel) {
        stylePanel.innerHTML = `
          <div class="pra-label" style="margin-bottom:8px">Email Settings</div>
          <div class="field"><label class="pra-label">Background</label><input class="pra-input" type="text" id="themeBg" value="${theme.background}"/></div>
          <div class="field"><label class="pra-label">Content Width (px)</label><input class="pra-input" type="number" id="themeWidth" value="${theme.maxWidth}"/></div>
        `;
        stylePanel.querySelector('#themeBg').addEventListener('input', (e) => { theme.background = e.target.value; renderPreviewBg(); emit(); });
        stylePanel.querySelector('#themeWidth').addEventListener('input', (e) => { theme.maxWidth = Number(e.target.value) || 650; renderPreviewBg(); emit(); });
        return;
      }
      const block = blocks.find(b => b.id === selectedId);
      if (!block) { stylePanel.innerHTML = '<div class="pra-muted" style="font-size:.82rem">Select a block to edit its style, or click Email Settings above.</div>'; return; }
      const s = block.style || {};
      const linkAction = block.linkAction || null;
      stylePanel.innerHTML = `
        <div class="pra-label" style="margin-bottom:8px">Block Style</div>
        <div class="field"><label class="pra-label">Alignment</label>
          <div style="display:flex;gap:6px">
            <button type="button" class="pra-btn pra-btn-ghost pra-btn-sm" data-align="left">&#8676;</button>
            <button type="button" class="pra-btn pra-btn-ghost pra-btn-sm" data-align="center">&#8596;</button>
            <button type="button" class="pra-btn pra-btn-ghost pra-btn-sm" data-align="right">&#8677;</button>
          </div>
        </div>
        <div class="field"><label class="pra-label">Background</label><input class="pra-input" type="text" id="styleBg" placeholder="#ffffff" value="${s.background || ''}"/></div>
        <div class="field"><label class="pra-label">Border</label><input class="pra-input" type="text" id="styleBorder" placeholder="1px solid #eee" value="${s.border || ''}"/></div>
        <div class="field"><label class="pra-label">Margin</label><input class="pra-input" type="text" id="styleMargin" placeholder="0" value="${s.margin || ''}"/></div>
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
      const bind = (id, key, target) => { const el = stylePanel.querySelector('#' + id); if (el) el.addEventListener('input', () => { target[key] = el.value; render(); emit(); }); };
      bind('styleBg', 'background', block.style = block.style || {});
      bind('styleBorder', 'border', block.style);
      bind('styleMargin', 'margin', block.style);
      bind('stylePadding', 'padding', block.style);
      if (block.type === 'image') {
        bind('imgSrc', 'src', block); bind('imgLink', 'link', block); bind('imgWidth', 'width', block);
        const uploadBtn = stylePanel.querySelector('#imgUploadBtn');
        const uploadInput = stylePanel.querySelector('#imgUpload');
        const uploadStatus = stylePanel.querySelector('#imgUploadStatus');
        uploadBtn.addEventListener('click', () => uploadInput.click());
        uploadInput.addEventListener('change', () => {
          const file = uploadInput.files[0];
          if (!file) return;
          uploadStatus.textContent = 'Uploading...';
          const reader = new FileReader();
          reader.onload = () => {
            fetch('/api/uploads/image', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ dataUrl: reader.result }),
            })
              .then(r => r.json().then(d => ({ ok: r.ok, d })))
              .then(({ ok, d }) => {
                if (!ok) { uploadStatus.textContent = d.error || 'Upload failed'; return; }
                block.src = d.url;
                uploadStatus.textContent = 'Uploaded.';
                render(); renderStylePanel(); emit();
              })
              .catch(() => { uploadStatus.textContent = 'Upload failed'; });
          };
          reader.readAsDataURL(file);
        });
      }
      if (block.type === 'button') { bind('btnText', 'text', block); bind('btnLink', 'link', block); }
      stylePanel.querySelectorAll('[data-align]').forEach(btn => btn.onclick = () => { block.style = block.style || {}; block.style.textAlign = btn.dataset.align; render(); emit(); });
      const actionTypeSel = stylePanel.querySelector('#linkActionType');
      const tagField = stylePanel.querySelector('#linkActionTagField');
      if (actionTypeSel) {
        actionTypeSel.addEventListener('change', () => {
          if (!actionTypeSel.value) { block.linkAction = null; tagField.style.display = 'none'; }
          else { block.linkAction = { type: actionTypeSel.value, tagId: allTags[0]?.id || null }; tagField.style.display = ''; }
          emit();
        });
        const tagSel = stylePanel.querySelector('#linkActionTag');
        if (tagSel) tagSel.addEventListener('change', () => { block.linkAction = { type: 'add_tag', tagId: tagSel.value }; emit(); });
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
    // with whatever block you happen to drop on.
    function dropZoneHtml(index) {
      return `<div class="be-dropzone" data-zone="${index}">
        <div class="be-dropzone-add" data-zone-add="${index}">
          <button type="button" data-zone-add-type="text" data-zone="${index}" title="Add text">T</button>
          <button type="button" data-zone-add-type="image" data-zone="${index}" title="Add image">&#128247;</button>
          <button type="button" data-zone-add-type="button" data-zone="${index}" title="Add button">&#128433;</button>
        </div>
      </div>`;
    }

    function render() {
      canvasInner.style.maxWidth = theme.maxWidth + 'px';
      renderPreviewBg();
      const blockHtml = blocks.map((b, i) => `
        <div class="be-block${b.id === selectedId && !showingThemePanel ? ' selected' : ''}" data-id="${b.id}">
          <div class="be-block-actions">
            <span class="be-drag-handle" draggable="true" data-drag="${b.id}" title="Drag to reorder">&#9776;</span>
            <span class="pra-muted" style="font-size:.7rem;text-transform:uppercase">${b.type}</span>
            <button type="button" data-move="up" data-id="${b.id}" ${i === 0 ? 'disabled' : ''}>&uarr;</button>
            <button type="button" data-move="down" data-id="${b.id}" ${i === blocks.length - 1 ? 'disabled' : ''}>&darr;</button>
            <button type="button" data-remove="${b.id}">&times;</button>
          </div>
          <div class="be-block-body" data-id="${b.id}" ${b.type === 'text' ? 'contenteditable="true"' : ''}>${renderBlockHtml(b)}</div>
        </div>
      `);
      canvasInner.innerHTML = blocks.length
        ? dropZoneHtml(0) + blockHtml.map((html, i) => html + dropZoneHtml(i + 1)).join('')
        : `<div class="be-dropzone be-dropzone-empty" data-zone="0">Drag a block here, or click one below</div>`;

      canvas.querySelectorAll('.be-block').forEach(el => {
        el.addEventListener('click', (e) => {
          if (e.target.closest('[data-move],[data-remove],[data-drag]')) return;
          selectBlock(blocks.find(b => b.id === el.dataset.id));
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
            render(); emit();
          }
        });
      });
      canvas.querySelectorAll('[data-drag]').forEach(handle => {
        handle.addEventListener('dragstart', (e) => { dragSourceId = handle.dataset.drag; e.dataTransfer.effectAllowed = 'move'; canvas.classList.add('dragging'); });
        handle.addEventListener('dragend', () => { dragSourceId = null; canvas.classList.remove('dragging'); canvas.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over')); });
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

    rootEl.querySelector('#beThemeBtn').addEventListener('click', () => {
      showingThemePanel = true;
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
    toolbar.querySelector('#beColor').addEventListener('input', (e) => { document.execCommand('foreColor', false, e.target.value); syncSelectedText(); });
    toolbar.querySelector('#beFontSize').addEventListener('change', (e) => { document.execCommand('fontSize', false, e.target.value); syncSelectedText(); });
    // Inline popover instead of prompt() -- native prompt() is blocked in
    // some embedded/sandboxed browser contexts (e.g. iframed previews),
    // and a small popover matches the rest of this editor's UI anyway.
    let savedRange = null;
    const linkPopover = toolbar.querySelector('#beLinkPopover');
    const linkUrlInput = toolbar.querySelector('#beLinkUrl');
    toolbar.querySelector('#beLinkBtn').addEventListener('click', () => {
      const sel = window.getSelection();
      savedRange = sel.rangeCount ? sel.getRangeAt(0) : null;
      linkUrlInput.value = 'https://';
      linkPopover.style.display = 'inline-flex';
      linkUrlInput.focus();
      linkUrlInput.select();
    });
    function closeLinkPopover() { linkPopover.style.display = 'none'; savedRange = null; }
    toolbar.querySelector('#beLinkCancel').addEventListener('click', closeLinkPopover);
    toolbar.querySelector('#beLinkApply').addEventListener('click', () => {
      const url = linkUrlInput.value.trim();
      if (url && savedRange) {
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(savedRange);
        document.execCommand('createLink', false, url);
        syncSelectedText();
      }
      closeLinkPopover();
    });
    linkUrlInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); toolbar.querySelector('#beLinkApply').click(); }
      if (e.key === 'Escape') closeLinkPopover();
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
      getState: () => ({ blocks, theme }),
      setState: (state) => {
        blocks = (state?.blocks || []).map(b => ({ ...b, id: b.id || uid() }));
        theme = { background: '#f4f4f4', maxWidth: 650, ...(state?.theme || {}) };
        selectedId = null; showingThemePanel = false;
        render(); renderStylePanel();
      },
      previewHtml: () => renderBlocksToHtml(blocks, theme),
    };
  }

  return { init, renderBlocksToHtml };
})();
