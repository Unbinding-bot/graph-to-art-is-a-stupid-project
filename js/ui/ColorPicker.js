/**
 * ColorPicker — lightweight HSV color picker.
 *
 * Two modes:
 *   popup  — floating panel, opened via picker.open(hex, anchorEl)
 *   inline — embedded permanently in a container via picker.embedIn(container)
 */

export class ColorPicker {
  /**
   * @param {HTMLElement|null} popupEl  The floating popup element (pass null for inline-only)
   */
  constructor(popupEl) {
    this.popup    = popupEl;
    this.onChange = null;   // (hex, alpha) => void

    this._h = 0;   // 0-360
    this._s = 1;   // 0-1
    this._v = 1;   // 0-1
    this._a = 1;   // 0-1

    this._inlineEl = null;  // set by embedIn()

    if (popupEl) {
      this._buildUI(popupEl, 'pk');
      this._bindEvents(popupEl, 'pk');
      // close on outside click for popup
      document.addEventListener('mousedown', e => {
        if (this.popup.classList.contains('open') &&
            !this.popup.contains(e.target) &&
            !this._anchor?.contains(e.target)) {
          this.close();
        }
      });
    }
  }

  /** Embed a permanent, always-visible picker inside `container`. */
  embedIn(container) {
    this._inlineEl = container;
    container.style.display = 'flex';
    container.style.flexDirection = 'column';
    container.style.flex = '1';
    container.style.minHeight = '0';
    this._buildUI(container, 'ipk');
    this._bindEvents(container, 'ipk');
    this._syncAll('ipk');
  }

  // ── UI building ────────────────────────────────────────────────────────────

  _buildUI(root, pfx) {
    root.innerHTML = `
      <div class="picker-gradient" id="${pfx}-gradient">
        <div class="picker-cursor" id="${pfx}-cursor"></div>
      </div>
      <div class="picker-hue-row">
        <input type="range" id="${pfx}-hue" min="0" max="360" step="1" value="0">
        <div class="picker-preview"><div class="picker-preview-fill" id="${pfx}-preview-fill"></div></div>
      </div>
      <div class="picker-alpha-row">
        <label style="color:var(--text-dim);font-size:11px;width:12px">A</label>
        <input type="range" id="${pfx}-alpha" min="0" max="100" step="1" value="100">
        <span id="${pfx}-alpha-val" style="font-size:11px;color:var(--text-dim);min-width:28px">100%</span>
      </div>
      <div class="picker-hex-row">
        <label>HEX</label>
        <input class="picker-hex-input" id="${pfx}-hex" type="text" maxlength="9" value="#ffffff">
      </div>
      <div class="picker-hex-row">
        <label>RGB</label>
        <input class="picker-hex-input" id="${pfx}-rgb" type="text" placeholder="255,255,255">
      </div>`;
  }

  _bindEvents(root, pfx) {
    const gradient    = root.querySelector(`#${pfx}-gradient`);
    const cursor      = root.querySelector(`#${pfx}-cursor`);
    const hueSlider   = root.querySelector(`#${pfx}-hue`);
    const alphaSlider = root.querySelector(`#${pfx}-alpha`);
    const alphaVal    = root.querySelector(`#${pfx}-alpha-val`);
    const previewFill = root.querySelector(`#${pfx}-preview-fill`);
    const hexInput    = root.querySelector(`#${pfx}-hex`);
    const rgbInput    = root.querySelector(`#${pfx}-rgb`);

    // Store refs on the root for _syncAll
    root._pickerRefs = { gradient, cursor, hueSlider, alphaSlider, alphaVal, previewFill, hexInput, rgbInput };

    // Gradient drag
    let gradDragging = false;
    gradient.addEventListener('mousedown', e => { gradDragging = true; this._pickSV(e, gradient); e.preventDefault(); });
    document.addEventListener('mousemove', e => { if (gradDragging) this._pickSV(e, gradient); });
    document.addEventListener('mouseup',   () => { gradDragging = false; });
    gradient.addEventListener('touchstart', e => { this._pickSV(e.touches[0], gradient); }, { passive: true });
    gradient.addEventListener('touchmove',  e => { this._pickSV(e.touches[0], gradient); e.preventDefault(); }, { passive: false });

    hueSlider.addEventListener('input', () => {
      this._h = +hueSlider.value;
      this._syncAll();
      this._emit();
    });

    alphaSlider.addEventListener('input', () => {
      this._a = +alphaSlider.value / 100;
      alphaVal.textContent = alphaSlider.value + '%';
      this._syncAll();
      this._emit();
    });

    hexInput.addEventListener('change', () => {
      const rgb = hexToRgb(hexInput.value.trim());
      if (rgb) { this.setRGB(rgb.r, rgb.g, rgb.b); this._emit(); }
    });

    rgbInput.addEventListener('change', () => {
      const p = rgbInput.value.split(',').map(s => parseInt(s.trim(), 10));
      if (p.length >= 3 && p.every(n => !isNaN(n))) { this.setRGB(p[0], p[1], p[2]); this._emit(); }
    });
  }

