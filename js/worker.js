import { Solver, latticeParams, buildFields, physicalField, sampleVectors, gridDims, MAX_CELLS } from './lbm/solver.js';
import { parseDxf } from './lbm/dxf.js';
import { lut, autoRange, quantize, makeGif, drawLine, drawArrow } from './lbm/render.js';
import { streamlines, Particles } from './lbm/flowviz.js';

const SAMPLES = new URL('../samples/', import.meta.url);
const CHUNK_MS = 50;
const DIVERGE_CHECK = 50;
const U_SCALE = 60000;
const R_SCALE = 100000;
const HIST_POINTS = 1500;

let status = { state: 'idle', message: '' };
let run = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const json = (obj, code = 200) => ({ status: code, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });
const binary = (buf, headers = {}, type = 'application/octet-stream') => ({ status: 200, headers: { 'Content-Type': type, ...headers }, body: buf });
const busy = () => run && ['building', 'running', 'paused'].includes(status.state);

function toI16(src, scale, offset = 0) {
  const out = new Int16Array(src.length);
  for (let k = 0; k < src.length; k++) out[k] = Math.max(-32767, Math.min(32767, Math.round((src[k] - offset) * scale)));
  return out;
}

function fromI16(src, scale, offset = 0) {
  const out = new Float32Array(src.length);
  for (let k = 0; k < src.length; k++) out[k] = src[k] / scale + offset;
  return out;
}

function autoEmitters(s) {
  const pts = [], Nx = s.Nx, Ny = s.Ny, flag = s.flag;
  const add = (x, y) => pts.push([x, y]);
  const spacing = Math.max(3, Math.round(Math.max(Nx, Ny) / 60));
  for (let y = spacing; y < Ny - 1; y += spacing) {
    if (flag[y * Nx] === 2) add(3, y + 0.5);
    if (flag[y * Nx + Nx - 1] === 2) add(Nx - 3, y + 0.5);
  }
  for (let x = spacing; x < Nx - 1; x += spacing) {
    if (flag[x] === 2) add(x + 0.5, 3);
    if (flag[(Ny - 1) * Nx + x] === 2) add(x + 0.5, Ny - 3);
  }
  for (const k of s.regionVel) if ((k % Nx) % spacing === 0 && Math.floor(k / Nx) % spacing === 0) add((k % Nx) + 0.5, Math.floor(k / Nx) + 0.5);
  return pts;
}

function recordHistory(s) {
  const L = s.objectLoads();
  run.hist.t.push(s.stepCount * s.prm.dt);
  L.forEach((l, i) => {
    const h = run.hist.obj[i];
    h.fx.push(l.fx); h.fy.push(l.fy); h.m.push(l.m);
    if (l.theta !== undefined) { h.theta.push(l.theta * 180 / Math.PI); h.rpm.push(l.omega * 60 / (2 * Math.PI)); }
  });
}

async function loop() {
  const s = run.solver, steps = s.prm.steps;
  let final = 'done', msg = '';
  const t0 = performance.now();
  while (s.stepCount < steps) {
    if (run.stop) { final = 'stopped'; break; }
    if (run.paused) {
      status.state = 'paused';
      const p0 = performance.now();
      while (run.paused && !run.stop) await sleep(50);
      run.pausedMs += performance.now() - p0;
      status.state = 'running';
      continue;
    }
    const end = performance.now() + CHUNK_MS;
    let diverged = false;
    while (s.stepCount < steps && performance.now() < end) {
      s.step();
      const n = s.stepCount;
      if (run.particles) run.particles.step(s.ux, s.uy, s.solid);
      if (n % DIVERGE_CHECK === 0 && s.isDiverged()) { diverged = true; break; }
      if (n % run.histEvery === 0) recordHistory(s);
      if (n % run.recEvery === 0) {
        run.frames.push({
          t: n * s.prm.dt, ux: toI16(s.ux, U_SCALE), uy: toI16(s.uy, U_SCALE), rho: toI16(s.rho, R_SCALE, 1),
          thetas: s.bodies.map((b) => b.theta), particles: run.particles ? run.particles.snapshot() : null,
        });
      }
    }
    const elapsed = (performance.now() - t0 - run.pausedMs) / 1000;
    Object.assign(status, { step: s.stepCount, t: s.stepCount * s.prm.dt, elapsed, sps: s.stepCount / Math.max(elapsed, 1e-9), frames: run.frames.length, loads: s.objectLoads() });
    if (diverged) { final = 'diverged'; msg = '발산했습니다. 격자를 늘리거나, 점성을 키우거나, u_lat_max를 낮춰 보세요.'; break; }
    await sleep(0);
  }
  Object.assign(status, { state: final, message: msg, step: s.stepCount, t: s.stepCount * s.prm.dt, frames: run.frames.length, loads: s.objectLoads() });
}

