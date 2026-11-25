import { argbColor, eventColor, type CanvasTheme } from '../model/colors';
import { fmtTick, niceStep } from '../model/format';
import type { CounterTrack, EventTrack } from '../model/types';

export interface ViewWindow {
  t0: number;
  t1: number;
  /** Canvas width in CSS pixels. */
  w: number;
}

export const FONT = '11px "Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';
export const FONT_MONO = '10.5px ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace';

/** First position k in [a, b) whose event end is > t (ends are non-decreasing within a row). */
export function firstEndAfter(end: Float64Array, idx: Int32Array | null, a: number, b: number, t: number): number {
  let lo = a;
  let hi = b;
  if (idx) {
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (end[idx[mid]] > t) hi = mid;
      else lo = mid + 1;
    }
  } else {
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (end[mid] > t) hi = mid;
      else lo = mid + 1;
    }
  }
  return lo;
}

const colorKeyCache = new Map<number, string>();
export function resetColorCache() {
  colorKeyCache.clear();
}

export function colorOf(t: EventTrack, i: number, strings: string[]): string {
  if (t.color) {
    const c = t.color[i];
    if (c) return argbColor(c);
  }
  const key = t.kind[i] * 0x4000000 + t.name[i];
  let c = colorKeyCache.get(key);
  if (!c) {
    c = eventColor(t.kind[i], strings[t.name[i]]);
    colorKeyCache.set(key, c);
  }
  return c;
}

/** Width cache for event labels, keyed by string index. */
export class TextMeasure {
  private w = new Map<number, number>();
  private font = '';
  measure(ctx: CanvasRenderingContext2D, idx: number, s: string): number {
    if (ctx.font !== this.font) {
      this.font = ctx.font;
      this.w.clear();
    }
    let v = this.w.get(idx);
    if (v === undefined) {
      v = ctx.measureText(s).width;
      this.w.set(idx, v);
    }
    return v;
  }
}

export interface RowDrawOpts {
  strings: string[];
  theme: CanvasTheme;
  labels: boolean;
  useAlt: boolean;
  alpha: number;
  measure: TextMeasure;
  /** Vertical clip in canvas coords. */
  clipTop: number;
  clipBottom: number;
}

/**
 * Draw an event track. Events narrower than a pixel are merged into one 1-px column whose
 * opacity reflects how busy that pixel is, so cost is bounded by pixels, not events.
 */
export function drawEventTrack(
  ctx: CanvasRenderingContext2D,
  t: EventTrack,
  y0: number,
  rowH: number,
  pad: number,
  view: ViewWindow,
  o: RowDrawOpts,
  subset: { idx: Int32Array; rowOffsets: Int32Array; cum: Float64Array } | null,
) {
  const { t0, t1, w } = view;
  const scale = w / (t1 - t0);
  const idx = subset ? subset.idx : null;
  const ro = subset ? subset.rowOffsets : t.rowOffsets;
  const cum = subset ? subset.cum : t.cum;
  const { start, end } = t;
  const names = o.useAlt && t.alt ? t.alt : t.name;
  const h = rowH - 2;
  const labelQ: number[] = [];

  for (let d = 0; d < t.rows; d++) {
    const y = y0 + pad + d * rowH;
    if (y > o.clipBottom || y + rowH < o.clipTop) continue;
    const a = ro[d];
    const b = ro[d + 1];
    if (a === b) continue;
    let k = firstEndAfter(end, idx, a, b, t0);
    let lastColor = '';
    let lastAlpha = -1;
    labelQ.length = 0;
    while (k < b) {
      const i = idx ? idx[k] : k;
      const s = start[i];
      if (s >= t1) break;
      const e = end[i];
      const x0 = (s - t0) * scale;
      const x1 = (e - t0) * scale;
      const c = colorOf(t, i, o.strings);
      if (c !== lastColor) {
        ctx.fillStyle = c;
        lastColor = c;
      }
      if (x1 - x0 >= 1) {
        if (lastAlpha !== o.alpha) {
          ctx.globalAlpha = o.alpha;
          lastAlpha = o.alpha;
        }
        const xa = x0 < -2 ? -2 : x0;
        const xb = x1 > w + 2 ? w + 2 : x1;
        // leave a hairline gap so back-to-back events stay distinguishable
        ctx.fillRect(xa, y, xb - xa > 4 ? xb - xa - 1 : xb - xa, h);
        if (o.labels && xb - xa > 34) labelQ.push(i, xa, xb);
        k++;
      } else {
        const px = Math.floor(x0);
        const tEdge = t0 + (px + 1) / scale;
        let k2 = firstEndAfter(end, idx, k, b, tEdge);
        if (k2 <= k) k2 = k + 1;
        const cov = (cum[k2] - cum[k]) * scale;
        const al = o.alpha * (0.5 + 0.5 * (cov > 1 ? 1 : cov));
        if (al !== lastAlpha) {
          ctx.globalAlpha = al;
          lastAlpha = al;
        }
        ctx.fillRect(px, y, 1, h);
        k = k2;
      }
    }
    if (labelQ.length) {
      ctx.globalAlpha = o.alpha;
      lastAlpha = o.alpha;
      ctx.fillStyle = o.theme.eventText;
      for (let q = 0; q < labelQ.length; q += 3) {
        const i = labelQ[q];
        const xa = Math.max(labelQ[q + 1], 0);
        const xb = labelQ[q + 2];
        const avail = xb - xa - 8;
        if (avail < 14) continue;
        const ni = names[i];
        const str = o.strings[ni];
        const full = o.measure.measure(ctx, ni, str);
        let text = str;
        if (full > avail) {
          const chars = Math.floor((str.length * avail) / full) - 1;
          if (chars < 2) continue;
          text = str.slice(0, chars) + '…';
        }
        ctx.fillText(text, xa + 4, y + h / 2 + 0.5);
      }
    }
  }
  ctx.globalAlpha = 1;
}

