/**
 * FittingPipeline — vectorization + equation derivation, decoupled from each other.
 *
 * ARCHITECTURE:
 *   vectorizeStroke(rawPts, worldRange)  → a SHAPE object (the one true geometry)
 *       This is checkbox-INDEPENDENT — always produces the single most accurate
 *       representation (a circle, or an always-cubic smooth chain of anchors).
 *       Runs once, when a stroke is drawn. This is what gets dragged/edited.
 *
 *   deriveEquations(shape, checked)      → [{label, desmos}]
 *       Re-expresses a shape's CURRENT geometry (reflecting any drags) in
 *       whichever degrees are currently checked. Never touches raw pixels —
 *       only ever samples the shape's own live curve. Cheap, instant, safe
 *       to call on every checkbox toggle and every drag frame.
 *
 *   deriveInequality(shape, worldRange)  → [{label, desmos}]
 *       Same idea, but produces a SOLID region (< instead of =) for the Fill tool.
 *
 * Public API also keeps fitShape() for the geometric shape tools (rect/circle/
 * polygon/line) — unchanged, since those aren't hand-drawn freehand strokes.
 */

// ── Utility ──────────────────────────────────────────────────────────────────

export function round(n, d = 3) { return Math.round(n * 10 ** d) / 10 ** d; }
export function fmtSigned(c)    { return c >= 0 ? `+${round(c)}` : `${round(c)}`; }
function xMinus(v) { return v >= 0 ? `-${round(v)}` : `+${round(-v)}`; }

// ── Ramer-Douglas-Peucker simplification ─────────────────────────────────────

function perpDist(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / (len * len);
  const proj = { x: a.x + t * dx, y: a.y + t * dy };
  return Math.hypot(p.x - proj.x, p.y - proj.y);
}

export function rdp(points, epsilon) {
  if (points.length < 3) return points;
  let maxD = 0, idx = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const d = perpDist(points[i], points[0], points[points.length - 1]);
    if (d > maxD) { maxD = d; idx = i; }
  }
  if (maxD > epsilon) {
    const left  = rdp(points.slice(0, idx + 1), epsilon);
    const right = rdp(points.slice(idx), epsilon);
    return left.slice(0, -1).concat(right);
  }
  return [points[0], points[points.length - 1]];
}

// ── Linear algebra ────────────────────────────────────────────────────────────

function solveLinearSystem(A, b) {
  const n = A.length;
  for (let i = 0; i < n; i++) A[i] = [...A[i], b[i]];
  for (let i = 0; i < n; i++) {
    let maxRow = i;
    for (let k = i + 1; k < n; k++)
      if (Math.abs(A[k][i]) > Math.abs(A[maxRow][i])) maxRow = k;
    [A[i], A[maxRow]] = [A[maxRow], A[i]];
    for (let k = i + 1; k < n; k++) {
      const f = A[k][i] / A[i][i];
      for (let j = i; j <= n; j++) A[k][j] -= f * A[i][j];
    }
  }
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let sum = A[i][n];
    for (let j = i + 1; j < n; j++) sum -= A[i][j] * x[j];
    x[i] = sum / A[i][i];
  }
  return x;
}

// polynomial least squares: fit y = c0 + c1*x + ... + cn*x^n
function polyfit(pts, degree) {
  const n = degree + 1;
  const A = Array.from({ length: n }, () => new Array(n).fill(0));
  const b = new Array(n).fill(0);
  for (const p of pts) {
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) A[i][j] += Math.pow(p.x, i + j);
      b[i] += Math.pow(p.x, i) * p.y;
    }
  }
  return solveLinearSystem(A, b);
}
function evalPoly(coeffs, x) {
  return coeffs.reduce((sum, c, i) => sum + c * Math.pow(x, i), 0);
}

// ── Circle fit (Kasa algebraic method) + goodness check ──────────────────────

function fitCircle(pts) {
  const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const b = [0, 0, 0];
  for (const p of pts) {
    const x = p.x, y = p.y, z = x * x + y * y;
    A[0][0] += x * x; A[0][1] += x * y; A[0][2] += x;
    A[1][0] += x * y; A[1][1] += y * y; A[1][2] += y;
    A[2][0] += x;     A[2][1] += y;     A[2][2] += 1;
    b[0] += -z * x; b[1] += -z * y; b[2] += -z;
  }
  const [D, E, F] = solveLinearSystem(A, b);
  const h = -D / 2, k = -E / 2;
  const r2 = h * h + k * k - F;
  return { h, k, r: Math.sqrt(Math.max(r2, 0)) };
}
function radiusGoodness(pts, h, k) {
  const radii = pts.map(p => Math.hypot(p.x - h, p.y - k));
  const mean = radii.reduce((a, b) => a + b, 0) / radii.length;
  const variance = radii.reduce((a, b) => a + (b - mean) ** 2, 0) / radii.length;
  return Math.sqrt(variance) / mean;
}