function startRun(c) {
  try {
    const prm = latticeParams(c);
    if (prm.cells > MAX_CELLS) throw new Error(`셀 수가 상한(${MAX_CELLS.toLocaleString()})을 넘습니다.`);
    const s = new Solver(c);
    const nFrames = Math.max(Math.trunc(c.frames ?? 100), 1);
    run = {
      solver: s, case: c, frames: [], stop: false, paused: false, pausedMs: 0,
      recEvery: Math.max(Math.floor(s.prm.steps / nFrames), 1),
      histEvery: Math.max(Math.floor(s.prm.steps / HIST_POINTS), 1),
      hist: { t: [], obj: (c.obstacles || []).map(() => ({ fx: [], fy: [], m: [], theta: [], rpm: [] })) },
      particles: new Particles(s.Nx, s.Ny),
    };
    run.particles.setEmitters([...autoEmitters(s), ...(c.emitters || []).map(([x, y]) => [x / s.dxmm, y / s.dxmm])]);
    status = { state: 'running', step: 0, steps: s.prm.steps, prm: s.prm, message: '', loads: s.objectLoads(), pivots: s.bodies.map((b) => ({ index: b.index, pivot: [b.pivot[0] * s.dxmm, b.pivot[1] * s.dxmm] })) };
    loop().catch((e) => { status = { state: 'error', message: `${e.name}: ${e.message}` }; });
  } catch (e) {
    status = { state: 'error', message: `${e.name}: ${e.message}` };
  }
}

function frame(name) {
  if (!run || !run.solver) return { status: 204, headers: {}, body: null };
  const s = run.solver, Nx = s.Nx, Ny = s.Ny;
  const arr = physicalField(name, s.ux, s.uy, s.rho, s.solid, s.prm, +s.case.fluid.rho, Nx, Ny);
  const fluid = [];
  for (let k = 0; k < arr.length; k++) if (!s.solid[k]) fluid.push(arr[k]);
  const [lo, hi] = autoRange(name, fluid.length ? fluid : arr);
  const q = quantize(arr, s.solid, lo, hi);
  return binary(q.buffer, { 'X-Nx': Nx, 'X-Ny': Ny, 'X-Lo': lo, 'X-Hi': hi, 'X-Step': s.stepCount, 'X-Time': s.stepCount * s.prm.dt });
}

function vectors(stride) {
  if (!run || !run.solver) return { status: 204, headers: {}, body: null };
  const s = run.solver, v = sampleVectors(s.ux, s.uy, s.solid, s.prm, s.Nx, s.Ny, stride);
  return binary(v.data.buffer, { 'X-Cols': v.cols, 'X-Rows': v.rows, 'X-Stride': v.stride, 'X-Umax': v.umax });
}

function lines(spacing) {
  if (!run || !run.solver) return json({ lines: [] });
  const s = run.solver, d = s.dxmm;
  const ls = streamlines(s.ux, s.uy, s.solid, s.Nx, s.Ny, Math.max(4, spacing));
  return json({ lines: ls.map((l) => l.filter((_, i) => i % 2 === 0 || i === l.length - 1).map(([x, y]) => [Math.round(x * d), Math.round(y * d)])) });
}

function particles() {
  if (!run || !run.particles) return { status: 204, headers: {}, body: null };
  const p = run.particles.snapshot(), d = run.solver.dxmm;
  for (let i = 0; i < p.length; i++) p[i] *= d;
  return binary(p.buffer);
}

function bodyOutlines(s, thetas, scale, head, Ny) {
  return s.bodies.map((b, bi) => {
    const c = Math.cos(thetas[bi]), sn = Math.sin(thetas[bi]), pts = [];
    for (let m = 0; m < b.M; m++) pts.push([(b.pivot[0] + b.rx[m] * c - b.ry[m] * sn) * scale, head + (Ny - (b.pivot[1] + b.rx[m] * sn + b.ry[m] * c)) * scale]);
    return pts;
  });
}

