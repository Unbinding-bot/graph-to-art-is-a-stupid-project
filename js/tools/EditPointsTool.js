/**
 * EditPointsTool — drag vector anchor points to reshape fitted strokes.
 * Shows all anchor dots for the active layer. Click+drag any dot to move it.
 * Dragging a chain node moves the anchor and both its handles together (smooth mode).
 * Dragging a circle centre or edge handle resizes/moves the circle.
 */
import { createTool } from './BaseTool.js';

export const EditPointsTool = createTool({
  cursor: 'default',

  onActivate() {
    this.app.ui.showOptions('editpoints');
    this.app.render(); // ensure anchors are drawn
  },

  onDeactivate() {
    this._dragTarget = null;
  },

  onDown(pos) {
    const hit = this.app.findDragTarget(pos.px, pos.py);
    if (hit) {
      this.lm.snapshot();
      this._dragTarget = hit;
      this.cm.eventCanvas.style.cursor = 'grabbing';
    }
  },

  onMove(pos) {
    if (this._dragTarget) {
      this.app.applyDrag(this._dragTarget, pos.x, pos.y);
      this.app.ui.refreshEquationsPanel();
      this.app.render();
    } else {
      // Highlight nearest anchor
      const hit = this.app.findDragTarget(pos.px, pos.py);
      this.cm.eventCanvas.style.cursor = hit ? 'grab' : 'default';
    }
  },

  onUp() {
    if (this._dragTarget) {
      this.app.render();
      this._dragTarget = null;
      this.cm.eventCanvas.style.cursor = 'default';
    }
  },

  onCancel() {
    this._dragTarget = null;
    this.cm.eventCanvas.style.cursor = 'default';
  },

  _dragTarget: null,
});
