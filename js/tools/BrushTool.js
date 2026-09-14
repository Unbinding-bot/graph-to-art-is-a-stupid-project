/**
 * BrushTool — paints screen-pixel dabs onto the layer canvas.
 * The layer canvas is regenerated from vector shapes on every render(),
 * so raster content always reflects the current view at full screen resolution.
 *
 * During a live stroke (before fitting), dabs are painted directly so the
 * user sees immediate feedback. On mouseup the stroke is fitted to a vector
 * shape and the raster is then always redrawn from that vector.
 */
import { createTool } from './BaseTool.js';

export const BrushTool = createTool({
  cursor: 'none',
  _drawing: false,
  _stroke:  [],
  _lastPos: null,
  _distAccum: 0,

  onActivate() { this.app.ui.showOptions('brush'); },

  onDown(pos) {
    const layer = this.lm.activeLayer;
    if (!layer) return;
    this.lm.snapshot();
    this._drawing   = true;
    this.app._brushDrawing = true;
    this._lastPos   = pos;
    this._distAccum = 0;
    this._stroke    = [{ x: pos.x, y: pos.y }];
    this._dab(layer, pos.px, pos.py);
    this.app.render();
  },

  onMove(pos) {
    this.app.drawCursorRing(pos, this._radius());
    if (!this._drawing) return;
    const layer = this.lm.activeLayer;
    if (!layer) return;

    this._stroke.push({ x: pos.x, y: pos.y });

    const r       = this._radius();
    const spacing = Math.max(1, r * 2 * (this.opts.brushSpacing ?? 0.25));
    const dx = pos.px - (this._lastPos?.px ?? pos.px);
    const dy = pos.py - (this._lastPos?.py ?? pos.py);
    const dist = Math.hypot(dx, dy);
    this._distAccum += dist;

    if (dist > 0) {
      const steps = Math.floor(this._distAccum / spacing);
      if (steps > 0) {
        this._distAccum -= steps * spacing;
        for (let s = 1; s <= steps; s++) {
          const t  = s * spacing / dist;
          const px = (this._lastPos?.px ?? pos.px) + dx * t;
          const py = (this._lastPos?.py ?? pos.py) + dy * t;
          this._dab(layer, px, py);
        }
      }
    }

    this._lastPos = pos;
    this.app.render();
  },

  onUp() {
    if (!this._drawing) return;
    this._drawing   = false;
    this.app._brushDrawing = false;
    this._lastPos   = null;
    this._distAccum = 0;
    if (this._stroke.length > 3 && this.app._brushAutoFit !== false) {
      this.app.maybeFitStroke(this._stroke);
    }
    this._stroke = [];
  },

  onCancel() {
    this._drawing   = false;
    this.app._brushDrawing = false;
    this._stroke    = [];
    this._lastPos   = null;
    this._distAccum = 0;
  },

  _dab(layer, px, py) {
    const r        = this._radius();
    const hardness = this.opts.brushHardness ?? 1.0;
    const blendMode = this.opts.brushBlend   ?? 'source-over';
    const ctx      = layer.ctx;

    ctx.save();
    ctx.globalCompositeOperation = blendMode;

    if (hardness >= 0.99) {
      ctx.fillStyle = this.app.foreColor;
      ctx.beginPath();
      ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.fill();
    } else {
      const innerR = r * hardness;
      const grad   = ctx.createRadialGradient(px, py, innerR, px, py, r);
      grad.addColorStop(0, this.app.foreColor);
      grad.addColorStop(1, this.app.foreColor + '00');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
  },

  _radius() { return this.opts.brushSize / 2; },
});
