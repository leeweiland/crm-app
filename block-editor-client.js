// Drag-and-drop email block editor -- shared by campaign-builder.html and
// the automation "send email" step's config panel, so it's built once, not
// twice. Mirrors block_editor_shared.js's render algorithm by hand (this
// file runs in the browser, that one's an ESM server module) so the live
// preview always matches what actually gets sent.
window.BlockEditor = (function () {
  function uid() { return 'b' + Math.random().toString(36).slice(2, 10); }

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
  // onChange receives the full { blocks, theme } state on every body edit.
  // onFooterChange (optional) receives { blocks: footerBlocks } on every
  // footer edit -- kept separate from onChange since footer content isn't
  // part of this campaign/step's own saved state, it belongs to the shared
  // footer template (see setFooter/getFooterState below).
  function init(rootEl, initialState, onChange, onFooterChange) {
    initialState = initialState || {};
    let blocks = (initialState.blocks || []).map(b => ({ ...b, id: b.id || uid() }));
    let theme = { background: '#f4f4f4', maxWidth: 650, ...(initialState.theme || {}) };
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
      return type === 'text' ? { id: uid(), type, html: 'New text block', style: { padding: '10px' } }
        : type === 'image' ? { id: uid(), type, src: '', link: '', width: 600, style: { padding: '10px' }, linkAction: null }
        : { id: uid(), type, text: 'Click here', link: '', style: { padding: '10px', textAlign: 'center' }, linkAction: null };
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
            <input type="color" id="beColor" title="Text color"/>
            <select id="beFontFamily" title="Font">
              <option value="">Font...</option>
              <option value="Arial, Helvetica, sans-serif">Arial</option>
              <option value="'Century Gothic', 'Apple Gothic', sans-serif">Century Gothic</option>
              <option value="'Century Gothic Bold', 'Century Gothic', sans-serif" style="font-weight:bold">Century Gothic Bold</option>
              <option value="Aldrich, Arial, sans-serif">Aldrich</option>
            </select>
            <select id="beFontSize"><option value="2">Small</option><option value="3" selected>Normal</option><option value="5">Large</option><option value="7">XL</option></select>
            <button type="button" id="beLinkBtn">Link</button>
            <select id="bePersonalize"><option value="">Personalize...</option><option value="%FIRSTNAME%">First name</option><option value="%LASTNAME%">Last name</option><option value="%EMAIL%">Email</option><option value="%UNSUBSCRIBE%">Unsubscribe link</option></select>
            <span class="be-link-popover" id="beLinkPopover" style="display:none">
              <input type="text" id="beLinkUrl" placeholder="https://"/>
              <input type="color" id="beLinkColor" title="Link color"/>
              <button type="button" id="beLinkApply">Apply</button>
              <button type="button" id="beLinkUnlink">Unlink</button>
              <button type="button" id="beLinkCancel">Cancel</button>
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
          <div class="field"><label class="pra-label">Background</label><input class="pra-input" type="text" id="themeBg" value="${theme.background}"/></div>
          <div class="field"><label class="pra-label">Content Width (px)</label><input class="pra-input" type="number" id="themeWidth" value="${theme.maxWidth}"/></div>
        `;
        stylePanel.querySelector('#themeBg').addEventListener('input', (e) => { theme.background = e.target.value; renderPreviewBg(); notifyChange(false); });
        stylePanel.querySelector('#themeWidth').addEventListener('input', (e) => { theme.maxWidth = Number(e.target.value) || 650; renderPreviewBg(); notifyChange(false); });
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
      const bind = (id, key, target) => { const el = stylePanel.querySelector('#' + id); if (el) el.addEventListener('input', () => { target[key] = el.value; render(); notifyChange(isFooter); }); };
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
    // send-time HTML) -- an empty block shows a click-to-upload placeholder
    // instead of a broken <img>, and a filled one is wrapped so clicking the
    // picture itself re-uploads/replaces it, not just the sidebar button.
    function blockBodyPreviewHtml(b) {
      if (b.type !== 'image') return renderBlockHtml(b);
      if (!b.src) return `<div class="be-image-upload-placeholder" data-upload-for="${b.id}">${ICON.image}<span>Click to upload image</span></div>`;
      return `<div class="be-image-replace-wrap" data-upload-for="${b.id}" title="Click to replace image">${renderBlockHtml(b)}</div>`;
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
            frag.querySelectorAll('[style]').forEach(node => {
              node.style.removeProperty('padding');
              ['padding-top', 'padding-right', 'padding-bottom', 'padding-left'].forEach(p => node.style.removeProperty(p));
              node.style.removeProperty('margin');
              ['margin-top', 'margin-right', 'margin-bottom', 'margin-left'].forEach(p => node.style.removeProperty(p));
              node.style.removeProperty('border');
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
    toolbar.querySelector('#beColor').addEventListener('input', (e) => { document.execCommand('foreColor', false, e.target.value); syncSelectedText(); });
    toolbar.querySelector('#beFontSize').addEventListener('change', (e) => { document.execCommand('fontSize', false, e.target.value); syncSelectedText(); });
    toolbar.querySelector('#beFontFamily').addEventListener('change', (e) => {
      if (!e.target.value) return;
      document.execCommand('fontName', false, e.target.value);
      e.target.value = '';
      syncSelectedText();
    });
    // Inline popover instead of prompt() -- native prompt() is blocked in
    // some embedded/sandboxed browser contexts (e.g. iframed previews),
    // and a small popover matches the rest of this editor's UI anyway.
    let savedRange = null;
    let linkColorTouched = false;
    const linkPopover = toolbar.querySelector('#beLinkPopover');
    const linkUrlInput = toolbar.querySelector('#beLinkUrl');
    const linkColorInput = toolbar.querySelector('#beLinkColor');
    // Walks up from a selection node to find an enclosing <a>, stopping at
    // the canvas boundary -- used both to pre-fill the popover when
    // re-opening it on already-linked text, and to locate the anchor(s)
    // Apply just created/updated.
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
    toolbar.querySelector('#beLinkBtn').addEventListener('click', () => {
      const sel = window.getSelection();
      let range = sel.rangeCount ? sel.getRangeAt(0) : null;
      const existingLink = range ? findLinkAncestor(range.startContainer) : null;
      // A collapsed selection (just a cursor) inside an existing link can't
      // be re-linked/unlinked as-is -- execCommand needs characters
      // selected. Expand to the whole link's text so Apply/Unlink act on
      // it, matching what a user placing the cursor there would expect.
      if (existingLink && range && range.collapsed) {
        range = document.createRange();
        range.selectNodeContents(existingLink);
        sel.removeAllRanges();
        sel.addRange(range);
      }
      savedRange = range;
      linkColorTouched = false;
      linkUrlInput.value = existingLink ? (existingLink.getAttribute('href') || '') : 'https://';
      linkColorInput.value = existingLink && existingLink.style.color ? rgbToHex(existingLink.style.color) : '#0000ff';
      linkPopover.style.display = 'inline-flex';
      linkUrlInput.focus();
      linkUrlInput.select();
    });
    linkColorInput.addEventListener('input', () => { linkColorTouched = true; });
    function closeLinkPopover() { linkPopover.style.display = 'none'; savedRange = null; }
    toolbar.querySelector('#beLinkCancel').addEventListener('click', closeLinkPopover);
    toolbar.querySelector('#beLinkApply').addEventListener('click', () => {
      const url = linkUrlInput.value.trim();
      if (url && savedRange) {
        // Captured before unlink/createLink mutate the DOM -- those can
        // replace the text nodes savedRange pointed at, so the range itself
        // isn't safe to re-query afterward, but the containing block-body
        // element survives (only its contents change).
        const startContainer = savedRange.startContainer;
        const startEl = startContainer.nodeType === 1 ? startContainer : startContainer.parentElement;
        const bodyEl = startEl ? startEl.closest('.be-block-body') : null;
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(savedRange);
        // Re-targeting text that's already inside an <a> is unreliable
        // across browsers with createLink alone (it can silently no-op or
        // leave the old href in place) -- unlinking first makes this work
        // consistently whether the selection is plain text or an existing link.
        document.execCommand('unlink', false, null);
        document.execCommand('createLink', false, url);
        if (linkColorTouched && bodyEl) {
          bodyEl.querySelectorAll(`a[href="${CSS.escape(url)}"]`).forEach(a => { a.style.color = linkColorInput.value; });
        }
        syncSelectedText();
      }
      closeLinkPopover();
    });
    toolbar.querySelector('#beLinkUnlink').addEventListener('click', () => {
      if (savedRange) {
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(savedRange);
        document.execCommand('unlink', false, null);
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
      const { block, isFooter } = findBlock(selectedId);
      if (el && block) { block.html = el.innerHTML; notifyChange(isFooter); }
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