  _pickSV(e, gradient) {
    const rect = gradient.getBoundingClientRect();
    this._s = Math.max(0, Math.min(1, (e.clientX - rect.left)  / rect.width));
    this._v = Math.max(0, Math.min(1, 1 - (e.clientY - rect.top) / rect.height));
    this._syncAll();
    this._emit();
  }

  /** Sync all rendered pickers to current h/s/v/a state */
  _syncAll(specificPfx) {
    const roots = [];
    if (this.popup)    roots.push(this.popup);
    if (this._inlineEl) roots.push(this._inlineEl);

    for (const root of roots) {
      const r = root._pickerRefs;
      if (!r) continue;

      // gradient background
      r.gradient.style.background =
        `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, hsl(${this._h},100%,50%))`;

      // cursor position
      r.cursor.style.left = (this._s * 100) + '%';
      r.cursor.style.top  = ((1 - this._v) * 100) + '%';

      // hue slider
      r.hueSlider.value = this._h;

      // alpha
      r.alphaSlider.value = Math.round(this._a * 100);
      r.alphaVal.textContent = Math.round(this._a * 100) + '%';

      // preview + hex/rgb
      const rgb = hsvToRgb(this._h, this._s, this._v);
      const hex = rgbToHex(rgb.r, rgb.g, rgb.b);
      r.previewFill.style.background = `rgba(${rgb.r},${rgb.g},${rgb.b},${this._a})`;
      r.hexInput.value = hex;
      r.rgbInput.value = `${rgb.r},${rgb.g},${rgb.b}`;
      r.alphaSlider.style.background = `linear-gradient(to right, transparent, ${hex})`;
    }
  }

  _emit() {
    if (this.onChange) {
      const rgb = hsvToRgb(this._h, this._s, this._v);
      this.onChange(rgbToHex(rgb.r, rgb.g, rgb.b), this._a);
    }
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  open(hexColor, anchorEl) {
    if (!this.popup) return;
    this._anchor = anchorEl;
    this.setHex(hexColor);
    this.popup.classList.add('open');

    if (anchorEl) {
      const rect = anchorEl.getBoundingClientRect();
      const popW = 240, popH = 300;
      let left = rect.right + 8;
      let top  = rect.top;
      if (left + popW > window.innerWidth)  left = rect.left - popW - 8;
      if (top  + popH > window.innerHeight) top  = window.innerHeight - popH - 8;
      this.popup.style.left = Math.max(0, left) + 'px';
      this.popup.style.top  = Math.max(0, top)  + 'px';
    }
  }

  close() {
    this.popup?.classList.remove('open');
    this._anchor = null;
  }

  setHex(hex) {
    const rgb = hexToRgb(hex);
    if (rgb) this.setRGB(rgb.r, rgb.g, rgb.b);
  }

  setRGB(r, g, b) {
    const hsv = rgbToHsv(r, g, b);
    this._h = hsv.h; this._s = hsv.s; this._v = hsv.v;
    this._syncAll();
  }

  getHex() {
    const rgb = hsvToRgb(this._h, this._s, this._v);
    return rgbToHex(rgb.r, rgb.g, rgb.b);
  }

  getAlpha() { return this._a; }
}

// ── Color math ────────────────────────────────────────────────────────────────

function hsvToRgb(h, s, v) {
  const i = Math.floor(h / 60) % 6;
  const f = h / 60 - Math.floor(h / 60);
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  let r, g, b;
  switch (i) {
    case 0: r=v;g=t;b=p; break; case 1: r=q;g=v;b=p; break;
    case 2: r=p;g=v;b=t; break; case 3: r=p;g=q;b=v; break;
    case 4: r=t;g=p;b=v; break; default: r=v;g=p;b=q;
  }
  return { r: Math.round(r*255), g: Math.round(g*255), b: Math.round(b*255) };
}

function rgbToHsv(r, g, b) {
  r/=255; g/=255; b/=255;
  const max=Math.max(r,g,b), min=Math.min(r,g,b), d=max-min;
  let h=0;
  if (d) {
    if (max===r) h=((g-b)/d+6)%6;
    else if (max===g) h=(b-r)/d+2;
    else h=(r-g)/d+4;
    h*=60;
  }
  return { h, s: max?d/max:0, v: max };
}

function rgbToHex(r, g, b) {
  return '#' + [r,g,b].map(n=>n.toString(16).padStart(2,'0')).join('');
}

function hexToRgb(hex) {
  hex = hex.replace(/^#/, '');
  if (hex.length === 3) hex = hex.split('').map(c=>c+c).join('');
  if (hex.length !== 6 && hex.length !== 8) return null;
  return {
    r: parseInt(hex.slice(0,2),16),
    g: parseInt(hex.slice(2,4),16),
    b: parseInt(hex.slice(4,6),16),
  };
}
