/**
 * FileManager — .mathart save/load and localStorage auto-save.
 *
 * .mathart format (renamed ZIP):
 *   manifest.json  — canvas settings, layer metadata, equations
 *   layer_0.png    — raster data per layer
 *   layer_1.png
 *   ...
 *
 * localStorage key: 'mathdraw_autosave'
 */

export class FileManager {
  constructor(app) {
    this.app = app;
    this._saveTimer = null;
    this._JSZip = null; // lazy-loaded
  }

  // ── JSZip loader ─────────────────────────────────────────────────────────

  async _getJSZip() {
    if (this._JSZip) return this._JSZip;
    // JSZip is loaded from CDN in index.html as window.JSZip
    if (window.JSZip) { this._JSZip = window.JSZip; return this._JSZip; }
    throw new Error('JSZip not loaded. Make sure the CDN script is included in index.html.');
  }

  // ── Save .mathart ─────────────────────────────────────────────────────────

  async save(filename = 'drawing.mathart') {
    const JSZip = await this._getJSZip();
    const zip   = new JSZip();
    const cm    = this.app.canvasManager;
    const lm    = this.app.layerManager;

    // Build manifest
    const manifest = {
      version: 1,
      canvas: { width: cm.W, height: cm.H, view: { ...cm.view } },
      foreColor: this.app.foreColor,
      backColor: this.app.backColor,
      ...lm.toJSON(),
    };
    zip.file('manifest.json', JSON.stringify(manifest, null, 2));

    // Add layer PNGs
    for (let i = 0; i < lm.layers.length; i++) {
      const layer = lm.layers[i];
      // resize layer canvas to match current display size before export
      const blob  = await canvasToBlob(layer.canvas);
      zip.file(`layer_${i}.png`, blob);
    }

    // Trigger download
    const content = await zip.generateAsync({ type: 'blob' });
    triggerDownload(content, filename, 'application/octet-stream');
  }

  // ── Load .mathart ─────────────────────────────────────────────────────────

  async load(file) {
    const JSZip  = await this._getJSZip();
    const zip    = await JSZip.loadAsync(file);
    const lm     = this.app.layerManager;
    const cm     = this.app.canvasManager;

    // Read manifest
    const manifestStr = await zip.file('manifest.json').async('string');
    const manifest    = JSON.parse(manifestStr);

    // Restore view
    if (manifest.canvas?.view) {
      Object.assign(cm.view, manifest.canvas.view);
      cm.drawGrid();
    }

    // Restore colors
    if (manifest.foreColor) this.app.setForeColor(manifest.foreColor);
    if (manifest.backColor) this.app.setBackColor(manifest.backColor);

    // Restore layer metadata (this resets layer list)
    lm.fromJSON({ activeIndex: manifest.activeIndex, layers: manifest.layers });

    // Restore layer pixels from PNGs
    for (let i = 0; i < lm.layers.length; i++) {
      const pngFile = zip.file(`layer_${i}.png`);
      if (!pngFile) continue;
      const blob   = await pngFile.async('blob');
      const url    = URL.createObjectURL(blob);
      await drawImageFromURL(lm.layers[i].ctx, url, cm.W, cm.H);
      URL.revokeObjectURL(url);
    }

    this.app.render();
    this.app.ui.refreshLayerPanel();
    this.app.ui.refreshEquationsPanel();
  }

  // ── Export PNG ────────────────────────────────────────────────────────────

  async exportPNG(filename = 'drawing.png') {
    const cm = this.app.canvasManager;
    const lm = this.app.layerManager;

    // Render layers at current view into the screen-space layerCtx, then snapshot it
    cm.compositeLayerCanvas(lm.layers);
    const tmp  = document.createElement('canvas');
    tmp.width  = cm.W;
    tmp.height = cm.H;
    tmp.getContext('2d').drawImage(cm.layerCanvas, 0, 0);
    const blob = await canvasToBlob(tmp);
    triggerDownload(blob, filename, 'image/png');
  }

  // ── localStorage auto-save ────────────────────────────────────────────────

  scheduleSave() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this._localSave(), 2000);
  }

  async _localSave() {
    try {
      const lm = this.app.layerManager;
      const cm = this.app.canvasManager;
      const data = {
        version: 1,
        savedAt: Date.now(),
        canvas: { view: { ...cm.view } },
        foreColor: this.app.foreColor,
        backColor: this.app.backColor,
        ...lm.toJSON(),
        layerPixels: [],
      };
      for (const layer of lm.layers) {
        data.layerPixels.push(layer.canvas.toDataURL('image/png'));
      }
      localStorage.setItem('mathdraw_autosave', JSON.stringify(data));
    } catch (e) {
      // Storage quota exceeded — silently ignore
      console.warn('Auto-save failed:', e);
    }
  }

  async loadAutosave() {
    const raw = localStorage.getItem('mathdraw_autosave');
    if (!raw) return false;
    try {
      const data = JSON.parse(raw);
      const lm   = this.app.layerManager;
      const cm   = this.app.canvasManager;

      if (data.canvas?.view) { Object.assign(cm.view, data.canvas.view); cm.drawGrid(); }
      if (data.foreColor) this.app.setForeColor(data.foreColor);
      if (data.backColor) this.app.setBackColor(data.backColor);

      lm.fromJSON({ activeIndex: data.activeIndex, layers: data.layers });

      for (let i = 0; i < lm.layers.length; i++) {
        const src = data.layerPixels?.[i];
        if (!src) continue;
        await drawImageFromURL(lm.layers[i].ctx, src, cm.W, cm.H);
      }

      this.app.render();
      this.app.ui.refreshLayerPanel();
      this.app.ui.refreshEquationsPanel();
      return true;
    } catch (e) {
      console.warn('Failed to restore autosave:', e);
      return false;
    }
  }

  clearAutosave() {
    localStorage.removeItem('mathdraw_autosave');
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function canvasToBlob(canvas) {
  return new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
}

function triggerDownload(blob, filename, type) {
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function drawImageFromURL(ctx, url, w, h) {
  return new Promise((resolve, reject) => {
    const img  = new Image();
    img.onload = () => {
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      resolve();
    };
    img.onerror = reject;
    img.src = url;
  });
}