// ── Guaranteed-coverage piecewise fitting (arc-length parametrized) ──────────

function arcLengthParam(pts) {
  const d = [0];
  for (let i = 1; i < pts.length; i++)
    d.push(d[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  const total = d[d.length - 1] || 1;
  return d.map(x => x / total);
}

function fitPolyDegreeSegment(pts, degree) {
  const ts = arcLengthParam(pts);
  const d = Math.min(degree, pts.length - 1);
  const cx = polyfit(pts.map((p, i) => ({ x: ts[i], y: p.x })), d);
  const cy = polyfit(pts.map((p, i) => ({ x: ts[i], y: p.y })), d);
  let maxErr = 0, maxIdx = 0;
  pts.forEach((p, i) => {
    const fx = evalPoly(cx, ts[i]), fy = evalPoly(cy, ts[i]);
    const e = Math.hypot(fx - p.x, fy - p.y);
    if (e > maxErr) { maxErr = e; maxIdx = i; }
  });
  return { cx, cy, degree: d, maxErr, maxIdx };
}

// Recursively subdivide using ONLY the checked degrees — never a degree that
// wasn't allowed. If only linear is allowed, this keeps splitting into more
// line segments until the whole stroke is covered, guaranteeing full
// reconstruction (a polyline can approximate any curve, given enough pieces).
function adaptivePiecewiseFit(pts, tolerance, allowedDegrees, depth = 0) {
  const maxDegree = Math.max(...allowedDegrees);
  if (pts.length < 3 || depth > 9) {
    return [fitPolyDegreeSegment(pts, Math.min(maxDegree, Math.max(1, pts.length - 1)))];
  }
  const fit = fitPolyDegreeSegment(pts, maxDegree);
  if (fit.maxErr <= tolerance || pts.length <= maxDegree + 2) return [fit];
  const splitIdx = Math.max(2, Math.min(pts.length - 3, fit.maxIdx));
  const left  = pts.slice(0, splitIdx + 1);
  const right = pts.slice(splitIdx);
  return [
    ...adaptivePiecewiseFit(left, tolerance, allowedDegrees, depth + 1),
    ...adaptivePiecewiseFit(right, tolerance, allowedDegrees, depth + 1),
  ];
}

// ── EXACT monomial -> cubic Bezier conversion (degree elevation where needed) ─
// A degree-d polynomial and a degree-d Bezier curve are two bases for the same
// curve — this loses nothing. Everything gets stored as cubic uniformly so the
// anchor+handle drag model works the same regardless of original fit degree.

function padCoeffs(arr, degree) { const out = arr.slice(); while (out.length < degree + 1) out.push(0); return out; }

function pieceToCubicBezier(piece) {
  const cx = padCoeffs(piece.cx, piece.degree), cy = padCoeffs(piece.cy, piece.degree);
  if (piece.degree === 1) {
    const P0 = { x: cx[0], y: cy[0] }, P1 = { x: cx[0] + cx[1], y: cy[0] + cy[1] };
    return [ P0, { x: P0.x + (P1.x - P0.x) / 3, y: P0.y + (P1.y - P0.y) / 3 },
                 { x: P0.x + 2 * (P1.x - P0.x) / 3, y: P0.y + 2 * (P1.y - P0.y) / 3 }, P1 ];
  }
  if (piece.degree === 2) {
    const Q0 = { x: cx[0], y: cy[0] };
    const Q1 = { x: cx[0] + cx[1] / 2, y: cy[0] + cy[1] / 2 };
    const Q2 = { x: cx[0] + cx[1] + cx[2], y: cy[0] + cy[1] + cy[2] };
    return [ Q0, { x: Q0.x + 2 / 3 * (Q1.x - Q0.x), y: Q0.y + 2 / 3 * (Q1.y - Q0.y) },
                 { x: Q2.x + 2 / 3 * (Q1.x - Q2.x), y: Q2.y + 2 / 3 * (Q1.y - Q2.y) }, Q2 ];
  }
  const [a0, a1, a2, a3] = cx, [d0, d1, d2, d3] = cy;
  return [
    { x: a0, y: d0 },
    { x: a0 + a1 / 3, y: d0 + d1 / 3 },
    { x: a0 + 2 * a1 / 3 + a2 / 3, y: d0 + 2 * d1 / 3 + d2 / 3 },
    { x: a0 + a1 + a2 + a3, y: d0 + d1 + d2 + d3 },
  ];
}

// Build a chain of on-curve anchors (each owning 2 invisible handles), welding
// each shared boundary point into ONE anchor so dragging it moves both
// neighboring curves together instead of tearing them apart.
function buildChainFromPieces(pieces) {
  const beziers = pieces.map(pieceToCubicBezier);
  const n = beziers.length;
  const nodes = [];
  for (let i = 0; i <= n; i++) {
    if (i === 0) {
      const [P0, P1] = beziers[0];
      nodes.push({ x: P0.x, y: P0.y, hInX: P0.x, hInY: P0.y, hOutX: P1.x, hOutY: P1.y });
    } else if (i === n) {
      const [, , P2, P3] = beziers[n - 1];
      nodes.push({ x: P3.x, y: P3.y, hInX: P2.x, hInY: P2.y, hOutX: P3.x, hOutY: P3.y });
    } else {
      const [, , P2left, P3left] = beziers[i - 1];
      const [P0right, P1right] = beziers[i];
      const wx = (P3left.x + P0right.x) / 2, wy = (P3left.y + P0right.y) / 2; // weld
      nodes.push({ x: wx, y: wy, hInX: P2left.x, hInY: P2left.y, hOutX: P1right.x, hOutY: P1right.y });
    }
  }
  return nodes;
}

export function sampleCubic(n0, n1, steps = 24) {
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps, mt = 1 - t;
    const b0 = mt * mt * mt, b1 = 3 * mt * mt * t, b2 = 3 * mt * t * t, b3 = t * t * t;
    pts.push({
      x: b0 * n0.x + b1 * n0.hOutX + b2 * n1.hInX + b3 * n1.x,
      y: b0 * n0.y + b1 * n0.hOutY + b2 * n1.hInY + b3 * n1.y,
    });
  }
  return pts;
}
function segmentDesmos(n0, n1) {
  const xE = `(1-t)^{3}*${round(n0.x)}+3(1-t)^{2}t*${round(n0.hOutX)}+3(1-t)t^{2}*${round(n1.hInX)}+t^{3}*${round(n1.x)}`;
  const yE = `(1-t)^{3}*${round(n0.y)}+3(1-t)^{2}t*${round(n0.hOutY)}+3(1-t)t^{2}*${round(n1.hInY)}+t^{3}*${round(n1.y)}`;
  return `(${xE},${yE})`;
}
function polyPieceDesmos(piece) {
  const xTerms = piece.cx.map((c, i) => i === 0 ? `${round(c)}` : i === 1 ? `${fmtSigned(c)}t` : `${fmtSigned(c)}t^{${i}}`).join('');
  const yTerms = piece.cy.map((c, i) => i === 0 ? `${round(c)}` : i === 1 ? `${fmtSigned(c)}t` : `${fmtSigned(c)}t^{${i}}`).join('');
  return `(${xTerms},${yTerms})`;
}
const degreeLabel = { 1: 'Line', 2: 'Quad', 3: 'Cubic' };

// ── Vectorization (checkbox-independent) ─────────────────────────────────────

/**
 * Convert a raw freehand stroke into its ONE canonical vector shape.
 * Never depends on which fit types are checked — always finds the single
 * most accurate representation. This is what gets stored and dragged.
 * @returns {object|null}  { type:'circle', h,k,r, edgeAngle } |
 *                         { type:'chain', nodes:[...] } | null
 */
export function vectorizeStroke(rawPts, worldRange = 20) {
  const simplified = rdp(rawPts, worldRange * 0.004);
  if (simplified.length < 2) return null;

  const startEndDist = Math.hypot(
    simplified[0].x - simplified.at(-1).x,
    simplified[0].y - simplified.at(-1).y
  );
  const isClosed = startEndDist < worldRange * 0.06 && simplified.length > 6;

  if (isClosed) {
    const c = fitCircle(simplified);
    if (radiusGoodness(simplified, c.h, c.k) < 0.12) {
      return { type: 'circle', h: c.h, k: c.k, r: c.r, edgeAngle: 0 };
    }
  }

  const pieces = adaptivePiecewiseFit(simplified, worldRange * 0.012, [3]); // always cubic
  const nodes = buildChainFromPieces(pieces);
  return { type: 'chain', nodes };
}

// Dense point samples of a shape's CURRENT geometry (reflects live drag edits).
export function getSamplePoints(shape) {
  if (shape.type === 'circle') {
    const pts = [];
    for (let i = 0; i <= 200; i++) { const a = (i / 200) * 2 * Math.PI; pts.push({ x: shape.h + shape.r * Math.cos(a), y: shape.k + shape.r * Math.sin(a) }); }
    return pts;
  }
  const pts = [];
  for (let i = 0; i < shape.nodes.length - 1; i++) {
    const seg = sampleCubic(shape.nodes[i], shape.nodes[i + 1], 20);
    if (i > 0) seg.shift();
    pts.push(...seg);
  }
  return pts;
}

// ── Equation derivation (checkbox-dependent, but never touches raw pixels) ───

/**
 * Re-express a shape's CURRENT geometry using only the checked degrees.
 * @param {object} shape    from vectorizeStroke() — possibly edited via drag
 * @param {object} checked  { linear, quad, cubic, circle }
 * @returns {Array<{label, desmos}>}
 */
export function deriveEquations(shape, checked, worldRange = 20) {
  const allowed = [];
  if (checked.linear) allowed.push(1);
  if (checked.quad)   allowed.push(2);
  if (checked.cubic)  allowed.push(3);

  if (shape.type === 'circle') {
    if (checked.circle) {
      return [{ label: 'Circle', desmos: `(x${xMinus(shape.h)})^{2}+(y${xMinus(shape.k)})^{2}=${round(shape.r * shape.r)}` }];
    }
    if (allowed.length === 0) return [];
    const pieces = adaptivePiecewiseFit(getSamplePoints(shape), worldRange * 0.012, allowed);
    return pieces.map(p => ({ label: degreeLabel[p.degree] || 'Curve', desmos: polyPieceDesmos(p) }));
  }

  if (shape.type === 'static') {
    if (!shape.desmos) return [];
    return [{ label: shape.label || 'Shape', desmos: shape.desmos }];
  }

  // chain shape — natively cubic, so cubic is a free exact lookup
  if (checked.cubic) {
    const eqs = [];
    for (let i = 0; i < shape.nodes.length - 1; i++) eqs.push({ label: 'Cubic', desmos: segmentDesmos(shape.nodes[i], shape.nodes[i + 1]) });
    return eqs;
  }
  if (checked.linear || checked.quad) {
    const pieces = adaptivePiecewiseFit(getSamplePoints(shape), worldRange * 0.012, allowed);
    return pieces.map(p => ({ label: degreeLabel[p.degree] || 'Curve', desmos: polyPieceDesmos(p) }));
  }
  if (checked.circle) {
    const samples = getSamplePoints(shape);
    const d = Math.hypot(samples[0].x - samples.at(-1).x, samples[0].y - samples.at(-1).y);
    if (d < worldRange * 0.06) {
      const c = fitCircle(samples);
      if (radiusGoodness(samples, c.h, c.k) < 0.15) {
        return [{ label: 'Circle', desmos: `(x${xMinus(c.h)})^{2}+(y${xMinus(c.k)})^{2}=${round(c.r * c.r)}` }];
      }
    }
  }
  return []; // nothing checked can represent this shape's geometry
}

// ── Point-in-shape test (used by the Fill tool) ──────────────────────────────

export function pointInShape(shape, wx, wy) {
  if (shape.type === 'circle') {
    return Math.hypot(wx - shape.h, wy - shape.k) <= shape.r;
  }
  // ray-casting point-in-polygon test against the sampled boundary
  const pts = getSamplePoints(shape);
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i].x, yi = pts[i].y, xj = pts[j].x, yj = pts[j].y;
    const intersects = ((yi > wy) !== (yj > wy)) &&
      (wx < (xj - xi) * (wy - yi) / (yj - yi) + xi);
    if (intersects) inside = !inside;
  }
  return inside;
}

