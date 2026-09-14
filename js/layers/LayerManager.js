/**
 * LayerManager — manages the layer stack.
 * Each Layer owns an offscreen canvas sized to match the screen canvas.
 */

let _layerIdCounter = 0;

export class Layer {
  constructor(name, width = 800, height = 600) {
    this.id       = _layerIdCounter++;
    this.name     = name;
    this.visible  = true;
    this.shapes   = [];
    this._eqIdCounter = 0;

    this.canvas = document.createElement('canvas');
    this.canvas.width  = width;
    this.canvas.height = height;
    this.ctx = this.canvas.getContext('2d');
  }

  resize(width, height) {
    // Preserve content through resize by scaling
    const tmp = document.createElement('canvas');
    tmp.width = this.canvas.width;
    tmp.height = this.canvas.height;
    tmp.getContext('2d').drawImage(this.canvas, 0, 0);
    this.canvas.width  = width;
    this.canvas.height = height;
    this.ctx.drawImage(tmp, 0, 0, tmp.width, tmp.height, 0, 0, width, height);
  }

  clear() {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  addShape(shape, mode = 'equation', strokeInfo = null) {
    const entry = { id: this._eqIdCounter++, visible: true, shape, mode, ...(strokeInfo || {}) };
    this.shapes.push(entry);
    return entry;
  }

  removeShape(id) {
    this.shapes = this.shapes.filter(e => e.id !== id);
  }

  /** Serialize to plain object (for file saving) */
  toJSON() {
    return {
      id:      this.id,
      name:    this.name,
      visible: this.visible,
      // strip non-serializable ImageData blobs from shapes
      shapes:  this.shapes.map(e => {
        const { preStrokeImageData, ...rest } = e;
        return rest;
      }),
    };
  }
}

export class LayerManager {
  constructor(canvasWidth, canvasHeight, onChange) {
    this.W = canvasWidth;
    this.H = canvasHeight;
    this.onChange = onChange || (() => {});
    this.layers = [];
    this.activeIndex = -1;
    this._undoStacks = {};
    this.addLayer('Layer 1');
  }

  get activeLayer() {
    return this.layers[this.activeIndex] ?? null;
  }

  resize(w, h) {
    this.W = w; this.H = h;
    for (const layer of this.layers) layer.resize(w, h);
  }

  addLayer(name) {
    const layer = new Layer(name || `Layer ${this.layers.length + 1}`, this.W, this.H);
    this.layers.push(layer);
    this._undoStacks[layer.id] = [];
    this.activeIndex = this.layers.length - 1;
    this.onChange();
    return layer;
  }

  removeLayer(id) {
    if (this.layers.length <= 1) return; // keep at least one
    const idx = this.layers.findIndex(l => l.id === id);
    if (idx === -1) return;
    this.layers.splice(idx, 1);
    delete this._undoStacks[id];
    this.activeIndex = Math.min(this.activeIndex, this.layers.length - 1);
    this.onChange();
  }

  setActive(id) {
    const idx = this.layers.findIndex(l => l.id === id);
    if (idx !== -1) this.activeIndex = idx;
    this.onChange();
  }

  moveLayer(fromIndex, toIndex) {
    if (fromIndex < 0 || fromIndex >= this.layers.length) return;
    if (toIndex < 0 || toIndex >= this.layers.length) return;
    const [layer] = this.layers.splice(fromIndex, 1);
    this.layers.splice(toIndex, 0, layer);
    // keep activeIndex pointing to the same layer
    this.activeIndex = this.layers.findIndex(l => l.id === layer.id);
    this.onChange();
  }