/**
 * Accumulate busy coverage (fraction of each pixel covered) of rows [r0, r1) into `out`.
 */
export function accumulateCoverage(t: EventTrack, r0: number, r1: number, view: ViewWindow, out: Float32Array) {
  const { t0, t1, w } = view;
  const scale = w / (t1 - t0);
  const { start, end, cum } = t;
  for (let d = r0; d < r1 && d < t.rows; d++) {
    const a = t.rowOffsets[d];
    const b = t.rowOffsets[d + 1];
    let i = firstEndAfter(end, null, a, b, t0);
    while (i < b) {
      const s = start[i];
      if (s >= t1) break;
      const x0 = (s - t0) * scale;
      const x1 = (end[i] - t0) * scale;
      if (x1 - x0 >= 1) {
        const c0 = x0 < 0 ? 0 : x0;
        const c1 = x1 > w ? w : x1;
        for (let px = Math.floor(c0); px < c1; px++) {
          const ov = Math.min(px + 1, c1) - Math.max(px, c0);
          if (ov > 0) out[px] += ov;
        }
        i++;
      } else {
        const px = Math.floor(x0);
        const tEdge = t0 + (px + 1) / scale;
        let j = firstEndAfter(end, null, i, b, tEdge);
        if (j <= i) j = i + 1;
        if (px >= 0 && px < w) out[px] += (cum[j] - cum[i]) * scale;
        i = j;
      }
    }
  }
}

/** Area chart of a coverage buffer (values clamped to [0, 1]). */
export function drawCoverage(
  ctx: CanvasRenderingContext2D,
  cov: Float32Array,
  w: number,
  y: number,
  h: number,
  color: string,
  norm = 1,
) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(0, y + h);
  for (let px = 0; px < w; px++) {
    let v = cov[px] / norm;
    if (v > 1) v = 1;
    const yy = y + h - v * h;
    ctx.lineTo(px, yy);
    ctx.lineTo(px + 1, yy);
  }
  ctx.lineTo(w, y + h);
  ctx.closePath();
  ctx.fill();
}

