/**
 * ShapeTools.js — Rectangle, Circle/Ellipse, Polygon draw.
 * Draws in screen-pixel space onto the layer canvas.
 * The layer canvas is regenerated from vectors on every render(), so
 * shapes always look crisp at any zoom level.
 */

import { createTool } from './BaseTool.js';
import { fitShape, round, fmtSigned } from '../math/FittingPipeline.js';

// ── Shared ────────────────────────────────────────────────────────────────────

function applyStrokeStyle(ctx, app) {
  ctx.lineWidth   = app.toolOptions.shapeStrokeWidth ?? 2;
  ctx.strokeStyle = app.foreColor;
  ctx.setLineDash([]);
}

function applyFillStyle(ctx, app) {
  ctx.fillStyle = app.toolOptions.shapeFill ? app.foreColor : 'transparent';
}

function strokeAndCommit(app, drawFn, fitPoints, fitType, renderMeta = {}) {
  const layer = app.layerManager.activeLayer;
  if (!layer) return;
  app.layerManager.snapshot();

  const lctx = layer.ctx;
  lctx.save();
  applyStrokeStyle(lctx, app);
  applyFillStyle(lctx, app);
  drawFn(lctx);
  lctx.restore();

  const doFill = app.toolOptions.shapeFill;
  const fillColor = app.foreColor;

  const baseInfo = {
    strokeColor:  app.foreColor,
    strokeSize:   app.toolOptions.shapeStrokeWidth ?? 2,
    strokeHardness: 1.0,
    shapeClosed:  renderMeta.closed ?? false,
    shapeFilled:  doFill,
    fillColor:    doFill ? fillColor : null,
    ...renderMeta,
  };

  if (fitPoints?.length >= 1) {
    const eqs = fitShape(fitPoints, fitType);

    // One render-only entry carries the full outline geometry
    const outlineKey = `outline_${Date.now()}_${Math.random()}`;
    layer.addShape({
      type: 'static', label: null, desmos: null,
      previewPoints: renderMeta.worldPts ?? [],
    }, 'equation', { ...baseInfo, shapeOutlineKey: outlineKey });

    // Equation entries for the panel (no outline drawn for these)
    for (const eq of eqs) {
      layer.addShape({
        type: 'static', label: eq.type,
        desmos: eq.desmos, previewPoints: eq.previewPoints,
      }, 'equation', { ...baseInfo, shapeOutlineKey: outlineKey, skipOutline: true });
    }

    // Fill inequality
    if (doFill) {
      const fillEq = _shapeFillEquation(fitType, fitPoints, renderMeta, app);
      if (fillEq) {
        layer.addShape({
          type: 'static', label: fillEq.label,
          desmos: fillEq.desmos, previewPoints: [],
        }, 'inequality', { fillColor, ...renderMeta });
      }
    }
  } else {
    // Render-only entry — no desmos
    layer.addShape({
      type: 'static', label: null, desmos: null,
      previewPoints: renderMeta.worldPts ?? [],
    }, 'equation', baseInfo);
  }

  app.ui.refreshEquationsPanel();
  app.canvasManager.clearOverlay();
  app.canvasManager.drawEquationOverlays(app.layerManager.layers);
  app.render();
}

/** Generate a Desmos fill inequality for a shape tool. */
function _shapeFillEquation(fitType, fitPoints, renderMeta, app) {
  if (fitType === 'ellipse') {
    const { cx, cy, rx, ry } = fitPoints[0];
    const isCircle = Math.abs(rx - ry) < 0.001;
    if (isCircle) {
      return { label: 'Fill', desmos: `(x${fmtSigned(-cx)})^{2}+(y${fmtSigned(-cy)})^{2}<${round(rx * rx)}` };
    }
    return { label: 'Fill', desmos: `\\frac{(x${fmtSigned(-cx)})^{2}}{${round(rx * rx)}}+\\frac{(y${fmtSigned(-cy)})^{2}}{${round(ry * ry)}}<1` };
  }
  if (fitType === 'rect') {
    const [tl, tr, br, bl] = fitPoints; // x0,y0 / x1,y0 / x1,y1 / x0,y1
    const x0 = round(Math.min(tl.x, br.x)), x1 = round(Math.max(tl.x, br.x));
    const y0 = round(Math.min(tl.y, br.y)), y1 = round(Math.max(tl.y, br.y));
    return { label: 'Fill', desmos: `${y0}<y<${y1}\\left\\{${x0}<x<${x1}\\right\\}` };
  }
  if (fitType === 'polygon') {
    // Use deriveInequality on a chain shape built from the polygon pts
    const worldRange = app.canvasManager.view.xMax - app.canvasManager.view.xMin;
    const { vectorizeStroke } = app._getFittingPipeline?.() ?? {};
    // Fallback: just return null — polygon fill via FillTool click is the better UX
    return null;
  }
  return null;
}

function previewStyle(ctx, app) {
  const lw = app.toolOptions.shapeStrokeWidth ?? 2;
  ctx.lineWidth   = lw;
  ctx.strokeStyle = app.foreColor;
  ctx.setLineDash([4, 4]);
  ctx.fillStyle = app.toolOptions.shapeFill ? app.foreColor + '66' : 'transparent';
}

