/**
 * CanvasManager — owns the visible canvas stack and coordinate transforms.
 *
 * Canvas layers (bottom → top):
 *   1. layer compositing canvas  – flattened raster layers (regenerated from vectors each render)
 *   2. overlay canvas  – marching ants, shape previews, cursor ring
 *   3. grid canvas  – math grid + axes (always on top)
 *
 * Layer canvases are screen-pixel sized. They are redrawn from vector geometry
 * on every render(), so they are always crisp at any zoom level.
 */

export class CanvasManager {
  constructor(container) {
    this.container = container;

    this.view = { xMin: -10, xMax: 10, yMin: -10, yMax: 10 };

    // physical canvas size (set in resize())
    this.W = 0;
    this.H = 0;

    // create canvases
    this.layerCanvas   = this._makeCanvas('layer-composite');
    this.overlayCanvas = this._makeCanvas('overlay');
    this.gridCanvas    = this._makeCanvas('grid');

    this.layerCtx   = this.layerCanvas.getContext('2d');
    this.overlayCtx = this.overlayCanvas.getContext('2d');
    this.gridCtx    = this.gridCanvas.getContext('2d');

    // pointer events only on overlay (passes through to nothing beneath — App wires its own listeners)
    this.layerCanvas.style.pointerEvents   = 'none';
    this.gridCanvas.style.pointerEvents    = 'none';
    this.overlayCanvas.style.pointerEvents = 'none';

    // one transparent canvas on top that receives all pointer events (wired by App)
    this.eventCanvas = this._makeCanvas('event-surface');
    this.eventCanvas.style.zIndex = '10';
    this.eventCanvas.style.background = 'transparent';

    this._setZIndices();
    this.resize();

    window.addEventListener('resize', () => this.resize());
  }

  _makeCanvas(id) {
    const c = document.createElement('canvas');
    c.id = id;
    c.style.position = 'absolute';
    c.style.top = '0';
    c.style.left = '0';
    this.container.appendChild(c);
    return c;
  }

  _setZIndices() {
    this.layerCanvas.style.zIndex   = '1';
    this.overlayCanvas.style.zIndex = '2';
    this.gridCanvas.style.zIndex    = '3';
    this.eventCanvas.style.zIndex   = '10';
  }

  resize() {
    const rect = this.container.getBoundingClientRect();
    this.W = Math.max(1, Math.floor(rect.width));
    this.H = Math.max(1, Math.floor(rect.height));

    // Expand x-range to match pixel aspect (keep grid squares square)
    const worldH = this.view.yMax - this.view.yMin;
    const pixelAspect = this.W / this.H;
    const halfW  = (worldH * pixelAspect) / 2;
    const centerX = (this.view.xMin + this.view.xMax) / 2;
    this.view.xMin = centerX - halfW;
    this.view.xMax = centerX + halfW;

    for (const c of [this.layerCanvas, this.overlayCanvas, this.gridCanvas, this.eventCanvas]) {
      c.width  = this.W;
      c.height = this.H;
      c.style.width  = this.W + 'px';
      c.style.height = this.H + 'px';
    }
    this.drawGrid();
  }

  // ── Coordinate transforms ─────────────────────────────────────────────────

  toWorld(px, py) {
    return {
      x: this.view.xMin + (px / this.W) * (this.view.xMax - this.view.xMin),
      y: this.view.yMax - (py / this.H) * (this.view.yMax - this.view.yMin),
    };
  }

  toPixel(x, y) {
    return {
      px: ((x - this.view.xMin) / (this.view.xMax - this.view.xMin)) * this.W,
      py: ((this.view.yMax - y) / (this.view.yMax - this.view.yMin)) * this.H,
    };
  }

  getPointerPos(e) {
    const rect = this.eventCanvas.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    const px = clientX - rect.left;
    const py = clientY - rect.top;
    return { px, py, ...this.toWorld(px, py) };
  }

  // ── Zoom & Pan ─────────────────────────────────────────────────────────────

