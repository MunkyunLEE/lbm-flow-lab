'use strict';

const $ = (id) => document.getElementById(id);
const EDGE_NAMES = { left: '왼쪽', right: '오른쪽', bottom: '아래', top: '위' };
const EDGE_NORMAL = { left: [1, 0], right: [-1, 0], bottom: [0, 1], top: [0, -1] };
const TYPES = { velocity: '속도', pressure: '압력', outflow: '유출', wall: '벽', slip: '미끄럼벽' };
const TYPE_COLOR = { velocity: '#1f9d55', pressure: '#2563eb', outflow: '#0891b2', wall: '#5b6475', slip: '#9ca3af' };
const ROLE_COLOR = { inlet: '#22c55e', outlet: '#3b82f6' };
const ROLE_NAME = { solid: '고체', inlet: '유입', outlet: '유출' };
const KIN_NAME = { off: '', free: '자유 회전', hinge: '힌지', drive: '강제 회전' };
const FLAG_RGBA = [null, [140, 148, 165, 235], [31, 157, 85, 220], [37, 99, 235, 220], [8, 145, 178, 220], [156, 163, 175, 220], [34, 197, 94, 150], [59, 130, 246, 150]];
const PRESETS = {
  demo: { nu: 0.005, rho: 1.2, les: false, cs: 0.2 },
  air: { nu: 1.5e-5, rho: 1.204, les: true, cs: 0.2 },
  water: { nu: 1.0e-6, rho: 998, les: true, cs: 0.2 },
};
const OBJ_COLORS = ['#e4572e', '#f3a712', '#5b8def', '#6a994e', '#9b5de5', '#00a6a6', '#f15bb5', '#c08552'];
const STATE_KO = { idle: '대기', building: '준비 중', running: '계산 중', paused: '일시정지', done: '완료', stopped: '중지됨', diverged: '발산', error: '오류' };
const FIELD_KO = { umag: '|u| [m/s]', vort: 'ω [1/s]', pressure: 'p [Pa]' };
const LEGEND_MEAN = { umag: ['느림', '빠름'], vort: ['시계방향 −', '반시계방향 +'], pressure: ['저압', '고압'] };
const THEME_NEXT = { system: 'dark', dark: 'light', light: 'system' };
const THEME_LABEL = { system: '◐', dark: '☾', light: '☀' };
const THEME_TITLE = { system: '테마: 시스템 설정', dark: '테마: 다크', light: '테마: 라이트' };
const MAX_CELLS = 1000000;
const MARGIN = 64, BAND = 14, GAP = 4, ARROW_PX = 26;

const S = {
  Lx: 10000, Ly: 10000, Nx: 500,
  preset: 'demo', nu: 0.005, rho: 1.2, les: false, cs: 0.2,
  duration: 12, ramp: 2, frames: 120, ulat: 0.08, sponge: 8,
  edges: {
    left: { type: 'velocity', ux: 1, uy: 0, p: 0 },
    right: { type: 'pressure', ux: 0, uy: 0, p: 0 },
    bottom: { type: 'slip', ux: 0, uy: 0, p: 0 },
    top: { type: 'slip', ux: 0, uy: 0, p: 0 },
  },
  patches: [], objects: [], emitters: [], sel: null,
  view: 'edit', field: 'umag', showMask: false, showGrid: true, showVec: false, showStream: false, showPart: false,
  zoom: 1, panX: 0, panY: 0, mode: null,
};
let uid = 1;
let maskImg = null, maskTimer = null, paramsTimer = null;
let resultCanvas = null, resultInfo = null, vecData = null, streamData = null, partData = null;
let luts = {}, status = { state: 'idle' }, polling = null, pollBusy = false, pollCount = 0;
let hist = null, runMap = new Map(), runCase = null;
let drag = null, spaceDown = false, theme = 'system', CV = {};

const cv = $('cv'), ctx = cv.getContext('2d');
let W = 0, H = 0, dpr = 1;
const grid = () => { const dx = S.Lx / S.Nx, Ny = Math.max(2, Math.round(S.Ly / dx)); return { dx, Nx: S.Nx, Ny, Lx: S.Lx, Ly: Ny * dx }; };
const sc = () => { const g = grid(); return Math.max(1e-9, Math.min((W - 2 * MARGIN) / g.Lx, (H - 2 * MARGIN) / g.Ly)) * S.zoom; };
const origin = () => { const s = sc(), g = grid(); return { x: (W - g.Lx * s) / 2 + S.panX, y: (H - g.Ly * s) / 2 + S.panY }; };
const w2s = (x, y) => { const s = sc(), o = origin(); return [o.x + x * s, o.y + (grid().Ly - y) * s]; };
const s2w = (px, py) => { const s = sc(), o = origin(); return [(px - o.x) / s, grid().Ly - (py - o.y) / s]; };
const dxmm = () => grid().dx;
const edgeLen = (e) => (e === 'left' || e === 'right' ? grid().Ly : grid().Lx);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const fmt = (v, d = 3) => (!Number.isFinite(v) ? '–' : (Math.abs(v) >= 1e4 || (Math.abs(v) < 1e-3 && v !== 0)) ? v.toExponential(2) : (+v.toFixed(d)).toString());
const locked = () => ['running', 'paused', 'building'].includes(status.state);

function readPalette() {
  const cs = getComputedStyle(document.documentElement);
  for (const k of ['cv-domain', 'cv-grid-minor', 'cv-grid-major', 'cv-border', 'cv-axis', 'text', 'muted', 'accent']) CV[k] = cs.getPropertyValue(`--${k}`).trim();
  CV.solidFill = parseFloat(cs.getPropertyValue('--cv-solid-fill')) || 0.3;
}
function applyTheme() {
  const light = theme === 'light' || (theme === 'system' && window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches);
  document.documentElement.dataset.theme = light ? 'light' : 'dark';
  $('btnTheme').textContent = THEME_LABEL[theme];
  $('btnTheme').title = THEME_TITLE[theme];
  readPalette();
  draw(); drawLoadChart();
}

function resize() {
  const r = cv.getBoundingClientRect();
  dpr = window.devicePixelRatio || 1;
  W = r.width; H = r.height;
  cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
  draw();
}

function ensureObj(o) {
  o.role = o.role || 'solid';
  o.inlet = Object.assign({ mode: 'normal', ux: 1, uy: 0, un: 1 }, o.inlet || {});
  o.outlet = Object.assign({ p: 0 }, o.outlet || {});
  o.kin = Object.assign({ mode: 'off', pl: [0, 0], inertia: 'normal', spring: 'medium', damping: 'low', rpm: 30, dir: 'ccw' }, o.kin || {});
  o.kin.advanced = Object.assign({}, o.kin.advanced || {});
  return o;
}
function toWorld(o, [x, y]) {
  const a = o.rot * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  return [o.cx + o.scale * (x * c - y * s), o.cy + o.scale * (x * s + y * c)];
}
function toLocal(o, [x, y]) {
  const a = -o.rot * Math.PI / 180, c = Math.cos(a), s = Math.sin(a), dx = (x - o.cx) / o.scale, dy = (y - o.cy) / o.scale;
  return [dx * c - dy * s, dx * s + dy * c];
}
const pivotWorld = (o) => toWorld(o, o.kin.pl);
const isKin = (o) => o.role === 'solid' && o.kin.mode !== 'off';
function objWorld(o, theta = 0) {
  const [px, py] = pivotWorld(o), c = Math.cos(theta), s = Math.sin(theta);
  return o.curves.map((cu) => ({
    closed: cu.closed,
    points: cu.points.map((p) => {
      const [x, y] = toWorld(o, p);
      return theta ? [px + (x - px) * c - (y - py) * s, py + (x - px) * s + (y - py) * c] : [x, y];
    }),
  }));
}
function objRadius(o) {
  let r = 0;
  for (const cu of o.curves) for (const [x, y] of cu.points) r = Math.max(r, Math.hypot(x, y));
  return r * o.scale;
}
function objHeight(o) {
  let y0 = Infinity, y1 = -Infinity;
  for (const cu of objWorld(o)) for (const [, y] of cu.points) { y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  return Math.max(y1 - y0, 1e-6);
}
function displayTheta(o) {
  if (S.view !== 'result' || !status.loads || !isKin(o)) return 0;
  const i = runMap.get(o.id);
  return i === undefined ? 0 : (status.loads[i]?.theta || 0);
}
function addObject(name, parsed) {
  const pts = parsed.curves.flatMap((c) => c.points);
  if (!pts.length) { toast(`${name}: 읽을 수 있는 커브가 없습니다.`); return; }
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  const g = grid(), cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const inside = x0 >= 0 && x1 <= g.Lx && y0 >= 0 && y1 <= g.Ly;
  const k = S.objects.length;
  const o = ensureObj({
    id: uid++, name, color: OBJ_COLORS[k % OBJ_COLORS.length], rot: 0, scale: 1,
    cx: inside ? cx : g.Lx / 2 + ((k % 3) - 1) * g.Lx * 0.12, cy: inside ? cy : g.Ly / 2,
    curves: parsed.curves.map((c) => ({ closed: c.closed, points: c.points.map(([x, y]) => [x - cx, y - cy]) })),
  });
  S.objects.push(o);
  if (!inside) toast(`${name}: 격자판 밖 좌표라 중앙 부근에 배치했습니다.`);
  select('obj', o.id);
  changed();
}
function pointInPoly(x, y, p) {
  let ins = false;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const [xi, yi] = p[i], [xj, yj] = p[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) ins = !ins;
  }
  return ins;
}
function distSeg(px, py, [ax, ay], [bx, by]) {
  const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
  const t = L2 ? clamp(((px - ax) * dx + (py - ay) * dy) / L2, 0, 1) : 0;
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}
function hitObject(wx, wy) {
  const tol = 8 / sc();
  for (let k = S.objects.length - 1; k >= 0; k--) {
    const o = S.objects[k];
    for (const cu of objWorld(o)) {
      const p = cu.points;
      if (cu.closed && pointInPoly(wx, wy, p)) return o;
      const n = p.length - 1 + (cu.closed ? 1 : 0);
      for (let i = 0; i < n; i++) if (distSeg(wx, wy, p[i], p[(i + 1) % p.length]) < tol) return o;
    }
  }
  return null;
}
const rotHandle = (o) => { const [x, y] = w2s(o.cx, o.cy); return [x, y - objRadius(o) * sc() - 26]; };