// ── Solid-region (inequality) derivation, for the Fill tool ─────────────────
// Produces "< / >" versions instead of "=" so pasting into Desmos shades a
// solid region rather than drawing just the boundary curve.

// Fit y = poly(x) pieces directly against x (not arc-length) — used to build
// an explicit upper/lower boundary envelope for a closed shape.
function fitFunctionPiece(pts, degree) {
  const d = Math.min(degree, pts.length - 1);
  const coeffs = polyfit(pts, d);
  let maxErr = 0, maxIdx = 0;
  pts.forEach((p, i) => { const e = Math.abs(evalPoly(coeffs, p.x) - p.y); if (e > maxErr) { maxErr = e; maxIdx = i; } });
  return { coeffs, degree: d, maxErr, maxIdx };
}
function functionPieceDesmos(fit, xMin, xMax) {
  const terms = fit.coeffs.map((c, i) => i === 0 ? `${round(c)}` : i === 1 ? `${fmtSigned(c)}x` : `${fmtSigned(c)}x^{${i}}`);
  return { expr: terms.join(''), xMin: round(xMin), xMax: round(xMax) };
}

/**
 * @param {object} shape
 * @param {object} checked   which polynomial degrees are allowed for a chain's
 *                           upper/lower envelope (falls back to cubic if none checked)
 * @returns {Array<{label, desmos}>}
 */
