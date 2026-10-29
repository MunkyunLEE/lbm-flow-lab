import { GIFEncoder } from '../vendor/gifenc.esm.js';

export const N_DATA = 253;
export const IDX_BLACK = 253, IDX_WHITE = 254, IDX_SOLID = 255;
export const LABELS = { umag: '|u| [m/s]', vort: 'vorticity [1/s]', pressure: 'p [Pa]' };
const LEGEND_SIDES = { umag: ['느림', '빠름'], vort: ['시계방향 −', '반시계방향 +'], pressure: ['저압', '고압'] };
const FONT = '11px "Malgun Gothic", "Apple SD Gothic Neo", "Noto Sans KR", system-ui, sans-serif';

function turbo(x) {
  const r = 0.13572138 + x * (4.6153926 + x * (-42.66032258 + x * (132.13108234 + x * (-152.94239396 + x * 59.28637943))));
  const g = 0.09140261 + x * (2.19418839 + x * (4.84296658 + x * (-14.18503333 + x * (4.27729857 + x * 2.82956604))));
  const b = 0.1066733 + x * (12.64194608 + x * (-60.58204836 + x * (110.36276771 + x * (-89.90310912 + x * 27.34824973))));
  return [r, g, b].map((v) => Math.min(1, Math.max(0, v)));
}

function diverging(x) {
  const lo = [0.23, 0.3, 0.75], mid = [0.95, 0.95, 0.95], hi = [0.71, 0.02, 0.15];
  return x < 0.5 ? lo.map((v, i) => v + (mid[i] - v) * (x / 0.5)) : mid.map((v, i) => v + (hi[i] - v) * ((x - 0.5) / 0.5));
}

export function lut(name) {
  const out = [];
  for (let k = 0; k < N_DATA; k++) {
    const x = k / (N_DATA - 1), c = name === 'umag' ? turbo(x) : diverging(x);
    out.push(c.map((v) => Math.round(v * 255)));
  }
  return out;
}

export function palette(name) {
  return [...lut(name), [20, 20, 20], [250, 250, 250], [90, 90, 96]];
}

function percentile(values, q) {
  const n = values.length;
  if (!n) return 0;
  const stride = Math.max(1, Math.ceil(n / 65536)), m = Math.ceil(n / stride), a = new Float32Array(m);
  for (let i = 0, j = 0; i < n; i += stride) a[j++] = values[i];
  a.sort();
  const pos = q / 100 * (m - 1), lo = Math.floor(pos), hi = Math.min(lo + 1, m - 1);
  return a[lo] + (a[hi] - a[lo]) * (pos - lo);
}

export function autoRange(name, values) {
  if (name === 'umag') return [0, Math.max(percentile(values, 99.7), 1e-9)];
  const abs = new Float32Array(values.length);
  for (let i = 0; i < values.length; i++) abs[i] = Math.abs(values[i]);
  const m = Math.max(percentile(abs, 99.0), 1e-9);
  return [-m, m];
}

export function quantize(arr, solid, lo, hi) {
  const q = new Uint8Array(arr.length), s = (N_DATA - 1) / (hi - lo + 1e-30);
  for (let k = 0; k < arr.length; k++) {
    if (solid[k]) { q[k] = IDX_SOLID; continue; }
    const v = (arr[k] - lo) * s;
    q[k] = v <= 0 ? 0 : v >= N_DATA - 1 ? N_DATA - 1 : Math.trunc(v);
  }
  return q;
}

function textMask(w, h, draw) {
  if (typeof OffscreenCanvas === 'undefined') return null;
  const cv = new OffscreenCanvas(w, h), ctx = cv.getContext('2d');
  ctx.font = FONT;
  ctx.textBaseline = 'top';
  ctx.fillStyle = '#000';
  draw(ctx);
  const d = ctx.getImageData(0, 0, w, h).data, m = new Uint8Array(w * h);
  for (let i = 0; i < m.length; i++) m[i] = d[4 * i + 3] > 110 ? 1 : 0;
  return m;
}

