const UNIT_TO_MM = { 0: 1, 1: 25.4, 2: 304.8, 4: 1, 5: 10, 6: 1000 };
const UNIT_NAME = { 1: 'inch', 2: 'ft', 4: 'mm', 5: 'cm', 6: 'm' };
const CHORD_TOL_MM = 1.0;
const SUPPORTED = new Set(['LINE', 'LWPOLYLINE', 'POLYLINE', 'CIRCLE', 'ARC', 'ELLIPSE', 'SPLINE', 'INSERT']);

function readPairs(text) {
  const lines = text.split(/\r\n|\r|\n/);
  const pairs = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = parseInt(lines[i].trim(), 10);
    if (Number.isNaN(code)) { i -= 1; continue; }
    pairs.push([code, lines[i + 1].trim()]);
  }
  return pairs;
}

function splitEntities(pairs, start, stopValues) {
  const out = [];
  let i = start, cur = null;
  while (i < pairs.length) {
    const [c, v] = pairs[i];
    if (c === 0) {
      if (stopValues.includes(v)) break;
      cur = { type: v, codes: [] };
      out.push(cur);
    } else if (cur) cur.codes.push([c, v]);
    i++;
  }
  return { entities: out, next: i };
}

function groupPolylines(list) {
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    if (e.type === 'POLYLINE') {
      e.vertices = [];
      while (i + 1 < list.length && list[i + 1].type === 'VERTEX') e.vertices.push(list[++i]);
      if (i + 1 < list.length && list[i + 1].type === 'SEQEND') i++;
    }
    if (e.type !== 'VERTEX' && e.type !== 'SEQEND') out.push(e);
  }
  return out;
}

function parse(text) {
  const pairs = readPairs(text);
  let insunits = 0;
  const blocks = {};
  let entities = [];
  for (let i = 0; i < pairs.length; i++) {
    if (pairs[i][0] !== 0 || pairs[i][1] !== 'SECTION' || !pairs[i + 1]) continue;
    const name = pairs[i + 1][1];
    if (name === 'HEADER') {
      for (let j = i + 2; j < pairs.length && !(pairs[j][0] === 0 && pairs[j][1] === 'ENDSEC'); j++) {
        if (pairs[j][0] === 9 && pairs[j][1] === '$INSUNITS' && pairs[j + 1]) insunits = parseInt(pairs[j + 1][1], 10) || 0;
      }
    } else if (name === 'BLOCKS') {
      let j = i + 2;
      while (j < pairs.length && !(pairs[j][0] === 0 && pairs[j][1] === 'ENDSEC')) {
        if (pairs[j][0] === 0 && pairs[j][1] === 'BLOCK') {
          const head = [];
          let k = j + 1;
          while (k < pairs.length && pairs[k][0] !== 0) head.push(pairs[k++]);
          const body = splitEntities(pairs, k, ['ENDBLK', 'ENDSEC']);
          const bname = (head.find((p) => p[0] === 2) || [, ''])[1];
          const bx = num(head, 10, 0), by = num(head, 20, 0);
          blocks[bname] = { base: [bx, by], entities: groupPolylines(body.entities) };
          j = body.next + 1;
        } else j++;
      }
    } else if (name === 'ENTITIES') {
      entities = groupPolylines(splitEntities(pairs, i + 2, ['ENDSEC']).entities);
    }
  }
  return { insunits, blocks, entities };
}

function num(codes, code, def) {
  const p = codes.find((q) => q[0] === code);
  return p ? parseFloat(p[1]) : def;
}

function nums(codes, code) {
  return codes.filter((q) => q[0] === code).map((q) => parseFloat(q[1]));
}

function ocsFlip(codes) {
  return num(codes, 230, 1) < 0;
}