// ── Round-rect helper ─────────────────────────────────────────────────────────

function roundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
  ctx.beginPath();
  if (ctx.roundRect) {
    ctx.roundRect(x, y, w, h, r);
  } else {
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);     ctx.arcTo(x+w, y,   x+w, y+r,   r);
    ctx.lineTo(x + w, y + h - r); ctx.arcTo(x+w, y+h, x+w-r, y+h, r);
    ctx.lineTo(x + r, y + h);     ctx.arcTo(x,   y+h, x,   y+h-r, r);
    ctx.lineTo(x, y + r);         ctx.arcTo(x,   y,   x+r, y,     r);
    ctx.closePath();
  }
}

// ── RectangleTool ─────────────────────────────────────────────────────────────

export const RectangleTool = createTool({
  cursor: 'crosshair',
  _start: null, _shift: false,

  onActivate() { this.app.ui.showOptions('rect'); },

  onDown(pos, e) { this._start = pos; this._shift = e.shiftKey; },
  onMove(pos, e) { if (!this._start) return; this._shift = e.shiftKey; this._preview(pos); },

  onUp(pos) {
    if (!this._start) return;
    const { x0, y0, x1, y1 } = this._corners(pos);
    const { px: px0, py: py0 } = this.cm.toPixel(x0, y1);
    const { px: px1, py: py1 } = this.cm.toPixel(x1, y0);
    const radius = this.opts.rectCornerRadius ?? 0;

    const drawFn = ctx => {
      roundRect(ctx, px0, py0, px1 - px0, py1 - py0, radius);
      if (this.opts.shapeFill) ctx.fill();
      ctx.stroke();
    };

    const fitPts = [{ x:x0,y:y0 },{ x:x1,y:y0 },{ x:x1,y:y1 },{ x:x0,y:y1 }];
    strokeAndCommit(this.app, drawFn, fitPts, 'rect',
      { closed: true, worldPts: fitPts });
    this._start = null;
  },

  onCancel() { this._start = null; this.cm.clearOverlay(); this.cm.drawEquationOverlays(this.lm.layers); },

  _corners(pos) {
    let x0=this._start.x, y0=this._start.y, x1=pos.x, y1=pos.y;
    if (this._shift) {
      const s = Math.min(Math.abs(x1-x0), Math.abs(y1-y0));
      x1 = x0 + Math.sign(x1-x0)*s; y1 = y0 + Math.sign(y1-y0)*s;
    }
    return { x0:Math.min(x0,x1), y0:Math.min(y0,y1), x1:Math.max(x0,x1), y1:Math.max(y0,y1) };
  },

  _preview(pos) {
    const ctx = this.cm.overlayCtx;
    ctx.clearRect(0,0,this.cm.W,this.cm.H);
    this.cm.drawEquationOverlays(this.lm.layers);
    const { x0, y0, x1, y1 } = this._corners(pos);
    const { px:px0, py:py0 } = this.cm.toPixel(x0,y1);
    const { px:px1, py:py1 } = this.cm.toPixel(x1,y0);
    const radius = this.opts.rectCornerRadius ?? 0;
    ctx.save();
    previewStyle(ctx, this.app);
    roundRect(ctx, px0, py0, px1-px0, py1-py0, radius);
    if (this.opts.shapeFill) ctx.fill();
    ctx.stroke();
    ctx.restore();
  },
});

// ── CircleTool ────────────────────────────────────────────────────────────────

export const CircleTool = createTool({
  cursor: 'crosshair',
  _start: null, _shift: false,

  onActivate() { this.app.ui.showOptions('circle'); },

  onDown(pos, e) { this._start = pos; this._shift = e.shiftKey; },
  onMove(pos, e) { if (!this._start) return; this._shift = e.shiftKey; this._preview(pos); },

  onUp(pos) {
    if (!this._start) return;
    const { cx, cy, rx, ry } = this._params(pos);
    const { px:cpx, py:cpy } = this.cm.toPixel(cx, cy);
    const prx = Math.abs(this.cm.toPixel(cx+rx,cy).px - cpx);
    const pry = Math.abs(this.cm.toPixel(cx,cy-ry).py - cpy);

    const drawFn = ctx => {
      ctx.beginPath();
      ctx.ellipse(cpx, cpy, prx, pry, 0, 0, Math.PI*2);
      if (this.opts.shapeFill) ctx.fill();
      ctx.stroke();
    };

    // World-space ellipse perimeter points for render-only storage
    const ellipsePts = Array.from({length: 64}, (_, i) => {
      const a = (i / 64) * Math.PI * 2;
      return { x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a) };
    });
    const fitPts = [{ cx, cy, rx, ry }];
    strokeAndCommit(this.app, drawFn, fitPts, 'ellipse',
      { closed: true, worldPts: ellipsePts, isEllipse: true, cx, cy, rx, ry });
    this._start = null;
  },

  onCancel() { this._start = null; this.cm.clearOverlay(); this.cm.drawEquationOverlays(this.lm.layers); },

  _params(pos) {
    const cx=(this._start.x+pos.x)/2, cy=(this._start.y+pos.y)/2;
    let rx=Math.abs(pos.x-this._start.x)/2, ry=Math.abs(pos.y-this._start.y)/2;
    if (this._shift) { const r=Math.min(rx,ry); rx=r; ry=r; }
    return { cx, cy, rx, ry };
  },

  _preview(pos) {
    const ctx = this.cm.overlayCtx;
    ctx.clearRect(0,0,this.cm.W,this.cm.H);
    this.cm.drawEquationOverlays(this.lm.layers);
    const { cx, cy, rx, ry } = this._params(pos);
    const { px:cpx, py:cpy } = this.cm.toPixel(cx, cy);
    const prx = Math.abs(this.cm.toPixel(cx+rx,cy).px - cpx);
    const pry = Math.abs(this.cm.toPixel(cx,cy-ry).py - cpy);
    ctx.save();
    previewStyle(ctx, this.app);
    ctx.beginPath();
    ctx.ellipse(cpx, cpy, prx, pry, 0, 0, Math.PI*2);
    if (this.opts.shapeFill) ctx.fill();
    ctx.stroke();
    ctx.restore();
  },
});

