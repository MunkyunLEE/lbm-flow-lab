import { rasterizeObjects, perimeter } from './geometry.js';
import { Body, bodyRadius, kernel } from './ibm.js';

export const EX = [0, 1, 0, -1, 0, 1, -1, -1, 1];
export const EY = [0, 0, 1, 0, -1, 1, 1, -1, -1];
export const W = [4 / 9, 1 / 9, 1 / 9, 1 / 9, 1 / 9, 1 / 36, 1 / 36, 1 / 36, 1 / 36];
const OPP = [0, 3, 4, 1, 2, 7, 8, 5, 6];
const MIRROR_X = [0, 3, 2, 1, 4, 6, 5, 8, 7];
const MIRROR_Y = [0, 1, 4, 3, 2, 8, 7, 6, 5];
export const CS2 = 1 / 3;

export const FLUID = 0, SOLID = 1, VELOCITY = 2, PRESSURE = 3, OUTFLOW = 4, SLIP = 5, REGION_VEL = 6, REGION_PRES = 7;
const TYPE_CODE = { wall: SOLID, velocity: VELOCITY, pressure: PRESSURE, outflow: OUTFLOW, slip: SLIP };
const PRIORITY = { [SOLID]: 5, [VELOCITY]: 4, [PRESSURE]: 3, [SLIP]: 2, [OUTFLOW]: 1, [FLUID]: 0 };
const LES_C = 18 * Math.SQRT2;
const IBM_ITER = 3;
export const MAX_CELLS = 1000000;

export function feq9(rho, ux, uy, out) {
  const usq = 1.5 * (ux * ux + uy * uy);
  for (let i = 0; i < 9; i++) {
    const eu = EX[i] * ux + EY[i] * uy;
    out[i] = W[i] * rho * (1 + 3 * eu + 4.5 * eu * eu - usq);
  }
  return out;
}

export function gridDims(c) {
  const Lx = +(c.Lx ?? c.L), Nx = Math.max(2, Math.trunc(c.Nx ?? c.N)), dxmm = Lx / Nx;
  const Ny = Math.max(2, Math.round(+(c.Ly ?? c.L) / dxmm));
  return { Lx, Ly: Ny * dxmm, Nx, Ny, dxmm };
}

function isKinematic(o) {
  return o.kin && o.kin.mode && o.kin.mode !== 'off';
}

export function latticeParams(c) {
  const g = gridDims(c), nu = +c.fluid.nu;
  const uLat = +(c.u_lat_max ?? 0.08), les = c.les?.enabled ?? true;
  const speeds = [...Object.values(c.edges), ...(c.patches || [])].filter((b) => b.type === 'velocity').map((b) => Math.hypot(b.ux || 0, b.uy || 0));
  for (const o of c.obstacles || []) {
    if (o.role === 'inlet' && o.inlet) speeds.push(o.inlet.mode === 'normal' ? Math.abs(+o.inlet.un || 0) : Math.hypot(+o.inlet.ux || 0, +o.inlet.uy || 0));
    if (isKinematic(o) && o.kin.mode === 'drive') speeds.push(Math.abs(+o.kin.rpm || 0) * 2 * Math.PI / 60 * bodyRadius(o) / 1000);
  }
  const hasFlow = speeds.some((s) => s > 1e-9);
  let uMax = Math.max(...speeds, 1e-9);
  if (uMax < 1e-6) uMax = 1;
  const dx = g.dxmm / 1000, dt = uLat * dx / uMax, nuLat = nu * dt / dx ** 2, tau0 = 3 * nuLat + 0.5;
  const steps = Math.ceil(+(c.duration ?? 10) / dt), cells = g.Nx * g.Ny;
  const warnings = [];
  if (cells > MAX_CELLS) warnings.push(`셀 수 ${cells.toLocaleString()}개가 상한(${MAX_CELLS.toLocaleString()})을 넘습니다. 분할 수를 줄여 주세요.`);
  if (tau0 < 0.51 && !les) warnings.push(`τ0 = ${tau0.toFixed(5)} (< 0.51): BGK 단독으로는 발산 위험이 큽니다. LES를 켜거나 점성/격자를 조정하세요.`);
  if (tau0 < 0.5005 && les) warnings.push('고 Re 조건입니다. LES(Smagorinsky)로 안정화하지만 벽 근처 정확도는 제한적입니다.');
  if (!hasFlow) warnings.push('속도 경계가 없습니다. Δt는 기준 속도 1 m/s로 계산됩니다.');
  return { dx, dt, nu_lat: nuLat, tau0, u_max: uMax, Re_L: uMax * g.Lx / 1000 / nu, steps, Nx: g.Nx, Ny: g.Ny, Lx: g.Lx, Ly: g.Ly, cells, warnings };
}

