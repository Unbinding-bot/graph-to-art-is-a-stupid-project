/**
 * FillTool — vector fill with raster preview.
 * Raster is drawn in screen-pixel space (layer canvas is screen-sized).
 */
import { createTool } from './BaseTool.js';
import { pointInShape, deriveInequality, getSamplePoints, round } from '../math/FittingPipeline.js';

function pointInPolygon(pts, wx, wy) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i].x, yi = pts[i].y, xj = pts[j].x, yj = pts[j].y;
    const intersects = ((yi > wy) !== (yj > wy)) && (wx < (xj - xi) * (wy - yi) / (yj - yi) + xi);
    if (intersects) inside = !inside;
  }
  return inside;
}

export const FillTool = createTool({
  cursor: 'cell',

  onActivate() { this.app.ui.showOptions('fill'); },

  onDown(pos) {
    const layer = this.lm.activeLayer;
    if (!layer) return;

    const worldRange = this.cm.view.xMax - this.cm.view.xMin;
    const color = this.app.foreColor;

    // ── Click inside a fitted shape → fill its interior ────────────────────
    for (let i = layer.shapes.length - 1; i >= 0; i--) {
      const entry = layer.shapes[i];
      if (!entry.visible || entry.shape.type === 'static') continue;
      if (pointInShape(entry.shape, pos.x, pos.y)) {
        this.lm.snapshot();
        const lines = deriveInequality(entry.shape, this.app.fitOptions, worldRange);
        if (lines.length) {
          layer.addShape(entry.shape, 'inequality', {
            strokeColor:    color,
            strokeSize:     this.opts.brushSize ?? 16,
            strokeHardness: 1.0,
            fillColor:      color,
          });
          this.app.ui.refreshEquationsPanel();
          this.app.render();
          return;
        }
      }
    }

    // ── Empty space → two complementary half-planes covering the whole canvas
    this.lm.snapshot();
    const yVal = round(pos.y, 3);

    const shapeAbove = {
      type: 'static', label: `y ≥ ${yVal}`,
      desmos: `y\\ge${yVal}`,
      previewPoints: [],
    };
    const shapeBelow = {
      type: 'static', label: `y < ${yVal}`,
      desmos: `y<${yVal}`,
      previewPoints: [],
    };

    layer.addShape(shapeAbove, 'inequality', { fillColor: color });
    layer.addShape(shapeBelow, 'inequality', { fillColor: color });
    this.app.ui.refreshEquationsPanel();
    this.app.render();
  },
});
