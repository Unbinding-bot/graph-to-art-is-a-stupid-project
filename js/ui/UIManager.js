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

/**
 * Convert a single Desmos expression string to GeoGebra syntax.
 *
 * Handles:
 *  - Parametric Bézier curves: ((expr),(expr)) → Curve(x,y,t,0,1)
 *  - Line equations with domain restriction: y=mx+b\{a≤x≤b\} → Segment
 *  - Vertical lines: x=a\{y1≤y≤y2\} → Segment
 *  - Inequality regions: lo<y<hi\{x0≤x≤x1\} → Polygon (filled rect)
 *  - Circle/ellipse: (x-h)²+(y-k)²=r² → Circle / Ellipse GeoGebra commands
 *  - Ellipse standard form: (x-h)²/a²+(y-k)²/b²=1 → Ellipse command
 *  - Half-plane inequalities: y>c, y<c, y≥c, y≤c → stays as-is (GeoGebra accepts)
 */
function desmosToGeoGebra(desmos) {
  if (!desmos) return '';

  // ── Strip LaTeX formatting ─────────────────────────────────────────────
  let s = desmos
    .replace(/\^\{(\d+)\}/g, '^$1')       // x^{2} → x^2
    .replace(/\\left\\{/g, '{')            // \left\{ → {
    .replace(/\\right\\}/g, '}')           // \right\} → }
    .replace(/\\le/g, '<=')               // \le → <=
    .replace(/\\ge/g, '>=')               // \ge → >=
    .replace(/\\frac\{([^}]+)\}\{([^}]+)\}/g, '($1)/($2)') // \frac{a}{b} → (a)/(b)
    .replace(/\\\\/g, '');                  // stray backslashes

  // ── Parametric curve: ((x-expr),(y-expr)) ─────────────────────────────
  // Desmos: ((1-t)^3*A+..., (1-t)^3*B+...)
  const paramMatch = s.match(/^\(\s*(.+)\s*,\s*(.+)\s*\)$/);
  if (paramMatch) {
    let xExpr = paramMatch[1].trim();
    let yExpr = paramMatch[2].trim();
    // Wrap negative literals after * so GeoGebra doesn't choke: *-8 → *(-8)
    const fixNegs = e => e.replace(/\*(-\d+\.?\d*)/g, '*($1)');
    // Insert explicit * wherever implicit multiplication would be ambiguous:
    //   (1-t)^2t  → (1-t)^2*t   (digit-exponent followed by 't')
    //   3(1-t)    → 3*(1-t)     (digit followed by open paren)
    //   )t        → )*t         (closing paren followed by 't')
    //   )(         → )*(         (closing paren followed by open paren)
    const fixImpl = e => e
      .replace(/(\d)t/g, '$1*t')        // 2t → 2*t  (covers ^2t → ^2*t)
      .replace(/(\d)\(/g, '$1*(')       // 3( → 3*(
      .replace(/\)\(/g, ')*(')          // )( → )*(
      .replace(/\)t/g, ')*t');          // )t → )*t
    xExpr = fixImpl(fixNegs(xExpr));
    yExpr = fixImpl(fixNegs(yExpr));
    return `Curve(${xExpr}, ${yExpr}, t, 0, 1)`;
  }

  // ── Circle: (x-h)^2+(y-k)^2=r^2 ──────────────────────────────────────
  const circleEq = s.match(/^\(x([+-]\d+\.?\d*)?\)?\^2\+\(y([+-]\d+\.?\d*)?\)?\^2=(\d+\.?\d*)$/);
  if (circleEq) {
    const h  = circleEq[1] ? -parseFloat(circleEq[1]) : 0;
    const k  = circleEq[2] ? -parseFloat(circleEq[2]) : 0;
    const r2 = parseFloat(circleEq[3]);
    const r  = Math.sqrt(r2).toFixed(4);
    return `Circle((${h},${k}),${r})`;
  }

  // ── Ellipse: (x-h)^2/a^2+(y-k)^2/b^2=1 ───────────────────────────────
  const ellipseEq = s.match(/^\(x([+-]\d+\.?\d*)?\)?\^2\/(\d+\.?\d*)\+\(y([+-]\d+\.?\d*)?\)?\^2\/(\d+\.?\d*)=1$/);
  if (ellipseEq) {
    const h  = ellipseEq[1] ? -parseFloat(ellipseEq[1]) : 0;
    const a  = Math.sqrt(parseFloat(ellipseEq[2])).toFixed(4);
    const k  = ellipseEq[3] ? -parseFloat(ellipseEq[3]) : 0;
    const b  = Math.sqrt(parseFloat(ellipseEq[4])).toFixed(4);
    // GeoGebra Ellipse needs two foci + semi-major — easier to use implicit form
    // Implicit: (x-h)^2/a^2+(y-k)^2/b^2=1 — GeoGebra CAS accepts this directly
    return `(x${h>=0?'-'+h:'+'+(-h)})^2/${(+a*+a).toFixed(4)}+(y${k>=0?'-'+k:'+'+(-k)})^2/${(+b*+b).toFixed(4)}=1`;
  }

  // ── Domain-restricted line/segment ────────────────────────────────────
  // Pattern: y=mx+b{x0<=x<=x1} or x=a{y0<=y<=y1}
  const domainMatch = s.match(/^(.+)\{(.+)<=(.+)<=(.+)\}$/);
  if (domainMatch) {
    const expr   = domainMatch[1].trim();
    const lo     = domainMatch[2].trim();
    const hi     = domainMatch[4].trim();

    // Vertical line: x=a{y0<=y<=y1}
    const vertMatch = expr.match(/^x=(-?\d+\.?\d*)$/);
    if (vertMatch) {
      const x = vertMatch[1];
      return `Segment((${x},${lo}),(${x},${hi}))`;
    }

    // Horizontal or sloped line: y=mx+b{x0<=x<=x1}
    const lineMatch = expr.match(/^y=(.+)$/);
    if (lineMatch) {
      // Evaluate y at x=lo and x=hi by substituting
      const evalLine = (xVal, expr) => {
        try { return Function('x', `return ${expr.replace(/(\d)(x)/g,'$1*$2')}`)( parseFloat(xVal) ).toFixed(4); }
        catch { return '0'; }
      };
      const lineExpr = lineMatch[1];
      const y0 = evalLine(lo, lineExpr);
      const y1 = evalLine(hi, lineExpr);
      return `Segment((${lo},${y0}),(${hi},${y1}))`;
    }
  }

  // ── Filled rectangle inequality: lo<y<hi{x0<x<x1} ────────────────────
  const fillMatch = s.match(/^(-?\d+\.?\d*)<y<(-?\d+\.?\d*)\{(-?\d+\.?\d*)<x<(-?\d+\.?\d*)\}$/);
  if (fillMatch) {
    const [,y0,y1,x0,x1] = fillMatch;
    return `Polygon((${x0},${y0}),(${x1},${y0}),(${x1},${y1}),(${x0},${y1}))`;
  }

  // ── Half-plane inequalities: GeoGebra accepts these natively ─────────
  if (/^y[<>]=?\d/.test(s) || /^y[<>]=?-\d/.test(s)) return s;

  // ── Fallback: return as-is (may or may not work in GeoGebra) ──────────
  return s;
}

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

    // Add reference image
    document.getElementById('add-reference-btn')?.addEventListener('click', () => {
      document.getElementById('reference-input').click();
    });
    document.getElementById('reference-input')?.addEventListener('change', e => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = ev => {
        this.app.layerManager.addReferenceLayer(file.name.replace(/\.[^.]+$/, ''), ev.target.result);
        this.refreshLayerPanel();
        this.app.render();
      };
      reader.readAsDataURL(file);
      e.target.value = '';
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

    // Copy all equations — Desmos format
    document.getElementById('eq-copy-desmos-btn')?.addEventListener('click', () => {
      const lines = this._collectDesmos();
      if (!lines.length) { this._flash('Nothing to copy'); return; }
      this._copyText(lines.join('\n'), 'Copied for Desmos!');
    });

    // Copy all equations — GeoGebra format
    document.getElementById('eq-copy-geo-btn')?.addEventListener('click', () => {
      const geoExprs = this._collectDesmos().map(desmosToGeoGebra).filter(Boolean);
      if (!geoExprs.length) { this._flash('Nothing to export'); return; }
      this._exportGGBFile(geoExprs);
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

    // Mobile UI (no-op on desktop)
    this._initMobile();

    // On mobile, resize canvas after layout settles so margins are accounted for
    if (window.matchMedia('(max-width: 640px)').matches) {
      requestAnimationFrame(() => {
        this.app.canvasManager.resize();
        this.app.layerManager.resize(this.app.canvasManager.W, this.app.canvasManager.H);
        this.app.render();
      });
    }
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
      if (layer.isReference) div.className += ' layer-reference';
      div.dataset.layerId = layer.id;

      const thumb = document.createElement('canvas');
      thumb.className = 'layer-thumb';
      thumb.width  = 32;
      thumb.height = 32;
      thumb.getContext('2d').drawImage(layer.canvas, 0, 0, 32, 32);

      if (layer.isReference) {
        // Reference layer: show opacity controls, no dup/merge
        const opPct = Math.round(layer.opacity * 100);
        div.innerHTML = `
          <div class="layer-row1">
            <button class="layer-vis-btn" data-id="${layer.id}" title="Toggle visibility">
              ${layer.visible ? '👁' : '🚫'}
            </button>
            <input class="layer-name" data-id="${layer.id}" value="${escHtml(layer.name)}" title="Double-click to rename">
            <span style="font-size:9px;color:var(--accent-hi);font-weight:700;letter-spacing:.05em;flex-shrink:0">REF</span>
            <div class="layer-actions">
              <button class="layer-action-btn danger" data-action="del" data-id="${layer.id}" title="Delete">✕</button>
            </div>
          </div>
          <div class="layer-row2" style="display:flex;align-items:center;gap:6px;margin-top:5px">
            <label style="font-size:11px;color:var(--text-dim);min-width:44px">Opacity</label>
            <input type="range" class="opt-slider ref-opacity-slider" min="0" max="100"
                   value="${opPct}" data-id="${layer.id}">
            <input type="number" class="opt-num ref-opacity-num" min="0" max="100"
                   value="${opPct}" data-id="${layer.id}" style="width:40px">
          </div>`;
      } else {
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
      }

      div.querySelector('.layer-row1').insertAdjacentElement('afterbegin', thumb);
      list.appendChild(div);

      div.addEventListener('click', (e) => {
        if (e.target.closest('button,input')) return;
        if (!layer.isReference) lm.setActive(layer.id);
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

      if (layer.isReference) {
        // Opacity slider+number sync
        const slider = div.querySelector('.ref-opacity-slider');
        const num    = div.querySelector('.ref-opacity-num');
        const apply  = v => {
          v = Math.max(0, Math.min(100, v));
          layer.opacity = v / 100;
          slider.value = v;
          num.value    = v;
          this.app.render();
        };
        slider.addEventListener('input',  () => apply(+slider.value));
        num.addEventListener('change',    () => apply(+num.value));
        num.addEventListener('keydown',   e => { if (e.key === 'Enter') apply(+num.value); });
      } else {
        div.querySelector('[data-action="dup"]')?.addEventListener('click', (e) => {
          e.stopPropagation(); lm.duplicateLayer(layer.id); this.refreshLayerPanel(); this.app.render();
        });
        div.querySelector('[data-action="merge"]')?.addEventListener('click', (e) => {
          e.stopPropagation(); lm.mergeDown(layer.id); this.refreshLayerPanel(); this.app.render();
        });
      }

      div.querySelector('[data-action="del"]').addEventListener('click', (e) => {
        e.stopPropagation(); lm.removeLayer(layer.id); this.refreshLayerPanel(); this.app.render();
      });

      if (!layer.isReference) {
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
      }
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
                <div style="display:flex;gap:3px">
                  <button class="eq-line-copy-btn" data-lineidx="${li}" data-fmt="desmos" title="Copy for Desmos">D↗</button>
                  <button class="eq-line-copy-btn" data-lineidx="${li}" data-fmt="geo"    title="Copy for GeoGebra">G↗</button>
                </div>
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
            const li     = +btn.dataset.lineidx;
            const desmos = lines[li]?.desmos;
            if (!desmos) return;
            const geo = btn.dataset.fmt === 'geo';
            const text = geo ? desmosToGeoGebra(desmos) : desmos;
            this._copyText(text, 'Copied!');
          });
        });

        section.appendChild(item);
      });
      container.appendChild(section);
    });

    if (!container.children.length) {
      container.innerHTML = '<div style="color:var(--text-dim);font-size:12px;padding:8px 0">No equations yet. Draw a stroke to fit one.</div>';
    }
    // Keep mobile mirror in sync
    const mDst = document.getElementById('mobile-equations-list');
    if (mDst) mDst.innerHTML = container.innerHTML;

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
        this._copyText(text, 'Copied!');
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

  /** Collect all visible Desmos expression strings across all layers. */
  _collectDesmos() {
    const worldRange = this.app.canvasManager.view.xMax - this.app.canvasManager.view.xMin;
    return this.app.layerManager.layers
      .flatMap(l => l.shapes)
      .filter(e => e.visible)
      .flatMap(e => e.mode === 'inequality'
        ? deriveInequality(e.shape, this.app.fitOptions, worldRange)
        : deriveEquations(e.shape, this.app.fitOptions, worldRange))
      .map(eq => eq.desmos)
      .filter(Boolean);
  }

  /** Export all equations as a GeoGebra .ggb file. */
  async _exportGGBFile(geoExprs) {
    // Build the geogebra.xml content
    const expElements = geoExprs.map((expr, i) => {
      const label = `f${i + 1}`;
      // Escape XML special chars in the expression
      const escaped = expr
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
      return `\t\t<expression label="${label}" exp="${escaped}"/>`;
    }).join('\n');

    const xml = `<?xml version="1.0" encoding="utf-8"?>
<geogebra format="5.0" version="5.0.0.0" app="graphing" platform="w">
\t<gui>
\t\t<font size="16"/>
\t</gui>
\t<euclidianView>
\t\t<viewNumber viewNo="1"/>
\t\t<coordSystem xZero="0" yZero="0" scale="50" yscale="50"/>
\t\t<evSettings axes="true" grid="true"/>
\t\t<bgColor r="255" g="255" b="255"/>
\t\t<axesColor r="0" g="0" b="0"/>
\t\t<gridColor r="192" g="192" b="192"/>
\t\t<lineStyle thickness="1" type="0" typeHidden="1"/>
\t</euclidianView>
\t<kernel>
\t\t<continuous val="false"/>
\t\t<decimals val="3"/>
\t\t<angleUnit val="degree"/>
\t\t<coordStyle val="0"/>
\t</kernel>
\t<construction>
${expElements}
\t</construction>
</geogebra>`;

    try {
      const JSZip = window.JSZip;
      if (!JSZip) { this._flash('JSZip not loaded'); return; }
      const zip = new JSZip();
      zip.file('geogebra.xml', xml);
      const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href     = url;
      a.download = 'drawing.ggb';
      a.click();
      URL.revokeObjectURL(url);
      this._flash('Exported drawing.ggb!');
    } catch (err) {
      console.error('GGBexport:', err);
      this._flash('Export failed');
    }
  }
  _copyText(text, successMsg) {
    navigator.clipboard.writeText(text)
      .then(() => this._flash(successMsg))
      .catch(() => {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
        document.body.appendChild(ta);
        ta.focus(); ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        this._flash(successMsg);
      });
  }

  // ── Mobile UI ─────────────────────────────────────────────────────────────

  _initMobile() {
    // Build toolstrip without cloning — fresh buttons with data-tool attributes
    const toolstrip = document.getElementById('mobile-toolstrip');
    if (toolstrip) {
      // Copy SVG icon content from each existing toolbar button
      document.querySelectorAll('#toolbar .tool-btn[data-tool]').forEach(src => {
        const btn = document.createElement('button');
        btn.className = src.className;
        btn.dataset.tool = src.dataset.tool;
        btn.innerHTML = src.innerHTML;
        btn.addEventListener('click', () => this.app.toolManager.activate(src.dataset.tool));
        toolstrip.appendChild(btn);
      });

      // Add separators and color swatches at the end
      const sep = document.createElement('div'); sep.className = 'tool-sep'; toolstrip.appendChild(sep);

      // Foreground swatch
      const fgBtn = document.createElement('div');
      fgBtn.className = 'tool-btn';
      fgBtn.style.cssText = 'position:relative;width:44px;height:44px';
      fgBtn.innerHTML = `
        <div style="position:absolute;width:22px;height:22px;top:4px;left:4px;border:2px solid var(--text);border-radius:5px;background:${this.app.foreColor};cursor:pointer;z-index:1" id="m-swatch-fg"></div>
        <div style="position:absolute;width:22px;height:22px;bottom:4px;right:4px;border:2px solid var(--surface2);border-radius:5px;background:${this.app.backColor};cursor:pointer" id="m-swatch-bg"></div>`;
      fgBtn.querySelector('#m-swatch-fg')?.addEventListener('click', e => {
        this.app._pickingBg = false;
        this.app.colorPicker.open(this.app.foreColor, e.currentTarget);
      });
      fgBtn.querySelector('#m-swatch-bg')?.addEventListener('click', e => {
        this.app._pickingBg = true;
        this.app.colorPicker.open(this.app.backColor, e.currentTarget);
      });
      toolstrip.appendChild(fgBtn);
    }

    // ── Bottom nav sheet toggling ──
    const sheet = document.getElementById('mobile-sheet');
    let activeNavBtn = null;

    document.querySelectorAll('.mobile-nav-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const section = btn.dataset.sheet;
        const isOpen  = sheet?.classList.contains('open');
        const isSame  = activeNavBtn === btn;

        if (isOpen && isSame) {
          sheet?.classList.remove('open');
          btn.classList.remove('active');
          activeNavBtn = null;
          return;
        }

        document.querySelectorAll('.mobile-nav-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.mobile-sheet-section').forEach(s => s.classList.remove('active'));
        btn.classList.add('active');
        document.querySelector(`.mobile-sheet-section[data-section="${section}"]`)?.classList.add('active');
        sheet?.classList.add('open');
        activeNavBtn = btn;

        if (section === 'layers')    this._refreshMobileLayers();
        if (section === 'equations') this._refreshMobileEquations();
        if (section === 'tools')     this._refreshMobileToolOpts();
      });
    });

    // Swipe down on handle to close
    const handle = document.getElementById('mobile-sheet-handle');
    if (handle && sheet) {
      let ty0 = 0;
      handle.addEventListener('touchstart', e => { ty0 = e.touches[0].clientY; }, { passive: true });
      handle.addEventListener('touchend', e => {
        if (e.changedTouches[0].clientY - ty0 > 50) {
          sheet.classList.remove('open');
          document.querySelectorAll('.mobile-nav-btn').forEach(b => b.classList.remove('active'));
          activeNavBtn = null;
        }
      }, { passive: true });
    }

    // ── Options buttons ──
    document.getElementById('mobile-zoom-reset-btn')?.addEventListener('click', () => {
      const cm = this.app.canvasManager;
      cm.view = { xMin: -10, xMax: 10, yMin: -10, yMax: 10 };
      cm.resize(); this.app.render();
    });
    document.getElementById('mobile-save-btn')?.addEventListener('click',   () => this.app.fileManager.save());
    document.getElementById('mobile-load-btn')?.addEventListener('click',   () => document.getElementById('load-input').click());
    document.getElementById('mobile-export-btn')?.addEventListener('click', () => this.app.fileManager.exportPNG());
    document.getElementById('mobile-undo-btn')?.addEventListener('click',   () => { this.app.layerManager.undo(); this.refreshEquationsPanel(); this.app.render(); });
    document.getElementById('mobile-redo-btn')?.addEventListener('click',   () => { this.app.layerManager.redo(); this.refreshEquationsPanel(); this.app.render(); });

    // Fit checkboxes sync
    ['Linear','Quad','Cubic','Circle'].forEach(name => {
      document.getElementById(`mobile-chk${name}`)?.addEventListener('change', e => {
        this.app.fitOptions[name.toLowerCase()] = e.target.checked;
        const d = document.getElementById(`chk${name}`);
        if (d) d.checked = e.target.checked;
        this.refreshEquationsPanel();
      });
    });

    // Equations copy buttons delegate to desktop equivalents
    document.getElementById('mobile-eq-copy-all-btn')?.addEventListener('click', () => document.getElementById('eq-copy-desmos-btn')?.click());
    document.getElementById('mobile-eq-only-btn')?.addEventListener('click',     () => document.getElementById('eq-only-btn')?.click());

    // Layer add
    document.getElementById('mobile-layer-add-btn')?.addEventListener('click', () => {
      this.app.layerManager.addLayer(); this._refreshMobileLayers(); this.app.render();
    });

    // Keep toolstrip active state in sync via setActiveTool override
    const _origSetActive = this.setActiveTool.bind(this);
    this.setActiveTool = (name) => {
      _origSetActive(name);
      toolstrip?.querySelectorAll('.tool-btn[data-tool]').forEach(b => {
        b.classList.toggle('active', b.dataset.tool === name);
      });
      this._refreshMobileToolOpts();
    };

    // Sync swatch colors when foreColor/backColor change
    const _origSetFore = this.app.setForeColor.bind(this.app);
    this.app.setForeColor = (hex) => {
      _origSetFore(hex);
      const el = document.getElementById('m-swatch-fg');
      if (el) el.style.background = hex;
    };
    const _origSetBack = this.app.setBackColor.bind(this.app);
    this.app.setBackColor = (hex) => {
      _origSetBack(hex);
      const el = document.getElementById('m-swatch-bg');
      if (el) el.style.background = hex;
    };
  }

  _refreshMobileToolOpts() {
    const mount = document.getElementById('mobile-tool-opts-mount');
    if (!mount) return;
    mount.innerHTML = '';
    const toolName = this.app.toolManager.currentName;
    const header   = document.createElement('div');
    header.style.cssText = 'font-size:10px;font-weight:700;color:var(--accent-hi);letter-spacing:.08em;text-transform:uppercase;padding:4px 0 10px';
    header.textContent   = document.getElementById('tool-name-label')?.textContent ?? '';
    mount.appendChild(header);
    const src = document.querySelector(`#panel-tool-opts .panel-opts-group[data-panel-opts="${toolName}"]`);
    if (src) {
      const clone = src.cloneNode(true);
      clone.style.display = 'flex';
      mount.appendChild(clone);
    }
  }

  _refreshMobileLayers() {
    const lm     = this.app.layerManager;
    const list   = document.getElementById('mobile-layer-list');
    if (!list) return;
    // Reuse the same render logic as the desktop layer panel but target mobile-layer-list
    const tmp = document.getElementById('layer-list');
    if (tmp) list.innerHTML = tmp.innerHTML;
  }

  _refreshMobileEquations() {
    const src = document.getElementById('equations-list');
    const dst = document.getElementById('mobile-equations-list');
    if (src && dst) dst.innerHTML = src.innerHTML;
  }
}

function escHtml(s) {
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;');
}