export function buildFields(c, prm) {
  const { Nx, Ny, dxmm } = gridDims(c), NN = Nx * Ny;
  const vScale = prm.dt / prm.dx;
  const pScale = 1 / (+c.fluid.rho * CS2 * (prm.dx / prm.dt) ** 2);
  const flag = new Int8Array(NN), ubx = new Float32Array(NN), uby = new Float32Array(NN), rbc = new Float32Array(NN).fill(1);
  const edges = {
    left: [Ny, (k) => k * Nx], right: [Ny, (k) => k * Nx + Nx - 1],
    bottom: [Nx, (k) => k], top: [Nx, (k) => (Ny - 1) * Nx + k],
  };
  for (const [edge, [n, cell]] of Object.entries(edges)) {
    const spec = new Array(n).fill(c.edges[edge]);
    for (const p of c.patches || []) {
      if (p.edge !== edge) continue;
      const a = Math.min(p.s0, p.s1), b = Math.max(p.s0, p.s1);
      for (let k = 0; k < n; k++) { const s = (k + 0.5) * dxmm; if (s >= a && s < b) spec[k] = p; }
    }
    for (let k = 0; k < n; k++) {
      const code = TYPE_CODE[spec[k].type], idx = cell(k);
      if (PRIORITY[code] < PRIORITY[flag[idx]]) continue;
      flag[idx] = code;
      ubx[idx] = (spec[k].ux || 0) * vScale;
      uby[idx] = (spec[k].uy || 0) * vScale;
      rbc[idx] = 1 + (spec[k].p || 0) * pScale;
    }
  }
  const r = rasterizeObjects(c.obstacles || [], dxmm, Nx, Ny);
  for (let k = 0; k < NN; k++) if (r.solid[k]) flag[k] = SOLID;
  const source = new Uint8Array(NN);
  for (const [k, [ux, uy, src]] of r.inlet) if (flag[k] === FLUID) { flag[k] = REGION_VEL; ubx[k] = ux * vScale; uby[k] = uy * vScale; source[k] = src; }
  for (const [k, p] of r.outlet) if (flag[k] === FLUID) { flag[k] = REGION_PRES; rbc[k] = 1 + p * pScale; }
  return { flag, ubx, uby, rbc, owner: r.owner, source };
}

export class Solver {
  constructor(c) {
    this.case = c;
    this.prm = latticeParams(c);
    const g = gridDims(c), Nx = this.Nx = g.Nx, Ny = this.Ny = g.Ny, NN = this.NN = Nx * Ny;
    this.dxmm = g.dxmm;
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
    this.initObjects();
    this.initSponge(+(c.sponge ?? 0.08));
    this.buildBoundaryLists();
    this.slow = new Uint8Array(NN);
    for (let y = 0; y < Ny; y++) for (let x = 0; x < Nx; x++) {
      const k = y * Nx + x;
      let sl = x === 0 || y === 0 || x === Nx - 1 || y === Ny - 1 || this.inBand[k];
      for (let i = 1; i < 9 && !sl; i++) if (this.solid[(y + EY[i]) * Nx + x + EX[i]]) sl = true;
      this.slow[k] = sl ? 1 : 0;
    }
  }