// ── PolygonTool ───────────────────────────────────────────────────────────────

export const PolygonTool = createTool({
  cursor: 'crosshair',
  _pts: [], _active: false,

  onActivate() { this.app.ui.showOptions('polygon'); },
  onDeactivate() { this._pts = []; this._active = false; },

  onDown(pos, e) {
    if (!this._active) { this._active = true; this._pts = []; }
    if (this._pts.length > 2) {
      const first = this._pts[0];
      if (Math.hypot(pos.px-first.px, pos.py-first.py) < 12) { this._commit(); return; }
    }
    this._pts.push({ px:pos.px, py:pos.py, x:pos.x, y:pos.y });
    this._preview(pos);
  },

  onMove(pos) { if (this._active && this._pts.length) this._preview(pos); },
  onDblClick() { if (this._active && this._pts.length >= 3) this._commit(); },

  onKeyDown(e) {
    if (e.key === 'Escape') {
      this._pts=[]; this._active=false;
      this.cm.clearOverlay(); this.cm.drawEquationOverlays(this.lm.layers);
      return true;
    }
    if (e.key === 'Enter' && this._active && this._pts.length >= 3) {
      this._commit(); return true;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && this._active) {
      e.preventDefault();
      if (this._pts.length > 0) {
        this._pts.pop();
        if (this._pts.length === 0) { this._active = false; this.cm.clearOverlay(); this.cm.drawEquationOverlays(this.lm.layers); }
        else this._preview(null);
      }
      return true; // consumed — don't fire global undo
    }
  },

  _commit() {
    this._active = false;
    const pts = this._pts;
    if (pts.length < 2) { this._pts=[]; return; }

    const drawFn = ctx => {
      ctx.beginPath();
      pts.forEach((p,i) => i===0 ? ctx.moveTo(p.px,p.py) : ctx.lineTo(p.px,p.py));
      ctx.closePath();
      if (this.opts.shapeFill) ctx.fill();
      ctx.stroke();
    };

    const fitPts = pts.map(p => ({ x:p.x, y:p.y }));
    strokeAndCommit(this.app, drawFn, [...fitPts, fitPts[0]], 'polygon',
      { closed: true, worldPts: fitPts });
    this._pts = [];
  },

  _preview(cursor) {
    const ctx = this.cm.overlayCtx;
    ctx.clearRect(0,0,this.cm.W,this.cm.H);
    this.cm.drawEquationOverlays(this.lm.layers);
    if (!this._pts.length) return;
    ctx.save();
    previewStyle(ctx, this.app);
    if (this.opts.shapeFill) {
      ctx.beginPath();
      this._pts.forEach((p,i) => i===0 ? ctx.moveTo(p.px,p.py) : ctx.lineTo(p.px,p.py));
      if (cursor) ctx.lineTo(cursor.px, cursor.py);
      ctx.closePath();
      ctx.fill();
    }
    ctx.beginPath();
    this._pts.forEach((p,i) => i===0 ? ctx.moveTo(p.px,p.py) : ctx.lineTo(p.px,p.py));
    if (cursor) ctx.lineTo(cursor.px, cursor.py);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = this.app.foreColor;
    this._pts.forEach(p => { ctx.beginPath(); ctx.arc(p.px,p.py,3,0,Math.PI*2); ctx.fill(); });
    if (this._pts.length > 2 && cursor) {
      const first = this._pts[0];
      if (Math.hypot(cursor.px-first.px, cursor.py-first.py) < 12) {
        ctx.strokeStyle = '#7fddcc'; ctx.lineWidth = 2; ctx.setLineDash([]);
        ctx.beginPath(); ctx.arc(first.px,first.py,6,0,Math.PI*2); ctx.stroke();
      }
    }
    ctx.restore();
  },
});