function edgeAt(px, py) {
  const o = origin(), s = sc(), g = grid(), Lxs = g.Lx * s, Lys = g.Ly * s, r = GAP + BAND + 6;
  const inY = py >= o.y && py <= o.y + Lys, inX = px >= o.x && px <= o.x + Lxs;
  if (inY && px >= o.x - r && px < o.x - 1) return 'left';
  if (inY && px > o.x + Lxs + 1 && px <= o.x + Lxs + r) return 'right';
  if (inX && py > o.y + Lys + 1 && py <= o.y + Lys + r) return 'bottom';
  if (inX && py >= o.y - r && py < o.y - 1) return 'top';
  return null;
}
function edgeCoord(edge, px, py) {
  const [wx, wy] = s2w(px, py), v = (edge === 'left' || edge === 'right') ? wy : wx;
  return clamp(Math.round(v / dxmm()) * dxmm(), 0, edgeLen(edge));
}
function patchAt(edge, s) {
  for (let k = S.patches.length - 1; k >= 0; k--) {
    const p = S.patches[k];
    if (p.edge === edge && s >= Math.min(p.s0, p.s1) && s <= Math.max(p.s0, p.s1)) return p;
  }
  return null;
}
function bandRect(edge, a, b) {
  const s = sc(), o = origin(), g = grid(), Lxs = g.Lx * s, Lys = g.Ly * s;
  if (edge === 'left') return [o.x - GAP - BAND, o.y + (g.Ly - b) * s, BAND, (b - a) * s];
  if (edge === 'right') return [o.x + Lxs + GAP, o.y + (g.Ly - b) * s, BAND, (b - a) * s];
  if (edge === 'bottom') return [o.x + a * s, o.y + Lys + GAP, (b - a) * s, BAND];
  return [o.x + a * s, o.y - GAP - BAND, (b - a) * s, BAND];
}
function edgeHasOutlet(edge) {
  return ['pressure', 'outflow'].includes(S.edges[edge].type) ||
    S.patches.some((p) => p.edge === edge && ['pressure', 'outflow'].includes(p.type));
}