function arcPoints(cx, cy, r, a0, a1, tol) {
  let sweep = a1 - a0;
  while (sweep <= 0) sweep += 2 * Math.PI;
  const step = r > tol ? 2 * Math.acos(Math.max(-1, 1 - tol / r)) : Math.PI / 4;
  const n = Math.max(Math.ceil(sweep / Math.max(step, 1e-3)), 2);
  const pts = [];
  for (let k = 0; k <= n; k++) {
    const a = a0 + sweep * k / n;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return pts;
}

function bulgeSegment(p0, p1, b, tol) {
  if (Math.abs(b) < 1e-12) return [p1];
  const theta = 4 * Math.atan(b), dx = p1[0] - p0[0], dy = p1[1] - p0[1], chord = Math.hypot(dx, dy);
  if (chord < 1e-12) return [p1];
  const r = chord / (2 * Math.sin(Math.abs(theta) / 2));
  const mx = (p0[0] + p1[0]) / 2, my = (p0[1] + p1[1]) / 2;
  const h = r * Math.cos(Math.abs(theta) / 2) * Math.sign(b);
  const cx = mx - h * dy / chord, cy = my + h * dx / chord;
  const a0 = Math.atan2(p0[1] - cy, p0[0] - cx);
  const step = r > tol ? 2 * Math.acos(Math.max(-1, 1 - tol / r)) : Math.PI / 4;
  const n = Math.max(Math.ceil(Math.abs(theta) / Math.max(step, 1e-3)), 1);
  const pts = [];
  for (let k = 1; k <= n; k++) {
    const a = a0 + theta * k / n;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  pts[pts.length - 1] = [p1[0], p1[1]];
  return pts;
}

function vertexPolyline(verts, closed, tol) {
  if (!verts.length) return [];
  const pts = [[verts[0].x, verts[0].y]];
  const n = verts.length, segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const a = verts[i], b = verts[(i + 1) % n];
    pts.push(...bulgeSegment([a.x, a.y], [b.x, b.y], a.bulge, tol));
  }
  return pts;
}

function deBoor(p, knots, ctrl, weights, t) {
  const n = ctrl.length - 1;
  let k = p;
  while (k < n && t >= knots[k + 1]) k++;
  const d = [];
  for (let j = 0; j <= p; j++) {
    const w = weights[j + k - p], c = ctrl[j + k - p];
    d.push([c[0] * w, c[1] * w, w]);
  }
  for (let r = 1; r <= p; r++) {
    for (let j = p; j >= r; j--) {
      const i = j + k - p, den = knots[i + p - r + 1] - knots[i];
      const al = den === 0 ? 0 : (t - knots[i]) / den;
      for (let q = 0; q < 3; q++) d[j][q] = (1 - al) * d[j - 1][q] + al * d[j][q];
    }
  }
  return [d[p][0] / d[p][2], d[p][1] / d[p][2]];
}

function splinePoints(codes, tol) {
  const deg = num(codes, 71, 3);
  const knots = nums(codes, 40), xs = nums(codes, 10), ys = nums(codes, 20);
  let weights = nums(codes, 41);
  const ctrl = xs.map((x, i) => [x, ys[i]]);
  if (ctrl.length < 2) {
    const fx = nums(codes, 11), fy = nums(codes, 21);
    const fit = fx.map((x, i) => [x, fy[i]]);
    if (fit.length < 3) return fit;
    const p = Math.min(deg, fit.length - 1), it = interpolate(fit, p);
    return sampleSpline(p, it.knots, it.ctrl, it.ctrl.map(() => 1), tol);
  }
  if (weights.length !== ctrl.length) weights = ctrl.map(() => 1);
  if (knots.length !== ctrl.length + deg + 1) return ctrl;
  return sampleSpline(deg, knots, ctrl, weights, tol);
}

function basisFuns(p, knots, span, t) {
  const N = [1], left = [], right = [];
  for (let j = 1; j <= p; j++) {
    left[j] = t - knots[span + 1 - j];
    right[j] = knots[span + j] - t;
    let saved = 0;
    for (let r = 0; r < j; r++) {
      const tmp = N[r] / (right[r + 1] + left[j - r]);
      N[r] = saved + right[r + 1] * tmp;
      saved = left[j - r] * tmp;
    }
    N[j] = saved;
  }
  return N;
}

function interpolate(Q, p) {
  const n = Q.length - 1;
  const d = [0];
  for (let k = 1; k <= n; k++) d.push(d[k - 1] + Math.hypot(Q[k][0] - Q[k - 1][0], Q[k][1] - Q[k - 1][1]));
  const ub = d.map((v) => v / d[n]);
  const knots = new Array(n + p + 2).fill(0);
  for (let k = n + 1; k <= n + p + 1; k++) knots[k] = 1;
  for (let j = 1; j <= n - p; j++) {
    let s = 0;
    for (let i = j; i <= j + p - 1; i++) s += ub[i];
    knots[j + p] = s / p;
  }
  const A = Array.from({ length: n + 1 }, () => new Array(n + 1).fill(0));
  for (let k = 0; k <= n; k++) {
    let span = p;
    while (span < n && ub[k] >= knots[span + 1]) span++;
    if (k === n) span = n;
    const Nb = basisFuns(p, knots, span, ub[k]);
    for (let j = 0; j <= p; j++) A[k][span - p + j] = Nb[j];
  }
  const B = Q.map((q) => [q[0], q[1]]);
  for (let c = 0; c <= n; c++) {
    let piv = c;
    for (let r = c + 1; r <= n; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    [A[c], A[piv]] = [A[piv], A[c]];
    [B[c], B[piv]] = [B[piv], B[c]];
    for (let r = c + 1; r <= n; r++) {
      const m = A[r][c] / A[c][c];
      if (!m) continue;
      for (let q = c; q <= n; q++) A[r][q] -= m * A[c][q];
      B[r][0] -= m * B[c][0]; B[r][1] -= m * B[c][1];
    }
  }
  const P = new Array(n + 1);
  for (let r = n; r >= 0; r--) {
    let sx = B[r][0], sy = B[r][1];
    for (let q = r + 1; q <= n; q++) { sx -= A[r][q] * P[q][0]; sy -= A[r][q] * P[q][1]; }
    P[r] = [sx / A[r][r], sy / A[r][r]];
  }
  return { knots, ctrl: P };
}

function sampleSpline(deg, knots, ctrl, weights, tol) {
  const t0 = knots[deg], t1 = knots[ctrl.length];
  const ev = (t) => deBoor(deg, knots, ctrl, weights, Math.min(t, t1 - 1e-12 * Math.max(1, Math.abs(t1))));
  const spans = Math.max(ctrl.length - deg, 1) * 4;
  const out = [ev(t0)];
  const refine = (ta, pa, tb, pb, depth) => {
    const tm = (ta + tb) / 2, pm = ev(tm);
    const dx = pb[0] - pa[0], dy = pb[1] - pa[1], L = Math.hypot(dx, dy);
    const dev = L > 1e-12 ? Math.abs((pm[0] - pa[0]) * dy - (pm[1] - pa[1]) * dx) / L : Math.hypot(pm[0] - pa[0], pm[1] - pa[1]);
    if (depth < 14 && dev > tol) { refine(ta, pa, tm, pm, depth + 1); refine(tm, pm, tb, pb, depth + 1); }
    else out.push(pb);
  };
  for (let s = 0; s < spans; s++) {
    const ta = t0 + (t1 - t0) * s / spans, tb = t0 + (t1 - t0) * (s + 1) / spans;
    refine(ta, ev(ta), tb, tb >= t1 ? deBoor(deg, knots, ctrl, weights, t1 - 1e-9 * Math.max(1, Math.abs(t1))) : ev(tb), 0);
  }
  return out;
}

function allClose(a, b) {
  return Math.abs(a[0] - b[0]) <= 1e-8 + 1e-5 * Math.abs(b[0]) && Math.abs(a[1] - b[1]) <= 1e-8 + 1e-5 * Math.abs(b[1]);
}

function entityCurves(e, tol, blocks, depth) {
  const c = e.codes, flip = ocsFlip(c), fx = (p) => (flip ? [-p[0], p[1]] : p);
  switch (e.type) {
    case 'LINE':
      return [{ pts: [[num(c, 10, 0), num(c, 20, 0)], [num(c, 11, 0), num(c, 21, 0)]], closed: null }];
    case 'CIRCLE': {
      const pts = arcPoints(num(c, 10, 0), num(c, 20, 0), num(c, 40, 0), 0, 2 * Math.PI, tol).map(fx);
      return [{ pts, closed: true }];
    }
    case 'ARC': {
      const d = Math.PI / 180;
      return [{ pts: arcPoints(num(c, 10, 0), num(c, 20, 0), num(c, 40, 0), num(c, 50, 0) * d, num(c, 51, 0) * d, tol).map(fx), closed: null }];
    }
    case 'ELLIPSE': {
      const cx = num(c, 10, 0), cy = num(c, 20, 0), mx = num(c, 11, 1), my = num(c, 21, 0), ratio = num(c, 40, 1);
      const s0 = num(c, 41, 0), s1 = num(c, 42, 2 * Math.PI), sgn = flip ? -1 : 1;
      let sweep = s1 - s0;
      while (sweep <= 0) sweep += 2 * Math.PI;
      const a = Math.hypot(mx, my), n = Math.max(Math.ceil(sweep / (2 * Math.acos(Math.max(-1, 1 - tol / Math.max(a, tol))))), 8);
      const pts = [];
      for (let k = 0; k <= n; k++) {
        const t = s0 + sweep * k / n;
        pts.push([cx + Math.cos(t) * mx - sgn * Math.sin(t) * ratio * my, cy + Math.cos(t) * my + sgn * Math.sin(t) * ratio * mx]);
      }
      return [{ pts, closed: Math.abs(sweep - 2 * Math.PI) < 1e-6 }];
    }
    case 'LWPOLYLINE': {
      const verts = [];
      for (const [code, v] of c) {
        if (code === 10) verts.push({ x: parseFloat(v), y: 0, bulge: 0 });
        else if (code === 20 && verts.length) verts[verts.length - 1].y = parseFloat(v);
        else if (code === 42 && verts.length) verts[verts.length - 1].bulge = parseFloat(v);
      }
      const closed = (num(c, 70, 0) & 1) === 1;
      return [{ pts: vertexPolyline(verts, closed, tol).map(fx), closed }];
    }
    case 'POLYLINE': {
      const flags = num(c, 70, 0);
      if (flags & (16 | 64)) return [];
      const verts = (e.vertices || []).map((v) => ({ x: num(v.codes, 10, 0), y: num(v.codes, 20, 0), bulge: num(v.codes, 42, 0) }));
      const closed = (flags & 1) === 1;
      return [{ pts: vertexPolyline(verts, closed, tol).map(fx), closed }];
    }
    case 'SPLINE': {
      const pts = splinePoints(c, tol);
      const closed = (num(c, 70, 0) & 1) === 1 ? true : null;
      return [{ pts, closed }];
    }
    case 'INSERT': {
      const blk = blocks[(c.find((q) => q[0] === 2) || [, ''])[1]];
      if (!blk || depth > 8) return [];
      const ix = num(c, 10, 0), iy = num(c, 20, 0), sx = num(c, 41, 1), sy = num(c, 42, 1), rot = num(c, 50, 0) * Math.PI / 180;
      const cr = Math.cos(rot), sr = Math.sin(rot), [bx, by] = blk.base;
      const tf = ([x, y]) => { const px = (x - bx) * sx, py = (y - by) * sy; return [ix + px * cr - py * sr, iy + px * sr + py * cr]; };
      const subTol = tol / Math.max(Math.abs(sx), Math.abs(sy), 1e-9);
      const out = [];
      for (const sub of blk.entities) {
        if (!SUPPORTED.has(sub.type)) continue;
        for (const cu of entityCurves(sub, subTol, blocks, depth + 1)) out.push({ pts: cu.pts.map(tf), closed: cu.closed });
      }
      return out;
    }
    default:
      return [];
  }
}

export function parseDxf(text) {
  const { insunits, blocks, entities } = parse(text);
  const scale = UNIT_TO_MM[insunits] ?? 1;
  const tol = 0.5 * CHORD_TOL_MM / scale;
  const curves = [];
  for (const e of entities) {
    if (!SUPPORTED.has(e.type)) continue;
    for (const cu of entityCurves(e, tol, blocks, 0)) {
      let pts = cu.pts.map(([x, y]) => [x * scale, y * scale]);
      if (pts.length < 2) continue;
      let closed = cu.closed === null ? pts.length > 2 && allClose(pts[0], pts[pts.length - 1]) : cu.closed;
      if (closed && allClose(pts[0], pts[pts.length - 1])) pts = pts.slice(0, -1);
      if (closed && pts.length < 3) continue;
      curves.push({ points: pts.map(([x, y]) => [Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000]), closed });
    }
  }
  return { curves, units: UNIT_NAME[insunits] ?? 'mm(가정)' };
}