  initObjects() {
    const objs = this.case.obstacles || [], n = objs.length, dxmm = this.dxmm, rp = +this.case.fluid.rho;
    this.nObj = n;
    this.fx = new Float64Array(n); this.fy = new Float64Array(n); this.mz = new Float64Array(n);
    this.refx = new Float64Array(n); this.refy = new Float64Array(n);
    this.bodies = [];
    objs.forEach((o, i) => {
      const ref = o.kin?.pivot || o.ref || [0, 0];
      this.refx[i] = ref[0] / dxmm; this.refy[i] = ref[1] / dxmm;
      if (isKinematic(o)) this.bodies.push(new Body(o, i, dxmm, this.prm, rp));
    });
    this.Fx = new Float32Array(this.NN); this.Fy = new Float32Array(this.NN);
    this.forced = new Uint8Array(this.NN);
    this.touched = [];
    this.regionVel = []; this.regionPres = [];
    for (let k = 0; k < this.NN; k++) {
      if (this.flag[k] === REGION_VEL) this.regionVel.push(k);
      else if (this.flag[k] === REGION_PRES) this.regionPres.push(k);
    }
    let inflow = 0;
    objs.forEach((o) => {
      if (o.role === 'inlet' && o.inlet?.mode === 'normal') inflow += (+o.inlet.un || 0) * this.prm.dt / this.prm.dx * perimeter(o.curves) / dxmm;
    });
    this.regionInflow = inflow;
  }

  initSponge(frac, sigmaMax = 0.08) {
    const Nx = this.Nx, Ny = this.Ny, flag = this.flag;
    const isOut = (k) => flag[k] === PRESSURE || flag[k] === OUTFLOW;
    const used = (n, fn) => { for (let k = 1; k < n - 1; k++) if (isOut(fn(k))) return true; return false; };
    this.bands = [];
    const make = (on, ax, sgn, w, lo) => {
      if (!on || w < 2) return;
      const sig = new Float32Array(w);
      for (let p = 0; p < w; p++) { const q = sgn < 0 ? p : w - 1 - p; sig[p] = (1 - q / (w - 1)) ** 2 * sigmaMax; }
      this.bands.push({ ax, sgn, lo, hi: lo + w, sig, corr: new Float32Array(w) });
    };
    const wx = Math.trunc(frac * Nx), wy = Math.trunc(frac * Ny);
    make(used(Ny, (k) => k * Nx), 0, -1, wx, 0);
    make(used(Ny, (k) => k * Nx + Nx - 1), 0, 1, wx, Nx - wx);
    make(used(Nx, (k) => k), 1, -1, wy, 0);
    make(used(Nx, (k) => (Ny - 1) * Nx + k), 1, 1, wy, Ny - wy);
    let flux = this.regionInflow, nOut = 0;
    for (let y = 0; y < Ny; y++) for (let x = 0; x < Nx; x++) {
      const k = y * Nx + x;
      if (isOut(k)) nOut++;
      if (flag[k] !== VELOCITY) continue;
      const nx = (x === 0) - (x === Nx - 1), ny = (y === 0) - (y === Ny - 1);
      flux += this.ubx[k] * nx + this.uby[k] * ny;
    }
    this.uOut = Math.max(flux, 0) / Math.max(nOut, 1);
    this.inBand = new Uint8Array(this.NN);
    for (const b of this.bands) {
      for (let y = 0; y < Ny; y++) for (let x = 0; x < Nx; x++) {
        const p = b.ax === 0 ? x : y, k = y * Nx + x;
        if (p >= b.lo && p < b.hi && !this.solid[k]) this.inBand[k] = 1;
      }
    }
  }

  prepareSponge(ramp) {
    const Nx = this.Nx, Ny = this.Ny, solid = this.solid;
    for (const b of this.bands) {
      const un = b.ax === 0 ? this.ux : this.uy, len = b.ax === 0 ? Ny : Nx;
      for (let p = b.lo; p < b.hi; p++) {
        let s = 0, n = 0;
        for (let q = 0; q < len; q++) {
          const k = b.ax === 0 ? q * Nx + p : p * Nx + q;
          if (!solid[k]) { s += un[k]; n++; }
        }
        b.corr[p - b.lo] = b.sgn * this.uOut * ramp - s / Math.max(n, 1);
      }
    }
  }

  applySponge(x, y, r, u, v, g) {
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
    const Nx = this.Nx, Ny = this.Ny, flag = this.flag;
    this.bnodes = [];
    for (const code of [VELOCITY, PRESSURE, OUTFLOW, SLIP]) {
      for (let y = 0; y < Ny; y++) for (let x = 0; x < Nx; x++) {
        const k = y * Nx + x;
        if (flag[k] !== code) continue;
        const ny = (y === 0) - (y === Ny - 1), nx = (x === 0) - (x === Nx - 1);
        this.bnodes.push({ code, k, kn: (y + ny) * Nx + (x + nx), mx: nx !== 0, my: ny !== 0 });
      }
    }
  }