export function deriveInequality(shape, checked = {}, worldRange = 20) {
  // Static shapes that already carry their own desmos expression (e.g. half-plane fills)
  if (shape.type === 'static') {
    return shape.desmos ? [{ label: shape.label || 'Fill', desmos: shape.desmos }] : [];
  }
  if (shape.type === 'circle') {
    return [{ label: 'Circle (solid)', desmos: `(x${xMinus(shape.h)})^{2}+(y${xMinus(shape.k)})^{2}<${round(shape.r * shape.r)}` }];
  }
  // Closed chain: build an upper/lower envelope as explicit functions of x by
  // sampling the boundary and bucketing by x. This only produces a correct
  // solid region for shapes that are "y-simple" (each vertical line crosses
  // the boundary at most twice) — concave or self-intersecting hand-drawn
  // shapes will get an approximate, not exact, fill.
  const samples = getSamplePoints(shape);
  const xs = samples.map(p => p.x);
  const xMin = Math.min(...xs), xMax = Math.max(...xs);
  const BUCKETS = 80;
  const upperPts = [], lowerPts = [];
  for (let b = 0; b <= BUCKETS; b++) {
    const bx = xMin + (b / BUCKETS) * (xMax - xMin);
    const bw = (xMax - xMin) / BUCKETS;
    const inBucket = samples.filter(p => Math.abs(p.x - bx) <= bw);
    if (inBucket.length === 0) continue;
    upperPts.push({ x: bx, y: Math.max(...inBucket.map(p => p.y)) });
    lowerPts.push({ x: bx, y: Math.min(...inBucket.map(p => p.y)) });
  }
  if (upperPts.length < 3) return [];

  const allowed = [];
  if (checked.linear) allowed.push(1);
  if (checked.quad)   allowed.push(2);
  if (checked.cubic)  allowed.push(3);
  if (allowed.length === 0) allowed.push(3); // fill always needs SOME basis — default to cubic
  const maxDegree = Math.max(...allowed);

  // Split the x-range into equal segments and fit upper/lower boundary
  // functions independently within each — simple, robust pairing that keeps
  // both curves defined over the exact same x-interval per inequality line.
  const tol = worldRange * 0.02;
  const targetSegCount = Math.max(1, Math.ceil((xMax - xMin) / (tol * 6)));
  const segCount = Math.min(targetSegCount, 24); // sanity cap
  const results = [];
  for (let i = 0; i < segCount; i++) {
    const segXMin = xMin + (i / segCount) * (xMax - xMin);
    const segXMax = xMin + ((i + 1) / segCount) * (xMax - xMin);
    const segUpperPts = upperPts.filter(p => p.x >= segXMin - 1e-9 && p.x <= segXMax + 1e-9);
    const segLowerPts = lowerPts.filter(p => p.x >= segXMin - 1e-9 && p.x <= segXMax + 1e-9);
    if (segUpperPts.length < 2 || segLowerPts.length < 2) continue;
    const upFit = fitFunctionPiece(segUpperPts, maxDegree);
    const loFit = fitFunctionPiece(segLowerPts, maxDegree);
    const up = functionPieceDesmos(upFit, segXMin, segXMax);
    const lo = functionPieceDesmos(loFit, segXMin, segXMax);
    results.push({
      label: 'Fill',
      desmos: `${lo.expr}<y<${up.expr}\\left\\{${lo.xMin}\\le x\\le${lo.xMax}\\right\\}`,
    });
  }
  return results;
}