function draw() {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const o = origin(), s = sc(), g = grid(), Lxs = g.Lx * s, Lys = g.Ly * s;
  ctx.fillStyle = CV['cv-domain'];
  ctx.fillRect(o.x, o.y, Lxs, Lys);
  ctx.imageSmoothingEnabled = false;
  const showResult = S.view === 'result' && resultCanvas;
  if (showResult) ctx.drawImage(resultCanvas, o.x, o.y, Lxs, Lys);
  else drawSponge();
  if (S.showMask && maskImg && S.view === 'edit') ctx.drawImage(maskImg, o.x, o.y, Lxs, Lys);
  if (S.showGrid) drawGrid();
  ctx.strokeStyle = CV['cv-border']; ctx.lineWidth = 1;
  ctx.strokeRect(Math.round(o.x) + 0.5, Math.round(o.y) + 0.5, Math.round(Lxs), Math.round(Lys));
  if (S.view === 'result') drawOverlays();
  drawObjects();
  drawEmitters();
  drawEdges();
  drawAxes();
}
function majorStep(cpx) {
  for (const m of [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000]) if (m * cpx >= 36) return m;
  return 1000;
}
function drawGrid() {
  const o = origin(), s = sc(), g = grid(), Lxs = g.Lx * s, Lys = g.Ly * s, cpx = g.dx * s;
  ctx.save();
  ctx.beginPath(); ctx.rect(o.x, o.y, Lxs, Lys); ctx.clip();
  const lines = (step, color) => {
    ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.beginPath();
    for (let i = 0; i <= g.Nx; i += step) {
      const x = Math.round(o.x + i * cpx) + 0.5;
      if (x > -1 && x < W + 1) { ctx.moveTo(x, Math.max(o.y, 0)); ctx.lineTo(x, Math.min(o.y + Lys, H)); }
    }
    for (let j = 0; j <= g.Ny; j += step) {
      const y = Math.round(o.y + Lys - j * cpx) + 0.5;
      if (y > -1 && y < H + 1) { ctx.moveTo(Math.max(o.x, 0), y); ctx.lineTo(Math.min(o.x + Lxs, W), y); }
    }
    ctx.stroke();
  };
  const dark = S.view === 'result' && resultCanvas;
  if (cpx >= 5) lines(1, dark ? 'rgba(255,255,255,0.08)' : CV['cv-grid-minor']);
  lines(majorStep(cpx), dark ? 'rgba(255,255,255,0.16)' : CV['cv-grid-major']);
  ctx.restore();
}
function drawSponge() {
  const g = grid();
  for (const e of Object.keys(EDGE_NAMES)) {
    if (!edgeHasOutlet(e)) continue;
    const w = S.sponge / 100 * (e === 'left' || e === 'right' ? g.Lx : g.Ly);
    if (w <= 0) continue;
    let r;
    if (e === 'left') r = [0, 0, w, g.Ly]; else if (e === 'right') r = [g.Lx - w, 0, w, g.Ly];
    else if (e === 'bottom') r = [0, 0, g.Lx, w]; else r = [0, g.Ly - w, g.Lx, w];
    const [x0, y1] = w2s(r[0], r[1] + r[3]), [x1, y0] = w2s(r[0] + r[2], r[1]);
    const gr = (e === 'left' || e === 'right') ? ctx.createLinearGradient(x0, 0, x1, 0) : ctx.createLinearGradient(0, y1, 0, y0);
    const a = 'rgba(59,130,246,0.14)', z = 'rgba(59,130,246,0)';
    if (e === 'left' || e === 'top') { gr.addColorStop(0, a); gr.addColorStop(1, z); } else { gr.addColorStop(0, z); gr.addColorStop(1, a); }
    ctx.fillStyle = gr; ctx.fillRect(x0, y1, x1 - x0, y0 - y1);
    ctx.fillStyle = 'rgba(96,150,255,0.7)'; ctx.font = '10px system-ui';
    const [lx, ly] = w2s(r[0] + r[2] / 2, r[1] + r[3] / 2);
    ctx.save(); ctx.translate(lx, ly); if (e === 'left' || e === 'right') ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center'; ctx.fillText('흡수층', 0, 3); ctx.restore();
  }
}
function overlayStroke() {
  return S.field === 'umag' ? 'rgba(255,255,255,0.85)' : 'rgba(15,20,30,0.8)';
}
function drawOverlays() {
  const s = sc(), o = origin(), g = grid();
  ctx.save();
  ctx.beginPath(); ctx.rect(o.x, o.y, g.Lx * s, g.Ly * s); ctx.clip();
  const col = overlayStroke();
  if (S.showStream && streamData) {
    ctx.strokeStyle = col; ctx.lineWidth = 1; ctx.globalAlpha = 0.8;
    for (const line of streamData) {
      ctx.beginPath();
      line.forEach(([x, y], i) => { const [px, py] = w2s(x, y); i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); });
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
  if (S.showPart && partData) {
    ctx.fillStyle = col;
    for (let i = 0; i < partData.length; i += 2) {
      const [px, py] = w2s(partData[i], partData[i + 1]);
      ctx.fillRect(px - 0.9, py - 0.9, 1.8, 1.8);
    }
  }
  if (S.showVec && vecData) {
    const { data, cols, rows, stride, umax } = vecData, Lpx = stride * g.dx * s * 0.9;
    ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = 1.2;
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
      const q = 2 * (j * cols + i), u = data[q], v = data[q + 1], m = Math.hypot(u, v);
      if (m < 1e-9) continue;
      const x = (Math.min(g.Nx - 1, i * stride + (stride >> 1)) + 0.5) * g.dx, y = (Math.min(g.Ny - 1, j * stride + (stride >> 1)) + 0.5) * g.dx;
      const [cx, cy] = w2s(x, y), L = Lpx * Math.min(1, m / Math.max(umax, 1e-9)), dx = u / m, dy = -v / m;
      if (L < 2) continue;
      const x0 = cx - dx * L / 2, y0 = cy - dy * L / 2, x1 = cx + dx * L / 2, y1 = cy + dy * L / 2;
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
      const a = Math.atan2(y1 - y0, x1 - x0), h = Math.min(5, L * 0.35);
      ctx.beginPath(); ctx.moveTo(x1, y1);
      ctx.lineTo(x1 - h * Math.cos(a - 0.45), y1 - h * Math.sin(a - 0.45));
      ctx.lineTo(x1 - h * Math.cos(a + 0.45), y1 - h * Math.sin(a + 0.45)); ctx.fill();
    }
  }
  ctx.restore();
}
function drawObjects() {
  const sel = S.sel && S.sel.kind === 'obj' ? S.sel.id : null;
  const inResult = S.view === 'result' && resultCanvas, inMask = S.showMask && maskImg && S.view === 'edit';
  for (const o of S.objects) {
    const on = o.id === sel, roleCol = ROLE_COLOR[o.role], color = roleCol || o.color;
    const theta = displayTheta(o);
    for (const cu of objWorld(o, theta)) {
      ctx.beginPath();
      cu.points.forEach(([x, y], i) => { const [sx, sy] = w2s(x, y); i ? ctx.lineTo(sx, sy) : ctx.moveTo(sx, sy); });
      if (cu.closed) {
        ctx.closePath();
        if (!inResult && !inMask) {
          ctx.globalAlpha = roleCol ? 0.22 : (on ? CV.solidFill + 0.15 : CV.solidFill);
          ctx.fillStyle = color; ctx.fill(); ctx.globalAlpha = 1;
        }
      }
      ctx.setLineDash(roleCol ? [6, 4] : []);
      ctx.strokeStyle = inResult ? (S.field === 'umag' ? '#ffffff' : '#1d2330') : color;
      ctx.lineWidth = on ? 2.5 : (cu.closed && !isKin(o) ? 1.5 : 2.5);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (o.role === 'inlet' && !inResult) drawInletArrows(o);
    if (isKin(o)) {
      const [px, py] = w2s(...pivotWorld(o));
      ctx.strokeStyle = inResult ? (S.field === 'umag' ? '#fff' : '#1d2330') : CV.accent; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(px, py, 5, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(px - 8, py); ctx.lineTo(px + 8, py); ctx.moveTo(px, py - 8); ctx.lineTo(px, py + 8); ctx.stroke();
    }
    if (on && !locked() && S.view === 'edit') {
      const [cx, cy] = w2s(o.cx, o.cy), [hx, hy] = rotHandle(o);
      ctx.strokeStyle = CV.accent; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.arc(cx, cy, objRadius(o) * sc() + 6, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
      ctx.beginPath(); ctx.moveTo(cx, cy - objRadius(o) * sc() - 6); ctx.lineTo(hx, hy); ctx.stroke();
      ctx.fillStyle = CV['cv-domain']; ctx.beginPath(); ctx.arc(hx, hy, 6, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.fillStyle = CV.accent; ctx.beginPath(); ctx.arc(cx, cy, 3, 0, Math.PI * 2); ctx.fill();
    }
  }
}
function drawInletArrows(o) {
  const [cx, cy] = w2s(o.cx, o.cy), R = objRadius(o) * sc();
  ctx.strokeStyle = ROLE_COLOR.inlet; ctx.fillStyle = ROLE_COLOR.inlet; ctx.lineWidth = 1.5;
  const arrow = (x0, y0, x1, y1) => {
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
    const a = Math.atan2(y1 - y0, x1 - x0);
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x1 - 6 * Math.cos(a - 0.45), y1 - 6 * Math.sin(a - 0.45)); ctx.lineTo(x1 - 6 * Math.cos(a + 0.45), y1 - 6 * Math.sin(a + 0.45)); ctx.fill();
  };
  if (o.inlet.mode === 'normal') {
    for (let k = 0; k < 8; k++) { const a = k * Math.PI / 4; arrow(cx + R * Math.cos(a), cy - R * Math.sin(a), cx + (R + 18) * Math.cos(a), cy - (R + 18) * Math.sin(a)); }
  } else {
    const m = Math.hypot(o.inlet.ux, o.inlet.uy);
    if (m > 1e-9) arrow(cx - 12 * o.inlet.ux / m, cy + 12 * o.inlet.uy / m, cx + 12 * o.inlet.ux / m, cy - 12 * o.inlet.uy / m);
  }
}
function drawEmitters() {
  if (!S.emitters.length) return;
  ctx.strokeStyle = '#facc15'; ctx.lineWidth = 1.5;
  for (const [x, y] of S.emitters) {
    const [px, py] = w2s(x, y);
    ctx.beginPath(); ctx.arc(px, py, 4, 0, Math.PI * 2); ctx.stroke();
  }
}
function uncovered(edge) {
  let segs = [[0, edgeLen(edge)]];
  for (const p of S.patches.filter((q) => q.edge === edge)) {
    const a = Math.min(p.s0, p.s1), b = Math.max(p.s0, p.s1), next = [];
    for (const [u, v] of segs) { if (a > u) next.push([u, Math.min(a, v)]); if (b < v) next.push([Math.max(b, u), v]); }
    segs = next.filter(([u, v]) => v - u > 1e-6);
  }
  return segs;
}
function drawBand(edge, a, b, bc, selected) {
  const [x, y, w, h] = bandRect(edge, a, b);
  ctx.fillStyle = TYPE_COLOR[bc.type];
  ctx.fillRect(x, y, w, h);
  if (bc.type === 'slip') {
    ctx.strokeStyle = 'rgba(255,255,255,0.7)'; ctx.lineWidth = 1; ctx.beginPath();
    for (let k = -h; k < w; k += 6) { ctx.moveTo(x + k, y + h); ctx.lineTo(x + k + h, y); }
    ctx.save(); ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip(); ctx.stroke(); ctx.restore();
  }
  if (selected) { ctx.strokeStyle = CV.text; ctx.lineWidth = 2; ctx.strokeRect(x - 1, y - 1, w + 2, h + 2); }
  if (Math.max(w, h) > 70) {
    let label = TYPES[bc.type];
    if (bc.type === 'velocity') label += ` (${fmt(+bc.ux, 2)}, ${fmt(+bc.uy, 2)}) m/s`;
    if (bc.type === 'pressure') label += ` ${fmt(+bc.p, 2)} Pa`;
    ctx.save(); ctx.fillStyle = '#fff'; ctx.font = '600 10px system-ui'; ctx.textAlign = 'center';
    ctx.translate(x + w / 2, y + h / 2);
    if (edge === 'left' || edge === 'right') ctx.rotate(-Math.PI / 2);
    ctx.fillText(label, 0, 3.5); ctx.restore();
  }
  if (bc.type === 'velocity') drawArrows(edge, a, b, +bc.ux, +bc.uy);
}
function drawArrows(edge, a, b, ux, uy) {
  const mag = Math.hypot(ux, uy);
  if (mag < 1e-9) return;
  const s = sc(), g = grid(), n = Math.max(1, Math.floor((b - a) * s / 56));
  const dx = ux / mag, dy = -uy / mag;
  ctx.strokeStyle = TYPE_COLOR.velocity; ctx.fillStyle = TYPE_COLOR.velocity; ctx.lineWidth = 1.5;
  for (let k = 0; k < n; k++) {
    const v = a + (b - a) * (k + 0.5) / n;
    let [px, py] = (edge === 'left' || edge === 'right') ? w2s(edge === 'left' ? 0 : g.Lx, v) : w2s(v, edge === 'bottom' ? 0 : g.Ly);
    const [nx, ny] = EDGE_NORMAL[edge];
    px += nx * 4; py -= ny * 4;
    const ex = px + dx * 20, ey = py + dy * 20;
    ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(ex, ey); ctx.stroke();
    const ang = Math.atan2(ey - py, ex - px);
    ctx.beginPath(); ctx.moveTo(ex, ey);
    ctx.lineTo(ex - 6 * Math.cos(ang - 0.45), ey - 6 * Math.sin(ang - 0.45));
    ctx.lineTo(ex - 6 * Math.cos(ang + 0.45), ey - 6 * Math.sin(ang + 0.45)); ctx.fill();
  }
}
function drawEdges() {
  for (const e of Object.keys(EDGE_NAMES)) for (const [a, b] of uncovered(e)) drawBand(e, a, b, S.edges[e], false);
  for (const p of S.patches) {
    const sel = S.sel && S.sel.kind === 'patch' && S.sel.id === p.id;
    drawBand(p.edge, Math.min(p.s0, p.s1), Math.max(p.s0, p.s1), p, sel);
  }
  if (drag && drag.mode === 'patch') {
    const [x, y, w, h] = bandRect(drag.edge, Math.min(drag.s0, drag.s1), Math.max(drag.s0, drag.s1));
    ctx.strokeStyle = CV.text; ctx.setLineDash([4, 3]); ctx.lineWidth = 1.5;
    ctx.strokeRect(x - 2, y - 2, w + 4, h + 4); ctx.setLineDash([]);
  }
}
function drawAxes() {
  const s = sc(), g = grid(), o = origin(), Lxs = g.Lx * s, Lys = g.Ly * s;
  let step = 100;
  for (const m of [100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000]) { step = m; if (m * s >= 60) break; }
  ctx.fillStyle = CV['cv-axis']; ctx.font = '10px system-ui';
  ctx.textAlign = 'center';
  for (let v = 0; v <= g.Lx + 1e-6; v += step) {
    const [x] = w2s(v, 0);
    if (x >= -20 && x <= W + 20) ctx.fillText(`${fmt(v / 1000, 2)}`, x, o.y + Lys + GAP + BAND + 14);
  }
  ctx.textAlign = 'right';
  for (let v = 0; v <= g.Ly + 1e-6; v += step) {
    const [, y] = w2s(0, v);
    if (y >= -20 && y <= H + 20) ctx.fillText(`${fmt(v / 1000, 2)}`, o.x - GAP - BAND - 6, y + 3);
  }
  ctx.textAlign = 'left';
  ctx.fillText('m', o.x + Lxs + GAP + BAND + 6, o.y + Lys + GAP + BAND + 14);
}

const pos = (e) => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
function setMode(m, text) {
  S.mode = m;
  $('modeHint').textContent = text || '';
  $('modeHint').classList.toggle('hidden', !m);
  $('btnEmit').classList.toggle('on', m === 'emit');
  cv.style.cursor = m ? 'crosshair' : 'default';
}
cv.addEventListener('contextmenu', (e) => e.preventDefault());
cv.addEventListener('mousedown', (e) => {
  const [px, py] = pos(e);
  const pan = { mode: 'pan', px, py, panX: S.panX, panY: S.panY };
  if (e.button === 0 && S.mode === 'emit') {
    const [wx, wy] = s2w(px, py), g = grid();
    if (wx >= 0 && wy >= 0 && wx <= g.Lx && wy <= g.Ly) { S.emitters.push([Math.round(wx), Math.round(wy)]); pushEmitters(); draw(); }
    return;
  }
  if (e.button === 0 && S.mode === 'pivot') {
    const o = selObj();
    if (o) { o.kin.pl = toLocal(o, s2w(px, py)); renderObjEditor(); changed(); }
    setMode(null);
    return;
  }
  if (e.button !== 0 || spaceDown || locked()) { drag = pan; return; }
  const so = S.view === 'edit' ? selObj() : null;
  if (so) {
    const [hx, hy] = rotHandle(so);
    if (Math.hypot(px - hx, py - hy) < 10) { drag = { mode: 'rotate', o: so }; return; }
  }
  const edge = edgeAt(px, py);
  if (edge) { const s = edgeCoord(edge, px, py); drag = { mode: 'patch', edge, s0: s, s1: s, px, py }; draw(); return; }
  const [wx, wy] = s2w(px, py), o = hitObject(wx, wy);
  if (o) { select('obj', o.id); drag = { mode: 'move', o, wx, wy, cx: o.cx, cy: o.cy }; return; }
  select(null);
  drag = pan;
});
window.addEventListener('mousemove', (e) => {
  const [px, py] = pos(e);
  updateCursorInfo(px, py);
  if (!drag) { if (!S.mode) setCursor(px, py); return; }
  if (drag.mode === 'pan') { S.panX = drag.panX + px - drag.px; S.panY = drag.panY + py - drag.py; }
  else if (drag.mode === 'move') {
    const [wx, wy] = s2w(px, py);
    drag.o.cx = drag.cx + wx - drag.wx; drag.o.cy = drag.cy + wy - drag.wy;
    renderObjEditor(); markMaskDirty();
  } else if (drag.mode === 'rotate') {
    const [cx, cy] = w2s(drag.o.cx, drag.o.cy);
    let deg = Math.atan2(-(py - cy), px - cx) * 180 / Math.PI - 90;
    deg = e.shiftKey ? Math.round(deg / 15) * 15 : Math.round(deg);
    drag.o.rot = ((deg % 360) + 360) % 360;
    renderObjEditor(); markMaskDirty();
  } else if (drag.mode === 'patch') drag.s1 = edgeCoord(drag.edge, px, py);
  draw();
});
window.addEventListener('mouseup', () => {
  if (!drag) return;
  const d = drag; drag = null;
  if (d.mode === 'patch') {
    if (Math.abs(d.s1 - d.s0) < dxmm() * 0.5) {
      const p = patchAt(d.edge, d.s0);
      select(p ? 'patch' : null, p ? p.id : null);
    } else {
      const [nx, ny] = EDGE_NORMAL[d.edge];
      const p = { id: uid++, edge: d.edge, s0: Math.min(d.s0, d.s1), s1: Math.max(d.s0, d.s1), type: 'velocity', ux: nx, uy: ny, p: 0 };
      S.patches.push(p); select('patch', p.id); changed();
    }
  } else if (d.mode === 'move' || d.mode === 'rotate') changed();
  draw();
});
cv.addEventListener('wheel', (e) => {
  e.preventDefault();
  const [px, py] = pos(e), [wx, wy] = s2w(px, py);
  S.zoom = clamp(S.zoom * Math.pow(1.0015, -e.deltaY), 0.4, 80);
  const [nx, ny] = w2s(wx, wy);
  S.panX += px - nx; S.panY += py - ny;
  draw();
}, { passive: false });
function setCursor(px, py) {
  if (locked()) { cv.style.cursor = 'grab'; return; }
  const so = selObj();
  if (so) { const [hx, hy] = rotHandle(so); if (Math.hypot(px - hx, py - hy) < 10) { cv.style.cursor = 'crosshair'; return; } }
  if (edgeAt(px, py)) { cv.style.cursor = 'copy'; return; }
  const [wx, wy] = s2w(px, py);
  cv.style.cursor = hitObject(wx, wy) ? 'move' : 'default';
}
function updateCursorInfo(px, py) {
  const [wx, wy] = s2w(px, py), g = grid();
  if (wx < 0 || wy < 0 || wx > g.Lx || wy > g.Ly) { $('cursorInfo').textContent = ''; return; }
  const ix = Math.floor(wx / g.dx), iy = Math.floor(wy / g.dx);
  let t = `x ${wx.toFixed(0)} mm  y ${wy.toFixed(0)} mm  ·  cell (${ix}, ${iy})`;
  if (S.view === 'result' && resultInfo && resultInfo.Nx === g.Nx && resultInfo.Ny === g.Ny) {
    const q = resultInfo.q[iy * resultInfo.Nx + ix];
    t += q === 255 ? '  ·  고체' : `  ·  ${FIELD_KO[resultInfo.field]} ≈ ${fmt(resultInfo.lo + q / 252 * (resultInfo.hi - resultInfo.lo))}`;
  }
  $('cursorInfo').textContent = t;
}
window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && !isTyping()) { spaceDown = true; e.preventDefault(); }
  if (e.key === 'Escape') setMode(null);
  if ((e.key === 'Delete' || e.key === 'Backspace') && !isTyping() && !locked()) deleteSelected();
});
window.addEventListener('keyup', (e) => { if (e.code === 'Space') spaceDown = false; });
const isTyping = () => ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName);

