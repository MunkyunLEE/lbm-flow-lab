function fillPolygon(solid, N, poly, dx) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of poly) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  const i0 = Math.max(Math.trunc(x0 / dx - 0.5), 0), i1 = Math.min(Math.trunc(x1 / dx + 0.5) + 1, N);
  const j0 = Math.max(Math.trunc(y0 / dx - 0.5), 0), j1 = Math.min(Math.trunc(y1 / dx + 0.5) + 1, N);
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
    const m = xs.length;
    if (!m) continue;
    const row = j * N;
    for (let i = i0; i < i1; i++) {
      const X = (i + 0.5) * dx;
      let inside = false;
      for (let q = 0; q < m; q++) if (X < xs[q]) inside = !inside;
      if (inside) solid[row + i] = 1;
    }
  }
}

function drawPolyline(solid, N, pts, dx) {
  for (let s = 0; s + 1 < pts.length; s++) {
    const [ax, ay] = pts[s], [bx, by] = pts[s + 1];
    const m = Math.max(Math.trunc(Math.hypot(bx - ax, by - ay) / (dx / 3)), 1);
    for (let k = 0; k <= m; k++) {
      const t = k / m, ix = Math.floor((ax + t * (bx - ax)) / dx), iy = Math.floor((ay + t * (by - ay)) / dx);
      if (ix >= 0 && ix < N && iy >= 0 && iy < N) solid[iy * N + ix] = 1;
    }
  }
}

export function rasterize(obstacles, Lmm, N) {
  const solid = new Uint8Array(N * N), dx = Lmm / N;
  for (const obj of obstacles || []) {
    for (const c of obj.curves || []) {
      const pts = c.points;
      if (!pts || pts.length < 2) continue;
      if (c.closed && pts.length >= 3) fillPolygon(solid, N, pts, dx);
      else drawPolyline(solid, N, pts, dx);
    }
  }
  return solid;
}
