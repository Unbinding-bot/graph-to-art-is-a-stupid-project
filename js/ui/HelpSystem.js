/**
 * HelpSystem — modal walkthrough + interactive UI tour.
 */

// ── Tour steps ────────────────────────────────────────────────────────────────
// Each step: { selector, title, body, side:'top'|'bottom'|'left'|'right' }
const TOUR_STEPS = [
  {
    selector: '#toolbar',
    side: 'right',
    title: 'Your tools',
    body: 'Everything you need to draw is here. Brush, Eraser, Fill, shape tools, selection tools, Edit Points. The two colored squares at the bottom are your foreground and background colors.',
  },
  {
    selector: '[data-tool="brush"]',
    side: 'right',
    title: 'Brush (B)',
    body: 'Just draw. Each stroke you make gets turned into a real math equation in the background. You\'ll see it show up in the Equations tab straight away.',
  },
  {
    selector: '[data-tool="editpoints"]',
    side: 'right',
    title: 'Edit Points (V)',
    body: 'Drew something and want to tweak the shape? Switch to this, then drag the dots on any stroke. The equation updates as you move things around.',
  },
  {
    selector: '[data-tool="fill"]',
    side: 'right',
    title: 'Fill (G)',
    body: 'Click inside a closed shape to shade its interior as a Desmos inequality. Click on empty space and it fills the whole canvas with two halves, y above and y below the point you clicked.',
  },
  {
    selector: '#options-bar',
    side: 'bottom',
    title: 'Top bar',
    body: 'The ? on the left opens this screen. When you have something selected, action buttons appear here. On the right you\'ve got the Reference image button, Default View reset, and the save/open/export buttons.',
  },
  {
    selector: '#add-reference-btn',
    side: 'bottom',
    title: 'Reference images',
    body: 'Drop in a photo or PNG and it sits at the bottom of your layers as a guide. You can lower its opacity so it\'s not in the way. You can\'t paint on it, it\'s just there to trace over.',
  },
  {
    selector: '#panel',
    side: 'left',
    title: 'Right panel',
    body: 'Top half: tool settings and color picker. Bottom half: your layers, all your equations, and fit type settings. Most of the important stuff lives here.',
  },
  {
    selector: '.panel-tab[data-panel="equations"]',
    side: 'left',
    title: 'Equations tab',
    body: 'Click here to see every equation your drawing has produced. Let me open it for you now.',
    onEnter() {
      // Switch the panel bottom half to the equations tab
      document.querySelectorAll('.panel-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.panel-section').forEach(s => s.classList.remove('active'));
      const tab = document.querySelector('.panel-tab[data-panel="equations"]');
      const sec = document.querySelector('.panel-section[data-section="equations"]');
      tab?.classList.add('active');
      sec?.classList.add('active');
    },
  },
  {
    selector: '#equations-list',
    side: 'left',
    title: 'Your equations',
    body: 'Each stroke and shape you drew shows up here. They update live as you draw. If the list is empty, go draw something first and come back.',
  },
  {
    selector: '.eq-panel-actions',
    side: 'left',
    title: 'Copy buttons',
    body: 'Desmos copies all your equations at once so you can paste them straight into desmos.com. GeoGebra downloads a .ggb file you just open in GeoGebra Classic. Each individual equation also has its own D and G buttons.',
  },
  {
    selector: '.panel-tab[data-panel="layers"]',
    side: 'left',
    title: 'Layers tab',
    body: 'Add new layers, hide or show them, drag to reorder, duplicate or merge. Reference layers show up with an opacity slider so you can fade them out while you work.',
    onEnter() {
      document.querySelectorAll('.panel-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.panel-section').forEach(s => s.classList.remove('active'));
      const tab = document.querySelector('.panel-tab[data-panel="layers"]');
      const sec = document.querySelector('.panel-section[data-section="layers"]');
      tab?.classList.add('active');
      sec?.classList.add('active');
    },
  },
  {
    selector: '.panel-tab[data-panel="fit"]',
    side: 'left',
    title: 'Fit settings',
    body: 'Controls what kind of equations your strokes get fitted to: lines, quadratics, cubics, circles. Cubic is the default and gives smooth results. Keyboard shortcuts are listed here as well.',
  },
  {
    selector: '#canvas-wrap',
    side: 'top',
    title: 'The canvas',
    body: 'Draw here! Scroll to zoom in and out. Hold Space and drag to move around, or use middle click. On touch, pinch to zoom and use two fingers to pan. The grid numbers are the actual coordinates your equations use.',
  },
];

