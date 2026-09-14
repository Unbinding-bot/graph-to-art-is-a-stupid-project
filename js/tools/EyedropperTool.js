import { createTool } from './BaseTool.js';

export const EyedropperTool = createTool({
  cursor: 'crosshair',

  onActivate() { this.app.ui.showOptions('eyedrop'); },

  onDown(pos) {
    this._pick(pos);
  },

  onMove(pos) {
    if (!this._active) return;
    this._pick(pos);
  },

  _pick(pos) {
    // Read from the composited layer canvas
    const ctx = this.cm.layerCtx;
    const x = Math.round(pos.px), y = Math.round(pos.py);
    const W = this.cm.W, H = this.cm.H;
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const pixel = ctx.getImageData(x, y, 1, 1).data;
    const hex = `#${toHex(pixel[0])}${toHex(pixel[1])}${toHex(pixel[2])}`;
    this.app.setForeColor(hex);
  },
});

function toHex(n) { return n.toString(16).padStart(2, '0'); }