function textWidth(text) {
  if (typeof OffscreenCanvas === 'undefined') return text.length * 7;
  const ctx = new OffscreenCanvas(1, 1).getContext('2d');
  ctx.font = FONT;
  return ctx.measureText(text).width;
}

function legendLayer(name, lo, hi, W, H) {
  const pad = 6, [l0, r0] = LEGEND_SIDES[name];
  const bw = Math.max(120, Math.ceil(textWidth(l0) + textWidth(r0)) + 14);
  const boxW = bw + 2 * pad, boxH = 50, x0 = W - boxW - 6, y0 = H - boxH - 6;
  if (x0 < 0 || y0 < 0) return null;
  const idx = new Int16Array(boxW * boxH).fill(IDX_WHITE);
  for (let x = 0; x < boxW; x++) { idx[x] = IDX_BLACK; idx[(boxH - 1) * boxW + x] = IDX_BLACK; }
  for (let y = 0; y < boxH; y++) { idx[y * boxW] = IDX_BLACK; idx[y * boxW + boxW - 1] = IDX_BLACK; }
  for (let i = 0; i < bw; i++) {
    const c = Math.round(i / (bw - 1) * (N_DATA - 1));
    for (let j = 0; j < 8; j++) idx[(pad + j) * boxW + pad + i] = c;
  }
  const [left, right] = LEGEND_SIDES[name];
  const fmt = (v) => Number(v.toPrecision(3)).toString();
  const mask = textMask(boxW, boxH, (ctx) => {
    ctx.fillText(fmt(lo), pad, pad + 10);
    ctx.textAlign = 'right';
    ctx.fillText(fmt(hi), boxW - pad, pad + 10);
    ctx.fillText(right, boxW - pad, pad + 24);
    ctx.textAlign = 'left';
    ctx.fillText(left, pad, pad + 24);
  });
  if (mask) for (let i = 0; i < mask.length; i++) if (mask[i] && idx[i] === IDX_WHITE) idx[i] = IDX_BLACK;
  return { idx, x0, y0, boxW, boxH };
}

export function makeGif(name, frames, solid, N, fps = 15, scale = 1) {
  const step = Math.max(Math.floor(frames.length / 20), 1), pool = [];
  for (let i = 0; i < frames.length; i += step) pool.push(frames[i].field);
  const all = new Float32Array(pool.length * N * N);
  pool.forEach((a, i) => all.set(a, i * N * N));
  const [lo, hi] = autoRange(name, all);
  const pal = palette(name), w = N * scale, h = N * scale, head = 22, H = h + head;
  const legend = legendLayer(name, lo, hi, w, H);
  const gif = GIFEncoder();
  const delay = Math.max(Math.trunc(1000 / fps), 20);
  frames.forEach(({ t, field }, fi) => {
    const q = quantize(field, solid, lo, hi), idx = new Uint8Array(w * H).fill(IDX_WHITE);
    for (let r = 0; r < h; r++) {
      const src = (N - 1 - Math.floor(r / scale)) * N, dst = (head + r) * w;
      for (let c = 0; c < w; c++) idx[dst + c] = q[src + Math.floor(c / scale)];
    }
    const mask = textMask(w, head, (ctx) => ctx.fillText(`t = ${t.toFixed(2).padStart(7)} s   ${LABELS[name]}`, 6, 5));
    if (mask) for (let i = 0; i < mask.length; i++) if (mask[i]) idx[i] = IDX_BLACK;
    if (legend) {
      for (let y = 0; y < legend.boxH; y++) for (let x = 0; x < legend.boxW; x++) {
        idx[(legend.y0 + y) * w + legend.x0 + x] = legend.idx[y * legend.boxW + x];
      }
    }
    gif.writeFrame(idx, w, H, fi === 0 ? { palette: pal, delay, repeat: 0 } : { delay });
  });
  gif.finish();
  return gif.bytes();
}
