'use strict';

const $ = (id) => document.getElementById(id);
const EDGE_NAMES = { left: '왼쪽', right: '오른쪽', bottom: '아래', top: '위' };
const EDGE_NORMAL = { left: [1, 0], right: [-1, 0], bottom: [0, 1], top: [0, -1] };
const TYPES = { velocity: '속도', pressure: '압력', outflow: '유출', wall: '벽', slip: '미끄럼벽' };
const TYPE_COLOR = { velocity: '#1f9d55', pressure: '#2563eb', outflow: '#0891b2', wall: '#374151', slip: '#9ca3af' };
const FLAG_RGBA = [null, [70, 76, 92, 235], [31, 157, 85, 220], [37, 99, 235, 220], [8, 145, 178, 220], [156, 163, 175, 220]];
const PRESETS = {
  demo: { nu: 0.005, rho: 1.2, les: false, cs: 0.2 },
  air: { nu: 1.5e-5, rho: 1.204, les: true, cs: 0.2 },
  water: { nu: 1.0e-6, rho: 998, les: true, cs: 0.2 },
};
const OBJ_COLORS = ['#e4572e', '#f3a712', '#3d5a80', '#6a994e', '#9b5de5', '#00a6a6', '#f15bb5', '#8d6346'];
const STATE_KO = { idle: '대기', building: '준비 중', running: '계산 중', paused: '일시정지', done: '완료', stopped: '중지됨', diverged: '발산', error: '오류' };
const FIELD_KO = { umag: '|u| [m/s]', vort: 'ω [1/s]', pressure: 'p [Pa]' };
const LEGEND_MEAN = { umag: ['느림', '빠름'], vort: ['시계방향 −', '반시계방향 +'], pressure: ['저압', '고압'] };
const MARGIN = 64, BAND = 14, GAP = 4;

const S = {
  L: 10000, N: 500,
  preset: 'demo', nu: 0.005, rho: 1.2, les: false, cs: 0.2,
  duration: 12, ramp: 2, frames: 120, ulat: 0.08, sponge: 8,
  edges: {
    left: { type: 'velocity', ux: 1, uy: 0, p: 0 },
    right: { type: 'pressure', ux: 0, uy: 0, p: 0 },
    bottom: { type: 'slip', ux: 0, uy: 0, p: 0 },
    top: { type: 'slip', ux: 0, uy: 0, p: 0 },
  },
  patches: [], objects: [], sel: null,
  view: 'edit', field: 'umag', showMask: false, showGrid: true,
  zoom: 1, panX: 0, panY: 0,
};
let uid = 1;
let maskImg = null, maskTimer = null, paramsTimer = null;
let resultCanvas = null, resultInfo = null;
let luts = {}, status = { state: 'idle' }, polling = null, pollBusy = false;
let drag = null, spaceDown = false, hoverPx = null;

const cv = $('cv'), ctx = cv.getContext('2d');
let W = 0, H = 0, dpr = 1;
const sc = () => Math.max(1e-9, (Math.min(W, H) - 2 * MARGIN) / S.L) * S.zoom;
const origin = () => { const s = sc(); return { x: (W - S.L * s) / 2 + S.panX, y: (H - S.L * s) / 2 + S.panY }; };
const w2s = (x, y) => { const s = sc(), o = origin(); return [o.x + x * s, o.y + (S.L - y) * s]; };
const s2w = (px, py) => { const s = sc(), o = origin(); return [(px - o.x) / s, S.L - (py - o.y) / s]; };
const dxmm = () => S.L / S.N;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const fmt = (v, d = 3) => (Math.abs(v) >= 1e4 || (Math.abs(v) < 1e-3 && v !== 0)) ? v.toExponential(2) : (+v.toFixed(d)).toString();
const locked = () => ['running', 'paused', 'building'].includes(status.state);

function resize() {
  const r = cv.getBoundingClientRect();
  dpr = window.devicePixelRatio || 1;
  W = r.width; H = r.height;
  cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
  draw();
}

