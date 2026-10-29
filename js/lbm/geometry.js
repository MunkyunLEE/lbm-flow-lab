function bbox(pts) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  return [x0, y0, x1, y1];
}

function polygonCells(poly, dx, Nx, Ny, visit) {
  const [x0, y0, x1, y1] = bbox(poly);
  const i0 = Math.max(Math.trunc(x0 / dx - 0.5), 0), i1 = Math.min(Math.trunc(x1 / dx + 0.5) + 1, Nx);
  const j0 = Math.max(Math.trunc(y0 / dx - 0.5), 0), j1 = Math.min(Math.trunc(y1 / dx + 0.5) + 1, Ny);
  if (i0 >= i1 || j0 >= j1) return;
  const n = poly.length, xs = [];
  for (let j = j0; j < j1; j++) {
    const Y = (j + 0.5) * dx;
    xs.length = 0;
    for (let k = 0; k < n; k++) {
      const [xa, ya] = poly[k], [xb, yb] = poly[(k + 1) % n];
      if (ya === yb) continue;
      if ((ya > Y) !== (yb > Y)) xs.push(xa + (Y - ya) * (xb - xa) / (yb - ya));
    }
    if (!xs.length) continue;
    for (let i = i0; i < i1; i++) {
      const X = (i + 0.5) * dx;
      let inside = false;
      for (let q = 0; q < xs.length; q++) if (X < xs[q]) inside = !inside;
      if (inside) visit(j * Nx + i, X, Y);
    }
  }
}

function polylineCells(pts, dx, Nx, Ny, visit) {
  for (let s = 0; s + 1 < pts.length; s++) {
    const [ax, ay] = pts[s], [bx, by] = pts[s + 1];
    const m = Math.max(Math.trunc(Math.hypot(bx - ax, by - ay) / (dx / 3)), 1);
    for (let k = 0; k <= m; k++) {
      const t = k / m, ix = Math.floor((ax + t * (bx - ax)) / dx), iy = Math.floor((ay + t * (by - ay)) / dx);
      if (ix >= 0 && ix < Nx && iy >= 0 && iy < Ny) visit(iy * Nx + ix);
    }
  }
}

function nearestBoundary(poly, X, Y) {
  let best = Infinity, bx = X, by = Y;
  for (let k = 0; k < poly.length; k++) {
    const [ax, ay] = poly[k], [cx, cy] = poly[(k + 1) % poly.length];
    const dx = cx - ax, dy = cy - ay, L2 = dx * dx + dy * dy;
    const t = L2 ? Math.max(0, Math.min(1, ((X - ax) * dx + (Y - ay) * dy) / L2)) : 0;
    const px = ax + t * dx, py = ay + t * dy, d = (X - px) ** 2 + (Y - py) ** 2;
    if (d < best) { best = d; bx = px; by = py; }
  }
  return [bx, by, Math.sqrt(best)];
}

function centroid(poly) {
  let a = 0, cx = 0, cy = 0;
  for (let k = 0; k < poly.length; k++) {
    const [x0, y0] = poly[k], [x1, y1] = poly[(k + 1) % poly.length], c = x0 * y1 - x1 * y0;
    a += c; cx += (x0 + x1) * c; cy += (y0 + y1) * c;
  }
  if (Math.abs(a) < 1e-12) { const b = bbox(poly); return [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2]; }
  return [cx / (3 * a), cy / (3 * a)];
}

export function perimeter(curves) {
  let p = 0;
  for (const c of curves) {
    const pts = c.points, n = pts.length, segs = c.closed ? n : n - 1;
    for (let k = 0; k < segs; k++) { const [ax, ay] = pts[k], [bx, by] = pts[(k + 1) % n]; p += Math.hypot(bx - ax, by - ay); }
  }
  return p;
}

export function rasterizeObjects(objects, dxmm, Nx, Ny) {
  const NN = Nx * Ny, solid = new Uint8Array(NN), owner = new Int16Array(NN).fill(-1);
  const inlet = new Map(), outlet = new Map();
  (objects || []).forEach((obj, oi) => {
    if (obj.kin && obj.kin.mode && obj.kin.mode !== 'off') return;
    const role = obj.role || 'solid';
    for (const c of obj.curves || []) {
      const pts = c.points;
      if (!pts || pts.length < 2) continue;
      const closed = c.closed && pts.length >= 3;
      if (role === 'solid') {
        const mark = (k) => { solid[k] = 1; owner[k] = oi; };
        if (closed) polygonCells(pts, dxmm, Nx, Ny, mark); else polylineCells(pts, dxmm, Nx, Ny, mark);
      } else if (closed && role === 'outlet') {
        polygonCells(pts, dxmm, Nx, Ny, (k) => outlet.set(k, +(obj.outlet?.p || 0)));
      } else if (closed && role === 'inlet') {
        const inl = obj.inlet || {}, mode = inl.mode || 'vector';
        const [gx, gy] = centroid(pts), P = perimeter([{ points: pts, closed: true }]), corr = P / (P + 2 * Math.PI * 0.8 * dxmm);
        polygonCells(pts, dxmm, Nx, Ny, (k, X, Y) => {
          if (mode === 'normal') {
            const [bx, by, d] = nearestBoundary(pts, X, Y);
            let nx = bx - X, ny = by - Y, L = Math.hypot(nx, ny);
            if (d < 1e-6 * dxmm || L < 1e-12) { nx = X - gx; ny = Y - gy; L = Math.hypot(nx, ny) || 1; }
            const un = +(inl.un || 0) * corr;
            inlet.set(k, [un * nx / L, un * ny / L, 1]);
          } else inlet.set(k, [+(inl.ux || 0), +(inl.uy || 0), 0]);
        });
      }
    }
  });
  for (const k of inlet.keys()) if (solid[k]) inlet.delete(k);
  for (const k of outlet.keys()) { if (solid[k]) outlet.delete(k); else inlet.delete(k); }
  return { solid, owner, inlet, outlet };
}
