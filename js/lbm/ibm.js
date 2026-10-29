const INERTIA = { light: 0.5, normal: 2, heavy: 8 };
const SPRING = { soft: 0.2, medium: 1, stiff: 5 };
const DAMPING = { low: 0.05, medium: 0.3, high: 1.5 };
const MARKER_SPACING = 0.8;
const TIP_LIMIT = 0.12;

function curveCenter(curves) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const c of curves) for (const [x, y] of c.points) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  return [(x0 + x1) / 2, (y0 + y1) / 2];
}

function polarMoment(pts, px, py) {
  let J = 0;
  for (let i = 0; i < pts.length; i++) {
    const x0 = pts[i][0] - px, y0 = pts[i][1] - py, x1 = pts[(i + 1) % pts.length][0] - px, y1 = pts[(i + 1) % pts.length][1] - py;
    J += (x0 * y1 - x1 * y0) * (x0 * x0 + x0 * x1 + x1 * x1 + y0 * y0 + y0 * y1 + y1 * y1) / 12;
  }
  return Math.abs(J);
}

export function bodyRadius(obj) {
  const [cx, cy] = obj.kin?.pivot || curveCenter(obj.curves);
  let r = 0;
  for (const c of obj.curves) for (const [x, y] of c.points) r = Math.max(r, Math.hypot(x - cx, y - cy));
  return r;
}

export class Body {
  constructor(obj, index, dxmm, prm, rhoPhys) {
    const kin = obj.kin;
    this.index = index;
    this.mode = kin.mode;
    const [px, py] = kin.pivot || curveCenter(obj.curves);
    this.pivot = [px / dxmm, py / dxmm];
    const rx = [], ry = [], ds = [];
    let Jint = 0;
    for (const c of obj.curves) {
      const pts = c.points, n = pts.length, segs = c.closed ? n : n - 1;
      for (let s = 0; s < segs; s++) {
        const [ax, ay] = pts[s], [bx, by] = pts[(s + 1) % n];
        const L = Math.hypot(bx - ax, by - ay) / dxmm, m = Math.max(1, Math.ceil(L / MARKER_SPACING));
        for (let q = 0; q < m; q++) {
          const t = (q + 0.5) / m;
          rx.push((ax + t * (bx - ax)) / dxmm - this.pivot[0]);
          ry.push((ay + t * (by - ay)) / dxmm - this.pivot[1]);
          ds.push(L / m);
        }
      }
      if (c.closed && n >= 3) Jint += polarMoment(pts, px, py);
    }
    this.rx = Float64Array.from(rx); this.ry = Float64Array.from(ry); this.ds = Float64Array.from(ds);
    this.M = rx.length;
    this.X = new Float64Array(this.M); this.Y = new Float64Array(this.M);
    this.U = new Float64Array(this.M); this.V = new Float64Array(this.M);
    this.Fx = new Float64Array(this.M); this.Fy = new Float64Array(this.M);
    this.um = new Float64Array(this.M); this.vm = new Float64Array(this.M);
    const dx = prm.dx, dt = prm.dt, R = Math.max(...rx.map((x, i) => Math.hypot(x, ry[i])), 1) * dx, U = prm.u_max;
    this.dx = dx; this.dt = dt; this.Rlat = R / dx;
    this.torqueScale = rhoPhys * dx ** 4 / dt ** 2;
    this.forceScale = rhoPhys * dx ** 3 / dt ** 2;
    this.Jint = rhoPhys * Jint * 1e-12;
    const a = kin.advanced || {};
    const pick = (v, d) => (v === null || v === undefined || v === '' || !Number.isFinite(+v) ? d : +v);
    this.I = pick(a.I, (INERTIA[kin.inertia] ?? INERTIA.normal) * rhoPhys * R ** 4);
    this.k = this.mode === 'hinge' ? pick(a.k, (SPRING[kin.spring] ?? SPRING.medium) * rhoPhys * U * U * R * R) : 0;
    this.c = pick(a.c, (DAMPING[kin.damping] ?? DAMPING.low) * rhoPhys * U * R ** 3);
    this.thMin = pick(a.thMin, this.mode === 'hinge' ? -90 : -Infinity) * Math.PI / 180;
    this.thMax = pick(a.thMax, this.mode === 'hinge' ? 90 : Infinity) * Math.PI / 180;
    this.omegaDrive = (+kin.rpm || 0) * 2 * Math.PI / 60 * (kin.dir === 'cw' ? -1 : 1);
    this.omegaMax = TIP_LIMIT / Math.max(this.Rlat, 1) / dt;
    this.theta = 0; this.omega = 0; this.omegaPrev = 0;
    this.torque = 0; this.fx = 0; this.fy = 0; this.limited = false;
    this.updateMarkers();
  }

  updateMarkers() {
    const c = Math.cos(this.theta), s = Math.sin(this.theta), wl = this.omega * this.dt;
    for (let m = 0; m < this.M; m++) {
      const x = this.rx[m] * c - this.ry[m] * s, y = this.rx[m] * s + this.ry[m] * c;
      this.X[m] = this.pivot[0] + x; this.Y[m] = this.pivot[1] + y;
      this.U[m] = -wl * y; this.V[m] = wl * x;
    }
  }

  advance(torqueLat, fxLat, fyLat, ramp) {
    const dt = this.dt, T = torqueLat * this.torqueScale;
    this.torque = T; this.fx = fxLat * this.forceScale; this.fy = fyLat * this.forceScale;
    if (this.mode === 'drive') {
      this.omega = this.omegaDrive * ramp;
    } else {
      const Tc = this.Jint * (this.omega - this.omegaPrev) / dt;
      this.omegaPrev = this.omega;
      const num = this.omega + dt / this.I * (T + Tc - this.k * this.theta);
      this.omega = num / (1 + dt * this.c / this.I + dt * dt * this.k / this.I);
    }
    this.limited = Math.abs(this.omega) > this.omegaMax;
    if (this.limited) this.omega = Math.sign(this.omega) * this.omegaMax;
    this.theta += dt * this.omega;
    if (this.theta > this.thMax) { this.theta = this.thMax; this.omega = Math.min(this.omega, 0); }
    if (this.theta < this.thMin) { this.theta = this.thMin; this.omega = Math.max(this.omega, 0); }
    this.updateMarkers();
  }
}

export function kernel(r) {
  const a = Math.abs(r);
  return a >= 2 ? 0 : 0.25 * (1 + Math.cos(Math.PI * a / 2));
}