// ── HelpSystem class ──────────────────────────────────────────────────────────
export class HelpSystem {
  constructor() {
    this._page    = 0;
    this._tourIdx = 0;
    this._totalPages = 5;

    this._overlay  = document.getElementById('help-overlay');
    this._modal    = document.getElementById('help-modal');
    this._body     = document.getElementById('help-body');
    this._dotsEl   = document.getElementById('help-dots');
    this._prevBtn  = document.getElementById('help-prev');
    this._nextBtn  = document.getElementById('help-next');

    this._tourOverlay  = document.getElementById('tour-overlay');
    this._spotlight    = document.getElementById('tour-spotlight');
    this._tooltip      = document.getElementById('tour-tooltip');
    this._tipTitle     = document.getElementById('tour-tip-title');
    this._tipBody      = document.getElementById('tour-tip-body');
    this._tipCounter   = document.getElementById('tour-step-counter');

    this._buildDots();
    this._wire();

    // Show on first open (check localStorage)
    if (!localStorage.getItem('mathdraw_help_seen')) {
      this.openHelp();
    }
  }

  openHelp(page = 0) {
    this._goTo(page);
    this._overlay?.classList.add('open');
  }

  closeHelp() {
    this._overlay?.classList.remove('open');
    localStorage.setItem('mathdraw_help_seen', '1');
  }

  // ── Pages ─────────────────────────────────────────────────────────────────

  _buildDots() {
    if (!this._dotsEl) return;
    this._dotsEl.innerHTML = '';
    for (let i = 0; i < this._totalPages; i++) {
      const dot = document.createElement('div');
      dot.className = 'help-dot' + (i === 0 ? ' active' : '');
      dot.addEventListener('click', () => this._goTo(i));
      this._dotsEl.appendChild(dot);
    }
  }

  _goTo(page) {
    this._page = Math.max(0, Math.min(this._totalPages - 1, page));

    document.querySelectorAll('.help-page').forEach((p, i) => {
      p.classList.toggle('active', i === this._page);
    });
    document.querySelectorAll('.help-tab').forEach((t, i) => {
      t.classList.toggle('active', i === this._page);
    });
    document.querySelectorAll('.help-dot').forEach((d, i) => {
      d.classList.toggle('active', i === this._page);
    });

    if (this._prevBtn) this._prevBtn.disabled = this._page === 0;
    if (this._nextBtn) this._nextBtn.textContent = this._page === this._totalPages - 1 ? 'Close' : 'Next →';
  }

  _wire() {
    document.getElementById('help-btn')?.addEventListener('click', () => this.openHelp());
    document.getElementById('help-close')?.addEventListener('click', () => this.closeHelp());

    // Close on backdrop click
    this._overlay?.addEventListener('click', (e) => {
      if (e.target === this._overlay) this.closeHelp();
    });

    // Tab clicks
    document.querySelectorAll('.help-tab').forEach((tab, i) => {
      tab.addEventListener('click', () => this._goTo(i));
    });

    // Prev / Next
    this._prevBtn?.addEventListener('click', () => this._goTo(this._page - 1));
    this._nextBtn?.addEventListener('click', () => {
      if (this._page === this._totalPages - 1) this.closeHelp();
      else this._goTo(this._page + 1);
    });

    // Start tour
    document.getElementById('help-start-tour')?.addEventListener('click', () => {
      this.closeHelp();
      this.startTour();
    });

    // Tour controls
    document.getElementById('tour-next-btn')?.addEventListener('click', () => this._tourNext());
    document.getElementById('tour-prev-btn')?.addEventListener('click', () => this._tourPrev());
    document.getElementById('tour-skip')?.addEventListener('click', () => this._endTour());

    // Keyboard nav for help modal
    document.addEventListener('keydown', (e) => {
      if (this._overlay?.classList.contains('open')) {
        if (e.key === 'ArrowRight') this._goTo(this._page + 1);
        if (e.key === 'ArrowLeft')  this._goTo(this._page - 1);
        if (e.key === 'Escape') this.closeHelp();
      }
      if (this._tourOverlay?.classList.contains('active')) {
        if (e.key === 'ArrowRight' || e.key === 'Enter') this._tourNext();
        if (e.key === 'ArrowLeft')  this._tourPrev();
        if (e.key === 'Escape') this._endTour();
      }
    });
  }

  // ── Tour ─────────────────────────────────────────────────────────────────

  startTour() {
    this._tourIdx = 0;
    this._tourOverlay?.classList.add('active');
    this._tourOverlay.style.display = 'block';
    this._showTourStep();
  }

  _endTour() {
    this._tourOverlay?.classList.remove('active');
    this._tourOverlay.style.display = 'none';
    // Restore full visibility
    if (this._spotlight) this._spotlight.style.clipPath = '';
  }

  _tourNext() {
    if (this._tourIdx >= TOUR_STEPS.length - 1) { this._endTour(); return; }
    this._tourIdx++;
    this._showTourStep();
  }

  _tourPrev() {
    if (this._tourIdx <= 0) return;
    this._tourIdx--;
    this._showTourStep();
  }

