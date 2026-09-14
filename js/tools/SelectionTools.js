/**
/**
 * SelectionTools.js — MagicWand, Lasso, PolygonalLasso
 *
 * All three share the same SelectionState on app.selection:
 *   { mask: Uint8Array (0-255 for feather support), width, height, bounds }
 *
 * Mode: 'new' | 'add' | 'subtract'  (shift = add, alt = subtract)
 */

import { createTool } from './BaseTool.js';

// ── Selection helpers ────────────────────────────────────────────────────────

function buildMask(W, H) {
  return new Uint8Array(W * H);
}

function polygonToMask(polygon, W, H) {
  const mask = buildMask(W, H);
  if (polygon.length < 3) return mask;

  // Scanline rasterization
  for (let y = 0; y < H; y++) {
    const intersections = [];
    for (let i = 0; i < polygon.length; i++) {
      const a = polygon[i];
      const b = polygon[(i + 1) % polygon.length];
      if ((a.py <= y && b.py > y) || (b.py <= y && a.py > y)) {
        const t = (y - a.py) / (b.py - a.py);
        intersections.push(a.px + t * (b.px - a.px));
      }
    }
    intersections.sort((a, b) => a - b);
    for (let i = 0; i < intersections.length - 1; i += 2) {
      const x0 = Math.max(0, Math.ceil(intersections[i]));
      const x1 = Math.min(W - 1, Math.floor(intersections[i + 1]));
      for (let x = x0; x <= x1; x++) mask[y * W + x] = 1;
    }
  }
  return mask;
}

function floodFillMask(compositeCtx, sx, sy, W, H, tolerance) {
  const mask    = buildMask(W, H);
  if (sx < 0 || sy < 0 || sx >= W || sy >= H) return mask;
  const imgData = compositeCtx.getImageData(0, 0, W, H);
  const data    = imgData.data;
  const si      = (sy * W + sx) * 4;
  const tr = data[si], tg = data[si+1], tb = data[si+2], ta = data[si+3];

  const matches = (i) =>
    Math.abs(data[i]   - tr) <= tolerance &&
    Math.abs(data[i+1] - tg) <= tolerance &&
    Math.abs(data[i+2] - tb) <= tolerance &&
    Math.abs(data[i+3] - ta) <= tolerance;

  const visited = new Uint8Array(W * H);
  const queue   = [[sx, sy]];
  visited[sy * W + sx] = 1;

  while (queue.length) {
    const [x, y] = queue.pop();
    const i = (y * W + x) * 4;
    if (!matches(i)) continue;
    mask[y * W + x] = 1;
    for (const [nx, ny] of [[x-1,y],[x+1,y],[x,y-1],[x,y+1]]) {
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const ni = ny * W + nx;
      if (!visited[ni]) { visited[ni] = 1; queue.push([nx, ny]); }
    }
  }
  return mask;
}

function globalColorMask(ctx, sx, sy, W, H, tolerance) {
  const mask    = buildMask(W, H);
  if (sx < 0 || sy < 0 || sx >= W || sy >= H) return mask;
  const imgData = ctx.getImageData(0, 0, W, H);
  const data    = imgData.data;
  const si      = (sy * W + sx) * 4;
  const tr = data[si], tg = data[si+1], tb = data[si+2], ta = data[si+3];
  for (let i = 0; i < W * H; i++) {
    const d = i * 4;
    if (Math.abs(data[d]-tr)   <= tolerance &&
        Math.abs(data[d+1]-tg) <= tolerance &&
        Math.abs(data[d+2]-tb) <= tolerance &&
        Math.abs(data[d+3]-ta) <= tolerance) {
      mask[i] = 1;
    }
  }
  return mask;
}

function applyMaskMode(existing, incoming, mode, W, H) {  if (!existing || mode === 'new') return incoming;
  const result = buildMask(W, H);
  for (let i = 0; i < W * H; i++) {
    if (mode === 'add')      result[i] = existing[i] | incoming[i];
    else if (mode === 'subtract') result[i] = existing[i] & ~incoming[i];
    else result[i] = incoming[i];
  }
  return result;
}

