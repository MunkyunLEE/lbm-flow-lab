import { rasterize } from './geometry.js';

export const EX = [0, 1, 0, -1, 0, 1, -1, -1, 1];
export const EY = [0, 0, 1, 0, -1, 1, 1, -1, -1];
export const W = [4 / 9, 1 / 9, 1 / 9, 1 / 9, 1 / 9, 1 / 36, 1 / 36, 1 / 36, 1 / 36];
const OPP = [0, 3, 4, 1, 2, 7, 8, 5, 6];
const MIRROR_X = [0, 3, 2, 1, 4, 6, 5, 8, 7];
const MIRROR_Y = [0, 1, 4, 3, 2, 8, 7, 6, 5];
export const CS2 = 1 / 3;

export const FLUID = 0, SOLID = 1, VELOCITY = 2, PRESSURE = 3, OUTFLOW = 4, SLIP = 5;
const TYPE_CODE = { wall: SOLID, velocity: VELOCITY, pressure: PRESSURE, outflow: OUTFLOW, slip: SLIP };
const PRIORITY = { [SOLID]: 5, [VELOCITY]: 4, [PRESSURE]: 3, [SLIP]: 2, [OUTFLOW]: 1, [FLUID]: 0 };
const LES_C = 18 * Math.SQRT2;

export function feq9(rho, ux, uy, out) {
  const usq = 1.5 * (ux * ux + uy * uy);
  for (let i = 0; i < 9; i++) {
    const eu = EX[i] * ux + EY[i] * uy;
    out[i] = W[i] * rho * (1 + 3 * eu + 4.5 * eu * eu - usq);
  }
  return out;
}

function allBcs(c) {
  return [...Object.values(c.edges), ...(c.patches || [])];
}

export function latticeParams(c) {
  const L = c.L / 1000, N = Math.trunc(c.N), nu = +c.fluid.nu;
  const uLat = +(c.u_lat_max ?? 0.08);
  const les = c.les?.enabled ?? true;
  const speeds = allBcs(c).filter((b) => b.type === 'velocity').map((b) => Math.hypot(b.ux || 0, b.uy || 0));
  let uMax = Math.max(...speeds, 1e-9);
  if (uMax < 1e-6) uMax = 1;
  const dx = L / N, dt = uLat * dx / uMax, nuLat = nu * dt / dx ** 2, tau0 = 3 * nuLat + 0.5;
  const steps = Math.ceil(+(c.duration ?? 10) / dt);
  const warnings = [];
  if (tau0 < 0.51 && !les) warnings.push(`τ0 = ${tau0.toFixed(5)} (< 0.51): BGK 단독으로는 발산 위험이 큽니다. LES를 켜거나 점성/격자를 조정하세요.`);
  if (tau0 < 0.5005 && les) warnings.push('고 Re 조건입니다. LES(Smagorinsky)로 안정화하지만 벽 근처 정확도는 제한적입니다.');
  if (!speeds.length) warnings.push('속도 경계가 없습니다. Δt는 기준 속도 1 m/s로 계산됩니다.');
  return { dx, dt, nu_lat: nuLat, tau0, u_max: uMax, Re_L: uMax * L / nu, steps, warnings };
}

export function buildFields(c, prm) {
  const N = Math.trunc(c.N), L = +c.L, dxmm = L / N, NN = N * N;
  const vScale = prm.dt / prm.dx;
  const pScale = 1 / (+c.fluid.rho * CS2 * (prm.dx / prm.dt) ** 2);
  const flag = new Int8Array(NN), ubx = new Float32Array(NN), uby = new Float32Array(NN), rbc = new Float32Array(NN).fill(1);
  const cell = {
    left: (k) => k * N, right: (k) => k * N + N - 1,
    bottom: (k) => k, top: (k) => (N - 1) * N + k,
  };
  for (const edge of ['left', 'right', 'bottom', 'top']) {
    const spec = new Array(N).fill(c.edges[edge]);
    for (const p of c.patches || []) {
      if (p.edge !== edge) continue;
      const a = Math.min(p.s0, p.s1), b = Math.max(p.s0, p.s1);
      for (let k = 0; k < N; k++) { const s = (k + 0.5) * dxmm; if (s >= a && s < b) spec[k] = p; }
    }
    for (let k = 0; k < N; k++) {
      const code = TYPE_CODE[spec[k].type], idx = cell[edge](k);
      if (PRIORITY[code] < PRIORITY[flag[idx]]) continue;
      flag[idx] = code;
      ubx[idx] = (spec[k].ux || 0) * vScale;
      uby[idx] = (spec[k].uy || 0) * vScale;
      rbc[idx] = 1 + (spec[k].p || 0) * pScale;
    }
  }
  const solid = rasterize(c.obstacles || [], L, N);
  for (let k = 0; k < NN; k++) if (solid[k]) flag[k] = SOLID;
  return { flag, ubx, uby, rbc };
}