function gif(opt) {
  if (!run || !run.frames.length) return json({ error: '기록된 프레임이 없습니다. 해석을 먼저 실행하세요.' }, 400);
  const s = run.solver, name = opt.field || 'umag', rp = +s.case.fluid.rho, Nx = s.Nx, Ny = s.Ny;
  const frames = run.frames.map((f) => {
    const ux = fromI16(f.ux, U_SCALE), uy = fromI16(f.uy, U_SCALE);
    return { t: f.t, thetas: f.thetas, particles: f.particles, ux, uy, field: physicalField(name, ux, uy, fromI16(f.rho, R_SCALE, 1), s.solid, s.prm, rp, Nx, Ny) };
  });
  const overlay = (idx, w, H, head, scale, fr, color) => {
    if (opt.particles && fr.particles) {
      const p = fr.particles;
      for (let i = 0; i < p.length; i += 2) {
        const x = Math.round(p[i] * scale), y = Math.round(head + (Ny - p[i + 1]) * scale);
        if (x >= 0 && x < w && y >= head && y < H) idx[y * w + x] = color;
      }
    }
    if (opt.vectors) {
      const stride = Math.max(4, Math.round(24 / scale)), vs = s.prm.dx / s.prm.dt;
      let umax = 1e-9;
      for (let k = 0; k < fr.ux.length; k += 7) umax = Math.max(umax, Math.hypot(fr.ux[k], fr.uy[k]) * vs);
      const v = sampleVectors(fr.ux, fr.uy, s.solid, s.prm, Nx, Ny, stride), Lpx = stride * scale * 0.9;
      for (let j = 0; j < v.rows; j++) for (let i = 0; i < v.cols; i++) {
        const q = 2 * (j * v.cols + i), u = v.data[q], vv = v.data[q + 1], m = Math.hypot(u, vv);
        if (m < 1e-6) continue;
        const cx = (Math.min(Nx - 1, i * v.stride + (v.stride >> 1)) + 0.5) * scale, cy = head + (Ny - Math.min(Ny - 1, j * v.stride + (v.stride >> 1)) - 0.5) * scale;
        const L = Lpx * Math.min(1, m / umax);
        drawArrow(idx, w, H, cx - 0.5 * L * u / m, cy + 0.5 * L * vv / m, cx + 0.5 * L * u / m, cy - 0.5 * L * vv / m, color);
      }
    }
    for (const pts of bodyOutlines(s, fr.thetas, scale, head, Ny)) {
      for (let m = 1; m < pts.length; m++) {
        if (Math.hypot(pts[m][0] - pts[m - 1][0], pts[m][1] - pts[m - 1][1]) < 2.5 * scale) drawLine(idx, w, H, pts[m - 1][0], pts[m - 1][1], pts[m][0], pts[m][1], 253);
      }
    }
  };
  const bytes = makeGif(name, frames, s.solid, Nx, Ny, { fps: opt.fps, scale: opt.scale, overlay });
  return binary(bytes.slice().buffer, {}, 'image/gif');
}

async function sampleIndex() {
  return (await fetch(new URL('index.json', SAMPLES))).json();
}

async function route(method, path, query, body) {
  const text = () => (typeof body === 'string' ? body : new TextDecoder('latin1').decode(body));
  const data = () => JSON.parse(text() || '{}');
  if (method === 'GET') {
    if (path === '/api/samples') return json((await sampleIndex()).dxf);
    if (path === '/api/sample') {
      const name = (query.get('name') || '').split('/').pop();
      const r = await fetch(new URL(name, SAMPLES));
      if (!r.ok) return json({ error: `샘플을 찾을 수 없습니다: ${name}` }, 404);
      return json(parseDxf(await r.text()));
    }
    if (path === '/api/colormaps') return json({ umag: lut('umag'), vort: lut('vort'), pressure: lut('pressure') });
    if (path === '/api/status') return json(status);
    if (path === '/api/frame') return frame(query.get('field') || 'umag');
    if (path === '/api/vectors') return vectors(+query.get('stride') || 10);
    if (path === '/api/streamlines') return lines(+query.get('spacing') || 12);
    if (path === '/api/particles') return particles();
    if (path === '/api/history') return json(run ? run.hist : { t: [], obj: [] });
  } else {
    if (path === '/api/dxf') return json(parseDxf(text()));
    if (path === '/api/params') return json(latticeParams(data()));
    if (path === '/api/mask') {
      const c = data(), g = gridDims(c);
      if (g.Nx * g.Ny > MAX_CELLS) return json({ error: '셀 수가 상한을 넘어 미리보기를 만들 수 없습니다.' }, 400);
      const { flag } = buildFields(c, latticeParams(c));
      return binary(new Uint8Array(flag.buffer.slice(0)).buffer, { 'X-Nx': g.Nx, 'X-Ny': g.Ny });
    }
    if (path === '/api/run') {
      if (busy()) return json({ error: '이미 해석이 진행 중입니다.' }, 400);
      const c = data();
      run = null;
      status = { state: 'building', message: '격자·경계 생성 중' };
      setTimeout(() => startRun(c), 0);
      return json({ ok: true });
    }
    if (path === '/api/emitters') {
      const d = data();
      if (run && run.particles) {
        if (d.clear) run.particles.clear();
        run.particles.setEmitters([...(d.auto === false ? [] : autoEmitters(run.solver)), ...(d.points || []).map(([x, y]) => [x / run.solver.dxmm, y / run.solver.dxmm])]);
      }
      return json({ ok: true });
    }
    if (path === '/api/stop') { if (run) { run.stop = true; run.paused = false; } return json({ ok: true }); }
    if (path === '/api/pause') { if (run) run.paused = !run.paused; return json({ paused: !!(run && run.paused) }); }
    if (path === '/api/gif') return gif(data());
  }
  return json({ error: 'not found' }, 404);
}

self.onmessage = async (e) => {
  const { id, method, url, body } = e.data;
  const u = new URL(url, 'http://local');
  let res;
  try {
    res = await route(method, u.pathname, u.searchParams, body);
  } catch (err) {
    res = json({ error: `${err.name}: ${err.message}` }, 400);
  }
  const transfer = res.body instanceof ArrayBuffer ? [res.body] : [];
  self.postMessage({ id, ...res }, transfer);
};