const selObj = () => (S.sel && S.sel.kind === 'obj') ? S.objects.find((o) => o.id === S.sel.id) : null;
const selPatch = () => (S.sel && S.sel.kind === 'patch') ? S.patches.find((p) => p.id === S.sel.id) : null;
function select(kind, id) {
  S.sel = kind ? { kind, id } : null;
  renderObjList(); renderObjEditor(); renderPatchList(); renderPatchEditor(); draw();
}
function deleteSelected() {
  if (!S.sel) return;
  if (S.sel.kind === 'obj') S.objects = S.objects.filter((o) => o.id !== S.sel.id);
  else S.patches = S.patches.filter((p) => p.id !== S.sel.id);
  select(null); changed();
}
function changed() {
  renderObjList(); renderPatchList(); renderLoadSelect();
  markMaskDirty(); scheduleParams(); draw();
}
function markMaskDirty() {
  if (!S.showMask) { maskImg = null; return; }
  clearTimeout(maskTimer);
  maskTimer = setTimeout(fetchMask, 250);
}

function renderEdgeRows() {
  const box = $('edgeRows'); box.innerHTML = '';
  for (const e of Object.keys(EDGE_NAMES)) {
    const b = S.edges[e], row = document.createElement('div');
    row.className = 'edge-row';
    row.innerHTML = `<div class="ename"><span class="sw" style="width:10px;height:10px;border-radius:2px;background:${TYPE_COLOR[b.type]}"></span>${EDGE_NAMES[e]}</div>`;
    row.appendChild(typeSelect(b.type, (v) => { b.type = v; renderEdgeRows(); changed(); }));
    for (const el of valueInputs(b, () => changed(), true)) row.appendChild(el);
    box.appendChild(row);
  }
}
function typeSelect(value, onchange) {
  const sel = document.createElement('select');
  for (const [k, v] of Object.entries(TYPES)) sel.add(new Option(v, k, false, k === value));
  sel.onchange = () => onchange(sel.value);
  sel.disabled = locked();
  return sel;
}
function numInput(obj, key, label, unit, step, onchange, compact = false) {
  const l = document.createElement('label');
  l.innerHTML = compact ? '' : `${label} <em>${unit}</em>`;
  const i = document.createElement('input');
  const plain = label.replace(/<\/?sub>/g, '');
  i.type = 'number'; i.step = step; i.value = obj[key]; i.title = `${plain} [${unit}]`;
  i.placeholder = plain; i.disabled = locked();
  i.oninput = () => { obj[key] = +i.value; onchange(); };
  l.appendChild(i); return l;
}
function valueInputs(b, onchange, compact) {
  if (b.type === 'velocity') return [numInput(b, 'ux', 'u<sub>x</sub>', 'm/s', 0.1, onchange, compact), numInput(b, 'uy', 'u<sub>y</sub>', 'm/s', 0.1, onchange, compact)];
  if (b.type === 'pressure') return [numInput(b, 'p', 'p', 'Pa', 1, onchange, compact), document.createElement('span')];
  return [document.createElement('span'), document.createElement('span')];
}
function renderObjList() {
  const ul = $('objList'); ul.innerHTML = '';
  for (const o of S.objects) {
    const li = document.createElement('li');
    li.className = (S.sel && S.sel.kind === 'obj' && S.sel.id === o.id) ? 'on' : '';
    const closed = o.curves.every((c) => c.closed);
    const tag = isKin(o) ? KIN_NAME[o.kin.mode] : o.role !== 'solid' ? ROLE_NAME[o.role] : (closed ? 'Solid' : '열린 커브');
    li.innerHTML = `<span class="sw" style="background:${ROLE_COLOR[o.role] || o.color}"></span>${o.name}<span class="meta"><span class="tag">${tag}</span></span>`;
    li.onclick = () => select('obj', o.id);
    ul.appendChild(li);
  }
}
function renderObjEditor() {
  const o = selObj();
  $('objEditor').classList.toggle('hidden', !o);
  if (!o) return;
  $('obX').value = o.cx.toFixed(0); $('obY').value = o.cy.toFixed(0);
  $('obR').value = o.rot.toFixed(0); $('obS').value = o.scale;
  $('obRole').value = o.role;
  const closed = o.curves.every((c) => c.closed && c.points.length >= 3);
  for (const opt of $('obRole').options) opt.disabled = opt.value !== 'solid' && !closed;
  const box = $('roleBox'); box.innerHTML = '';
  box.classList.toggle('hidden', o.role === 'solid');
  const upd = () => { renderObjList(); scheduleParams(); markMaskDirty(); draw(); };
  if (o.role === 'inlet') {
    box.innerHTML = '<h4>유입 영역</h4>';
    const l = document.createElement('label'); l.textContent = '방식';
    const sel = document.createElement('select');
    sel.add(new Option('방사형 (경계 법선 방향)', 'normal', false, o.inlet.mode === 'normal'));
    sel.add(new Option('균일 벡터', 'vector', false, o.inlet.mode === 'vector'));
    sel.onchange = () => { o.inlet.mode = sel.value; renderObjEditor(); upd(); };
    l.appendChild(sel); box.appendChild(l);
    const g = document.createElement('div'); g.className = 'grid2';
    if (o.inlet.mode === 'normal') g.appendChild(numInput(o.inlet, 'un', '분출 속도', 'm/s', 0.1, upd));
    else { g.appendChild(numInput(o.inlet, 'ux', 'u<sub>x</sub>', 'm/s', 0.1, upd)); g.appendChild(numInput(o.inlet, 'uy', 'u<sub>y</sub>', 'm/s', 0.1, upd)); }
    box.appendChild(g);
  } else if (o.role === 'outlet') {
    box.innerHTML = '<h4>유출 영역</h4>';
    const g = document.createElement('div'); g.className = 'grid2';
    g.appendChild(numInput(o.outlet, 'p', '압력', 'Pa', 1, upd));
    box.appendChild(g);
  }
  $('kinBox').classList.toggle('hidden', o.role !== 'solid');
  const k = o.kin;
  $('kinMode').value = k.mode;
  $('kinOpts').classList.toggle('hidden', k.mode === 'off');
  const [px, py] = pivotWorld(o);
  $('pvX').value = px.toFixed(0); $('pvY').value = py.toFixed(0);
  $('kinI').value = k.inertia; $('kinK').value = k.spring; $('kinC').value = k.damping;
  $('kinRpm').value = k.rpm; $('kinDir').value = k.dir;
  $('lbInertia').classList.toggle('hidden', k.mode === 'drive');
  $('lbSpring').classList.toggle('hidden', k.mode !== 'hinge');
  $('lbDamping').classList.toggle('hidden', k.mode === 'drive');
  $('kinDrive').classList.toggle('hidden', k.mode !== 'drive');
  $('kinAdv').classList.toggle('hidden', k.mode === 'drive');
  const a = k.advanced;
  for (const [id, key] of [['advI', 'I'], ['advC', 'c'], ['advK', 'k'], ['advMin', 'thMin'], ['advMax', 'thMax']]) $(id).value = a[key] ?? '';
}
function renderPatchList() {
  const ul = $('patchList'); ul.innerHTML = '';
  $('patchCount').textContent = S.patches.length ? `${S.patches.length}개` : '없음';
  for (const p of S.patches) {
    const li = document.createElement('li');
    li.className = (S.sel && S.sel.kind === 'patch' && S.sel.id === p.id) ? 'on' : '';
    let v = '';
    if (p.type === 'velocity') v = `(${fmt(p.ux, 2)}, ${fmt(p.uy, 2)}) m/s`;
    if (p.type === 'pressure') v = `${fmt(p.p, 2)} Pa`;
    li.innerHTML = `<span class="sw" style="background:${TYPE_COLOR[p.type]}"></span>${EDGE_NAMES[p.edge]} ${(p.s0 / 1000).toFixed(2)}–${(p.s1 / 1000).toFixed(2)} m<span class="meta">${TYPES[p.type]} ${v}</span>`;
    li.onclick = () => select('patch', p.id);
    ul.appendChild(li);
  }
}
function renderPatchEditor() {
  const p = selPatch();
  $('patchEditor').classList.toggle('hidden', !p);
  if (!p) return;
  $('paEdge').value = p.edge; $('paS0').value = p.s0.toFixed(0); $('paS1').value = p.s1.toFixed(0);
  const box = $('paVals'); box.innerHTML = '';
  const l = document.createElement('label'); l.innerHTML = '종류';
  l.appendChild(typeSelect(p.type, (v) => { p.type = v; renderPatchEditor(); changed(); }));
  box.appendChild(l);
  for (const el of valueInputs(p, () => { renderPatchList(); draw(); scheduleParams(); }, false)) box.appendChild(el);
}