  /**
   * Zoom the view around a pixel-space focal point.
   * @param {number} px  focal x in canvas pixels
   * @param {number} py  focal y in canvas pixels
   * @param {number} factor  > 1 zooms in, < 1 zooms out
   */
  zoom(px, py, factor) {
    const { x: wx, y: wy } = this.toWorld(px, py);
    const clampedFactor = Math.max(0.1, Math.min(10, factor));
    // scale view around focal world point
    this.view.xMin = wx + (this.view.xMin - wx) / clampedFactor;
    this.view.xMax = wx + (this.view.xMax - wx) / clampedFactor;
    this.view.yMin = wy + (this.view.yMin - wy) / clampedFactor;
    this.view.yMax = wy + (this.view.yMax - wy) / clampedFactor;
    // enforce min/max zoom (world units visible)
    const worldW = this.view.xMax - this.view.xMin;
    const worldH = this.view.yMax - this.view.yMin;
    const MIN_WORLD = 0.5, MAX_WORLD = 400;
    if (worldH < MIN_WORLD || worldH > MAX_WORLD) {
      // revert
      this.view.xMin = wx + (this.view.xMin - wx) * clampedFactor;
      this.view.xMax = wx + (this.view.xMax - wx) * clampedFactor;
      this.view.yMin = wy + (this.view.yMin - wy) * clampedFactor;
      this.view.yMax = wy + (this.view.yMax - wy) * clampedFactor;
    }
    this.drawGrid();
  }

  /**
   * Pan the view by a delta in pixel space.
   * @param {number} dpx  pixel delta x
   * @param {number} dpy  pixel delta y
   */
  pan(dpx, dpy) {
    const worldPerPixelX = (this.view.xMax - this.view.xMin) / this.W;
    const worldPerPixelY = (this.view.yMax - this.view.yMin) / this.H;
    const dx = dpx * worldPerPixelX;
    const dy = dpy * worldPerPixelY;
    this.view.xMin -= dx;
    this.view.xMax -= dx;
    this.view.yMin += dy;  // y axis is flipped
    this.view.yMax += dy;
    this.drawGrid();
  }

  // ── Grid rendering ─────────────────────────────────────────────────────────

