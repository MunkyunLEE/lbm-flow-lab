import { Solver, latticeParams, buildFields, physicalField } from './lbm/solver.js';
import { parseDxf } from './lbm/dxf.js';
import { lut, autoRange, quantize, makeGif } from './lbm/render.js';

const SAMPLES = new URL('../samples/', import.meta.url);
const CHUNK_MS = 50;
const DIVERGE_CHECK = 50;
const U_SCALE = 60000;
const R_SCALE = 100000;

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
      if (n % DIVERGE_CHECK === 0 && s.isDiverged()) { diverged = true; break; }
      if (n % run.recEvery === 0) {
        run.frames.push({ t: n * s.prm.dt, ux: toI16(s.ux, U_SCALE), uy: toI16(s.uy, U_SCALE), rho: toI16(s.rho, R_SCALE, 1) });
      }
    }
    const elapsed = (performance.now() - t0 - run.pausedMs) / 1000;
    Object.assign(status, { step: s.stepCount, t: s.stepCount * s.prm.dt, elapsed, sps: s.stepCount / Math.max(elapsed, 1e-9), frames: run.frames.length });
    if (diverged) { final = 'diverged'; msg = '발산했습니다. 격자를 늘리거나, 점성을 키우거나, u_lat_max를 낮춰 보세요.'; break; }
    await sleep(0);
  }
  Object.assign(status, { state: final, message: msg, step: s.stepCount, t: s.stepCount * s.prm.dt, frames: run.frames.length });
}

function startRun(c) {
  try {
    const s = new Solver(c);
    const nFrames = Math.max(Math.trunc(c.frames ?? 100), 1);
    run = { solver: s, case: c, frames: [], recEvery: Math.max(Math.floor(s.prm.steps / nFrames), 1), stop: false, paused: false, pausedMs: 0 };
    status = { state: 'running', step: 0, steps: s.prm.steps, prm: s.prm, message: '' };
    loop().catch((e) => { status = { state: 'error', message: `${e.name}: ${e.message}` }; });
  } catch (e) {
    status = { state: 'error', message: `${e.name}: ${e.message}` };
  }
}

function frame(name) {
  if (!run || !run.solver) return { status: 204, headers: {}, body: null };
  const s = run.solver, N = s.N;
  const arr = physicalField(name, s.ux, s.uy, s.rho, s.solid, s.prm, +s.case.fluid.rho, N);
  const fluid = [];
  for (let k = 0; k < arr.length; k++) if (!s.solid[k]) fluid.push(arr[k]);
  const [lo, hi] = autoRange(name, fluid.length ? fluid : arr);
  const q = quantize(arr, s.solid, lo, hi);
  return binary(q.buffer, { 'X-N': N, 'X-Lo': lo, 'X-Hi': hi, 'X-Step': s.stepCount, 'X-Time': s.stepCount * s.prm.dt });
}

function gif(opt) {
  if (!run || !run.frames.length) return json({ error: '기록된 프레임이 없습니다. 해석을 먼저 실행하세요.' }, 400);
  const s = run.solver, name = opt.field || 'umag', rp = +s.case.fluid.rho;
  const frames = run.frames.map((f) => ({
    t: f.t,
    field: physicalField(name, fromI16(f.ux, U_SCALE), fromI16(f.uy, U_SCALE), fromI16(f.rho, R_SCALE, 1), s.solid, s.prm, rp, s.N),
  }));
  const bytes = makeGif(name, frames, s.solid, s.N, +(opt.fps || 15), +(opt.scale || 1));
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
  } else {
    if (path === '/api/dxf') return json(parseDxf(text()));
    if (path === '/api/params') return json(latticeParams(data()));
    if (path === '/api/mask') {
      const c = data(), { flag } = buildFields(c, latticeParams(c));
      return binary(new Uint8Array(flag.buffer.slice(0)).buffer, { 'X-N': Math.trunc(c.N) });
    }
    if (path === '/api/run') {
      if (busy()) return json({ error: '이미 해석이 진행 중입니다.' }, 400);
      const c = data();
      run = null;
      status = { state: 'building', message: '격자·경계 생성 중' };
      setTimeout(() => startRun(c), 0);
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