function bcOut(b) {
  const o = { type: b.type };
  if (b.type === 'velocity') { o.ux = +b.ux; o.uy = +b.uy; }
  if (b.type === 'pressure') o.p = +b.p;
  return o;
}
function obstacleOut(o) {
  const out = { id: o.id, curves: objWorld(o), role: o.role, ref: [o.cx, o.cy] };
  if (o.role === 'inlet') out.inlet = { ...o.inlet };
  if (o.role === 'outlet') out.outlet = { ...o.outlet };
  if (o.role === 'solid' && o.kin.mode !== 'off') {
    const k = o.kin, adv = {};
    for (const [key, v] of Object.entries(k.advanced)) if (v !== '' && v !== null && Number.isFinite(+v)) adv[key] = +v;
    out.kin = { mode: k.mode, pivot: pivotWorld(o), inertia: k.inertia, spring: k.spring, damping: k.damping, rpm: +k.rpm, dir: k.dir, advanced: adv };
  }
  return out;
}
function buildCase() {
  return {
    Lx: S.Lx, Ly: grid().Ly, Nx: S.Nx, fluid: { nu: S.nu, rho: S.rho }, les: { enabled: S.les, cs: S.cs },
    u_lat_max: S.ulat, duration: S.duration, ramp: S.ramp, sponge: S.sponge / 100, frames: S.frames,
    edges: Object.fromEntries(Object.entries(S.edges).map(([k, v]) => [k, bcOut(v)])),
    patches: S.patches.map((p) => ({ edge: p.edge, s0: p.s0, s1: p.s1, ...bcOut(p) })),
    obstacles: S.objects.map(obstacleOut),
    emitters: S.emitters,
  };
}
async function api(path, body, raw = false) {
  const r = await fetch(path, body === undefined ? {} : { method: 'POST', body: body instanceof Blob ? body : JSON.stringify(body) });
  if (!r.ok) { let m = r.statusText; try { m = (await r.json()).error; } catch (_) {} throw new Error(m); }
  return raw ? r : r.json();
}
function scheduleParams() { clearTimeout(paramsTimer); paramsTimer = setTimeout(updateParams, 200); }
async function updateParams() {
  const g = grid(), cells = g.Nx * g.Ny;
  $('gridInfo').textContent = `Δx = ${fmt(g.dx, 2)} mm  ·  ${g.Nx} × ${g.Ny} = ${cells.toLocaleString()} 셀  ·  실제 Ly ${fmt(g.Ly / 1000, 3)} m${cells > MAX_CELLS ? '  ·  상한 초과' : ''}`;
  $('gridInfo').style.color = cells > MAX_CELLS ? 'var(--danger)' : '';
  try {
    const p = await api('/api/params', buildCase());
    $('params').innerHTML = [
      ['Δx', `${fmt(p.dx * 1000, 3)} mm`], ['Δt', `${fmt(p.dt * 1000, 4)} ms`],
      ['τ₀', fmt(p.tau0, 5)], ['ν_lat', fmt(p.nu_lat, 3)],
      ['U_max', `${fmt(p.u_max, 3)} m/s`], ['Re_L', fmt(p.Re_L, 0)],
      ['스텝 수', p.steps.toLocaleString()], ['GIF 간격', `${Math.max(1, Math.floor(p.steps / S.frames))} step`],
    ].map(([k, v]) => `<b>${k}</b><span>${v}</span>`).join('');
    $('warns').innerHTML = p.warnings.map((w) => `<div class="warn">${w}</div>`).join('');
  } catch (e) { $('warns').innerHTML = `<div class="warn">${e.message}</div>`; }
  updateStatusUI();
}
function flagCanvas(buf, Nx, Ny) {
  const off = document.createElement('canvas'); off.width = Nx; off.height = Ny;
  const c = off.getContext('2d'), img = c.createImageData(Nx, Ny);
  for (let iy = 0; iy < Ny; iy++) {
    const row = (Ny - 1 - iy) * Nx;
    for (let ix = 0; ix < Nx; ix++) {
      const col = FLAG_RGBA[buf[iy * Nx + ix]];
      if (!col) continue;
      const k = (row + ix) * 4;
      img.data[k] = col[0]; img.data[k + 1] = col[1]; img.data[k + 2] = col[2]; img.data[k + 3] = col[3];
    }
  }
  c.putImageData(img, 0, 0);
  return off;
}
async function fetchMask() {
  try {
    const r = await api('/api/mask', buildCase(), true);
    maskImg = flagCanvas(new Uint8Array(await r.arrayBuffer()), +r.headers.get('X-Nx'), +r.headers.get('X-Ny'));
    draw();
  } catch (e) { toast(`복셀 생성 실패: ${e.message}`); }
}
async function fetchFrame() {
  const r = await fetch(`/api/frame?field=${S.field}`);
  if (r.status !== 200) return;
  const q = new Uint8Array(await r.arrayBuffer()), Nx = +r.headers.get('X-Nx'), Ny = +r.headers.get('X-Ny');
  const lo = +r.headers.get('X-Lo'), hi = +r.headers.get('X-Hi'), lut = luts[S.field];
  const off = resultCanvas && resultCanvas.width === Nx && resultCanvas.height === Ny ? resultCanvas : Object.assign(document.createElement('canvas'), { width: Nx, height: Ny });
  const c = off.getContext('2d'), img = c.createImageData(Nx, Ny);
  for (let iy = 0; iy < Ny; iy++) {
    const row = (Ny - 1 - iy) * Nx;
    for (let ix = 0; ix < Nx; ix++) {
      const v = q[iy * Nx + ix], k = (row + ix) * 4;
      const col = v === 255 ? [90, 90, 96] : lut[Math.min(v, 252)];
      img.data[k] = col[0]; img.data[k + 1] = col[1]; img.data[k + 2] = col[2]; img.data[k + 3] = 255;
    }
  }
  c.putImageData(img, 0, 0);
  resultCanvas = off;
  resultInfo = { Nx, Ny, lo, hi, q, field: S.field, t: +r.headers.get('X-Time') };
  await fetchOverlays();
  updateLegend();
  draw();
}
async function fetchOverlays() {
  const g = grid();
  if (S.showVec) {
    const stride = Math.max(2, Math.round(ARROW_PX / Math.max(g.dx * sc(), 1e-6)));
    const r = await fetch(`/api/vectors?stride=${stride}`);
    if (r.status === 200) vecData = { data: new Float32Array(await r.arrayBuffer()), cols: +r.headers.get('X-Cols'), rows: +r.headers.get('X-Rows'), stride: +r.headers.get('X-Stride'), umax: +r.headers.get('X-Umax') };
  }
  if (S.showStream && (pollCount % 3 === 0 || !streamData || !locked())) {
    const spacing = Math.max(4, Math.round(22 / Math.max(g.dx * sc(), 1e-6)));
    streamData = (await api(`/api/streamlines?spacing=${spacing}`)).lines;
  }
  if (S.showPart) {
    const r = await fetch('/api/particles');
    if (r.status === 200) partData = new Float32Array(await r.arrayBuffer());
  }
}
function updateLegend() {
  const show = S.view === 'result' && resultInfo;
  $('legend').classList.toggle('hidden', !show);
  if (!show) return;
  const c = $('legendCv').getContext('2d'), lut = luts[resultInfo.field];
  for (let x = 0; x < 160; x++) { const col = lut[Math.round(x / 159 * 252)]; c.fillStyle = `rgb(${col})`; c.fillRect(x, 0, 1, 10); }
  $('lgLo').textContent = fmt(resultInfo.lo); $('lgHi').textContent = fmt(resultInfo.hi);
  $('lgName').textContent = `${FIELD_KO[resultInfo.field]} · t = ${resultInfo.t.toFixed(2)} s`;
  const [l, r] = LEGEND_MEAN[resultInfo.field];
  $('lgL').textContent = l; $('lgR').textContent = r;
}