  drawGrid() {
    const ctx = this.gridCtx;
    const { W, H, view } = this;
    ctx.clearRect(0, 0, W, H);

    // minor grid lines
    ctx.strokeStyle = 'rgba(80,80,140,0.25)';
    ctx.lineWidth = 1;
    for (let x = Math.ceil(view.xMin); x <= view.xMax; x++) {
      const p1 = this.toPixel(x, view.yMin);
      const p2 = this.toPixel(x, view.yMax);
      ctx.beginPath(); ctx.moveTo(p1.px, p1.py); ctx.lineTo(p2.px, p2.py); ctx.stroke();
    }
    for (let y = Math.ceil(view.yMin); y <= view.yMax; y++) {
      const p1 = this.toPixel(view.xMin, y);
      const p2 = this.toPixel(view.xMax, y);
      ctx.beginPath(); ctx.moveTo(p1.px, p1.py); ctx.lineTo(p2.px, p2.py); ctx.stroke();
    }

    // axes
    ctx.strokeStyle = 'rgba(120,120,200,0.6)';
    ctx.lineWidth = 1.5;
    const ax1 = this.toPixel(view.xMin, 0), ax2 = this.toPixel(view.xMax, 0);
    ctx.beginPath(); ctx.moveTo(ax1.px, ax1.py); ctx.lineTo(ax2.px, ax2.py); ctx.stroke();
    const ay1 = this.toPixel(0, view.yMin), ay2 = this.toPixel(0, view.yMax);
    ctx.beginPath(); ctx.moveTo(ay1.px, ay1.py); ctx.lineTo(ay2.px, ay2.py); ctx.stroke();

    // axis labels (every integer)
    ctx.fillStyle = 'rgba(120,120,200,0.5)';
    ctx.font = '10px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const origin = this.toPixel(0, 0);
    for (let x = Math.ceil(view.xMin); x <= view.xMax; x++) {
      if (x === 0) continue;
      const p = this.toPixel(x, 0);
      ctx.fillText(x, p.px, origin.py + 3);
    }
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let y = Math.ceil(view.yMin); y <= view.yMax; y++) {
      if (y === 0) continue;
      const p = this.toPixel(0, y);
      ctx.fillText(y, origin.px - 4, p.py);
    }
  }

  // ── Layer compositing ──────────────────────────────────────────────────────

  /**
   * Composite all visible layers onto the layer canvas.
   * @param {Array} layers  Array of Layer objects from LayerManager
   */
  compositeLayerCanvas(layers) {
    const ctx = this.layerCtx;
    ctx.clearRect(0, 0, this.W, this.H);

    // checkerboard bg
    const pat = this._getCheckerPattern();
    if (pat) {
      ctx.save();
      ctx.fillStyle = pat;
      ctx.fillRect(0, 0, this.W, this.H);
      ctx.restore();
    }

    // Layer canvases are screen-pixel sized — draw 1:1
    for (const layer of layers) {
      if (!layer.visible) continue;
      ctx.drawImage(layer.canvas, 0, 0);
    }
  }

  _getCheckerPattern() {
    if (this._checkerPat) return this._checkerPat;
    const sz = 12;
    const pc = document.createElement('canvas');
    pc.width = pc.height = sz * 2;
    const pctx = pc.getContext('2d');
    pctx.fillStyle = '#1a1a2e';
    pctx.fillRect(0, 0, sz * 2, sz * 2);
    pctx.fillStyle = '#13132a';
    pctx.fillRect(0, 0, sz, sz);
    pctx.fillRect(sz, sz, sz, sz);
    this._checkerPat = this.layerCtx.createPattern(pc, 'repeat');
    return this._checkerPat;
  }

  // ── Overlay ────────────────────────────────────────────────────────────────

  clearOverlay() {
    this.overlayCtx.clearRect(0, 0, this.W, this.H);
  }

  /** Draw each layer's vector shapes (live geometry) + their draggable anchor dots */
  drawEquationOverlays(layers) {
    const ctx = this.overlayCtx;
    const colors = ['#7fddcc', '#dd99ff', '#ffcc77', '#77ddff', '#ff7799'];
    layers.forEach((layer, li) => {
      if (!layer.visible) return;
      const color = colors[li % colors.length];
      for (const entry of layer.shapes) {
        if (!entry.visible) continue;
        const shape = entry.shape;
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        if (shape.type === 'static') {
          // Half-plane fills (mode=inequality) have no drawable boundary — skip them.
          // Shape-tool primitives (mode=equation) draw their preview polyline.
          if (entry.mode === 'inequality') continue;
          if (!shape.previewPoints?.length) continue;
          ctx.beginPath();
          shape.previewPoints.forEach((p, i) => {
            const px = this.toPixel(p.x, p.y);
            i === 0 ? ctx.moveTo(px.px, px.py) : ctx.lineTo(px.px, px.py);
          });
          ctx.stroke();
        } else if (shape.type === 'circle') {
          ctx.beginPath();
          for (let t = 0; t <= 64; t++) {
            const a = (t / 64) * 2 * Math.PI;
            const px = this.toPixel(shape.h + shape.r * Math.cos(a), shape.k + shape.r * Math.sin(a));
            t === 0 ? ctx.moveTo(px.px, px.py) : ctx.lineTo(px.px, px.py);
          }
          ctx.stroke();
          this._drawAnchor(shape.h, shape.k, color);
          this._drawAnchor(shape.h + shape.r * Math.cos(shape.edgeAngle), shape.k + shape.r * Math.sin(shape.edgeAngle), color);
        } else if (shape.type === 'chain') {
          for (let i = 0; i < shape.nodes.length - 1; i++) {
            const n0 = shape.nodes[i], n1 = shape.nodes[i + 1];
            ctx.beginPath();
            for (let t = 0; t <= 24; t++) {
              const u = t / 24, mu = 1 - u;
              const b0 = mu*mu*mu, b1 = 3*mu*mu*u, b2 = 3*mu*u*u, b3 = u*u*u;
              const x = b0*n0.x + b1*n0.hOutX + b2*n1.hInX + b3*n1.x;
              const y = b0*n0.y + b1*n0.hOutY + b2*n1.hInY + b3*n1.y;
              const px = this.toPixel(x, y);
              t === 0 ? ctx.moveTo(px.px, px.py) : ctx.lineTo(px.px, px.py);
            }
            ctx.stroke();
          }
          // ONLY anchors are drawn — handles stay invisible, matching "only the
          // important points" — smooth-mode dragging carries handles along silently.
          shape.nodes.forEach(n => this._drawAnchor(n.x, n.y, color));
        }
      }
    });
  }

  _drawAnchor(x, y, color) {
    const p = this.toPixel(x, y);
    const ctx = this.overlayCtx;
    ctx.beginPath();
    ctx.arc(p.px, p.py, 5, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = '#0f0f1a';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
}