function objWorld(o) {
  const a = o.rot * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  return o.curves.map((cu) => ({
    closed: cu.closed,
    points: cu.points.map(([x, y]) => [o.cx + o.scale * (x * c - y * s), o.cy + o.scale * (x * s + y * c)]),
  }));
}
function objRadius(o) {
  let r = 0;
  for (const cu of o.curves) for (const [x, y] of cu.points) r = Math.max(r, Math.hypot(x, y));
  return r * o.scale;
}
function addObject(name, parsed) {
  const pts = parsed.curves.flatMap((c) => c.points);
  if (!pts.length) { toast(`${name}: 읽을 수 있는 커브가 없습니다.`); return; }
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const inside = x0 >= 0 && x1 <= S.L && y0 >= 0 && y1 <= S.L;
  const k = S.objects.length;
  const o = {
    id: uid++, name, color: OBJ_COLORS[k % OBJ_COLORS.length], rot: 0, scale: 1,
    cx: inside ? cx : S.L / 2 + ((k % 3) - 1) * S.L * 0.12, cy: inside ? cy : S.L / 2,
    curves: parsed.curves.map((c) => ({ closed: c.closed, points: c.points.map(([x, y]) => [x - cx, y - cy]) })),
  };
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
  const o = origin(), Ls = S.L * sc(), r = GAP + BAND + 6;
  const inY = py >= o.y && py <= o.y + Ls, inX = px >= o.x && px <= o.x + Ls;
  if (inY && px >= o.x - r && px < o.x - 1) return 'left';
  if (inY && px > o.x + Ls + 1 && px <= o.x + Ls + r) return 'right';
  if (inX && py > o.y + Ls + 1 && py <= o.y + Ls + r) return 'bottom';
  if (inX && py >= o.y - r && py < o.y - 1) return 'top';
  return null;
}
function edgeCoord(edge, px, py) {
  const [wx, wy] = s2w(px, py), v = (edge === 'left' || edge === 'right') ? wy : wx;
  return clamp(Math.round(v / dxmm()) * dxmm(), 0, S.L);
}
function patchAt(edge, s) {
  for (let k = S.patches.length - 1; k >= 0; k--) {
    const p = S.patches[k];
    if (p.edge === edge && s >= Math.min(p.s0, p.s1) && s <= Math.max(p.s0, p.s1)) return p;
  }
  return null;
}
function bandRect(edge, a, b) {
  const s = sc(), o = origin(), Ls = S.L * s;
  if (edge === 'left') return [o.x - GAP - BAND, o.y + (S.L - b) * s, BAND, (b - a) * s];
  if (edge === 'right') return [o.x + Ls + GAP, o.y + (S.L - b) * s, BAND, (b - a) * s];
  if (edge === 'bottom') return [o.x + a * s, o.y + Ls + GAP, (b - a) * s, BAND];
  return [o.x + a * s, o.y - GAP - BAND, (b - a) * s, BAND];
}
function edgeHasOutlet(edge) {
  return ['pressure', 'outflow'].includes(S.edges[edge].type) ||
    S.patches.some((p) => p.edge === edge && ['pressure', 'outflow'].includes(p.type));
}