function renderLoadSelect() {
  const sel = $('loadObj'), cur = sel.value;
  sel.innerHTML = '';
  for (const o of S.objects) if (o.role === 'solid') sel.add(new Option(o.name, o.id, false, String(o.id) === cur));
}
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
function renderLoads() {
  const tbl = $('loadTable'), loads = status.loads;
  if (!loads || !runCase) { tbl.innerHTML = '<tr><td>해석 후 표시됩니다.</td></tr>'; return; }
  const U = status.prm ? status.prm.u_max : 1, q = 0.5 * S.rho * U * U;
  const half = hist && hist.t.length ? Math.floor(hist.t.length / 2) : 0;
  let html = '<tr><th>객체</th><th>F<sub>x</sub></th><th>F<sub>y</sub></th><th>M</th><th>C<sub>d</sub> 평균</th><th>C<sub>l</sub> 평균</th><th>상태</th></tr>';
  runCase.obstacles.forEach((ob, i) => {
    if (ob.role !== 'solid') return;
    const o = S.objects.find((x) => x.id === ob.id), L = loads[i] || {}, D = objHeight(o || { curves: [], rot: 0, scale: 1, cx: 0, cy: 0 }) / 1000;
    const h = hist && hist.obj[i];
    const cd = h ? mean(h.fx.slice(half)) / (q * D) : NaN, cl = h ? mean(h.fy.slice(half)) / (q * D) : NaN;
    const st = L.theta !== undefined ? `${(L.theta * 180 / Math.PI).toFixed(1)}° · ${(L.omega * 60 / 2 / Math.PI).toFixed(1)} rpm${L.limited ? ' ⚠' : ''}` : '고정';
    html += `<tr><td title="${o ? o.name : ''}">${o ? o.name : i}</td><td>${fmt(L.fx)}</td><td>${fmt(L.fy)}</td><td>${fmt(L.m)}</td><td>${fmt(cd)}</td><td>${fmt(cl)}</td><td>${st}</td></tr>`;
  });
  tbl.innerHTML = html;
}
function drawLoadChart() {
  const c = $('loadChart'), r = c.getBoundingClientRect(), w = Math.max(200, Math.round(r.width || 336)), h = 140, d = window.devicePixelRatio || 1;
  c.width = w * d; c.height = h * d;
  const g = c.getContext('2d');
  g.setTransform(d, 0, 0, d, 0, 0);
  g.clearRect(0, 0, w, h);
  g.font = '10px system-ui'; g.fillStyle = CV.muted;
  const id = +$('loadObj').value, qty = $('loadQty').value;
  const i = runCase ? runCase.obstacles.findIndex((o) => o.id === id) : -1;
  const ys = i >= 0 && hist && hist.obj[i] ? hist.obj[i][qty] : null;
  if (!ys || ys.length < 2) { g.fillText('해석 중/후 선택한 객체의 시계열이 표시됩니다.', 8, h / 2); return; }
  const ts = hist.t.slice(0, ys.length);
  let y0 = Math.min(...ys), y1 = Math.max(...ys);
  if (y1 - y0 < 1e-12) { y0 -= 1; y1 += 1; }
  const pad = 30, X = (t) => pad + (t - ts[0]) / Math.max(ts.at(-1) - ts[0], 1e-9) * (w - pad - 8), Y = (v) => 8 + (1 - (v - y0) / (y1 - y0)) * (h - 26);
  g.strokeStyle = CV['cv-grid-major']; g.lineWidth = 1;
  g.beginPath(); g.moveTo(pad, 8); g.lineTo(pad, h - 18); g.lineTo(w - 8, h - 18); g.stroke();
  if (y0 < 0 && y1 > 0) { g.setLineDash([3, 3]); g.beginPath(); g.moveTo(pad, Y(0)); g.lineTo(w - 8, Y(0)); g.stroke(); g.setLineDash([]); }
  g.fillText(fmt(y1), 2, 14); g.fillText(fmt(y0), 2, h - 20);
  g.fillText(`${ts[0].toFixed(1)} s`, pad, h - 5); g.textAlign = 'right'; g.fillText(`${ts.at(-1).toFixed(1)} s`, w - 8, h - 5); g.textAlign = 'left';
  g.strokeStyle = CV.accent; g.lineWidth = 1.5; g.beginPath();
  ys.forEach((v, k) => { const x = X(ts[k]), y = Y(v); k ? g.lineTo(x, y) : g.moveTo(x, y); });
  g.stroke();
}
async function fetchHistory() {
  hist = await api('/api/history');
  renderLoads(); drawLoadChart();
}