  _showTourStep() {
    const step = TOUR_STEPS[this._tourIdx];
    const el   = document.querySelector(step.selector);

    // Run any setup the step needs (e.g. opening a tab)
    if (step.onEnter) step.onEnter();

    // Update tooltip text
    if (this._tipTitle) this._tipTitle.textContent = step.title;
    if (this._tipBody)  this._tipBody.textContent  = step.body;
    if (this._tipCounter) this._tipCounter.textContent = `${this._tourIdx + 1} / ${TOUR_STEPS.length}`;

    // Prev button visibility
    const prevBtn = document.getElementById('tour-prev-btn');
    if (prevBtn) prevBtn.style.visibility = this._tourIdx === 0 ? 'hidden' : 'visible';

    // Next button label
    const nextBtn = document.getElementById('tour-next-btn');
    if (nextBtn) nextBtn.textContent = this._tourIdx === TOUR_STEPS.length - 1 ? 'Done ✓' : 'Next →';

    if (!el) {
      // Element not found — just clear spotlight
      if (this._spotlight) this._spotlight.style.clipPath = 'inset(0 0 0 0)';
      return;
    }

    const rect = el.getBoundingClientRect();
    const pad  = 8;
    const vw   = window.innerWidth;
    const vh   = window.innerHeight;

    const x1 = Math.max(0, rect.left   - pad);
    const y1 = Math.max(0, rect.top    - pad);
    const x2 = Math.min(vw, rect.right  + pad);
    const y2 = Math.min(vh, rect.bottom + pad);

    // Cut a hole in the backdrop using clip-path polygon
    // Outer rect (full screen) minus inner rect (spotlight)
    if (this._spotlight) {
      this._spotlight.style.clipPath = `polygon(
        0% 0%, 100% 0%, 100% 100%, 0% 100%,
        0% ${y1}px, ${x1}px ${y1}px, ${x1}px ${y2}px, ${x2}px ${y2}px,
        ${x2}px ${y1}px, 0% ${y1}px
      )`;
    }

    // Position tooltip near the element
    this._positionTooltip(rect, step.side, x1, y1, x2, y2, vw, vh);
  }

  _positionTooltip(rect, preferredSide, x1, y1, x2, y2, vw, vh) {
    const tip   = this._tooltip;
    if (!tip) return;
    const tw = 280, th = 160; // approx tooltip size
    const gap = 16;
    let   top, left, arrowCss;

    const sides = [preferredSide, 'right', 'left', 'bottom', 'top'];
    for (const side of sides) {
      if (side === 'right' && x2 + gap + tw <= vw) {
        left = x2 + gap;
        top  = Math.max(8, Math.min(vh - th - 8, (y1 + y2) / 2 - th / 2));
        arrowCss = `left:-6px;top:${Math.min(th-20, Math.max(10,(y1+y2)/2-top-5))}px;border-right-color:transparent;border-top-color:transparent;`;
        break;
      }
      if (side === 'left' && x1 - gap - tw >= 0) {
        left = x1 - gap - tw;
        top  = Math.max(8, Math.min(vh - th - 8, (y1 + y2) / 2 - th / 2));
        arrowCss = `right:-6px;top:${Math.min(th-20, Math.max(10,(y1+y2)/2-top-5))}px;border-left-color:transparent;border-bottom-color:transparent;`;
        break;
      }
      if (side === 'bottom' && y2 + gap + th <= vh) {
        top  = y2 + gap;
        left = Math.max(8, Math.min(vw - tw - 8, (x1 + x2) / 2 - tw / 2));
        arrowCss = `top:-6px;left:${Math.min(tw-20,Math.max(10,(x1+x2)/2-left-5))}px;border-bottom-color:transparent;border-right-color:transparent;`;
        break;
      }
      if (side === 'top' && y1 - gap - th >= 0) {
        top  = y1 - gap - th;
        left = Math.max(8, Math.min(vw - tw - 8, (x1 + x2) / 2 - tw / 2));
        arrowCss = `bottom:-6px;left:${Math.min(tw-20,Math.max(10,(x1+x2)/2-left-5))}px;border-top-color:transparent;border-left-color:transparent;`;
        break;
      }
      // fallback — centre of screen
      top = (vh - th) / 2; left = (vw - tw) / 2; arrowCss = 'display:none';
    }

    tip.style.top    = `${top}px`;
    tip.style.left   = `${left}px`;
    tip.style.setProperty('--arrow', arrowCss);
    // Apply arrow style via ::before override
    const styleId = 'tour-arrow-style';
    let styleEl = document.getElementById(styleId);
    if (!styleEl) { styleEl = document.createElement('style'); styleEl.id = styleId; document.head.appendChild(styleEl); }
    styleEl.textContent = `#tour-tooltip::before { ${arrowCss} }`;
  }
}
