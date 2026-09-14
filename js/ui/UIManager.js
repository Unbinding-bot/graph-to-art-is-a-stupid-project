/**
 * UIManager — manages the right panel (tool options, color, layers, equations).
 */

import { deriveEquations, deriveInequality } from '../math/FittingPipeline.js';

const TOOL_NAMES = {
  brush:      'Brush',
  eraser:     'Eraser',
  fill:       'Fill Bucket',
  eyedrop:    'Eyedropper',
  wand:       'Magic Wand',
  lasso:      'Lasso',
  plasso:     'Polygonal Lasso',
  rect:       'Rectangle',
  circle:     'Circle / Ellipse',
  polygon:    'Polygon',
  editpoints: 'Edit Points',
};

export class UIManager {
  constructor(app) {
    this.app = app;

    this._panelTab   = 'layers';
    this._activeOpts = null;
    this._eqOnlyMode = false;

    this._init();
  }

  _init() {
    // Panel tabs (bottom half)
    document.querySelectorAll('.panel-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        this._panelTab = tab.dataset.panel;
        this._refreshTabs();
      });
    });

    // Top-half tabs (Tool Options / Color)
    document.querySelectorAll('.panel-top-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.panel-top-tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.panel-top-body').forEach(b => b.classList.remove('active'));
        tab.classList.add('active');
        document.querySelector(`.panel-top-body[data-top-body="${tab.dataset.topTab}"]`)?.classList.add('active');
      });
    });

    // FG / BG target buttons inside Color tab
    document.getElementById('color-target-fg')?.addEventListener('click', () => {
      this.app._pickingBg = false;
      this._updateSwatchActiveState();
    });
    document.getElementById('color-target-bg')?.addEventListener('click', () => {
      this.app._pickingBg = true;
      this._updateSwatchActiveState();
    });

    // Layer add button
    document.getElementById('layer-add-btn').addEventListener('click', () => {
      this.app.layerManager.addLayer();
      this.refreshLayerPanel();
      this.app.render();
    });

    // Equation-only toggle
    document.getElementById('eq-only-btn')?.addEventListener('click', () => {
      this._eqOnlyMode = !this._eqOnlyMode;
      document.getElementById('eq-only-btn').classList.toggle('active', this._eqOnlyMode);
      this.app.render();
    });

    // Copy all equations
    document.getElementById('eq-copy-all-btn')?.addEventListener('click', () => {
      const worldRange = this.app.canvasManager.view.xMax - this.app.canvasManager.view.xMin;
      const all = this.app.layerManager.layers
        .flatMap(l => l.shapes)
        .filter(e => e.visible)
        .flatMap(e => e.mode === 'inequality'
          ? deriveInequality(e.shape, this.app.fitOptions, worldRange)
          : deriveEquations(e.shape, this.app.fitOptions, worldRange))
        .map(eq => eq.desmos)
        .filter(d => d)
        .join('\n');
      if (!all) { this._flash('Nothing to copy'); return; }
      navigator.clipboard.writeText(all).then(() => this._flash('Copied!'));
    });

    // File operations
    document.getElementById('export-png-btn')?.addEventListener('click', () => {
      this.app.fileManager.exportPNG();
    });
    document.getElementById('save-btn')?.addEventListener('click', () => {
      this.app.fileManager.save();
    });
    document.getElementById('load-btn')?.addEventListener('click', () => {
      document.getElementById('load-input').click();
    });

    // Mobile panel toggle
    document.getElementById('panel-toggle-btn')?.addEventListener('click', () => {
      const panel = document.getElementById('panel');
      if (panel) panel.classList.toggle('mobile-open');
    });
    // Swipe-down on the panel handle to close it
    const panel = document.getElementById('panel');
    if (panel) {
      let touchStartY = 0;
      panel.addEventListener('touchstart', e => { touchStartY = e.touches[0].clientY; }, { passive: true });
      panel.addEventListener('touchend', e => {
        const dy = e.changedTouches[0].clientY - touchStartY;
        if (dy > 60) panel.classList.remove('mobile-open');
      }, { passive: true });
    }
    document.getElementById('load-input')?.addEventListener('change', e => {
      const file = e.target.files[0];
      if (file) { this.app.fileManager.load(file); e.target.value = ''; }
    });

    // Zoom reset
    document.getElementById('zoom-reset-btn')?.addEventListener('click', () => {
      const cm = this.app.canvasManager;
      cm.view = { xMin: -10, xMax: 10, yMin: -10, yMax: 10 };
      cm.resize(); // re-applies aspect ratio
      this.app.render();
    });

    // Toolbar color swatches
    document.getElementById('swatch-fg')?.addEventListener('click', (e) => {
      this.app._pickingBg = false;
      this.app.colorPicker.setHex(this.app.foreColor);
      this.app.colorPicker.open(this.app.foreColor, e.currentTarget);
      this._updateSwatchActiveState();
    });
    document.getElementById('swatch-bg')?.addEventListener('click', (e) => {
      this.app._pickingBg = true;
      this.app.colorPicker.setHex(this.app.backColor);
      this.app.colorPicker.open(this.app.backColor, e.currentTarget);
      this._updateSwatchActiveState();
    });
    document.getElementById('swap-colors-btn')?.addEventListener('click', () => {
      const tmp = this.app.foreColor;
      this.app.setForeColor(this.app.backColor);
      this.app.setBackColor(tmp);
    });
    document.getElementById('reset-colors-btn')?.addEventListener('click', () => {
      this.app.setForeColor('#ffffff');
      this.app.setBackColor('#000000');
    });

    // Brush auto-fit toggle
    document.getElementById('chk-brush-fit')?.addEventListener('change', e => {
      this.app._brushAutoFit = e.target.checked;
    });

    // Fit settings checkboxes — toggling these never touches vector geometry,
    // only how it's re-expressed, so just refresh the panel + overlay.
    ['chkLinear','chkQuad','chkCubic','chkCircle'].forEach(id => {
      document.getElementById(id)?.addEventListener('change', e => {
        this.app.fitOptions[id.replace('chk','').toLowerCase()] = e.target.checked;
        this.refreshEquationsPanel();
      });
    });

    // ── Helper: wire a slider+number pair ────────────────────────────────
    const syncPair = (sliderId, numId, onChange) => {
      const slider = document.getElementById(sliderId);
      const num    = document.getElementById(numId);
      if (!slider || !num) return;
      const apply = v => { v = Math.max(+slider.min, Math.min(+slider.max, v)); slider.value = v; num.value = v; onChange(v); };
      slider.addEventListener('input', () => apply(+slider.value));
      num.addEventListener('change', () => apply(+num.value));
      num.addEventListener('keydown', e => { if (e.key === 'Enter') apply(+num.value); });
    };

    // Panel tool-option sliders / checks — BRUSH
    syncPair('opt-brush-size', 'opt-brush-size-num', v => { this.app.toolOptions.brushSize = v; });

    // ERASER
    syncPair('opt-eraser-size', 'opt-eraser-size-num', v => { this.app.toolOptions.eraserSize = v; });
    document.getElementById('opt-eraser-hardness')?.addEventListener('input', e => {
      this.app.toolOptions.eraserHardness = +e.target.value / 100;
      document.getElementById('opt-eraser-hardness-val').textContent = e.target.value + '%';
    });

    // FILL — vector only, no options to wire

    // WAND
    document.getElementById('opt-wand-tol')?.addEventListener('input', e => {
      this.app.toolOptions.wandTolerance = +e.target.value;
      document.getElementById('opt-wand-tol-val').textContent = e.target.value;
    });
    document.getElementById('opt-wand-contiguous')?.addEventListener('change', e => {
      this.app.toolOptions.wandContiguous = e.target.checked;
    });
    document.getElementById('opt-wand-sampleall')?.addEventListener('change', e => {
      this.app.toolOptions.wandSampleAll = e.target.checked;
    });

    // LASSO feather (shared between lasso & plasso)
    document.getElementById('opt-lasso-feather')?.addEventListener('input', e => {
      this.app.toolOptions.lassoFeather = +e.target.value;
      document.getElementById('opt-lasso-feather-val').textContent = e.target.value + 'px';
    });
    document.getElementById('opt-plasso-feather')?.addEventListener('input', e => {
      this.app.toolOptions.lassoFeather = +e.target.value;
      document.getElementById('opt-plasso-feather-val').textContent = e.target.value + 'px';
    });

    // SHAPES — stroke size + fill checkbox
    ['', '-c', '-p'].forEach(suffix => {
      syncPair(`opt-shape-stroke${suffix}`, `opt-shape-stroke${suffix}-num`,
        v => { this.app.toolOptions.shapeStrokeWidth = v; });
      document.getElementById(`opt-shape-fill${suffix}`)?.addEventListener('change', e => {
        this.app.toolOptions.shapeFill = e.target.checked;
      });
    });

    // Selection actions
    document.getElementById('fit-selection-btn')?.addEventListener('click', () => {
      this.app._fitSelection();
    });
    document.getElementById('goto-selection-btn')?.addEventListener('click', () => {
      this.app.gotoSelection();
    });
    document.getElementById('delete-selection-btn')?.addEventListener('click', () => {
      this.app.deleteSelection();
    });
    document.getElementById('clear-selection-btn')?.addEventListener('click', () => {
      this.app._clearSelection();
    });

    this._refreshTabs();
    this.refreshLayerPanel();
    this.refreshEquationsPanel();
    this.showOptions('brush');
    this.hideSelectionActions();
    // Init swatch outline state (FG active by default)
    this.app._pickingBg = false;
    this._updateSwatchActiveState();
  }

  // ── Swatch active state (shows which color the inline picker is editing) ──

  _updateSwatchActiveState() {
    if (this._updatingSwatches) return;
    this._updatingSwatches = true;

    const isBg = this.app._pickingBg;

    // Toolbar swatch outlines
    const fg = document.getElementById('swatch-fg');
    const bg = document.getElementById('swatch-bg');
    if (fg) fg.style.outline = isBg ? 'none' : '2px solid var(--accent-hi)';
    if (bg) bg.style.outline = isBg ? '2px solid var(--accent-hi)' : 'none';

    // Color tab FG/BG buttons
    document.getElementById('color-target-fg')?.classList.toggle('active', !isBg);
    document.getElementById('color-target-bg')?.classList.toggle('active',  isBg);

    // Color dots inside those buttons
    const dotFg = document.getElementById('color-dot-fg');
    const dotBg = document.getElementById('color-dot-bg');
    if (dotFg) dotFg.style.background = this.app.foreColor;
    if (dotBg) dotBg.style.background = this.app.backColor;

    // Sync inline picker to the active color (suppress onChange during sync)
    const hex = isBg ? this.app.backColor : this.app.foreColor;
    this.app.colorPicker?.setHex(hex);

    this._updatingSwatches = false;
  }

  // ── Panel tabs ────────────────────────────────────────────────────────────

  _refreshTabs() {
    document.querySelectorAll('.panel-tab').forEach(tab => {
      tab.classList.toggle('active', tab.dataset.panel === this._panelTab);
    });
    document.querySelectorAll('.panel-section').forEach(sec => {
      sec.classList.toggle('active', sec.dataset.section === this._panelTab);
    });
  }

  // ── Active tool ───────────────────────────────────────────────────────────

  setActiveTool(name) {
    document.querySelectorAll('.tool-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tool === name);
    });
    // Update tool name header
    const label = document.getElementById('tool-name-label');
    if (label) label.textContent = TOOL_NAMES[name] ?? name;
  }

  // ── Tool options panel ────────────────────────────────────────────────────

  showOptions(toolName) {
    this._activeOpts = toolName;
    document.querySelectorAll('.panel-opts-group').forEach(g => {
      g.style.display = g.dataset.panelOpts === toolName ? 'flex' : 'none';
    });
    // Sync fill + stroke to current toolOptions
    if (['rect','circle','polygon'].includes(toolName)) {
      const sfxMap = { rect: '', circle: '-c', polygon: '-p' };
      const sfx = sfxMap[toolName];
      const fillEl = document.getElementById(`opt-shape-fill${sfx}`);
      const strEl  = document.getElementById(`opt-shape-stroke${sfx}`);
      const strNum = document.getElementById(`opt-shape-stroke${sfx}-num`);
      if (fillEl) fillEl.checked = this.app.toolOptions.shapeFill;
      if (strEl)  strEl.value = this.app.toolOptions.shapeStrokeWidth;
      if (strNum) strNum.value = this.app.toolOptions.shapeStrokeWidth;
    }
    this.setActiveTool(toolName);
  }

  // ── Selection action bar ──────────────────────────────────────────────────

  showSelectionActions() {
    const el = document.getElementById('selection-actions');
    if (el) el.style.display = 'flex';
  }
  hideSelectionActions() {
    const el = document.getElementById('selection-actions');
    if (el) el.style.display = 'none';
  }

  // ── Layer panel ───────────────────────────────────────────────────────────

  refreshLayerPanel() {
    const lm   = this.app.layerManager;
    const list = document.getElementById('layer-list');
    if (!list) return;
    list.innerHTML = '';

    const reversed = [...lm.layers].reverse();
    reversed.forEach((layer) => {
      const realIdx = lm.layers.indexOf(layer);
      const div = document.createElement('div');
      div.className = 'layer-item' + (realIdx === lm.activeIndex ? ' active' : '');
      div.dataset.layerId = layer.id;

      const thumb = document.createElement('canvas');
      thumb.className = 'layer-thumb';
      thumb.width  = 32;
      thumb.height = 32;
      thumb.getContext('2d').drawImage(layer.canvas, 0, 0, 32, 32);

      div.innerHTML = `
        <div class="layer-row1">
          <button class="layer-vis-btn" data-id="${layer.id}" title="Toggle visibility">
            ${layer.visible ? '👁' : '🚫'}
          </button>
          <input class="layer-name" data-id="${layer.id}" value="${escHtml(layer.name)}" title="Double-click to rename">
          <div class="layer-actions">
            <button class="layer-action-btn" data-action="dup"   data-id="${layer.id}" title="Duplicate">⧉</button>
            <button class="layer-action-btn" data-action="merge" data-id="${layer.id}" title="Merge down">⬇</button>
            <button class="layer-action-btn danger" data-action="del" data-id="${layer.id}" title="Delete">✕</button>
          </div>
        </div>`;

      div.querySelector('.layer-row1').insertAdjacentElement('afterbegin', thumb);
      list.appendChild(div);

      div.addEventListener('click', (e) => {
        if (e.target.closest('button,input')) return;
        lm.setActive(layer.id);
        this.refreshLayerPanel();
      });

      div.querySelector('.layer-vis-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        layer.visible = !layer.visible;
        this.refreshLayerPanel();
        this.app.render();
      });

      const nameInput = div.querySelector('.layer-name');
      nameInput.addEventListener('dblclick', () => { nameInput.style.pointerEvents='auto'; nameInput.focus(); });
      nameInput.addEventListener('blur', () => { layer.name = nameInput.value||'Layer'; nameInput.style.pointerEvents='none'; });
      nameInput.addEventListener('keydown', e => { if (e.key==='Enter') nameInput.blur(); });

      div.querySelector('[data-action="dup"]').addEventListener('click', (e) => {
        e.stopPropagation(); lm.duplicateLayer(layer.id); this.refreshLayerPanel(); this.app.render();
      });
      div.querySelector('[data-action="merge"]').addEventListener('click', (e) => {
        e.stopPropagation(); lm.mergeDown(layer.id); this.refreshLayerPanel(); this.app.render();
      });
      div.querySelector('[data-action="del"]').addEventListener('click', (e) => {
        e.stopPropagation(); lm.removeLayer(layer.id); this.refreshLayerPanel(); this.app.render();
      });

      div.setAttribute('draggable', 'true');
      div.addEventListener('dragstart', (e) => { e.dataTransfer.setData('layerId', layer.id); div.classList.add('dragging'); });
      div.addEventListener('dragend',   () => div.classList.remove('dragging'));
      div.addEventListener('dragover',  (e) => e.preventDefault());
      div.addEventListener('drop', (e) => {
        e.preventDefault();
        const srcId  = +e.dataTransfer.getData('layerId');
        const srcIdx = lm.layers.findIndex(l => l.id === srcId);
        if (srcIdx !== realIdx) { lm.moveLayer(srcIdx, realIdx); this.refreshLayerPanel(); this.app.render(); }
      });
    });
  }

  // ── Equations panel ───────────────────────────────────────────────────────

  refreshEquationsPanel() {
    const container = document.getElementById('equations-list');
    if (!container) return;
    container.innerHTML = '';
    const lm     = this.app.layerManager;
    const colors = ['#7fddcc','#dd99ff','#ffcc77','#77ddff','#ff7799'];
    const worldRange = this.app.canvasManager.view.xMax - this.app.canvasManager.view.xMin;

    lm.layers.forEach((layer, li) => {
      if (!layer.shapes.length) return;
      const color = colors[li % colors.length];
      const section = document.createElement('div');
      section.className = 'eq-layer-section';
      section.innerHTML = `
        <div class="eq-layer-title" style="border-color:${color}55">
          <span>${escHtml(layer.name)}</span>
          <button class="eq-copy-btn" data-layeridx="${li}">Copy ↗</button>
        </div>`;

      layer.shapes.forEach((entry, idx) => {
        const lines = entry.mode === 'inequality'
          ? deriveInequality(entry.shape, this.app.fitOptions, worldRange)
          : deriveEquations(entry.shape, this.app.fitOptions, worldRange);

        // Skip render-only entries (no equation to show)
        if (!lines.length && entry.shape?.type === 'static' && !entry.shape?.desmos) return;
        const item = document.createElement('div');
        item.className = 'eq-item';
        const codeHtml = lines.length
          ? lines.map((l, li) => `
            <div class="eq-line-box" data-lineidx="${li}">
              <div class="eq-line-top">
                <span class="eq-type">${escHtml(l.label)}</span>
                <button class="eq-line-copy-btn" data-lineidx="${li}" title="Copy equation">↗</button>
              </div>
              <div class="eq-code">${escHtml(l.desmos)}</div>
            </div>`).join('')
          : `<div class="eq-code" style="color:var(--text-dim)">No equation for the currently checked types</div>`;
        item.innerHTML = `
          <div class="eq-item-top">
            <label class="eq-item-label">
              <input type="checkbox" class="eq-vis-toggle" ${entry.visible?'checked':''} data-layerid="${layer.id}" data-eqid="${entry.id}">
              <span class="eq-type" style="color:${color}">${entry.mode === 'inequality' ? 'Fill' : 'Shape'} ${idx+1}</span>
            </label>
            <button class="eq-del-btn" data-layerid="${layer.id}" data-eqid="${entry.id}">✕</button>
          </div>${codeHtml}`;

        // Wire per-line copy buttons
        item.querySelectorAll('.eq-line-copy-btn').forEach(btn => {
          btn.addEventListener('click', () => {
            const li = +btn.dataset.lineidx;
            const desmos = lines[li]?.desmos;
            if (!desmos) return;
            navigator.clipboard.writeText(desmos)
              .then(() => this._flash('Copied!'))
              .catch(() => {
                // fallback for file:// protocol
                const ta = document.createElement('textarea');
                ta.value = desmos;
                ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
                document.body.appendChild(ta);
                ta.focus(); ta.select();
                document.execCommand('copy');
                document.body.removeChild(ta);
                this._flash('Copied!');
              });
          });
        });

        section.appendChild(item);
      });
      container.appendChild(section);
    });

    if (!container.children.length) {
      container.innerHTML = '<div style="color:var(--text-dim);font-size:12px;padding:8px 0">No equations yet. Draw a stroke to fit one.</div>';
    }

    container.querySelectorAll('.eq-vis-toggle').forEach(cb => {
      cb.addEventListener('change', (e) => {
        const layer = lm.layers.find(l => l.id === +e.target.dataset.layerid);
        const entry = layer?.shapes.find(s => s.id === +e.target.dataset.eqid);
        if (entry) { entry.visible = e.target.checked; this.app.render(); }
      });
    });
    container.querySelectorAll('.eq-del-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const layer = lm.layers.find(l => l.id === +e.target.dataset.layerid);
        if (layer) { layer.removeShape(+e.target.dataset.eqid); this.refreshEquationsPanel(); this.app.render(); }
      });
    });
    container.querySelectorAll('.eq-copy-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const layer = lm.layers[+e.target.dataset.layeridx];
        if (!layer) return;
        const text = layer.shapes.filter(s=>s.visible)
          .flatMap(entry => entry.mode === 'inequality'
            ? deriveInequality(entry.shape, this.app.fitOptions, worldRange)
            : deriveEquations(entry.shape, this.app.fitOptions, worldRange))
          .map(l => l.desmos).filter(d => d).join('\n');
        if (!text) { this._flash('Nothing to copy'); return; }
        navigator.clipboard.writeText(text).then(() => this._flash('Copied!'));
      });
    });
  }

  isEqOnlyMode() { return this._eqOnlyMode; }

  // ── Status bar ────────────────────────────────────────────────────────────

  updateStatus(pos, msg) {
    const lm = this.app.layerManager;
    const posEl = document.getElementById('status-pos');
    if (posEl) posEl.textContent = pos ? `x: ${pos.x.toFixed(2)}  y: ${pos.y.toFixed(2)}` : '';
    const layerEl = document.getElementById('status-layer');
    if (layerEl) layerEl.textContent = lm.activeLayer?.name ?? '—';
    if (msg !== undefined) {
      const msgEl = document.getElementById('status-msg');
      if (msgEl) msgEl.textContent = msg;
    }
    // Update zoom % in button
    const cm      = this.app.canvasManager;
    const worldH  = cm.view.yMax - cm.view.yMin;
    const baseH   = 20;
    const zoomPct = Math.round((baseH / worldH) * 100);
    const zBtn    = document.getElementById('zoom-reset-btn');
    if (zBtn) zBtn.title = `Reset to default view (currently ${zoomPct}%)`;
  }

  _flash(msg) {
    const el = document.getElementById('status-msg');
    if (!el) return;
    el.textContent = msg;
    setTimeout(() => { el.textContent = ''; }, 1500);
  }
}

function escHtml(s) {
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;');
}