  ramp() {
    const r = Math.min(1, this.stepCount / this.rampSteps);
    return 0.5 - 0.5 * Math.cos(Math.PI * r);
  }

  applyIBM() {
    const Fx = this.Fx, Fy = this.Fy, forced = this.forced, touched = this.touched;
    for (const k of touched) { Fx[k] = 0; Fy[k] = 0; forced[k] = 0; }
    touched.length = 0;
    if (!this.bodies.length) return;
    const Nx = this.Nx, Ny = this.Ny, ux = this.ux, uy = this.uy, rho = this.rho;
    const wx = new Float64Array(4), wy = new Float64Array(4);
    for (const b of this.bodies) b.Fx.fill(0), b.Fy.fill(0);
    for (let it = 0; it < IBM_ITER; it++) {
      for (const b of this.bodies) {
        for (let m = 0; m < b.M; m++) {
          const X = b.X[m] - 0.5, Y = b.Y[m] - 0.5, ix0 = Math.floor(X) - 1, iy0 = Math.floor(Y) - 1;
          for (let a = 0; a < 4; a++) { wx[a] = kernel(X - (ix0 + a)); wy[a] = kernel(Y - (iy0 + a)); }
          let su = 0, sv = 0;
          for (let bj = 0; bj < 4; bj++) {
            const y = iy0 + bj;
            if (y < 0 || y >= Ny) continue;
            for (let ai = 0; ai < 4; ai++) {
              const x = ix0 + ai;
              if (x < 0 || x >= Nx) continue;
              const k = y * Nx + x, w = wx[ai] * wy[bj], r2 = 2 * rho[k];
              su += w * (ux[k] + Fx[k] / r2); sv += w * (uy[k] + Fy[k] / r2);
            }
          }
          b.um[m] = su; b.vm[m] = sv;
        }
      }
      for (const b of this.bodies) {
        for (let m = 0; m < b.M; m++) {
          const dFx = 2 * (b.U[m] - b.um[m]), dFy = 2 * (b.V[m] - b.vm[m]), ds = b.ds[m];
          b.Fx[m] += dFx; b.Fy[m] += dFy;
          const X = b.X[m] - 0.5, Y = b.Y[m] - 0.5, ix0 = Math.floor(X) - 1, iy0 = Math.floor(Y) - 1;
          for (let a = 0; a < 4; a++) { wx[a] = kernel(X - (ix0 + a)); wy[a] = kernel(Y - (iy0 + a)); }
          for (let bj = 0; bj < 4; bj++) {
            const y = iy0 + bj;
            if (y < 0 || y >= Ny) continue;
            for (let ai = 0; ai < 4; ai++) {
              const x = ix0 + ai;
              if (x < 0 || x >= Nx) continue;
              const k = y * Nx + x, w = wx[ai] * wy[bj] * ds;
              if (!forced[k]) { forced[k] = 1; touched.push(k); }
              Fx[k] += w * dFx; Fy[k] += w * dFy;
            }
          }
        }
      }
    }
    for (const b of this.bodies) {
      let fx = 0, fy = 0, mz = 0;
      for (let m = 0; m < b.M; m++) {
        const ffx = -b.Fx[m] * b.ds[m], ffy = -b.Fy[m] * b.ds[m];
        fx += ffx; fy += ffy; mz += (b.X[m] - b.pivot[0]) * ffy - (b.Y[m] - b.pivot[1]) * ffx;
      }
      this.fx[b.index] = fx; this.fy[b.index] = fy; this.mz[b.index] = mz;
    }
  }

