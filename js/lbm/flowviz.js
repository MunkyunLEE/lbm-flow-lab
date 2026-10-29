function sample(ux, uy, solid, Nx, Ny, x, y) {
  const fx = x - 0.5, fy = y - 0.5, i = Math.floor(fx), j = Math.floor(fy);
  if (i < 0 || j < 0 || i >= Nx - 1 || j >= Ny - 1) return null;
  const ax = fx - i, ay = fy - j, k = j * Nx + i;
  if (solid[k] && solid[k + 1] && solid[k + Nx] && solid[k + Nx + 1]) return null;
  const w00 = (1 - ax) * (1 - ay), w10 = ax * (1 - ay), w01 = (1 - ax) * ay, w11 = ax * ay;
  return [
    w00 * ux[k] + w10 * ux[k + 1] + w01 * ux[k + Nx] + w11 * ux[k + Nx + 1],
    w00 * uy[k] + w10 * uy[k + 1] + w01 * uy[k + Nx] + w11 * uy[k + Nx + 1],
  ];
}

function trace(ux, uy, solid, Nx, Ny, x0, y0, dir, h, maxSteps, occ, ocSize, ocCols, ocRows, umin) {
  const pts = [];
  let x = x0, y = y0;
  for (let n = 0; n < maxSteps; n++) {
    const v1 = sample(ux, uy, solid, Nx, Ny, x, y);
    if (!v1) break;
    const s1 = Math.hypot(v1[0], v1[1]);
    if (s1 < umin) break;
    const d = (v) => { const s = Math.hypot(v[0], v[1]) || 1; return [dir * v[0] / s, dir * v[1] / s]; };
    const k1 = d(v1);
    const v2 = sample(ux, uy, solid, Nx, Ny, x + 0.5 * h * k1[0], y + 0.5 * h * k1[1]); if (!v2) break;
    const k2 = d(v2);
    const v3 = sample(ux, uy, solid, Nx, Ny, x + 0.5 * h * k2[0], y + 0.5 * h * k2[1]); if (!v3) break;
    const k3 = d(v3);
    const v4 = sample(ux, uy, solid, Nx, Ny, x + h * k3[0], y + h * k3[1]); if (!v4) break;
    const k4 = d(v4);
    x += h * (k1[0] + 2 * k2[0] + 2 * k3[0] + k4[0]) / 6;
    y += h * (k1[1] + 2 * k2[1] + 2 * k3[1] + k4[1]) / 6;
    const ci = Math.floor(x / ocSize), cj = Math.floor(y / ocSize);
    if (ci < 0 || cj < 0 || ci >= ocCols || cj >= ocRows) break;
    const o = occ[cj * ocCols + ci];
    if (o === 2) break;
    pts.push([x, y]);
  }
  return pts;
}

export function streamlines(ux, uy, solid, Nx, Ny, spacingCells) {
  const ocSize = Math.max(2, spacingCells / 2), ocCols = Math.ceil(Nx / ocSize), ocRows = Math.ceil(Ny / ocSize);
  const occ = new Uint8Array(ocCols * ocRows);
  let umax = 0;
  for (let k = 0; k < ux.length; k++) umax = Math.max(umax, Math.hypot(ux[k], uy[k]));
  const umin = umax * 0.01, lines = [], maxSteps = 4 * (Nx + Ny);
  const seedStep = Math.max(2, spacingCells);
  for (let sy = seedStep / 2; sy < Ny; sy += seedStep) {
    for (let sx = seedStep / 2; sx < Nx; sx += seedStep) {
      const ci = Math.floor(sx / ocSize), cj = Math.floor(sy / ocSize);
      if (occ[cj * ocCols + ci]) continue;
      if (!sample(ux, uy, solid, Nx, Ny, sx, sy)) continue;
      const back = trace(ux, uy, solid, Nx, Ny, sx, sy, -1, 0.5, maxSteps, occ, ocSize, ocCols, ocRows, umin);
      const fwd = trace(ux, uy, solid, Nx, Ny, sx, sy, 1, 0.5, maxSteps, occ, ocSize, ocCols, ocRows, umin);
      const line = [...back.reverse(), [sx, sy], ...fwd];
      if (line.length < 8) continue;
      for (const [x, y] of line) {
        const a = Math.floor(x / ocSize), b = Math.floor(y / ocSize);
        if (a >= 0 && b >= 0 && a < ocCols && b < ocRows) occ[b * ocCols + a] = 2;
      }
      lines.push(line);
    }
  }
  return lines;
}

export class Particles {
  constructor(Nx, Ny, max = 6000) {
    this.Nx = Nx; this.Ny = Ny; this.max = max;
    this.x = new Float32Array(max); this.y = new Float32Array(max); this.age = new Float32Array(max);
    this.n = 0; this.emitters = []; this.every = 6; this.tick = 0;
  }

  setEmitters(points) {
    this.emitters = points.slice(0, 400);
  }

  clear() {
    this.n = 0;
  }

  step(ux, uy, solid) {
    const Nx = this.Nx, Ny = this.Ny;
    if (this.emitters.length && this.tick++ % this.every === 0) {
      for (const [ex, ey] of this.emitters) {
        if (this.n >= this.max) this.recycle();
        this.x[this.n] = ex; this.y[this.n] = ey; this.age[this.n] = 0; this.n++;
      }
    }
    let w = 0;
    for (let p = 0; p < this.n; p++) {
      const v1 = sample(ux, uy, solid, Nx, Ny, this.x[p], this.y[p]);
      if (!v1) continue;
      const v2 = sample(ux, uy, solid, Nx, Ny, this.x[p] + 0.5 * v1[0], this.y[p] + 0.5 * v1[1]);
      if (!v2) continue;
      this.x[w] = this.x[p] + v2[0]; this.y[w] = this.y[p] + v2[1]; this.age[w] = this.age[p] + 1; w++;
    }
    this.n = w;
  }

  recycle() {
    const keep = Math.floor(this.max * 0.8), off = this.n - keep;
    this.x.copyWithin(0, off, this.n); this.y.copyWithin(0, off, this.n); this.age.copyWithin(0, off, this.n);
    this.n = keep;
  }

  snapshot() {
    const out = new Float32Array(2 * this.n);
    for (let p = 0; p < this.n; p++) { out[2 * p] = this.x[p]; out[2 * p + 1] = this.y[p]; }
    return out;
  }
}