/** Step-area chart of a counter track; zoomed-out pixels show the max of their samples. */
export function drawCounter(
  ctx: CanvasRenderingContext2D,
  c: CounterTrack,
  y: number,
  h: number,
  view: ViewWindow,
  theme: CanvasTheme,
) {
  const { t0, t1, w } = view;
  const scale = w / (t1 - t0);
  const { t, v } = c;
  const n = t.length;
  if (!n) return;
  const top = y + 4;
  const H = h - 7;
  const base = top + H;
  const maxV = c.max || 1;
  // last sample at or before t0
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (t[mid] <= t0) lo = mid + 1;
    else hi = mid;
  }
  let i = Math.max(0, lo - 1);
  ctx.beginPath();
  ctx.moveTo(Math.max(0, (t[i] - t0) * scale), base);
  let lastX = 0;
  while (i < n && t[i] < t1) {
    const x0 = Math.max(0, (t[i] - t0) * scale);
    const nextT = i + 1 < n ? t[i + 1] : t[i] + (i > 0 ? t[i] - t[i - 1] : 1);
    const x1 = Math.min(w, (nextT - t0) * scale);
    if (x1 - x0 >= 1) {
      const yy = base - (v[i] / maxV) * H;
      ctx.lineTo(x0, yy);
      ctx.lineTo(x1, yy);
      lastX = x1;
      i++;
    } else {
      const px = Math.floor(x0);
      let m = v[i];
      let j = i + 1;
      while (j < n && (t[j] - t0) * scale < px + 1) {
        if (v[j] > m) m = v[j];
        j++;
      }
      const yy = base - (m / maxV) * H;
      ctx.lineTo(px, yy);
      ctx.lineTo(px + 1, yy);
      lastX = px + 1;
      i = j;
    }
  }
  ctx.lineTo(lastX, base);
  ctx.closePath();
  ctx.fillStyle = theme.counterFill;
  ctx.fill();
  ctx.strokeStyle = theme.counter;
  ctx.lineWidth = 1;
  ctx.stroke();
}

export function counterValueAt(c: CounterTrack, time: number): number | null {
  const { t, v } = c;
  let lo = 0;
  let hi = t.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (t[mid] <= time) lo = mid + 1;
    else hi = mid;
  }
  return lo > 0 ? v[lo - 1] : null;
}

export interface Ticks {
  step: number;
  first: number;
  /** When zoomed far in, labels are shown relative to `base`. */
  base: number | null;
}

export function computeTicks(view: ViewWindow): Ticks {
  const nsPerPx = (view.t1 - view.t0) / view.w;
  const step = niceStep(nsPerPx);
  const first = Math.ceil(view.t0 / step) * step;
  const decimalsNeeded = Math.abs(first) / step;
  const base = decimalsNeeded > 2e5 ? Math.floor(view.t0 / (step * 1000)) * (step * 1000) : null;
  return { step, first, base };
}

export function drawRuler(
  ctx: CanvasRenderingContext2D,
  view: ViewWindow,
  h: number,
  theme: CanvasTheme,
  ticks: Ticks,
  formatBase: (ns: number) => string,
) {
  const { t0, t1, w } = view;
  const scale = w / (t1 - t0);
  ctx.fillStyle = theme.rulerBg;
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = theme.groupLine;
  ctx.beginPath();
  ctx.moveTo(0, h - 0.5);
  ctx.lineTo(w, h - 0.5);
  ctx.stroke();

  ctx.font = FONT_MONO;
  ctx.textBaseline = 'middle';
  const { step, first, base } = ticks;
  const minor = step / 5;
  ctx.strokeStyle = theme.textDim;
  ctx.globalAlpha = 0.5;
  ctx.beginPath();
  for (let tm = Math.ceil(t0 / minor) * minor; tm < t1; tm += minor) {
    const x = Math.round((tm - t0) * scale) + 0.5;
    ctx.moveTo(x, h - 4);
    ctx.lineTo(x, h);
  }
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.beginPath();
  for (let tm = first; tm < t1; tm += step) {
    const x = Math.round((tm - t0) * scale) + 0.5;
    ctx.moveTo(x, h - 9);
    ctx.lineTo(x, h);
  }
  ctx.stroke();
  ctx.fillStyle = theme.textDim;
  for (let tm = first; tm < t1; tm += step) {
    const x = Math.round((tm - t0) * scale);
    const label = base !== null ? '+' + fmtTick(tm - base, step) : fmtTick(tm, step);
    ctx.fillText(label, x + 4, h / 2 - 2);
  }
  if (base !== null) {
    const txt = formatBase(base);
    const tw = ctx.measureText(txt).width + 12;
    ctx.fillStyle = theme.rulerBg;
    ctx.fillRect(0, 0, tw, h - 1);
    ctx.fillStyle = theme.text;
    ctx.fillText(txt, 6, h / 2 - 2);
  }
}

export function drawGrid(ctx: CanvasRenderingContext2D, view: ViewWindow, h: number, theme: CanvasTheme, ticks: Ticks) {
  const scale = view.w / (view.t1 - view.t0);
  ctx.strokeStyle = theme.grid;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let tm = ticks.first; tm < view.t1; tm += ticks.step) {
    const x = Math.round((tm - view.t0) * scale) + 0.5;
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
  }
  ctx.stroke();
}
