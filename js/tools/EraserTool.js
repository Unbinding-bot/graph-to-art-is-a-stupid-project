import { createTool } from './BaseTool.js';
import { getSamplePoints, vectorizeStroke } from '../math/FittingPipeline.js';

export const EraserTool = createTool({
  cursor: 'none',
  _drawing: false,
  _last:    null,
  _erasedWorld: [], // world-space points erased this stroke

  onActivate() { this.app.ui.showOptions('eraser'); },

  onDown(pos) {
    const layer = this.lm.activeLayer;
    if (!layer) return;
    this.lm.snapshot();
    this._drawing     = true;
    this._last        = pos;
    this._erasedWorld = [{ x: pos.x, y: pos.y }];
    // No raster erase needed — raster is regenerated from shapes.
    // Just remove shapes that were hit.
    this.app.render();
  },

  onMove(pos) {
    this.app.drawCursorRing(pos, this._radius(), '#ff6666');
    if (!this._drawing) return;
    this._erasedWorld.push({ x: pos.x, y: pos.y });
    this._last = pos;
    this.app.render();
  },

  onUp() {
    if (!this._drawing) return;
    this._drawing = false;
    const layer = this.lm.activeLayer;
    if (layer) this._removeErasedShapes(layer);
    this._last        = null;
    this._erasedWorld = [];
  },
  onCancel() { this._drawing = false; this._last = null; this._erasedWorld = []; },

  _removeErasedShapes(layer) {
    const cm         = this.app.canvasManager;
    const worldRange = cm.view.xMax - cm.view.xMin;
    const viewYSpan  = cm.view.yMax - cm.view.yMin;
    const radiusWorld = this.opts.eraserSize / cm.H * viewYSpan;

    const toAdd    = [];
    const toRemove = [];

    for (const entry of layer.shapes) {
      if (!entry.shape) continue;
      const pts = getSamplePoints(entry.shape);

      const erased = pts.map(wp =>
        this._erasedWorld.some(ew => Math.hypot(wp.x - ew.x, wp.y - ew.y) <= radiusWorld)
      );

      if (!erased.some(Boolean)) continue;

      toRemove.push(entry.id);

      let run = [];
      for (let i = 0; i <= pts.length; i++) {
        if (i < pts.length && !erased[i]) {
          run.push(pts[i]);
        } else if (run.length >= 4) {
          const newShape = vectorizeStroke(run, worldRange);
          if (newShape) {
            toAdd.push({
              shape: newShape,
              mode:  entry.mode,
              strokeColor:    entry.strokeColor,
              strokeSize:     entry.strokeSize,
              strokeHardness: entry.strokeHardness,
            });
          }
          run = [];
        } else {
          run = [];
        }
      }
    }

    if (!toRemove.length) return;
    for (const id of toRemove) layer.removeShape(id);
    for (const info of toAdd) layer.addShape(info.shape, info.mode, info);
    this.app.ui.refreshEquationsPanel();
    this.app.render();
  },

  _radius() { return this.opts.eraserSize / 2; },
});