export class Solver {
  constructor(c) {
    this.case = c;
    this.prm = latticeParams(c);
    const N = this.N = Math.trunc(c.N), NN = this.NN = N * N;
    Object.assign(this, buildFields(c, this.prm));
    this.solid = new Uint8Array(NN);
    for (let k = 0; k < NN; k++) this.solid[k] = this.flag[k] === SOLID ? 1 : 0;
    this.tau0 = this.prm.tau0;
    const les = c.les || {};
    this.cs2 = (les.enabled ?? true) ? (les.cs ?? 0.15) ** 2 : 0;
    this.rampSteps = Math.max(Math.trunc(+(c.ramp ?? 2) / this.prm.dt), 1);
    this.rho = new Float32Array(NN).fill(1);
    this.ux = new Float32Array(NN);
    this.uy = new Float32Array(NN);
    this.f = new Float32Array(9 * NN);
    this.fn = new Float32Array(9 * NN);
    for (let i = 0; i < 9; i++) this.f.fill(W[i], i * NN, (i + 1) * NN);
    this.stepCount = 0;
    this.g = new Float64Array(9);
    this.e1 = new Float64Array(9);
    this.e2 = new Float64Array(9);
    this.initSponge(+(c.sponge ?? 0.08));
    this.buildBoundaryLists();
    this.slow = new Uint8Array(NN);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const k = y * N + x;
      let sl = x === 0 || y === 0 || x === N - 1 || y === N - 1 || this.inBand[k];
      for (let i = 1; i < 9 && !sl; i++) if (this.solid[(y + EY[i]) * N + x + EX[i]]) sl = true;
      this.slow[k] = sl ? 1 : 0;
    }
  }

  initSponge(frac, sigmaMax = 0.08) {
    const N = this.N, w = Math.trunc(frac * N), flag = this.flag;
    const isOut = (k) => flag[k] === PRESSURE || flag[k] === OUTFLOW;
    const used = (fn) => { for (let k = 1; k < N - 1; k++) if (isOut(fn(k))) return true; return false; };
    this.bands = [];
    if (w >= 2) {
      const prof = Array.from({ length: w }, (_, k) => (1 - k / (w - 1)) ** 2 * sigmaMax);
      const defs = [
        { on: used((k) => k * N), ax: 0, sgn: -1, lo: 0, sig: (p) => prof[p] },
        { on: used((k) => k * N + N - 1), ax: 0, sgn: 1, lo: N - w, sig: (p) => prof[w - 1 - p] },
        { on: used((k) => k), ax: 1, sgn: -1, lo: 0, sig: (p) => prof[p] },
        { on: used((k) => (N - 1) * N + k), ax: 1, sgn: 1, lo: N - w, sig: (p) => prof[w - 1 - p] },
      ];
      for (const d of defs) {
        if (!d.on) continue;
        const sig = new Float32Array(w);
        for (let p = 0; p < w; p++) sig[p] = d.sig(p);
        this.bands.push({ ax: d.ax, sgn: d.sgn, lo: d.lo, hi: d.lo + w, sig, corr: new Float32Array(w) });
      }
    }
    let flux = 0, nOut = 0;
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const k = y * N + x;
      if (isOut(k)) nOut++;
      if (flag[k] !== VELOCITY) continue;
      const nx = (x === 0) - (x === N - 1), ny = (y === 0) - (y === N - 1);
      flux += this.ubx[k] * nx + this.uby[k] * ny;
    }
    this.uOut = Math.max(flux, 0) / Math.max(nOut, 1);
    this.inBand = new Uint8Array(this.NN);
    for (const b of this.bands) {
      for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
        const p = b.ax === 0 ? x : y;
        if (p >= b.lo && p < b.hi && !this.solid[y * N + x]) this.inBand[y * N + x] = 1;
      }
    }
  }

  prepareSponge(ramp) {
    const N = this.N, solid = this.solid;
    for (const b of this.bands) {
      const un = b.ax === 0 ? this.ux : this.uy;
      for (let p = b.lo; p < b.hi; p++) {
        let s = 0, n = 0;
        for (let q = 0; q < N; q++) {
          const k = b.ax === 0 ? q * N + p : p * N + q;
          if (!solid[k]) { s += un[k]; n++; }
        }
        b.corr[p - b.lo] = b.sgn * this.uOut * ramp - s / Math.max(n, 1);
      }
    }
  }

  applySponge(k, x, y, r, u, v, g) {
    const e1 = this.e1, e2 = this.e2;
    feq9(r, u, v, e1);
    for (const b of this.bands) {
      const p = b.ax === 0 ? x : y;
      if (p < b.lo || p >= b.hi) continue;
      const corr = b.corr[p - b.lo], sig = b.sig[p - b.lo];
      if (b.ax === 0) feq9(1, u + corr, v, e2); else feq9(1, u, v + corr, e2);
      for (let i = 0; i < 9; i++) g[i] += sig * (e2[i] - e1[i]);
    }
  }

  buildBoundaryLists() {
    const N = this.N, flag = this.flag;
    this.bnodes = [];
    for (const code of [VELOCITY, PRESSURE, OUTFLOW, SLIP]) {
      for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
        const k = y * N + x;
        if (flag[k] !== code) continue;
        const ny = (y === 0) - (y === N - 1), nx = (x === 0) - (x === N - 1);
        this.bnodes.push({ code, k, kn: (y + ny) * N + (x + nx), mx: nx !== 0, my: ny !== 0 });
      }
    }
  }

  ramp() {
    const r = Math.min(1, this.stepCount / this.rampSteps);
    return 0.5 - 0.5 * Math.cos(Math.PI * r);
  }

  collideStream() {
    const N = this.N, NN = this.NN, f = this.f, fn = this.fn, rho = this.rho, ux = this.ux, uy = this.uy;
    const solid = this.solid, slow = this.slow, g = this.g, t0 = this.tau0, cs2 = this.cs2, les = cs2 > 0;
    const w0 = W[0], w1 = W[1], w5 = W[5], c1 = 2 / 3, c2 = 1 / 3;
    const N2 = 2 * NN, N3 = 3 * NN, N4 = 4 * NN, N5 = 5 * NN, N6 = 6 * NN, N7 = 7 * NN, N8 = 8 * NN;
    for (let k = 0; k < NN; k++) {
      if (solid[k]) continue;
      const f1 = f[NN + k], f2 = f[N2 + k], f3 = f[N3 + k], f4 = f[N4 + k];
      const f5 = f[N5 + k], f6 = f[N6 + k], f7 = f[N7 + k], f8 = f[N8 + k];
      const r = rho[k], u = ux[k], v = uy[k];
      const diag = f5 + f6 + f7 + f8, uxx = u * u, uyy = v * v, uxy = u * v;
      const pxx = f1 + f3 + diag - r * (uxx + CS2);
      const pyy = f2 + f4 + diag - r * (uyy + CS2);
      const pxy = f5 - f6 + f7 - f8 - r * uxy;
      let tau = t0;
      if (les) tau = 0.5 * (t0 + Math.sqrt(t0 * t0 + LES_C * cs2 * Math.sqrt(pxx * pxx + pyy * pyy + 2 * pxy * pxy) / r));
      const a = 4.5 * (1 - 1 / tau), hxx = a * pxx, hyy = a * pyy, hxy = a * pxy;
      const rux = r * u, ruy = r * v;
      const base = r * (1 - 1.5 * (uxx + uyy)), r45 = 4.5 * r, s2 = c1 * (hxx + hyy);
      let g0 = w0 * (base - c2 * (hxx + hyy));
      let A = base + r45 * uxx + c1 * hxx - c2 * hyy, B = 3 * rux;
      let g1 = w1 * (A + B), g3 = w1 * (A - B);
      A = base + r45 * uyy + c1 * hyy - c2 * hxx; B = 3 * ruy;
      let g2 = w1 * (A + B), g4 = w1 * (A - B);
      A = base + r45 * (uxx + uyy + 2 * uxy) + s2 + 2 * hxy; B = 3 * (rux + ruy);
      let g5 = w5 * (A + B), g7 = w5 * (A - B);
      A = base + r45 * (uxx + uyy - 2 * uxy) + s2 - 2 * hxy; B = 3 * (ruy - rux);
      let g6 = w5 * (A + B), g8 = w5 * (A - B);
      if (!slow[k]) {
        fn[k] = g0;
        fn[NN + k + 1] = g1; fn[N2 + k + N] = g2; fn[N3 + k - 1] = g3; fn[N4 + k - N] = g4;
        fn[N5 + k + N + 1] = g5; fn[N6 + k + N - 1] = g6; fn[N7 + k - N - 1] = g7; fn[N8 + k - N + 1] = g8;
        continue;
      }
      g[0] = g0; g[1] = g1; g[2] = g2; g[3] = g3; g[4] = g4; g[5] = g5; g[6] = g6; g[7] = g7; g[8] = g8;
      const x = k % N, y = (k - x) / N;
      if (this.inBand[k]) this.applySponge(k, x, y, r, u, v, g);
      fn[k] = g[0];
      for (let i = 1; i < 9; i++) {
        const tx = x + EX[i], ty = y + EY[i];
        if (tx < 0 || tx >= N || ty < 0 || ty >= N) continue;
        const kt = ty * N + tx;
        if (solid[kt]) fn[OPP[i] * NN + k] = g[i]; else fn[i * NN + kt] = g[i];
      }
    }
    this.f = fn;
    this.fn = f;
  }

  applyBoundaries(ramp) {
    const f = this.f, NN = this.NN, e1 = this.e1, e2 = this.e2, fnb = this.g;
    for (const b of this.bnodes) {
      for (let i = 0; i < 9; i++) fnb[i] = f[i * NN + b.kn];
      if (b.code === OUTFLOW) {
        for (let i = 0; i < 9; i++) f[i * NN + b.k] = fnb[i];
        continue;
      }
      if (b.code === SLIP) {
        for (let i = 0; i < 9; i++) {
          const j = b.mx && b.my ? MIRROR_X[MIRROR_Y[i]] : b.mx ? MIRROR_X[i] : MIRROR_Y[i];
          f[i * NN + b.k] = fnb[j];
        }
        continue;
      }
      let rn = 0, mx = 0, my = 0;
      for (let i = 0; i < 9; i++) { rn += fnb[i]; mx += fnb[i] * EX[i]; my += fnb[i] * EY[i]; }
      const un = mx / rn, vn = my / rn;
      feq9(rn, un, vn, e1);
      if (b.code === VELOCITY) feq9(rn, this.ubx[b.k] * ramp, this.uby[b.k] * ramp, e2);
      else feq9(this.rbc[b.k], un, vn, e2);
      for (let i = 0; i < 9; i++) f[i * NN + b.k] = e2[i] + fnb[i] - e1[i];
    }
  }

  macroscopic() {
    const f = this.f, NN = this.NN, rho = this.rho, ux = this.ux, uy = this.uy, solid = this.solid;
    for (let k = 0; k < NN; k++) {
      if (solid[k]) { rho[k] = 1; ux[k] = 0; uy[k] = 0; continue; }
      const f0 = f[k], f1 = f[NN + k], f2 = f[2 * NN + k], f3 = f[3 * NN + k], f4 = f[4 * NN + k];
      const f5 = f[5 * NN + k], f6 = f[6 * NN + k], f7 = f[7 * NN + k], f8 = f[8 * NN + k];
      const r = f0 + f1 + f2 + f3 + f4 + f5 + f6 + f7 + f8;
      rho[k] = r;
      ux[k] = (f1 - f3 + f5 - f6 - f7 + f8) / r;
      uy[k] = (f2 - f4 + f5 + f6 - f7 - f8) / r;
    }
  }

  step() {
    if (this.bands.length) this.prepareSponge(this.ramp());
    this.collideStream();
    this.stepCount++;
    this.applyBoundaries(this.ramp());
    this.macroscopic();
  }

  isDiverged() {
    let m = 0;
    for (let k = 0; k < this.NN; k++) {
      const s = this.ux[k] * this.ux[k] + this.uy[k] * this.uy[k];
      if (!(s <= 0.25)) { m = s; break; }
    }
    return m > 0.25 || Number.isNaN(m);
  }
}

export function physicalField(name, ux, uy, rho, solid, prm, rhoPhys, N) {
  const NN = N * N, out = new Float32Array(NN), dx = prm.dx, dt = prm.dt, vs = dx / dt;
  if (name === 'umag') {
    for (let k = 0; k < NN; k++) out[k] = Math.hypot(ux[k], uy[k]) * vs;
  } else if (name === 'vort') {
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const k = y * N + x;
      const dvx = x === 0 ? uy[k + 1] - uy[k] : x === N - 1 ? uy[k] - uy[k - 1] : 0.5 * (uy[k + 1] - uy[k - 1]);
      const duy = y === 0 ? ux[k + N] - ux[k] : y === N - 1 ? ux[k] - ux[k - N] : 0.5 * (ux[k + N] - ux[k - N]);
      out[k] = (dvx - duy) / dt;
    }
  } else if (name === 'pressure') {
    const c = CS2 * rhoPhys * vs * vs;
    for (let k = 0; k < NN; k++) out[k] = (rho[k] - 1) * c;
  } else throw new Error(name);
  for (let k = 0; k < NN; k++) if (solid[k]) out[k] = 0;
  return out;
}