function maskBounds(mask, W, H) {
  let minX = W, minY = H, maxX = 0, maxY = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (mask[y * W + x]) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

// ── Feather (Gaussian blur approximation on mask) ────────────────────────────

/**
 * Apply a feather (soft edge) to a binary mask using a box-blur approximation.
 * @param {Uint8Array} mask  Binary mask (0 or 1)
 * @param {number} W
 * @param {number} H
 * @param {number} radius  Feather radius in pixels
 * @returns {Uint8Array}  Feathered mask (0-255)
 */
function featherMask(mask, W, H, radius) {
  if (!radius || radius <= 0) return mask;
  // Convert to float
  const float = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) float[i] = mask[i] ? 1.0 : 0.0;

  // Box blur passes (3 passes approximates Gaussian)
  const r = Math.round(radius);
  for (let pass = 0; pass < 3; pass++) {
    const tmp = new Float32Array(W * H);
    // Horizontal
    for (let y = 0; y < H; y++) {
      let sum = 0, count = 0;
      for (let x = 0; x < Math.min(r, W); x++) { sum += float[y*W+x]; count++; }
      for (let x = 0; x < W; x++) {
        if (x + r < W)  { sum += float[y*W + x + r]; count++; }
        if (x - r - 1 >= 0) { sum -= float[y*W + x - r - 1]; count--; }
        tmp[y*W+x] = sum / count;
      }
    }
    // Vertical
    for (let x = 0; x < W; x++) {
      let sum = 0, count = 0;
      for (let y = 0; y < Math.min(r, H); y++) { sum += tmp[y*W+x]; count++; }
      for (let y = 0; y < H; y++) {
        if (y + r < H)  { sum += tmp[(y+r)*W+x]; count++; }
        if (y - r - 1 >= 0) { sum -= tmp[(y-r-1)*W+x]; count--; }
        float[y*W+x] = sum / count;
      }
    }
  }

  // Convert back to 0-255 Uint8Array
  const out = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) out[i] = Math.round(Math.max(0, Math.min(1, float[i])) * 255);
  return out;
}

// ── Marching ants overlay ─────────────────────────────────────────────────────
let _marchOffset = 0;
let _marchInterval = null;

export function startMarchingAnts(app) {
  if (_marchInterval) return;
  _marchInterval = setInterval(() => {
    _marchOffset = (_marchOffset + 1) % 12;
    if (app.selection?.mask) drawSelectionOverlay(app);
  }, 80);
}

export function stopMarchingAnts() {
  if (_marchInterval) { clearInterval(_marchInterval); _marchInterval = null; }
}

export function drawSelectionOverlay(app) {
  const sel = app.selection;
  if (!sel?.mask) return;
  const ctx = app.canvasManager.overlayCtx;
  const W   = app.canvasManager.W;
  const H   = app.canvasManager.H;

  // We redraw the full overlay
  ctx.clearRect(0, 0, W, H);
  // redraw equation overlays
  app.canvasManager.drawEquationOverlays(app.layerManager.layers);

  // draw selection border
  ctx.save();
  ctx.strokeStyle = '#fff';
  ctx.lineWidth   = 1;
  ctx.setLineDash([6, 6]);
  ctx.lineDashOffset = -_marchOffset;

  // trace the boundary of the mask by finding edge pixels
  const mask = sel.mask;
  ctx.beginPath();
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!mask[y * W + x]) continue;
      // check right / bottom neighbors for edge
      const rightEdge  = x === W - 1 || !mask[y * W + x + 1];
      const bottomEdge = y === H - 1 || !mask[(y + 1) * W + x];
      const leftEdge   = x === 0     || !mask[y * W + x - 1];
      const topEdge    = y === 0     || !mask[(y - 1) * W + x];
      if (topEdge)    { ctx.moveTo(x, y);     ctx.lineTo(x + 1, y); }
      if (bottomEdge) { ctx.moveTo(x, y + 1); ctx.lineTo(x + 1, y + 1); }
      if (leftEdge)   { ctx.moveTo(x, y);     ctx.lineTo(x, y + 1); }
      if (rightEdge)  { ctx.moveTo(x + 1, y); ctx.lineTo(x + 1, y + 1); }
    }
  }
  ctx.stroke();
  ctx.restore();
}