async function poll() {
  status = await api('/api/status');
  pollCount++;
  updateStatusUI();
  if (S.view === 'result' && status.state !== 'building') await fetchFrame();
  if (pollCount % 4 === 0 || !locked()) await fetchHistory(); else renderLoads();
  if (!locked()) { stopPolling(); await fetchHistory(); }
}
function startPolling() {
  if (polling) return;
  polling = setInterval(() => { if (pollBusy) return; pollBusy = true; poll().catch(() => {}).finally(() => { pollBusy = false; }); }, 350);
}
function stopPolling() { clearInterval(polling); polling = null; }
function updateStatusUI() {
  const st = status.state || 'idle', g = grid();
  const b = $('stateBadge'); b.className = `badge ${st}`; b.textContent = STATE_KO[st] || st;
  const steps = status.steps || 0, step = status.step || 0;
  $('progBar').style.width = steps ? `${(100 * step / steps).toFixed(1)}%` : '0%';
  let txt = status.message || '–';
  if (steps) {
    const T = status.prm ? steps * status.prm.dt : 0, eta = status.sps ? (steps - step) / status.sps : 0;
    const cells = status.prm ? status.prm.cells : g.Nx * g.Ny;
    txt = `t ${(status.t || 0).toFixed(2)} / ${T.toFixed(2)} s · step ${step.toLocaleString()} / ${steps.toLocaleString()}`;
    if (status.sps) txt += ` · ${status.sps.toFixed(0)} step/s · ${(status.sps * cells / 1e6).toFixed(1)} MLUPS`;
    if (st === 'running' && eta) txt += ` · 남은 시간 ${eta > 90 ? (eta / 60).toFixed(1) + '분' : eta.toFixed(0) + '초'}`;
    if (status.message) txt += ` · ${status.message}`;
  }
  $('progText').textContent = txt;
  const busy = locked(), tooBig = g.Nx * g.Ny > MAX_CELLS;
  $('btnRun').disabled = busy || tooBig;
  $('btnPause').disabled = !['running', 'paused'].includes(st);
  $('btnPause').textContent = st === 'paused' ? '재개' : '일시정지';
  $('btnStop').disabled = !busy;
  $('btnGif').disabled = busy || !(status.frames > 0);
  for (const id of ['inLx', 'inLy', 'inNx', 'inPreset', 'inNu', 'inRho', 'inLes', 'inCs', 'inDur', 'inRamp', 'inFrames', 'inUlat', 'inSponge',
    'obX', 'obY', 'obR', 'obS', 'obRole', 'obDel', 'kinMode', 'pvX', 'pvY', 'btnPivot', 'kinI', 'kinK', 'kinC', 'kinRpm', 'kinDir',
    'advI', 'advC', 'advK', 'advMin', 'advMax', 'paEdge', 'paS0', 'paS1', 'paDel', 'btnSamples', 'btnMask', 'selExample']) $(id).disabled = busy;
  $('fileDxf').disabled = busy;
  if (busy !== updateStatusUI.lastBusy) { updateStatusUI.lastBusy = busy; renderEdgeRows(); renderPatchEditor(); renderObjEditor(); }
}
async function run() {
  try {
    const hasOut = Object.values(S.edges).some((b) => ['pressure', 'outflow'].includes(b.type)) || S.patches.some((p) => ['pressure', 'outflow'].includes(p.type)) || S.objects.some((o) => o.role === 'outlet');
    if (!hasOut) toast('압력/유출 경계가 없으면 질량이 누적될 수 있습니다.');
    runCase = buildCase();
    runMap = new Map(runCase.obstacles.map((o, i) => [o.id, i]));
    hist = null; vecData = null; streamData = null; partData = null;
    await api('/api/run', runCase);
    status = { state: 'building' }; updateStatusUI();
    setView('result');
    $('gifBox').classList.add('hidden');
    startPolling();
  } catch (e) { toast(`실행 실패: ${e.message}`); }
}
async function makeGif() {
  const btn = $('btnGif'); btn.disabled = true; btn.textContent = 'GIF 생성 중…';
  try {
    const r = await api('/api/gif', { field: S.field, fps: +$('inFps').value, scale: +$('inGifScale').value, vectors: $('gifVec').checked, particles: $('gifPart').checked }, true);
    const url = URL.createObjectURL(await r.blob());
    $('gifImg').src = url; $('gifLink').href = url; $('gifLink').download = `lbm_${S.field}.gif`;
    $('gifBox').classList.remove('hidden');
  } catch (e) { toast(`GIF 실패: ${e.message}`); }
  btn.textContent = 'GIF 만들기'; updateStatusUI();
}
function setView(v) {
  S.view = v;
  for (const b of $('viewSeg').querySelectorAll('button')) b.classList.toggle('on', b.dataset.view === v);
  if (v === 'result' && !locked() && status.state !== 'idle') fetchFrame().catch(() => {});
  updateLegend(); draw();
}
function pushEmitters(clear = false) {
  if (status.state === 'idle') return;
  api('/api/emitters', { points: S.emitters, clear }).catch(() => {});
}

function bindNumber(id, key, after) {
  $(id).value = S[key];
  $(id).addEventListener('change', () => { const v = +$(id).value; if (!Number.isFinite(v)) return; S[key] = v; if (after) after(); changed(); });
}
function applyPreset(name) {
  S.preset = name;
  if (PRESETS[name]) Object.assign(S, PRESETS[name]);
  $('inPreset').value = name; $('inNu').value = S.nu; $('inRho').value = S.rho; $('inLes').checked = S.les; $('inCs').value = S.cs;
  scheduleParams();
}
function syncInputs() {
  for (const [id, key] of [['inLx', 'Lx'], ['inLy', 'Ly'], ['inNx', 'Nx'], ['inDur', 'duration'], ['inRamp', 'ramp'], ['inFrames', 'frames'], ['inUlat', 'ulat'], ['inSponge', 'sponge']]) $(id).value = S[key];
  $('inPreset').value = S.preset; $('inNu').value = S.nu; $('inRho').value = S.rho; $('inLes').checked = S.les; $('inCs').value = S.cs;
}
function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toast.timer); toast.timer = setTimeout(() => t.classList.add('hidden'), 3200);
}