  collideStream() {
    const Nx = this.Nx, Ny = this.Ny, NN = this.NN, f = this.f, fn = this.fn, rho = this.rho, ux = this.ux, uy = this.uy;
    const solid = this.solid, slow = this.slow, forced = this.forced, owner = this.owner, g = this.g, t0 = this.tau0, cs2 = this.cs2, les = cs2 > 0;
    const Fx = this.Fx, Fy = this.Fy, ofx = this.fx, ofy = this.fy, omz = this.mz, refx = this.refx, refy = this.refy;
    const w0 = W[0], w1 = W[1], w5 = W[5], c1 = 2 / 3, c2 = 1 / 3;
    const N2 = 2 * NN, N3 = 3 * NN, N4 = 4 * NN, N5 = 5 * NN, N6 = 6 * NN, N7 = 7 * NN, N8 = 8 * NN;
    for (let k = 0; k < NN; k++) {
      if (solid[k]) continue;
      const f1 = f[NN + k], f2 = f[N2 + k], f3 = f[N3 + k], f4 = f[N4 + k];
      const f5 = f[N5 + k], f6 = f[N6 + k], f7 = f[N7 + k], f8 = f[N8 + k];
      const r = rho[k], isF = forced[k] === 1;
      let u = ux[k], v = uy[k];
      if (isF) { u += Fx[k] / (2 * r); v += Fy[k] / (2 * r); }
      const diag = f5 + f6 + f7 + f8, uxx = u * u, uyy = v * v, uxy = u * v;
      const pxx = f1 + f3 + diag - r * (uxx + CS2);
      const pyy = f2 + f4 + diag - r * (uyy + CS2);
      const pxy = f5 - f6 + f7 - f8 - r * uxy;
      let tau = t0;
      if (les) tau = 0.5 * (t0 + Math.sqrt(t0 * t0 + LES_C * cs2 * Math.sqrt(pxx * pxx + pyy * pyy + 2 * pxy * pxy) / r));
      const a = 4.5 * (1 - 1 / tau), hxx = a * pxx, hyy = a * pyy, hxy = a * pxy;
      const rux = r * u, ruy = r * v;
      const base = r * (1 - 1.5 * (uxx + uyy)), r45 = 4.5 * r, s2 = c1 * (hxx + hyy);
      const g0 = w0 * (base - c2 * (hxx + hyy));
      let A = base + r45 * uxx + c1 * hxx - c2 * hyy, B = 3 * rux;
      const g1 = w1 * (A + B), g3 = w1 * (A - B);
      A = base + r45 * uyy + c1 * hyy - c2 * hxx; B = 3 * ruy;
      const g2 = w1 * (A + B), g4 = w1 * (A - B);
      A = base + r45 * (uxx + uyy + 2 * uxy) + s2 + 2 * hxy; B = 3 * (rux + ruy);
      const g5 = w5 * (A + B), g7 = w5 * (A - B);
      A = base + r45 * (uxx + uyy - 2 * uxy) + s2 - 2 * hxy; B = 3 * (ruy - rux);
      const g6 = w5 * (A + B), g8 = w5 * (A - B);
      if (!slow[k] && !isF) {
        fn[k] = g0;
        fn[NN + k + 1] = g1; fn[N2 + k + Nx] = g2; fn[N3 + k - 1] = g3; fn[N4 + k - Nx] = g4;
        fn[N5 + k + Nx + 1] = g5; fn[N6 + k + Nx - 1] = g6; fn[N7 + k - Nx - 1] = g7; fn[N8 + k - Nx + 1] = g8;
        continue;
      }
      g[0] = g0; g[1] = g1; g[2] = g2; g[3] = g3; g[4] = g4; g[5] = g5; g[6] = g6; g[7] = g7; g[8] = g8;
      const x = k % Nx, y = (k - x) / Nx;
      if (isF) {
        const fx = Fx[k], fy = Fy[k], pre = 1 - 0.5 / tau;
        for (let i = 0; i < 9; i++) {
          const eu = EX[i] * u + EY[i] * v;
          g[i] += pre * W[i] * (3 * ((EX[i] - u) * fx + (EY[i] - v) * fy) + 9 * eu * (EX[i] * fx + EY[i] * fy));
        }
      }
      if (this.inBand[k]) this.applySponge(x, y, r, ux[k], uy[k], g);
      fn[k] = g[0];
      for (let i = 1; i < 9; i++) {
        const tx = x + EX[i], ty = y + EY[i];
        if (tx < 0 || tx >= Nx || ty < 0 || ty >= Ny) continue;
        const kt = ty * Nx + tx;
        if (solid[kt]) {
          fn[OPP[i] * NN + k] = g[i];
          const o = owner[kt];
          if (o >= 0) {
            const px = 2 * g[i] * EX[i], py = 2 * g[i] * EY[i];
            ofx[o] += px; ofy[o] += py;
            omz[o] += (x + 0.5 + 0.5 * EX[i] - refx[o]) * py - (y + 0.5 + 0.5 * EY[i] - refy[o]) * px;
          }
        } else fn[i * NN + kt] = g[i];
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
    this.applyRegions(this.regionVel, true, ramp);
    this.applyRegions(this.regionPres, false, ramp);
  }

  applyRegions(cells, isVel, ramp) {
    const f = this.f, NN = this.NN, e1 = this.e1, e2 = this.e2;
    for (const k of cells) {
      let r = 0, mx = 0, my = 0;
      for (let i = 0; i < 9; i++) { const v = f[i * NN + k]; r += v; mx += v * EX[i]; my += v * EY[i]; }
      const u = mx / r, v = my / r;
      feq9(r, u, v, e1);
      if (isVel) feq9(this.source[k] ? this.rbc[k] : r, this.ubx[k] * ramp, this.uby[k] * ramp, e2); else feq9(this.rbc[k], u, v, e2);
      for (let i = 0; i < 9; i++) f[i * NN + k] += e2[i] - e1[i];
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
    const r0 = this.ramp();
    this.fx.fill(0); this.fy.fill(0); this.mz.fill(0);
    this.applyIBM();
    if (this.bands.length) this.prepareSponge(r0);
    this.collideStream();
    this.stepCount++;
    const r1 = this.ramp();
    this.applyBoundaries(r1);
    this.macroscopic();
    for (const b of this.bodies) b.advance(this.mz[b.index], this.fx[b.index], this.fy[b.index], r1);
  }

  objectLoads() {
    const p = this.prm, rp = +this.case.fluid.rho, fs = rp * p.dx ** 3 / p.dt ** 2, ms = rp * p.dx ** 4 / p.dt ** 2;
    const out = [];
    for (let i = 0; i < this.nObj; i++) out.push({ fx: this.fx[i] * fs, fy: this.fy[i] * fs, m: this.mz[i] * ms });
    for (const b of this.bodies) Object.assign(out[b.index], { theta: b.theta, omega: b.omega, limited: b.limited });
    return out;
  }

  isDiverged() {
    for (let k = 0; k < this.NN; k++) {
      const s = this.ux[k] * this.ux[k] + this.uy[k] * this.uy[k];
      if (!(s <= 0.25)) return true;
    }
    return false;
  }
}

export function physicalField(name, ux, uy, rho, solid, prm, rhoPhys, Nx, Ny) {
  const NN = Nx * Ny, out = new Float32Array(NN), dt = prm.dt, vs = prm.dx / dt;
  if (name === 'umag') {
    for (let k = 0; k < NN; k++) out[k] = Math.hypot(ux[k], uy[k]) * vs;
  } else if (name === 'vort') {
    for (let y = 0; y < Ny; y++) for (let x = 0; x < Nx; x++) {
      const k = y * Nx + x;
      const dvx = x === 0 ? uy[k + 1] - uy[k] : x === Nx - 1 ? uy[k] - uy[k - 1] : 0.5 * (uy[k + 1] - uy[k - 1]);
      const duy = y === 0 ? ux[k + Nx] - ux[k] : y === Ny - 1 ? ux[k] - ux[k - Nx] : 0.5 * (ux[k + Nx] - ux[k - Nx]);
      out[k] = (dvx - duy) / dt;
    }
  } else if (name === 'pressure') {
    const c = CS2 * rhoPhys * vs * vs;
    for (let k = 0; k < NN; k++) out[k] = (rho[k] - 1) * c;
  } else throw new Error(name);
  for (let k = 0; k < NN; k++) if (solid[k]) out[k] = 0;
  return out;
}

export function sampleVectors(ux, uy, solid, prm, Nx, Ny, stride) {
  const s = Math.max(1, Math.trunc(stride)), cols = Math.ceil(Nx / s), rows = Math.ceil(Ny / s), vs = prm.dx / prm.dt;
  const out = new Float32Array(2 * cols * rows);
  let umax = 0;
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    const x = Math.min(Nx - 1, i * s + (s >> 1)), y = Math.min(Ny - 1, j * s + (s >> 1)), k = y * Nx + x, q = 2 * (j * cols + i);
    if (solid[k]) continue;
    out[q] = ux[k] * vs; out[q + 1] = uy[k] * vs;
    umax = Math.max(umax, Math.hypot(out[q], out[q + 1]));
  }
  return { data: out, cols, rows, stride: s, umax };
}