export function clearSelection(app) {
  app.selection = null;
  stopMarchingAnts();
  app.canvasManager.clearOverlay();
  app.canvasManager.drawEquationOverlays(app.layerManager.layers);
  app.ui.hideSelectionActions();
}

// ── MagicWandTool ─────────────────────────────────────────────────────────────

export const MagicWandTool = createTool({
  cursor: 'crosshair',

  onActivate() { this.app.ui.showOptions('wand'); },

  onDown(pos, e) {
    const mode = e.shiftKey ? 'add' : e.altKey ? 'subtract' : 'new';
    const W  = this.cm.W, H = this.cm.H;
    const sx = Math.round(pos.px), sy = Math.round(pos.py);
    const tol         = this.opts.wandTolerance  ?? 30;
    const contiguous  = this.opts.wandContiguous ?? true;
    const sampleAll   = this.opts.wandSampleAll  ?? false;

    // Determine sample source
    if (sampleAll) {
      this.cm.compositeLayerCanvas(this.lm.layers);
    }
    const sampleCtx = sampleAll ? this.cm.layerCtx : this.lm.activeLayer?.ctx;
    if (!sampleCtx) return;

    let incoming;
    if (contiguous) {
      incoming = floodFillMask(sampleCtx, sx, sy, W, H, tol);
    } else {
      // Global: select all pixels matching the clicked color anywhere
      incoming = globalColorMask(sampleCtx, sx, sy, W, H, tol);
    }

    const existing = this.app.selection?.mask ?? null;
    const mask     = applyMaskMode(existing, incoming, mode, W, H);
    this.app.selection = { mask, width: W, height: H, bounds: maskBounds(mask, W, H) };
    this.app.ui.showSelectionActions();
    startMarchingAnts(this.app);
    drawSelectionOverlay(this.app);
  },
});

// ── LassoTool ─────────────────────────────────────────────────────────────────

export const LassoTool = createTool({
  cursor: 'crosshair',
  _pts: [],
  _drawing: false,

  onActivate() { this.app.ui.showOptions('lasso'); },

  onDown(pos, e) {
    this._mode = e.shiftKey ? 'add' : e.altKey ? 'subtract' : 'new';
    this._drawing = true;
    this._pts = [{ px: pos.px, py: pos.py }];
  },

  onMove(pos) {
    if (!this._drawing) return;
    this._pts.push({ px: pos.px, py: pos.py });
    this._drawPreview();
  },

  onUp(pos) {
    if (!this._drawing) return;
    this._drawing = false;
    if (this._pts.length < 3) { this._pts = []; return; }
    const W = this.cm.W, H = this.cm.H;
    const feather  = this.opts.lassoFeather ?? 0;
    let   incoming = polygonToMask(this._pts, W, H);
    if (feather > 0) incoming = featherMask(incoming, W, H, feather);
    const existing = this.app.selection?.mask ?? null;
    const mask     = applyMaskMode(existing, incoming, this._mode, W, H);
    this.app.selection = { mask, width: W, height: H, bounds: maskBounds(mask, W, H) };
    this.app.ui.showSelectionActions();
    startMarchingAnts(this.app);
    drawSelectionOverlay(this.app);
    this._pts = [];
  },

  onCancel() { this._drawing = false; this._pts = []; },

  _drawPreview() {
    const ctx = this.cm.overlayCtx;
    ctx.clearRect(0, 0, this.cm.W, this.cm.H);
    this.cm.drawEquationOverlays(this.lm.layers);
    ctx.save();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    this._pts.forEach((p, i) => i === 0 ? ctx.moveTo(p.px, p.py) : ctx.lineTo(p.px, p.py));
    ctx.stroke();
    ctx.restore();
  },
});