function init() {
  try { theme = localStorage.getItem('lbm-theme') || 'system'; } catch (_) { theme = 'system'; }
  applyTheme();
  if (window.matchMedia) window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => { if (theme === 'system') applyTheme(); });
  $('btnTheme').onclick = () => { theme = THEME_NEXT[theme]; try { localStorage.setItem('lbm-theme', theme); } catch (_) {} applyTheme(); };

  bindNumber('inLx', 'Lx', () => { S.Lx = Math.max(S.Lx, 10); resultCanvas = null; });
  bindNumber('inLy', 'Ly', () => { S.Ly = Math.max(S.Ly, 10); resultCanvas = null; });
  bindNumber('inNx', 'Nx', () => { S.Nx = Math.round(clamp(S.Nx, 20, 2000)); $('inNx').value = S.Nx; resultCanvas = null; });
  bindNumber('inDur', 'duration'); bindNumber('inRamp', 'ramp'); bindNumber('inFrames', 'frames');
  bindNumber('inUlat', 'ulat'); bindNumber('inSponge', 'sponge');
  $('inPreset').onchange = () => applyPreset($('inPreset').value);
  $('inNu').onchange = () => { S.nu = +$('inNu').value; S.preset = 'custom'; $('inPreset').value = 'custom'; scheduleParams(); };
  $('inRho').onchange = () => { S.rho = +$('inRho').value; S.preset = 'custom'; $('inPreset').value = 'custom'; scheduleParams(); };
  $('inLes').onchange = () => { S.les = $('inLes').checked; scheduleParams(); };
  $('inCs').onchange = () => { S.cs = +$('inCs').value; };
  applyPreset('demo');

  $('fileDxf').onchange = async (e) => {
    for (const f of e.target.files) {
      try { addObject(f.name.replace(/\.dxf$/i, ''), await api('/api/dxf', f)); } catch (err) { toast(`${f.name}: ${err.message}`); }
    }
    e.target.value = '';
  };
  $('btnSamples').onclick = async () => {
    const names = await api('/api/samples');
    for (const n of names) addObject(n.replace(/\.dxf$/i, ''), await api(`/api/sample?name=${encodeURIComponent(n)}`));
  };
  const objField = (id, key, f = (v) => v) => { $(id).onchange = () => { const o = selObj(); if (!o) return; o[key] = f(+$(id).value); changed(); renderObjEditor(); }; };
  objField('obX', 'cx'); objField('obY', 'cy'); objField('obR', 'rot', (v) => ((v % 360) + 360) % 360); objField('obS', 'scale', (v) => Math.max(v, 0.01));
  $('obDel').onclick = deleteSelected;
  $('obRole').onchange = () => { const o = selObj(); if (!o) return; o.role = $('obRole').value; if (o.role !== 'solid') o.kin.mode = 'off'; renderObjEditor(); changed(); };
  $('kinMode').onchange = () => { const o = selObj(); if (!o) return; o.kin.mode = $('kinMode').value; renderObjEditor(); changed(); };
  const kinField = (id, key, num = false) => { $(id).onchange = () => { const o = selObj(); if (!o) return; o.kin[key] = num ? +$(id).value : $(id).value; changed(); }; };
  kinField('kinI', 'inertia'); kinField('kinK', 'spring'); kinField('kinC', 'damping'); kinField('kinRpm', 'rpm', true); kinField('kinDir', 'dir');
  const pv = () => { const o = selObj(); if (!o) return; o.kin.pl = toLocal(o, [+$('pvX').value, +$('pvY').value]); changed(); };
  $('pvX').onchange = pv; $('pvY').onchange = pv;
  $('btnPivot').onclick = () => setMode('pivot', '캔버스를 클릭해 회전축을 지정하세요 (Esc 취소)');
  for (const [id, key] of [['advI', 'I'], ['advC', 'c'], ['advK', 'k'], ['advMin', 'thMin'], ['advMax', 'thMax']]) {
    $(id).onchange = () => { const o = selObj(); if (!o) return; const v = $(id).value; o.kin.advanced[key] = v === '' ? null : +v; changed(); };
  }
  $('paEdge').onchange = () => { const p = selPatch(); if (p) { p.edge = $('paEdge').value; changed(); renderPatchEditor(); } };
  $('paS0').onchange = () => { const p = selPatch(); if (p) { p.s0 = clamp(+$('paS0').value, 0, edgeLen(p.edge)); changed(); } };
  $('paS1').onchange = () => { const p = selPatch(); if (p) { p.s1 = clamp(+$('paS1').value, 0, edgeLen(p.edge)); changed(); } };
  $('paDel').onclick = deleteSelected;

  $('btnMask').onclick = () => { S.showMask = true; $('chkMask').checked = true; setView('edit'); fetchMask(); };
  $('chkMask').onchange = () => { S.showMask = $('chkMask').checked; if (S.showMask) fetchMask(); else draw(); };
  $('chkGrid').onchange = () => { S.showGrid = $('chkGrid').checked; draw(); };
  const overlayToggle = (id, key) => { $(id).onchange = () => { S[key] = $(id).checked; if (S[key] && S.view === 'result' && status.state !== 'idle') fetchOverlays().then(draw).catch(() => {}); else draw(); }; };
  overlayToggle('chkVec', 'showVec'); overlayToggle('chkStream', 'showStream'); overlayToggle('chkPart', 'showPart');
  $('btnEmit').onclick = () => { if (S.mode === 'emit') setMode(null); else { setMode('emit', '캔버스를 클릭해 입자 방출점을 추가하세요 (Esc 종료)'); S.showPart = true; $('chkPart').checked = true; } };
  $('btnEmitClear').onclick = () => { S.emitters = []; pushEmitters(true); draw(); };
  $('btnFit').onclick = () => { S.zoom = 1; S.panX = 0; S.panY = 0; draw(); };
  for (const b of $('viewSeg').querySelectorAll('button')) b.onclick = () => setView(b.dataset.view);
  $('inField').onchange = () => { S.field = $('inField').value; if (status.state !== 'idle') fetchFrame().catch(() => {}); };
  $('loadObj').onchange = drawLoadChart; $('loadQty').onchange = drawLoadChart;

  $('btnRun').onclick = run;
  $('btnStop').onclick = () => api('/api/stop', {}).catch(() => {});
  $('btnPause').onclick = () => api('/api/pause', {}).then(() => poll()).catch(() => {});
  $('btnGif').onclick = makeGif;

  $('btnSaveCase').onclick = () => {
    const keys = ['Lx', 'Ly', 'Nx', 'preset', 'nu', 'rho', 'les', 'cs', 'duration', 'ramp', 'frames', 'ulat', 'sponge', 'edges', 'patches', 'objects', 'emitters'];
    const data = JSON.stringify(Object.fromEntries(keys.map((k) => [k, S[k]])), null, 1);
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([data], { type: 'application/json' })), download: 'lbm_case.json' });
    a.click();
  };
  const applyCase = (data, label) => {
    if (locked()) { toast('해석 중에는 케이스를 바꿀 수 없습니다.'); return; }
    const d = { ...data };
    if (d.L !== undefined && d.Lx === undefined) { d.Lx = d.L; d.Ly = d.L; d.Nx = d.N; }
    delete d.L; delete d.N;
    Object.assign(S, { emitters: [] }, d);
    S.objects.forEach(ensureObj);
    uid = 1 + Math.max(0, ...S.objects.map((o) => o.id), ...S.patches.map((p) => p.id));
    resultCanvas = null; S.zoom = 1; S.panX = 0; S.panY = 0;
    runCase = null; hist = null; vecData = null; streamData = null; partData = null;
    $('gifBox').classList.add('hidden'); renderLoads(); drawLoadChart();
    syncInputs(); renderEdgeRows(); select(null); setView('edit'); changed(); toast(`${label}을(를) 불러왔습니다.`);
  };
  $('fileCase').onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try { applyCase(JSON.parse(await f.text()), '케이스'); } catch (err) { toast(`불러오기 실패: ${err.message}`); }
    e.target.value = '';
  };
  fetch('samples/index.json').then((r) => r.json()).then((idx) => {
    for (const c of idx.cases || []) $('selExample').add(new Option(c.title, c.file));
  }).catch(() => {});
  $('selExample').onchange = async () => {
    const sel = $('selExample'), file = sel.value;
    if (!file) return;
    try { applyCase(await (await fetch(`samples/${file}`)).json(), sel.selectedOptions[0].text); } catch (err) { toast(`예제 불러오기 실패: ${err.message}`); }
    sel.value = '';
  };

  window.addEventListener('resize', () => { resize(); drawLoadChart(); });
  renderEdgeRows(); renderObjList(); renderPatchList(); renderLoadSelect(); renderLoads();
  api('/api/colormaps').then((m) => { luts = m; });
  api('/api/status').then((st) => { status = st; updateStatusUI(); if (locked()) { setView('result'); startPolling(); } });
  resize(); updateParams(); drawLoadChart();
}
init();