function draw() {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const o = origin(), Ls = S.L * sc();
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(o.x, o.y, Ls, Ls);
  ctx.imageSmoothingEnabled = false;
  if (S.view === 'result' && resultCanvas) ctx.drawImage(resultCanvas, o.x, o.y, Ls, Ls);
  else drawSponge();
  if (S.showMask && maskImg && S.view === 'edit') ctx.drawImage(maskImg, o.x, o.y, Ls, Ls);
  if (S.showGrid) drawGrid();
  ctx.strokeStyle = '#8b93a3'; ctx.lineWidth = 1;
  ctx.strokeRect(Math.round(o.x) + 0.5, Math.round(o.y) + 0.5, Math.round(Ls), Math.round(Ls));
  drawObjects();
  drawEdges();
  drawAxes();
}
function majorStep(cpx) {
  for (const m of [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000]) if (m * cpx >= 36) return m;
  return 1000;
}
function drawGrid() {
  const o = origin(), Ls = S.L * sc(), cpx = dxmm() * sc();
  ctx.save();
  ctx.beginPath(); ctx.rect(o.x, o.y, Ls, Ls); ctx.clip();
  const lines = (step, color) => {
    ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.beginPath();
    for (let i = 0; i <= S.N; i += step) {
      const x = Math.round(o.x + i * cpx) + 0.5, y = Math.round(o.y + i * cpx) + 0.5;
      if (x > -1 && x < W + 1) { ctx.moveTo(x, Math.max(o.y, 0)); ctx.lineTo(x, Math.min(o.y + Ls, H)); }
      if (y > -1 && y < H + 1) { ctx.moveTo(Math.max(o.x, 0), y); ctx.lineTo(Math.min(o.x + Ls, W), y); }
    }
    ctx.stroke();
  };
  const dark = S.view === 'result' && resultCanvas;
  if (cpx >= 5) lines(1, dark ? 'rgba(255,255,255,0.10)' : 'rgba(20,30,50,0.07)');
  lines(majorStep(cpx), dark ? 'rgba(255,255,255,0.18)' : 'rgba(20,30,50,0.14)');
  ctx.restore();
}
function drawSponge() {
  const w = S.sponge / 100 * S.L;
  if (w <= 0) return;
  for (const e of Object.keys(EDGE_NAMES)) {
    if (!edgeHasOutlet(e)) continue;
    let r;
    if (e === 'left') r = [0, 0, w, S.L]; else if (e === 'right') r = [S.L - w, 0, w, S.L];
    else if (e === 'bottom') r = [0, 0, S.L, w]; else r = [0, S.L - w, S.L, w];
    const [x0, y1] = w2s(r[0], r[1] + r[3]), [x1, y0] = w2s(r[0] + r[2], r[1]);
    const g = (e === 'left' || e === 'right') ? ctx.createLinearGradient(x0, 0, x1, 0) : ctx.createLinearGradient(0, y1, 0, y0);
    const a = 'rgba(37,99,235,0.10)', z = 'rgba(37,99,235,0)';
    if (e === 'left' || e === 'top') { g.addColorStop(0, a); g.addColorStop(1, z); } else { g.addColorStop(0, z); g.addColorStop(1, a); }
    ctx.fillStyle = g; ctx.fillRect(x0, y1, x1 - x0, y0 - y1);
    ctx.fillStyle = 'rgba(37,99,235,0.55)'; ctx.font = '10px system-ui';
    const [lx, ly] = w2s(r[0] + r[2] / 2, r[1] + r[3] / 2);
    ctx.save(); ctx.translate(lx, ly); if (e === 'left' || e === 'right') ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center'; ctx.fillText('흡수층', 0, 3); ctx.restore();
  }
}
function drawObjects() {
  const sel = S.sel && S.sel.kind === 'obj' ? S.sel.id : null;
  const faint = (S.view === 'result' && resultCanvas) || (S.showMask && maskImg);
  for (const o of S.objects) {
    const on = o.id === sel;
    for (const cu of objWorld(o)) {
      ctx.beginPath();
      cu.points.forEach(([x, y], i) => { const [sx, sy] = w2s(x, y); i ? ctx.lineTo(sx, sy) : ctx.moveTo(sx, sy); });
      if (cu.closed) {
        ctx.closePath();
        if (!faint) { ctx.fillStyle = o.color + (on ? '66' : '40'); ctx.fill(); }
      }
      ctx.strokeStyle = faint ? (S.view === 'result' ? 'rgba(255,255,255,0.9)' : o.color) : o.color;
      ctx.lineWidth = on ? 2.5 : (cu.closed ? 1.5 : 2.5);
      ctx.stroke();
    }
    if (on && !locked()) {
      const [cx, cy] = w2s(o.cx, o.cy), [hx, hy] = rotHandle(o);
      ctx.strokeStyle = '#2f5bea'; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.arc(cx, cy, objRadius(o) * sc() + 6, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
      ctx.beginPath(); ctx.moveTo(cx, cy - objRadius(o) * sc() - 6); ctx.lineTo(hx, hy); ctx.stroke();
      ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(hx, hy, 6, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#2f5bea'; ctx.beginPath(); ctx.arc(cx, cy, 3, 0, Math.PI * 2); ctx.fill();
    }
  }
}
function uncovered(edge) {
  let segs = [[0, S.L]];
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
  if (selected) { ctx.strokeStyle = '#111'; ctx.lineWidth = 2; ctx.strokeRect(x - 1, y - 1, w + 2, h + 2); }
  const len = Math.max(w, h);
  if (len > 70) {
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
  const s = sc(), span = (b - a) * s, n = Math.max(1, Math.floor(span / 56));
  const dx = ux / mag, dy = -uy / mag;
  ctx.strokeStyle = TYPE_COLOR.velocity; ctx.fillStyle = TYPE_COLOR.velocity; ctx.lineWidth = 1.5;
  for (let k = 0; k < n; k++) {
    const v = a + (b - a) * (k + 0.5) / n;
    let [px, py] = (edge === 'left' || edge === 'right') ? w2s(edge === 'left' ? 0 : S.L, v) : w2s(v, edge === 'bottom' ? 0 : S.L);
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
    ctx.strokeStyle = '#111'; ctx.setLineDash([4, 3]); ctx.lineWidth = 1.5;
    ctx.strokeRect(x - 2, y - 2, w + 4, h + 4); ctx.setLineDash([]);
  }
}
function drawAxes() {
  const s = sc();
  let step = 100;
  for (const m of [100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000]) { step = m; if (m * s >= 60) break; }
  ctx.fillStyle = '#6b7280'; ctx.font = '10px system-ui';
  const o = origin(), Ls = S.L * s;
  ctx.textAlign = 'center';
  for (let v = 0; v <= S.L + 1e-6; v += step) {
    const [x] = w2s(v, 0);
    if (x >= -20 && x <= W + 20) ctx.fillText(`${fmt(v / 1000, 2)}`, x, o.y + Ls + GAP + BAND + 14);
  }
  ctx.textAlign = 'right';
  for (let v = 0; v <= S.L + 1e-6; v += step) {
    const [, y] = w2s(0, v);
    if (y >= -20 && y <= H + 20) ctx.fillText(`${fmt(v / 1000, 2)}`, o.x - GAP - BAND - 6, y + 3);
  }
  ctx.textAlign = 'left';
  ctx.fillText('m', o.x + Ls + GAP + BAND + 6, o.y + Ls + GAP + BAND + 14);
}

const pos = (e) => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
cv.addEventListener('contextmenu', (e) => e.preventDefault());
cv.addEventListener('mousedown', (e) => {
  const [px, py] = pos(e);
  const pan = { mode: 'pan', px, py, panX: S.panX, panY: S.panY };
  if (e.button !== 0 || spaceDown || locked()) { drag = pan; return; }
  const so = selObj();
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
  hoverPx = [px, py];
  updateCursorInfo(px, py);
  if (!drag) { setCursor(px, py); return; }
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
  const [wx, wy] = s2w(px, py);
  if (wx < 0 || wy < 0 || wx > S.L || wy > S.L) { $('cursorInfo').textContent = ''; return; }
  const ix = Math.floor(wx / dxmm()), iy = Math.floor(wy / dxmm());
  let t = `x ${wx.toFixed(0)} mm  y ${wy.toFixed(0)} mm  ·  cell (${ix}, ${iy})`;
  if (S.view === 'result' && resultInfo && resultInfo.N === S.N) {
    const q = resultInfo.q[iy * resultInfo.N + ix];
    t += q === 255 ? '  ·  고체' : `  ·  ${FIELD_KO[resultInfo.field]} ≈ ${fmt(resultInfo.lo + q / 252 * (resultInfo.hi - resultInfo.lo))}`;
  }
  $('cursorInfo').textContent = t;
}
window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && !isTyping()) { spaceDown = true; e.preventDefault(); }
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
  renderObjList(); renderPatchList();
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
function valueInputs(b, onchange, compact) {
  const mk = (key, label, unit, step) => {
    const l = document.createElement('label');
    l.innerHTML = compact ? '' : `${label} <em>${unit}</em>`;
    const i = document.createElement('input');
    const plain = label.replace(/<\/?sub>/g, '');
    i.type = 'number'; i.step = step; i.value = b[key]; i.title = `${plain} [${unit}]`;
    i.placeholder = plain; i.disabled = locked();
    i.oninput = () => { b[key] = +i.value; onchange(); };
    l.appendChild(i); return l;
  };
  if (b.type === 'velocity') return [mk('ux', 'u<sub>x</sub>', 'm/s', 0.1), mk('uy', 'u<sub>y</sub>', 'm/s', 0.1)];
  if (b.type === 'pressure') return [mk('p', 'p', 'Pa', 1), document.createElement('span')];
  return [document.createElement('span'), document.createElement('span')];
}
function renderObjList() {
  const ul = $('objList'); ul.innerHTML = '';
  for (const o of S.objects) {
    const li = document.createElement('li');
    li.className = (S.sel && S.sel.kind === 'obj' && S.sel.id === o.id) ? 'on' : '';
    const nc = o.curves.length, closed = o.curves.every((c) => c.closed);
    li.innerHTML = `<span class="sw" style="background:${o.color}"></span>${o.name}<span class="meta">${nc}커브 · ${closed ? 'Solid' : '열린 커브 포함'}</span>`;
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
function buildCase(withObs = true) {
  return {
    L: S.L, N: S.N, fluid: { nu: S.nu, rho: S.rho }, les: { enabled: S.les, cs: S.cs },
    u_lat_max: S.ulat, duration: S.duration, ramp: S.ramp, sponge: S.sponge / 100, frames: S.frames,
    edges: Object.fromEntries(Object.entries(S.edges).map(([k, v]) => [k, bcOut(v)])),
    patches: S.patches.map((p) => ({ edge: p.edge, s0: p.s0, s1: p.s1, ...bcOut(p) })),
    obstacles: withObs ? S.objects.map((o) => ({ curves: objWorld(o) })) : [],
  };
}
async function api(path, body, raw = false) {
  const r = await fetch(path, body === undefined ? {} : { method: 'POST', body: body instanceof Blob ? body : JSON.stringify(body) });
  if (!r.ok) { let m = r.statusText; try { m = (await r.json()).error; } catch (_) {} throw new Error(m); }
  return raw ? r : r.json();
}
function scheduleParams() { clearTimeout(paramsTimer); paramsTimer = setTimeout(updateParams, 200); }
async function updateParams() {
  $('gridInfo').textContent = `Δx = ${fmt(dxmm(), 2)} mm  ·  셀 ${(S.N * S.N).toLocaleString()}개`;
  try {
    const p = await api('/api/params', buildCase(false));
    $('params').innerHTML = [
      ['Δx', `${fmt(p.dx * 1000, 3)} mm`], ['Δt', `${fmt(p.dt * 1000, 4)} ms`],
      ['τ₀', fmt(p.tau0, 5)], ['ν_lat', fmt(p.nu_lat, 3)],
      ['U_max', `${fmt(p.u_max, 3)} m/s`], ['Re_L', fmt(p.Re_L, 0)],
      ['스텝 수', p.steps.toLocaleString()], ['GIF 간격', `${Math.max(1, Math.floor(p.steps / S.frames))} step`],
    ].map(([k, v]) => `<b>${k}</b><span>${v}</span>`).join('');
    $('warns').innerHTML = p.warnings.map((w) => `<div class="warn">${w}</div>`).join('');
  } catch (e) { $('warns').innerHTML = `<div class="warn">${e.message}</div>`; }
}
async function fetchMask() {
  try {
    const r = await api('/api/mask', buildCase(), true);
    const N = +r.headers.get('X-N'), buf = new Uint8Array(await r.arrayBuffer());
    const off = document.createElement('canvas'); off.width = N; off.height = N;
    const c = off.getContext('2d'), img = c.createImageData(N, N);
    for (let iy = 0; iy < N; iy++) {
      const row = (N - 1 - iy) * N;
      for (let ix = 0; ix < N; ix++) {
        const col = FLAG_RGBA[buf[iy * N + ix]];
        if (!col) continue;
        const k = (row + ix) * 4;
        img.data[k] = col[0]; img.data[k + 1] = col[1]; img.data[k + 2] = col[2]; img.data[k + 3] = col[3];
      }
    }
    c.putImageData(img, 0, 0);
    maskImg = off; draw();
  } catch (e) { toast(`복셀 생성 실패: ${e.message}`); }
}
async function fetchFrame() {
  const r = await fetch(`/api/frame?field=${S.field}`);
  if (r.status !== 200) return;
  const q = new Uint8Array(await r.arrayBuffer()), N = +r.headers.get('X-N');
  const lo = +r.headers.get('X-Lo'), hi = +r.headers.get('X-Hi');
  const lut = luts[S.field];
  const off = resultCanvas && resultCanvas.width === N ? resultCanvas : Object.assign(document.createElement('canvas'), { width: N, height: N });
  const c = off.getContext('2d'), img = c.createImageData(N, N);
  for (let iy = 0; iy < N; iy++) {
    const row = (N - 1 - iy) * N;
    for (let ix = 0; ix < N; ix++) {
      const v = q[iy * N + ix], k = (row + ix) * 4;
      const col = v === 255 ? [90, 90, 96] : lut[Math.min(v, 252)];
      img.data[k] = col[0]; img.data[k + 1] = col[1]; img.data[k + 2] = col[2]; img.data[k + 3] = 255;
    }
  }
  c.putImageData(img, 0, 0);
  resultCanvas = off;
  resultInfo = { N, lo, hi, q, field: S.field, t: +r.headers.get('X-Time') };
  updateLegend();
  draw();
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

async function poll() {
  status = await api('/api/status');
  updateStatusUI();
  if (S.view === 'result' && status.state !== 'building') await fetchFrame();
  if (!locked()) stopPolling();
}
function startPolling() {
  if (polling) return;
  polling = setInterval(() => { if (pollBusy) return; pollBusy = true; poll().catch(() => {}).finally(() => { pollBusy = false; }); }, 350);
}
function stopPolling() { clearInterval(polling); polling = null; }
function updateStatusUI() {
  const st = status.state || 'idle';
  const b = $('stateBadge'); b.className = `badge ${st}`; b.textContent = STATE_KO[st] || st;
  const steps = status.steps || 0, step = status.step || 0;
  $('progBar').style.width = steps ? `${(100 * step / steps).toFixed(1)}%` : '0%';
  let txt = status.message || '–';
  if (steps) {
    const T = status.prm ? steps * status.prm.dt : 0;
    const eta = status.sps ? (steps - step) / status.sps : 0;
    txt = `t ${(status.t || 0).toFixed(2)} / ${T.toFixed(2)} s · step ${step.toLocaleString()} / ${steps.toLocaleString()}`;
    if (status.sps) txt += ` · ${status.sps.toFixed(0)} step/s · ${(status.sps * S.N * S.N / 1e6).toFixed(1)} MLUPS`;
    if (st === 'running' && eta) txt += ` · 남은 시간 ${eta > 90 ? (eta / 60).toFixed(1) + '분' : eta.toFixed(0) + '초'}`;
    if (status.message) txt += ` · ${status.message}`;
  }
  $('progText').textContent = txt;
  const busy = locked();
  $('btnRun').disabled = busy;
  $('btnPause').disabled = !['running', 'paused'].includes(st);
  $('btnPause').textContent = st === 'paused' ? '재개' : '일시정지';
  $('btnStop').disabled = !busy;
  $('btnGif').disabled = busy || !(status.frames > 0);
  for (const id of ['inL', 'inN', 'inPreset', 'inNu', 'inRho', 'inLes', 'inCs', 'inDur', 'inRamp', 'inFrames', 'inUlat', 'inSponge',
    'obX', 'obY', 'obR', 'obS', 'obDel', 'paEdge', 'paS0', 'paS1', 'paDel', 'btnSamples', 'btnMask', 'selExample']) $(id).disabled = busy;
  $('fileDxf').disabled = busy;
  if (busy !== updateStatusUI.lastBusy) { updateStatusUI.lastBusy = busy; renderEdgeRows(); renderPatchEditor(); }
}
async function run() {
  try {
    if (!Object.values(S.edges).some((b) => ['pressure', 'outflow'].includes(b.type)) && !S.patches.some((p) => ['pressure', 'outflow'].includes(p.type)))
      toast('압력/유출 경계가 없으면 질량이 누적될 수 있습니다.');
    await api('/api/run', buildCase());
    status = { state: 'building' }; updateStatusUI();
    setView('result');
    $('gifBox').classList.add('hidden');
    startPolling();
  } catch (e) { toast(`실행 실패: ${e.message}`); }
}
async function makeGif() {
  const btn = $('btnGif'); btn.disabled = true; btn.textContent = 'GIF 생성 중…';
  try {
    const r = await api('/api/gif', { field: S.field, fps: +$('inFps').value, scale: +$('inGifScale').value }, true);
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
  for (const [id, key] of [['inL', 'L'], ['inN', 'N'], ['inDur', 'duration'], ['inRamp', 'ramp'], ['inFrames', 'frames'], ['inUlat', 'ulat'], ['inSponge', 'sponge']]) $(id).value = S[key];
  $('inPreset').value = S.preset; $('inNu').value = S.nu; $('inRho').value = S.rho; $('inLes').checked = S.les; $('inCs').value = S.cs;
}
function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toast.timer); toast.timer = setTimeout(() => t.classList.add('hidden'), 3200);
}

function init() {
  bindNumber('inL', 'L', () => { S.L = Math.max(S.L, 10); resultCanvas = null; });
  bindNumber('inN', 'N', () => { S.N = Math.round(clamp(S.N, 20, 2000)); $('inN').value = S.N; resultCanvas = null; });
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
  const objField = (id, key, f = (v) => v) => { $(id).onchange = () => { const o = selObj(); if (!o) return; o[key] = f(+$(id).value); changed(); }; };
  objField('obX', 'cx'); objField('obY', 'cy'); objField('obR', 'rot', (v) => ((v % 360) + 360) % 360); objField('obS', 'scale', (v) => Math.max(v, 0.01));
  $('obDel').onclick = deleteSelected;
  $('paEdge').onchange = () => { const p = selPatch(); if (p) { p.edge = $('paEdge').value; changed(); renderPatchEditor(); } };
  $('paS0').onchange = () => { const p = selPatch(); if (p) { p.s0 = clamp(+$('paS0').value, 0, S.L); changed(); } };
  $('paS1').onchange = () => { const p = selPatch(); if (p) { p.s1 = clamp(+$('paS1').value, 0, S.L); changed(); } };
  $('paDel').onclick = deleteSelected;

  $('btnMask').onclick = () => { S.showMask = true; $('chkMask').checked = true; setView('edit'); fetchMask(); };
  $('chkMask').onchange = () => { S.showMask = $('chkMask').checked; if (S.showMask) fetchMask(); else draw(); };
  $('chkGrid').onchange = () => { S.showGrid = $('chkGrid').checked; draw(); };
  $('btnFit').onclick = () => { S.zoom = 1; S.panX = 0; S.panY = 0; draw(); };
  for (const b of $('viewSeg').querySelectorAll('button')) b.onclick = () => setView(b.dataset.view);
  $('inField').onchange = () => { S.field = $('inField').value; if (status.state !== 'idle') fetchFrame().catch(() => {}); };

  $('btnRun').onclick = run;
  $('btnStop').onclick = () => api('/api/stop', {}).catch(() => {});
  $('btnPause').onclick = () => api('/api/pause', {}).then(() => poll()).catch(() => {});
  $('btnGif').onclick = makeGif;

  $('btnSaveCase').onclick = () => {
    const keys = ['L', 'N', 'preset', 'nu', 'rho', 'les', 'cs', 'duration', 'ramp', 'frames', 'ulat', 'sponge', 'edges', 'patches', 'objects'];
    const data = JSON.stringify(Object.fromEntries(keys.map((k) => [k, S[k]])), null, 1);
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([data], { type: 'application/json' })), download: 'lbm_case.json' });
    a.click();
  };
  const applyCase = (data, label) => {
    if (locked()) { toast('해석 중에는 케이스를 바꿀 수 없습니다.'); return; }
    Object.assign(S, data);
    uid = 1 + Math.max(0, ...S.objects.map((o) => o.id), ...S.patches.map((p) => p.id));
    resultCanvas = null; S.zoom = 1; S.panX = 0; S.panY = 0;
    $('gifBox').classList.add('hidden');
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

  window.addEventListener('resize', resize);
  renderEdgeRows(); renderObjList(); renderPatchList();
  api('/api/colormaps').then((m) => { luts = m; });
  api('/api/status').then((st) => { status = st; updateStatusUI(); if (locked()) { setView('result'); startPolling(); } });
  resize(); updateParams();
}
init();
