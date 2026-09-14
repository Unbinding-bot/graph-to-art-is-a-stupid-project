/**
 * app.js — MathDraw entry point.
 * Wires together all managers and tools.
 */

import { CanvasManager }   from './canvas/CanvasManager.js';
import { LayerManager }    from './layers/LayerManager.js';
import { ToolManager }     from './tools/ToolManager.js';
import { UIManager }       from './ui/UIManager.js';
import { FileManager }     from './file/FileManager.js';
import { ColorPicker }     from './ui/ColorPicker.js';
import { vectorizeStroke, deriveEquations, getSamplePoints } from './math/FittingPipeline.js';
import { BrushTool }       from './tools/BrushTool.js';
import { EraserTool }      from './tools/EraserTool.js';
import { FillTool }        from './tools/FillTool.js';
import { EyedropperTool }  from './tools/EyedropperTool.js';
import {
  MagicWandTool, LassoTool, PolygonalLassoTool,
  clearSelection, drawSelectionOverlay, startMarchingAnts,
} from './tools/SelectionTools.js';
import { RectangleTool, CircleTool, PolygonTool } from './tools/ShapeTools.js';
import { EditPointsTool } from './tools/EditPointsTool.js';

class App {
  constructor() {
    // ── State ──────────────────────────────────────────────────────────────
    this.foreColor = '#ffffff';
    this.backColor = '#000000';

    this.toolOptions = {
      // Brush
      brushSize:       16,
      brushOpacity:    1.0,
      brushHardness:   1.0,   // 0-1  (0 = fully soft, 1 = hard edge)
      brushSpacing:    0.25,  // fraction of diameter between dabs
      brushBlend:      'source-over',  // canvas globalCompositeOperation
      // Eraser
      eraserSize:      24,
      eraserOpacity:   1.0,
      eraserHardness:  1.0,
      // Fill
      fillMode:        'vector', // 'vector' (solid inequality) | 'raster' (pixels)
      fillTolerance:   30,
      fillOpacity:     1.0,
      fillContiguous:  true,
      fillSampleAll:   false,
      // Magic Wand
      wandTolerance:   30,
      wandContiguous:  true,
      wandSampleAll:   false,
      // Lasso / Poly-lasso
      lassoFeather:    0,
      // Shapes
      shapeStrokeWidth: 16,
      shapeFill:        false,
      shapeFillOpacity: 1.0,
      shapeFillColor:   'fore',  // 'fore' | 'back'
      shapeDash:        'solid', // 'solid' | 'dashed' | 'dotted'
      shapeFit:         false,
      rectCornerRadius: 0,
    };

    this.fitOptions = {
      linear: true, quad: true, cubic: true, circle: true,
    };

    this.selection = null; // { mask, width, height, bounds }
    this._brushAutoFit = true;
    this._brushDrawing = false;

    // ── Managers ───────────────────────────────────────────────────────────
    const container = document.getElementById('canvas-wrap');
    this.canvasManager = new CanvasManager(container);

    // Pass a deferred onChange so it only fires once this.ui exists
    this.layerManager = new LayerManager(
      this.canvasManager.W,
      this.canvasManager.H,
      () => { if (this.ui) { this.ui.refreshEquationsPanel(); this.render(); } },
    );

    this.toolManager  = new ToolManager(this);
    this.fileManager  = new FileManager(this);
    this.ui           = new UIManager(this);

    // Color picker — popup for swatch clicks, inline for the Color tab
    this.colorPicker  = new ColorPicker(document.getElementById('color-picker-popup'));
    this.colorPicker.onChange = (hex) => {
      if (this.ui?._updatingSwatches) return; // avoid feedback loop during sync
      if (this._pickingBg) {
        this.backColor = hex;
        const bg = document.getElementById('swatch-bg');
        if (bg) bg.style.background = hex;
        const dot = document.getElementById('color-dot-bg');
        if (dot) dot.style.background = hex;
      } else {
        this.foreColor = hex;
        const fg = document.getElementById('swatch-fg');
        if (fg) fg.style.background = hex;
        const dot = document.getElementById('color-dot-fg');
        if (dot) dot.style.background = hex;
      }
    };

    // Embed same picker inline in the Color tab (shares h/s/v state)
    this.colorPicker.embedIn(document.getElementById('panel-color-picker'));

    // ── Register tools ─────────────────────────────────────────────────────
    this.toolManager.register('brush',   BrushTool);
    this.toolManager.register('eraser',  EraserTool);
    this.toolManager.register('fill',    FillTool);
    this.toolManager.register('eyedrop', EyedropperTool);
    this.toolManager.register('wand',    MagicWandTool);
    this.toolManager.register('lasso',   LassoTool);
    this.toolManager.register('plasso',  PolygonalLassoTool);
    this.toolManager.register('rect',       RectangleTool);
    this.toolManager.register('circle',     CircleTool);
    this.toolManager.register('polygon',    PolygonTool);
    this.toolManager.register('editpoints', EditPointsTool);

    // Inject app reference into all tools
    for (const [, tool] of Object.entries(this.toolManager.tools)) {
      tool.app = this;
    }

    // ── Wire toolbar buttons ───────────────────────────────────────────────
    document.querySelectorAll('.tool-btn[data-tool]').forEach(btn => {
      btn.addEventListener('click', () => {
        this.toolManager.activate(btn.dataset.tool);
      });
    });

    // ── Wire color swatches ────────────────────────────────────────────────
    // (swatches are now in the right panel; wired by UIManager)

    // ── Fit Selection button ───────────────────────────────────────────────
    // (wired by UIManager via _clearSelection / _fitSelection)

    // ── Pointer events ─────────────────────────────────────────────────────
    this._bindPointerEvents();

    // ── Keyboard shortcuts ─────────────────────────────────────────────────
    this._bindKeyboard();

    // ── Resize ────────────────────────────────────────────────────────────
    window.addEventListener('resize', () => {
      this.canvasManager.resize();
      this.layerManager.resize(this.canvasManager.W, this.canvasManager.H);
      this.render();
    });

    // ── Initial state ──────────────────────────────────────────────────────
    this.toolManager.activate('brush');
    this.setForeColor('#ffffff');
    this.setBackColor('#000000');
    this.render();

    // Auto-save restore
    this.fileManager.loadAutosave().then(restored => {
      if (restored) {
        this.ui.updateStatus(null, 'Session restored');
      }
    });
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  render() {
    if (!this.ui) return;
    const cm = this.canvasManager;
    const lm = this.layerManager;

    // Regenerate raster for all layers from their vector shapes,
    // but only when not actively drawing (during a stroke the brush
    // paints dabs directly for immediate feedback).
    if (!this.ui.isEqOnlyMode() && !this._brushDrawing) {
      for (const layer of lm.layers) {
        if (layer.visible && !layer.isReference) this.redrawRasterFromShapes(layer);
      }
    }

    // Composite layers
    if (this.ui.isEqOnlyMode()) {
      cm.layerCtx.clearRect(0, 0, cm.W, cm.H);
    } else {
      cm.compositeLayerCanvas(lm.layers);
    }

    // Equation overlays (on overlay canvas)
    cm.clearOverlay();
    cm.drawEquationOverlays(lm.layers);

    // Redraw active selection overlay on top
    if (this.selection?.mask) {
      drawSelectionOverlay(this);
    }

    // Schedule auto-save
    this.fileManager.scheduleSave();
  }

  // ── Color helpers ──────────────────────────────────────────────────────────

  setForeColor(hex) {
    this.foreColor = hex;
    const fg = document.getElementById('swatch-fg');
    if (fg) fg.style.background = hex;
    const dot = document.getElementById('color-dot-fg');
    if (dot) dot.style.background = hex;
    if (this.ui) this.ui._updateSwatchActiveState();
  }

  setBackColor(hex) {
    this.backColor = hex;
    const bg = document.getElementById('swatch-bg');
    if (bg) bg.style.background = hex;
    const dot = document.getElementById('color-dot-bg');
    if (dot) dot.style.background = hex;
    if (this.ui) this.ui._updateSwatchActiveState();
  }

  // ── Cursor ring ────────────────────────────────────────────────────────────

  drawCursorRing(pos, radius, color = '#ffffff88') {
    const ctx = this.canvasManager.overlayCtx;
    const cm  = this.canvasManager;
    const lm  = this.layerManager;
    ctx.clearRect(0, 0, cm.W, cm.H);
    cm.drawEquationOverlays(lm.layers);
    if (this.selection?.mask) drawSelectionOverlay(this);
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.arc(pos.px, pos.py, Math.max(2, radius), 0, Math.PI * 2);
    ctx.stroke();
    // crosshair
    ctx.strokeStyle = color;
    const s = 4;
    ctx.beginPath();
    ctx.moveTo(pos.px - s, pos.py); ctx.lineTo(pos.px + s, pos.py);
    ctx.moveTo(pos.px, pos.py - s); ctx.lineTo(pos.px, pos.py + s);
    ctx.stroke();
    ctx.restore();
    this.ui.updateStatus(pos);
  }

  // ── Equation fitting ───────────────────────────────────────────────────────

  maybeFitStroke(worldPoints) {
    const layer = this.layerManager.activeLayer;
    if (!layer) return;
    const cm = this.canvasManager;
    const worldRange = cm.view.xMax - cm.view.xMin;
    const shape = vectorizeStroke(worldPoints, worldRange);
    if (!shape) return;

    const strokeInfo = {
      strokeColor:    this.foreColor,
      strokeSize:     this.toolOptions.brushSize,
      strokeHardness: this.toolOptions.brushHardness,
    };

    layer.addShape(shape, 'equation', strokeInfo);
    this.ui.refreshEquationsPanel();
    this.render();
  }

  // ── Raster repaint from vector geometry ────────────────────────────────────

  /**
   * After a drag, repaint all raster strokes on the layer from their live vector
   * shapes. Restores to the pre-first-stroke state, then replays each stroke.
   */
  redrawRasterFromShapes(layer) {
    if (!layer) return;
    const cm = this.canvasManager;

    // Clear the layer canvas first
    layer.ctx.clearRect(0, 0, cm.W, cm.H);

    const drawnOutlineKeys = new Set();
    for (const entry of layer.shapes) {
      if (!entry.visible) continue;
      this._renderEntry(layer.ctx, entry, cm, drawnOutlineKeys);
    }
  }

  /** Render one shape entry onto a canvas context at the current view. */
  _renderEntry(ctx, entry, cm, drawnOutlineKeys = new Set()) {
    const shape = entry.shape;
    if (!shape) return;

    // ── Static shape fill (static + inequality with geometry from shape tool) ─
    if (shape.type === 'static' && entry.mode === 'inequality') {
      if (!entry.fillColor) return;
      ctx.save();
      ctx.fillStyle = entry.fillColor;

      if (entry.isEllipse && entry.cx !== undefined) {
        // Ellipse/circle fill
        const { px: cpx, py: cpy } = cm.toPixel(entry.cx, entry.cy);
        const prx = Math.abs(cm.toPixel(entry.cx + entry.rx, entry.cy).px - cpx);
        const pry = Math.abs(cm.toPixel(entry.cx, entry.cy - entry.ry).py - cpy);
        ctx.beginPath();
        ctx.ellipse(cpx, cpy, prx, pry, 0, 0, Math.PI * 2);
        ctx.fill();
      } else if (entry.worldPts?.length >= 3) {
        // Polygon / rect fill — draw filled polygon from worldPts
        ctx.beginPath();
        entry.worldPts.forEach((p, i) => {
          const { px, py } = cm.toPixel(p.x, p.y);
          i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
        });
        ctx.closePath();
        ctx.fill();
      } else {
        // Half-plane fill — parse desmos for y-split
        const m = shape.desmos?.match(/y(?:\\ge|>=|>|<=|<)([-\d.]+)/);
        if (m) {
          const yVal = parseFloat(m[1]);
          const isAbove = shape.desmos.includes('\\ge') || shape.desmos.includes('>=') || (shape.desmos.includes('>') && !shape.desmos.includes('<'));
          const splitPy = cm.toPixel(0, yVal).py;
          if (isAbove) ctx.fillRect(0, 0, cm.W, Math.ceil(splitPy));
          else ctx.fillRect(0, Math.floor(splitPy), cm.W, cm.H - Math.floor(splitPy));
        }
      }
      ctx.restore();
      return;
    }

    // ── Shape-interior fill (real geometry, inequality) ───────────────────
    if (entry.mode === 'inequality' && shape.type !== 'static') {
      if (!entry.fillColor) return;
      this._paintFilledShape(ctx, shape, entry.fillColor, cm);
      return;
    }

    // ── Brush stroke (equation, has strokeColor) ──────────────────────────
    if (entry.strokeColor && shape.type !== 'static') {
      const color    = entry.strokeColor;
      const radius   = (entry.strokeSize ?? 16) / 2;
      const hardness = entry.strokeHardness ?? 1.0;
      const spacing  = Math.max(1, radius * 2 * 0.2);
      const worldPts = getSamplePoints(shape);
      let distAccum = 0, lastPx = null, lastPy = null;
      for (const wp of worldPts) {
        const { px, py } = cm.toPixel(wp.x, wp.y);
        if (lastPx === null) {
          this._paintDab(ctx, px, py, radius, hardness, color);
          lastPx = px; lastPy = py; continue;
        }
        const d = Math.hypot(px - lastPx, py - lastPy);
        distAccum += d;
        while (distAccum >= spacing) {
          distAccum -= spacing;
          const t = distAccum / (d || 1);
          this._paintDab(ctx, px-(px-lastPx)*t, py-(py-lastPy)*t, radius, hardness, color);
        }
        lastPx = px; lastPy = py;
      }
      return;
    }

    // ── Shape tool outline (static, equation) ────────────────────────────
    if (shape.type === 'static' && entry.mode === 'equation') {
      if (entry.skipOutline) return; // equation-only entry, no raster
      if (!entry.strokeColor) return;

      // Track outline keys so multi-entry shapes (rect→4 lines) only draw once
      if (entry.shapeOutlineKey) {
        if (drawnOutlineKeys.has(entry.shapeOutlineKey)) return;
        drawnOutlineKeys.add(entry.shapeOutlineKey);
      }

      ctx.save();
      ctx.strokeStyle = entry.strokeColor;
      ctx.lineWidth   = entry.strokeSize ?? 2;
      ctx.setLineDash([]);

      if (entry.isEllipse && entry.cx !== undefined) {
        const { px: cpx, py: cpy } = cm.toPixel(entry.cx, entry.cy);
        const prx = Math.abs(cm.toPixel(entry.cx + entry.rx, entry.cy).px - cpx);
        const pry = Math.abs(cm.toPixel(entry.cx, entry.cy - entry.ry).py - cpy);
        ctx.beginPath();
        ctx.ellipse(cpx, cpy, prx, pry, 0, 0, Math.PI * 2);
        ctx.stroke();
      } else if (shape.previewPoints?.length >= 2) {
        ctx.beginPath();
        shape.previewPoints.forEach((p, i) => {
          const { px, py } = cm.toPixel(p.x, p.y);
          i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
        });
        if (entry.shapeClosed) ctx.closePath();
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  /** Paint a filled shape interior in screen-pixel space. */
  _paintFilledShape(ctx, shape, color, cm) {
    const W = cm.W, H = cm.H;
    const rgba = this._parseHexColor(color);
    const pts = shape.type === 'circle' ? null : getSamplePoints(shape);

    // Compute screen-pixel bounding box
    let x0, x1, y0, y1;
    if (shape.type === 'circle') {
      const tl = cm.toPixel(shape.h - shape.r, shape.k + shape.r);
      const br = cm.toPixel(shape.h + shape.r, shape.k - shape.r);
      x0 = tl.px; x1 = br.px; y0 = tl.py; y1 = br.py;
    } else {
      const spx = pts.map(p => cm.toPixel(p.x, p.y));
      x0 = Math.min(...spx.map(p => p.px)); x1 = Math.max(...spx.map(p => p.px));
      y0 = Math.min(...spx.map(p => p.py)); y1 = Math.max(...spx.map(p => p.py));
    }
    x0 = Math.max(0, Math.floor(x0)); x1 = Math.min(W, Math.ceil(x1));
    y0 = Math.max(0, Math.floor(y0)); y1 = Math.min(H, Math.ceil(y1));
    if (x1 <= x0 || y1 <= y0) return;

    const imgData = ctx.getImageData(x0, y0, x1-x0, y1-y0);
    const d = imgData.data;
    for (let sy = 0; sy < y1-y0; sy++) {
      for (let sx = 0; sx < x1-x0; sx++) {
        const { x: wx, y: wy } = cm.toWorld(x0+sx, y0+sy);
        const inside = shape.type === 'circle'
          ? Math.hypot(wx-shape.h, wy-shape.k) <= shape.r
          : this._pointInPolygon(pts, wx, wy);
        if (!inside) continue;
        const i = (sy*(x1-x0)+sx)*4;
        d[i]=rgba.r; d[i+1]=rgba.g; d[i+2]=rgba.b; d[i+3]=rgba.a;
      }
    }
    ctx.putImageData(imgData, x0, y0);
  }

  _pointInPolygon(pts, wx, wy) {
    let inside = false;
    for (let i=0, j=pts.length-1; i<pts.length; j=i++) {
      const xi=pts[i].x, yi=pts[i].y, xj=pts[j].x, yj=pts[j].y;
      if (((yi>wy)!==(yj>wy)) && (wx < (xj-xi)*(wy-yi)/(yj-yi)+xi)) inside=!inside;
    }
    return inside;
  }

  _parseHexColor(hex) {
    hex = hex.replace('#','');
    if (hex.length===3) hex=hex.split('').map(c=>c+c).join('');
    return { r:parseInt(hex.slice(0,2),16), g:parseInt(hex.slice(2,4),16), b:parseInt(hex.slice(4,6),16), a:255 };
  }


  /** Paint one brush dab onto a canvas context. */
  _paintDab(ctx, px, py, radius, hardness, color) {
    ctx.save();
    if (hardness >= 0.99) {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(px, py, radius, 0, Math.PI * 2);
      ctx.fill();
    } else {
      const innerR = radius * hardness;
      const grad   = ctx.createRadialGradient(px, py, innerR, px, py, radius);
      grad.addColorStop(0, color);
      grad.addColorStop(1, color + '00');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(px, py, radius, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  _clearSelection() {
    clearSelection(this);
  }

  // ── Delete selection ──────────────────────────────────────────────────────

  deleteSelection() {
    const sel = this.selection;
    const layer = this.layerManager.activeLayer;
    if (!sel?.mask || !layer) return;
    this.layerManager.snapshot();

    const cm = this.canvasManager;
    const SW = cm.W, SH = cm.H;
    const mask = sel.mask;

    const isInsideMask = (worldPtsArr) => {
      if (!worldPtsArr?.length) return false;
      let inside = 0;
      for (const wp of worldPtsArr) {
        const { px, py } = cm.toPixel(wp.x, wp.y);
        const ix = Math.round(px), iy = Math.round(py);
        if (ix >= 0 && ix < SW && iy >= 0 && iy < SH && mask[iy * SW + ix]) inside++;
      }
      return inside / worldPtsArr.length > 0.4;
    };

    const toRemove = new Set();
    const hitOutlineKeys = new Set();

    for (const entry of layer.shapes) {
      // Get representative geometry points — prefer getSamplePoints, fall back to worldPts/previewPoints
      let pts = [];
      if (entry.shape && entry.shape.type !== 'static') {
        pts = getSamplePoints(entry.shape);
      } else {
        // Static shapes: use worldPts (render outline) or previewPoints (equation entries)
        pts = entry.worldPts ?? entry.shape?.previewPoints ?? [];
        // For ellipses, sample the perimeter
        if (!pts.length && entry.isEllipse && entry.cx !== undefined) {
          pts = Array.from({length: 32}, (_, i) => {
            const a = (i / 32) * Math.PI * 2;
            return { x: entry.cx + entry.rx * Math.cos(a), y: entry.cy + entry.ry * Math.sin(a) };
          });
        }
      }

      if (isInsideMask(pts)) {
        toRemove.add(entry.id);
        if (entry.shapeOutlineKey) hitOutlineKeys.add(entry.shapeOutlineKey);
      }
    }

    // Also remove all entries sharing a hitOutlineKey (linked equation entries)
    for (const entry of layer.shapes) {
      if (entry.shapeOutlineKey && hitOutlineKeys.has(entry.shapeOutlineKey)) {
        toRemove.add(entry.id);
      }
    }

    for (const id of toRemove) layer.removeShape(id);

    clearSelection(this);
    this.ui.refreshEquationsPanel();
    this.render();
  }

  // ── Select all (active layer non-transparent pixels) ──────────────────────

  selectAll() {
    const layer = this.layerManager.activeLayer;
    if (!layer) return;
    const W = this.canvasManager.W, H = this.canvasManager.H;
    // Full canvas mask — every pixel selected
    const mask = new Uint8Array(W * H).fill(1);
    this.selection = { mask, width: W, height: H, bounds: { x:0, y:0, w:W, h:H } };
    this.ui.showSelectionActions();
    startMarchingAnts(this);
    drawSelectionOverlay(this);
  }

  // ── Go to selection (zoom/pan view to fit selection bounds) ───────────────

  gotoSelection() {
    const cm  = this.canvasManager;
    const lm  = this.layerManager;

    // Compute world-space bounding box from all visible shapes across all layers
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;

    for (const layer of lm.layers) {
      if (!layer.visible) continue;
      for (const entry of layer.shapes) {
        if (!entry.visible || !entry.shape) continue;
        const pts = getSamplePoints(entry.shape);
        for (const p of pts) {
          if (p.x < minX) minX = p.x;
          if (p.x > maxX) maxX = p.x;
          if (p.y < minY) minY = p.y;
          if (p.y > maxY) maxY = p.y;
        }
      }
    }

    if (!isFinite(minX)) return; // nothing to go to

    // 20% padding
    const padX = Math.max((maxX - minX) * 0.2, 1);
    const padY = Math.max((maxY - minY) * 0.2, 1);
    minX -= padX; maxX += padX;
    minY -= padY; maxY += padY;

    const worldW = maxX - minX;
    const worldH = maxY - minY;
    const aspect = cm.W / cm.H;
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;

    let halfH = worldH / 2;
    let halfW = worldW / 2;
    if (worldW / worldH > aspect) halfH = halfW / aspect;
    else halfW = halfH * aspect;

    cm.view.yMin = cy - halfH;
    cm.view.yMax = cy + halfH;
    // xMin/xMax will be recomputed by resize() to match aspect ratio around cx
    cm.view.xMin = cx - halfW;
    cm.view.xMax = cx + halfW;

    cm.resize();
    this.render();
    this.ui.updateStatus(null);
  }

  // ── Selection move ────────────────────────────────────────────────────────

  /** Returns true if pixel-space point (px,py) is inside the current selection */
  _posInSelection(px, py) {
    const sel = this.selection;
    if (!sel?.mask) return false;
    const ix = Math.round(px), iy = Math.round(py);
    const W = this.canvasManager.W, H = this.canvasManager.H;
    if (ix < 0 || iy < 0 || ix >= W || iy >= H) return false;
    return !!sel.mask[iy * W + ix];
  }

  /** Lift the selected pixels off the layer onto a floating canvas, ready to drag */
  selMoveStart(px, py) {
    const sel   = this.selection;
    const layer = this.layerManager.activeLayer;
    if (!sel?.mask || !layer) return;
    this.layerManager.snapshot();

    const cm = this.canvasManager;
    const SW = cm.W, SH = cm.H;
    const mask = sel.mask;

    // Remember which shapes are inside the selection (to move them too)
    const movedShapes = [];
    for (const entry of layer.shapes) {
      if (!entry.shape) continue;
      const pts = getSamplePoints(entry.shape);
      let inside = 0;
      for (const wp of pts) {
        const { px: spx, py: spy } = cm.toPixel(wp.x, wp.y);
        const ix = Math.round(spx), iy = Math.round(spy);
        if (ix >= 0 && ix < SW && iy >= 0 && iy < SH && mask[iy * SW + ix]) inside++;
      }
      if (pts.length && inside / pts.length > 0.5) movedShapes.push(entry);
    }

    this._selMoving      = true;
    this._selMoveCanvas  = null; // not needed — raster is regenerated from vectors
    this._selMoveStartPx = { px, py };
    this._selMoveLastPx  = { px, py };
    this._selMoveShapes  = movedShapes;
  }

  selMoveUpdate(px, py) {
    if (!this._selMoving) return;
    const cm    = this.canvasManager;
    const dpx   = px - this._selMoveLastPx.px;
    const dpy   = py - this._selMoveLastPx.py;
    this._selMoveLastPx = { px, py };

    // Move each shape by the world-space delta
    const { x: wx0, y: wy0 } = cm.toWorld(0, 0);
    const { x: wx1, y: wy1 } = cm.toWorld(dpx, dpy);
    const dwx = wx1 - wx0, dwy = wy1 - wy0;

    for (const entry of this._selMoveShapes) {
      const s = entry.shape;
      if (s.type === 'circle') {
        s.h += dwx; s.k += dwy;
      } else if (s.type === 'chain') {
        for (const n of s.nodes) {
          n.x += dwx; n.y += dwy;
          n.hInX += dwx; n.hInY += dwy;
          n.hOutX += dwx; n.hOutY += dwy;
        }
      }
    }

    // Move the selection mask
    const W = cm.W, H = cm.H;
    const oldMask = this.selection.mask;
    const newMask = new Uint8Array(W * H);
    const idx = Math.round(dpx), idy = Math.round(dpy);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (!oldMask[y * W + x]) continue;
        const nx = x + idx, ny = y + idy;
        if (nx >= 0 && nx < W && ny >= 0 && ny < H) newMask[ny * W + nx] = 1;
      }
    }
    this.selection.mask = newMask;

    this.render();
    drawSelectionOverlay(this);
  }

  selMoveCommit() {
    if (!this._selMoving) return;
    this._selMoving     = false;
    this._selMoveCanvas = null;
    this._selMoveShapes = [];
    this.ui.refreshEquationsPanel();
    this.render();
    drawSelectionOverlay(this);
  }

  // ── Vector anchor dragging (works regardless of which tool is active) ───────

  /** Find the nearest draggable control point (anchor/handle) within grab range. */
  findDragTarget(px, py) {
    const cm = this.canvasManager;
    const layer = this.layerManager.activeLayer;
    if (!layer) return null;
    let best = null, bestDist = 12; // 12px grab radius
    for (const entry of layer.shapes) {
      if (!entry.visible) continue;
      const shape = entry.shape;
      if (shape.type === 'circle') {
        const c = cm.toPixel(shape.h, shape.k);
        let d = Math.hypot(c.px - px, c.py - py);
        if (d < bestDist) { bestDist = d; best = { entryId: entry.id, kind: 'circleCenter' }; }
        const ex = shape.h + shape.r * Math.cos(shape.edgeAngle), ey = shape.k + shape.r * Math.sin(shape.edgeAngle);
        const e = cm.toPixel(ex, ey);
        d = Math.hypot(e.px - px, e.py - py);
        if (d < bestDist) { bestDist = d; best = { entryId: entry.id, kind: 'circleEdge' }; }
      } else if (shape.type === 'chain') {
        shape.nodes.forEach((n, i) => {
          const p = cm.toPixel(n.x, n.y);
          const d = Math.hypot(p.px - px, p.py - py);
          if (d < bestDist) { bestDist = d; best = { entryId: entry.id, kind: 'node', nodeIndex: i }; }
        });
      }
    }
    return best;
  }

  /** Apply a drag to whichever control point is currently targeted. */
  applyDrag(target, worldX, worldY) {
    const layer = this.layerManager.activeLayer;
    if (!layer) return;
    const entry = layer.shapes.find(e => e.id === target.entryId);
    if (!entry) return;
    const shape = entry.shape;
    if (target.kind === 'circleCenter') {
      shape.h = worldX; shape.k = worldY;
    } else if (target.kind === 'circleEdge') {
      shape.r = Math.hypot(worldX - shape.h, worldY - shape.k);
      shape.edgeAngle = Math.atan2(worldY - shape.k, worldX - shape.h);
    } else if (target.kind === 'node') {
      const n = shape.nodes[target.nodeIndex];
      const dx = worldX - n.x, dy = worldY - n.y;
      // SMOOTH MODE: translate the anchor AND both its handles by the same
      // delta. Translation preserves relative direction exactly, so the
      // tangent through this point stays smooth automatically.
      n.x += dx; n.y += dy;
      n.hInX += dx; n.hInY += dy;
      n.hOutX += dx; n.hOutY += dy;
    }
  }

  _fitSelection() {    if (!this.selection?.mask) return;
    const layer = this.layerManager.activeLayer;
    if (!layer) return;
    // Not enough context to re-extract world strokes from pixels —
    // Instead we sample the mask boundary as a polygon and fit it
    const mask = this.selection.mask;
    const W = this.canvasManager.W;
    const H = this.canvasManager.H;
    const cm = this.canvasManager;

    // Collect boundary pixels as world points (every 3rd pixel for performance)
    const pts = [];
    for (let y = 0; y < H; y += 2) {
      for (let x = 0; x < W; x += 2) {
        if (!mask[y * W + x]) continue;
        const hasUnset =
          (x > 0   && !mask[y * W + x - 1]) ||
          (x < W-1 && !mask[y * W + x + 1]) ||
          (y > 0   && !mask[(y-1) * W + x]) ||
          (y < H-1 && !mask[(y+1) * W + x]);
        if (hasUnset) pts.push(cm.toWorld(x, y));
      }
    }
    if (pts.length < 4) return;
    this.maybeFitStroke(pts);
  }

  // ── Pointer events ─────────────────────────────────────────────────────────

  _bindPointerEvents() {
    const ec  = this.canvasManager.eventCanvas;
    const cm  = this.canvasManager;
    let   down      = false;
    let   panning   = false;
    let   lastPanX  = 0;
    let   lastPanY  = 0;
    let   spaceHeld = false;

    // ── Space key for pan mode ──
    document.addEventListener('keydown', (e) => {
      if (e.code === 'Space' && !e.target.matches('input,textarea')) {
        if (!spaceHeld) {
          spaceHeld = true;
          ec.style.cursor = 'grab';
        }
        e.preventDefault(); // stop page scroll
      }
    });
    document.addEventListener('keyup', (e) => {
      if (e.code === 'Space') {
        spaceHeld = false;
        if (!panning) ec.style.cursor = this.toolManager.current?.cursor ?? 'crosshair';
      }
    });

    ec.addEventListener('mousedown', (e) => {
      // Middle-mouse or Space+LMB → pan
      if (e.button === 1 || (e.button === 0 && spaceHeld)) {
        e.preventDefault();
        panning  = true;
        lastPanX = e.clientX;
        lastPanY = e.clientY;
        ec.style.cursor = 'grabbing';
        return;
      }
      if (e.button !== 0) return;
      const pos = cm.getPointerPos(e);

      // If a selection tool is active and click is inside existing selection → move mode
      const selTools = ['wand','lasso','plasso'];
      if (selTools.includes(this.toolManager.currentName) && this._posInSelection(pos.px, pos.py)) {
        this.selMoveStart(pos.px, pos.py);
        ec.style.cursor = 'move';
        return;
      }

      down = true;
      this.toolManager.onDown(pos, e);
    });

    ec.addEventListener('mousemove', (e) => {
      if (panning) {
        const dx = e.clientX - lastPanX;
        const dy = e.clientY - lastPanY;
        lastPanX = e.clientX;
        lastPanY = e.clientY;
        cm.pan(dx, dy);
        this.render();
        return;
      }

      const pos = cm.getPointerPos(e);
      if (this._selMoving) {
        this.selMoveUpdate(pos.px, pos.py);
        return;
      }
      if (down) {
        this.toolManager.onMove(pos, e);
      } else {
        this.ui.updateStatus(pos);
        const tn = this.toolManager.currentName;
        if (tn === 'brush')       this.drawCursorRing(pos, this.toolOptions.brushSize / 2);
        else if (tn === 'eraser') this.drawCursorRing(pos, this.toolOptions.eraserSize / 2, '#ff666688');
        else {
          cm.clearOverlay();
          cm.drawEquationOverlays(this.layerManager.layers);
          if (this.selection?.mask) drawSelectionOverlay(this);
          if (['plasso','polygon'].includes(tn)) this.toolManager.onMove(pos, e);
        }
      }
    });

    window.addEventListener('mouseup', (e) => {
      if (this._selMoving) {
        this.selMoveCommit();
        ec.style.cursor = this.toolManager.current?.cursor ?? 'crosshair';
        return;
      }
      if (panning) {
        panning = false;
        ec.style.cursor = spaceHeld ? 'grab' : (this.toolManager.current?.cursor ?? 'crosshair');
        return;
      }
      if (!down) return;
      down = false;
      const pos = cm.getPointerPos(e);
      this.toolManager.onUp(pos, e);
    });

    // Scroll wheel → zoom
    ec.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = ec.getBoundingClientRect();
      const px   = e.clientX - rect.left;
      const py   = e.clientY - rect.top;
      // normalise delta — trackpads send small values, wheels send multiples of 120
      const delta = e.deltaY !== 0 ? e.deltaY : e.deltaX;
      const factor = delta > 0 ? 1 / 1.1 : 1.1;
      cm.zoom(px, py, factor);
      this.render();
    }, { passive: false });

    ec.addEventListener('dblclick', (e) => {
      const pos = cm.getPointerPos(e);
      this.toolManager.onDblClick(pos, e);
    });

    // Touch
    let lastTouchDist = null;
    let lastTouchMidX = 0, lastTouchMidY = 0; // for two-finger pan
    ec.addEventListener('touchstart', (e) => {
      e.preventDefault();
      if (e.touches.length === 2) {
        lastTouchDist = Math.hypot(
          e.touches[0].clientX - e.touches[1].clientX,
          e.touches[0].clientY - e.touches[1].clientY,
        );
        lastTouchMidX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
        lastTouchMidY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
        return;
      }
      lastTouchDist = null;
      const pos = cm.getPointerPos(e);
      down = true;
      this.toolManager.onDown(pos, e);
    }, { passive: false });

    ec.addEventListener('touchmove', (e) => {
      e.preventDefault();
      if (e.touches.length === 2 && lastTouchDist !== null) {
        const dist = Math.hypot(
          e.touches[0].clientX - e.touches[1].clientX,
          e.touches[0].clientY - e.touches[1].clientY,
        );
        const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
        const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
        const rect = ec.getBoundingClientRect();

        // Pinch-to-zoom
        cm.zoom(midX - rect.left, midY - rect.top, dist / lastTouchDist);

        // Two-finger pan
        cm.pan(midX - lastTouchMidX, midY - lastTouchMidY);

        lastTouchDist = dist;
        lastTouchMidX = midX;
        lastTouchMidY = midY;
        this.render();
        return;
      }
      const pos = cm.getPointerPos(e);
      if (!down) return;
      this.toolManager.onMove(pos, e);
    }, { passive: false });

    ec.addEventListener('touchend', (e) => {
      lastTouchDist = null;
      if (!down) return;
      down = false;
      // Use changedTouches — touches[] is empty when finger lifts
      const touch = e.changedTouches[0];
      const rect  = ec.getBoundingClientRect();
      const px    = touch.clientX - rect.left;
      const py    = touch.clientY - rect.top;
      const pos   = { px, py, ...cm.toWorld(px, py) };
      this.toolManager.onUp(pos, e);
    });

    // Global touch-end: catches finger-lifts outside the canvas
    window.addEventListener('touchend', () => {
      if (this._selMoving) { this.selMoveCommit(); return; }
      if (down) {
        down = false;
        this.toolManager.onCancel?.();
      }
    }, { passive: true });
  }

  // ── Keyboard shortcuts ─────────────────────────────────────────────────────

  _bindKeyboard() {
    document.addEventListener('keydown', (e) => {
      // Don't fire shortcuts when typing in inputs
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      // Space is handled by pan logic in _bindPointerEvents
      if (e.code === 'Space') return;

      const lm = this.layerManager;

      if (e.ctrlKey || e.metaKey) {
        switch (e.key.toLowerCase()) {
          case 'z': e.preventDefault(); lm.undo(); this.ui.refreshEquationsPanel(); this.render(); break;
          case 'y': e.preventDefault(); lm.redo(); this.ui.refreshEquationsPanel(); this.render(); break;
          case 's': e.preventDefault(); this.fileManager.save(); break;
          case 'o': e.preventDefault(); document.getElementById('load-input').click(); break;
          case 'e': e.preventDefault(); this.fileManager.exportPNG(); break;
          case 'd': e.preventDefault(); clearSelection(this); break;
          case 'a': e.preventDefault(); this.selectAll(); break;
        }
        return;
      }

      switch (e.key.toLowerCase()) {
        case 'b': this.toolManager.activate('brush');      break;
        case 'e': this.toolManager.activate('eraser');     break;
        case 'v': this.toolManager.activate('editpoints'); break;
        case 'g': this.toolManager.activate('fill');    break;
        case 'i': this.toolManager.activate('eyedrop'); break;
        case 'w': this.toolManager.activate('wand');    break;
        case 'l': this.toolManager.activate('lasso');   break;
        case 'p': this.toolManager.activate('plasso');  break;
        case 'r': this.toolManager.activate('rect');    break;
        case 'c': this.toolManager.activate('circle');  break;
        case 'o': this.toolManager.activate('polygon'); break;
        case 'x': { const t=this.foreColor; this.setForeColor(this.backColor); this.setBackColor(t); break; }
        case 'delete':
        case 'backspace':
          if (this.selection?.mask) { e.preventDefault(); this.deleteSelection(); }
          break;
        case '[': {
          const tn = this.toolManager.currentName;
          if (tn==='brush')  { this.toolOptions.brushSize  = Math.max(1, this.toolOptions.brushSize  - 2); this._syncSlider('opt-brush-size',  this.toolOptions.brushSize,  'opt-brush-size-num'); }
          if (tn==='eraser') { this.toolOptions.eraserSize = Math.max(1, this.toolOptions.eraserSize - 2); this._syncSlider('opt-eraser-size', this.toolOptions.eraserSize, 'opt-eraser-size-num'); }
          break;
        }
        case ']': {
          const tn = this.toolManager.currentName;
          if (tn==='brush')  { this.toolOptions.brushSize  = Math.min(200, this.toolOptions.brushSize  + 2); this._syncSlider('opt-brush-size',  this.toolOptions.brushSize,  'opt-brush-size-num'); }
          if (tn==='eraser') { this.toolOptions.eraserSize = Math.min(200, this.toolOptions.eraserSize + 2); this._syncSlider('opt-eraser-size', this.toolOptions.eraserSize, 'opt-eraser-size-num'); }
          break;
        }
        default:
          this.toolManager.onKeyDown(e);
      }
    });
  }

  _syncSlider(sliderId, value, numId) {
    const slider = document.getElementById(sliderId);
    const numEl  = document.getElementById(numId);
    if (slider) slider.value = value;
    if (numEl)  numEl.value  = value;
  }
}

// ── Boot ──────────────────────────────────────────────────────────────────────

window.addEventListener('DOMContentLoaded', () => {
  window.app = new App();
});