// ── PolygonalLassoTool ────────────────────────────────────────────────────────

export const PolygonalLassoTool = createTool({
  cursor: 'crosshair',
  _pts: [],
  _active: false,

  onActivate() { this.app.ui.showOptions('plasso'); },
  onDeactivate() { this._pts = []; this._active = false; },

  onDown(pos, e) {
    if (!this._active) {
      this._mode   = e.shiftKey ? 'add' : e.altKey ? 'subtract' : 'new';
      this._active = true;
      this._pts    = [];
    }
    // Close if clicking near first point
    if (this._pts.length > 2) {
      const first = this._pts[0];
      const dist  = Math.hypot(pos.px - first.px, pos.py - first.py);
      if (dist < 12) {
        this._commit();
        return;
      }
    }
    this._pts.push({ px: pos.px, py: pos.py, x: pos.x, y: pos.y });
    this._drawPreview(pos);
  },

  onMove(pos) {
    if (!this._active || !this._pts.length) return;
    this._drawPreview(pos);
  },

  onDblClick() {
    if (this._active && this._pts.length >= 3) this._commit();
  },

  onKeyDown(e) {
    if (e.key === 'Escape') {
      this._pts = []; this._active = false; this.cm.clearOverlay();
      return true;
    }
    if (e.key === 'Enter' && this._active && this._pts.length >= 3) {
      this._commit(); return true;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && this._active) {
      e.preventDefault();
      if (this._pts.length > 0) {
        this._pts.pop();
        if (this._pts.length === 0) { this._active = false; this.cm.clearOverlay(); }
        else this._drawPreview(null);
      }
      return true;
    }
  },

  _commit() {
    this._active = false;
    const W = this.cm.W, H = this.cm.H;
    const feather  = this.opts.lassoFeather ?? 0;
    let   incoming = polygonToMask(this._pts, W, H);
    if (feather > 0) incoming = featherMask(incoming, W, H, feather);
    const existing = this.app.selection?.mask ?? null;
    const mask     = applyMaskMode(existing, incoming, this._mode, W, H);
    this.app.selection = { mask, width: W, height: H, bounds: maskBounds(mask, W, H) };
    this.app.ui.showSelectionActions();
    startMarchingAnts(this.app);
    drawSelectionOverlay(this.app);
    this._pts = [];
  },

  _drawPreview(cursor) {
    const ctx = this.cm.overlayCtx;
    ctx.clearRect(0, 0, this.cm.W, this.cm.H);
    this.cm.drawEquationOverlays(this.lm.layers);
    if (!this._pts.length) return;
    ctx.save();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth   = 1;
    ctx.setLineDash([5, 5]);
    ctx.fillStyle   = 'rgba(100,100,255,0.08)';
    ctx.beginPath();
    this._pts.forEach((p, i) => i === 0 ? ctx.moveTo(p.px, p.py) : ctx.lineTo(p.px, p.py));
    if (cursor) ctx.lineTo(cursor.px, cursor.py);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    // draw vertices
    ctx.setLineDash([]);
    ctx.fillStyle = '#fff';
    this._pts.forEach(p => {
      ctx.beginPath();
      ctx.arc(p.px, p.py, 3, 0, Math.PI * 2);
      ctx.fill();
    });
    // highlight first point if closeable
    if (this._pts.length > 2 && cursor) {
      const first = this._pts[0];
      const dist  = Math.hypot(cursor.px - first.px, cursor.py - first.py);
      if (dist < 12) {
        ctx.strokeStyle = '#7fddcc';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(first.px, first.py, 6, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    ctx.restore();
  },
});