/**
 * Fit geometric shapes (rectangle, circle tool, polygon).
 * @param {Array<{x,y}>} points  Defining vertices in world coords
 * @param {'rect'|'circle'|'polygon'|'line'} shapeType
 * @returns {Array<{type, desmos, previewPoints}>}
 */
export function fitShape(points, shapeType) {
  switch (shapeType) {
    case 'rect': {
      const results = [];
      for (let i = 0; i < 4; i++) {
        const a = points[i], b = points[(i + 1) % 4];
        const slope = a.x !== b.x ? (b.y - a.y) / (b.x - a.x) : null;
        let desmos, preview;
        if (slope === null) {
          const xVal = round(a.x);
          const yMin = round(Math.min(a.y, b.y)), yMax = round(Math.max(a.y, b.y));
          desmos = `x=${xVal}\\left\\{${yMin}\\le y\\le${yMax}\\right\\}`;
          preview = [a, b];
        } else {
          const intercept = a.y - slope * a.x;
          const xMin = round(Math.min(a.x, b.x)), xMax = round(Math.max(a.x, b.x));
          desmos = `y=${round(slope)}x${fmtSigned(intercept)}\\left\\{${xMin}\\le x\\le${xMax}\\right\\}`;
          preview = [a, b];
        }
        results.push({ type: 'Line', desmos, previewPoints: preview });
      }
      return results;
    }
    case 'circle': {
      if (points.length >= 2) {
        const [center, edge] = points;
        const r = Math.hypot(edge.x - center.x, edge.y - center.y);
        const desmos = `(x${fmtSigned(-center.x)})^{2}+(y${fmtSigned(-center.y)})^{2}=${round(r * r)}`;
        const preview = [];
        for (let t = 0; t <= 64; t++) { const a = (t / 64) * 2 * Math.PI; preview.push({ x: center.x + r * Math.cos(a), y: center.y + r * Math.sin(a) }); }
        return [{ type: 'Circle', desmos, previewPoints: preview }];
      }
      return [];
    }
    case 'ellipse': {
      // points = [{ cx, cy, rx, ry }]
      if (points.length >= 1) {
        const { cx, cy, rx, ry } = points[0];
        const isCircle = Math.abs(rx - ry) < 0.001;
        let desmos, preview;
        if (isCircle) {
          desmos = `(x${fmtSigned(-cx)})^{2}+(y${fmtSigned(-cy)})^{2}=${round(rx * rx)}`;
        } else {
          desmos = `\\frac{(x${fmtSigned(-cx)})^{2}}{${round(rx * rx)}}+\\frac{(y${fmtSigned(-cy)})^{2}}{${round(ry * ry)}}=1`;
        }
        preview = [];
        for (let t = 0; t <= 64; t++) {
          const a = (t / 64) * 2 * Math.PI;
          preview.push({ x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a) });
        }
        return [{ type: isCircle ? 'Circle' : 'Ellipse', desmos, previewPoints: preview }];
      }
      return [];
    }
    case 'line': {
      if (points.length < 2) return [];
      const [a, b] = points;
      const slope = a.x !== b.x ? (b.y - a.y) / (b.x - a.x) : null;
      if (slope === null) {
        const xVal = round(a.x);
        const yMin = round(Math.min(a.y, b.y)), yMax = round(Math.max(a.y, b.y));
        return [{ type: 'Line', desmos: `x=${xVal}\\left\\{${yMin}\\le y\\le${yMax}\\right\\}`, previewPoints: [a, b] }];
      }
      const intercept = a.y - slope * a.x;
      const xMin = round(Math.min(a.x, b.x)), xMax = round(Math.max(a.x, b.x));
      return [{ type: 'Line', desmos: `y=${round(slope)}x${fmtSigned(intercept)}\\left\\{${xMin}\\le x\\le${xMax}\\right\\}`, previewPoints: [a, b] }];
    }
    case 'polygon': {
      const results = [];
      for (let i = 0; i < points.length - 1; i++) results.push(...fitShape([points[i], points[i + 1]], 'line'));
      return results;
    }
    default:
      return [];
  }
}