  mergeDown(id) {
    const idx = this.layers.findIndex(l => l.id === id);
    if (idx <= 0) return;
    const top    = this.layers[idx];
    const bottom = this.layers[idx - 1];
    // composite top onto bottom
    bottom.ctx.drawImage(top.canvas, 0, 0);
    // merge shapes
    bottom.shapes.push(...top.shapes.map(eq => ({ ...eq, id: bottom._eqIdCounter++ })));
    this.layers.splice(idx, 1);
    delete this._undoStacks[top.id];
    this.activeIndex = Math.min(this.activeIndex, this.layers.length - 1);
    this.onChange();
  }

  duplicateLayer(id) {
    const src = this.layers.find(l => l.id === id);
    if (!src) return;
    const dup = new Layer(src.name + ' copy', this.W, this.H);
    dup.visible = src.visible;
    dup.ctx.drawImage(src.canvas, 0, 0);
    dup.shapes = src.shapes.map(eq => ({ ...eq, id: dup._eqIdCounter++ }));
    const idx = this.layers.findIndex(l => l.id === id);
    this.layers.splice(idx + 1, 0, dup);
    this._undoStacks[dup.id] = [];
    this.activeIndex = idx + 1;
    this.onChange();
  }

  // ── Undo / Redo ───────────────────────────────────────────────────────────

  static MAX_UNDO = 30;

  snapshot(layerId) {
    const layer = this.layers.find(l => l.id === (layerId ?? this.activeLayer?.id));
    if (!layer) return;
    const stack = this._undoStacks[layer.id];
    if (!stack) return;
    const data = layer.ctx.getImageData(0, 0, this.W, this.H);
    const shapesClone = layer.shapes.map(e => {
      const { preStrokeImageData, ...rest } = e;
      return JSON.parse(JSON.stringify(rest));
    });
    stack.push({ imageData: data, shapes: shapesClone });
    if (stack.length > LayerManager.MAX_UNDO) stack.shift();
    layer._redoStack = [];
  }

  undo(layerId) {
    const layer = this.layers.find(l => l.id === (layerId ?? this.activeLayer?.id));
    if (!layer) return false;
    const stack = this._undoStacks[layer.id];
    if (!stack || stack.length === 0) return false;
    if (!layer._redoStack) layer._redoStack = [];
    layer._redoStack.push({
      imageData: layer.ctx.getImageData(0, 0, this.W, this.H),
      shapes: layer.shapes.map(e => { const { preStrokeImageData, ...rest } = e; return JSON.parse(JSON.stringify(rest)); }),
    });
    const prev = stack.pop();
    layer.ctx.putImageData(prev.imageData, 0, 0);
    layer.shapes = prev.shapes;
    this.onChange();
    return true;
  }

  redo(layerId) {
    const layer = this.layers.find(l => l.id === (layerId ?? this.activeLayer?.id));
    if (!layer || !layer._redoStack || layer._redoStack.length === 0) return false;
    const next = layer._redoStack.pop();
    const stack = this._undoStacks[layer.id];
    stack.push({
      imageData: layer.ctx.getImageData(0, 0, this.W, this.H),
      shapes: layer.shapes.map(e => { const { preStrokeImageData, ...rest } = e; return JSON.parse(JSON.stringify(rest)); }),
    });
    layer.ctx.putImageData(next.imageData, 0, 0);
    layer.shapes = next.shapes;
    this.onChange();
    return true;
  }

  // ── Serialization ─────────────────────────────────────────────────────────

  toJSON() {
    return {
      activeIndex: this.activeIndex,
      layers: this.layers.map(l => l.toJSON()),
    };
  }

  /** Restore layer metadata from JSON (canvas pixels restored separately from PNGs) */
  fromJSON(data) {
    this.layers = [];
    this._undoStacks = {};
    for (const ld of data.layers) {
      const layer = new Layer(ld.name, this.W, this.H);
      layer.visible = ld.visible;
      layer.shapes = ld.shapes || [];
      layer._eqIdCounter = layer.shapes.length;
      this.layers.push(layer);
      this._undoStacks[layer.id] = [];
    }
    this.activeIndex = data.activeIndex ?? 0;
    this.onChange();
  }
}
