import { ChevronRight, Cpu, Gauge, Layers } from 'lucide-react';
import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef } from 'react';
import type { CanvasTheme } from '../model/colors';
import type { FilterIndex } from '../model/filter';
import { escapeHtml, fmtBytes, fmtCompact, fmtDur, fmtRate, fmtTime } from '../model/format';
import { GROUP_H, TRACK_PAD, tracksUnder, type Layout, type LayoutItem } from '../model/layout';
import { depthOf } from '../model/stats';
import { KIND_LABEL, Kind, type CounterTrack, type EventRef, type EventTrack, type ProfileData, type TimeRange, type Track } from '../model/types';
import {
  accumulateCoverage,
  computeTicks,
  counterValueAt,
  drawCounter,
  drawCoverage,
  drawEventTrack,
  drawGrid,
  drawRuler,
  firstEndAfter,
  FONT,
  FONT_MONO,
  TextMeasure,
  type ViewWindow,
} from './draw';

export interface TimelineHandle {
  zoomTo: (t0: number, t1: number) => void;
  reveal: (ref: EventRef, zoom?: boolean) => void;
  fitAll: () => void;
  zoomToSelection: () => void;
  getView: () => TimeRange;
}

interface Props {
  data: ProfileData;
  layout: Layout;
  theme: CanvasTheme;
  collapsed: Set<string>;
  onToggle: (gid: string) => void;
  onExpandTo: (trackId: number) => void;
  selection: EventRef | null;
  onSelect: (ref: EventRef | null) => void;
  range: TimeRange | null;
  onRange: (r: TimeRange | null) => void;
  filter: FilterIndex | null;
  useAlt: boolean;
  partners: EventRef[];
  labelWidth: number;
  onLabelWidth: (w: number) => void;
  onViewChange?: (v: TimeRange) => void;
}

const MINIMAP_H = 36;
const RULER_H = 26;
const MIN_SPAN = 50; // ns
const MINIMAP_BINS = 1200;

type Drag =
  | { mode: 'pending'; x: number; y: number; t: number; pan: boolean; scrollTop: number; t0: number; t1: number }
  | { mode: 'range'; t: number }
  | { mode: 'pan'; x: number; y: number; scrollTop: number; t0: number; t1: number }
  | { mode: 'minimap'; offset: number }
  | { mode: 'ruler'; t: number };

function isTyping(e: KeyboardEvent) {
  const el = e.target as HTMLElement | null;
  if (!el) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable;
}

export const Timeline = memo(
  forwardRef<TimelineHandle, Props>(function Timeline(props, ref) {
    const { data, layout, labelWidth } = props;
    const P = useRef(props);
    P.current = props;

    const scrollRef = useRef<HTMLDivElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const colRef = useRef<HTMLDivElement>(null);
    const rulerRef = useRef<HTMLCanvasElement>(null);
    const miniRef = useRef<HTMLCanvasElement>(null);
    const tipRef = useRef<HTMLDivElement>(null);
    const rootRef = useRef<HTMLDivElement>(null);

    const span0 = Math.max(1000, data.maxTime - data.minTime);
    const fullView = useMemo(
      () => ({ t0: data.minTime - span0 * 0.015, t1: data.maxTime + span0 * 0.015 }),
      [data, span0],
    );
    const view = useRef<TimeRange>({ ...fullView });
    const size = useRef({ w: 800, h: 400, dpr: 1 });
    const hover = useRef<{ x: number; y: number; inside: boolean; ref: EventRef | null }>({
      x: 0,
      y: 0,
      inside: false,
      ref: null,
    });
    const drag = useRef<Drag | null>(null);
    const liveRange = useRef<TimeRange | null>(null);
    const raf = useRef(0);
    const measure = useRef(new TextMeasure());
    const keys = useRef(new Set<string>());
    const keyRaf = useRef(0);
    const spaceDown = useRef(false);
    const pendingReveal = useRef<EventRef | null>(null);

    // Tracks used for each group's activity summary
    const groupCover = useMemo(() => {
      const m = new Map<string, Array<{ t: EventTrack; rows: number }>>();
      for (const gid of Object.keys(data.groups)) {
        const all = tracksUnder(data, gid).filter((t): t is EventTrack => t.type === 'events');
        const gpu = all.filter((t) => t.role === 'gpu');
        const api = all.filter((t) => t.role === 'api' || t.role === 'lib');
        const pick = gpu.length ? gpu : api.length ? api : all.filter((t) => t.role !== 'nvtx');
        m.set(
          gid,
          (pick.length ? pick : all).map((t) => ({ t, rows: t.role === 'gpu' ? t.rows : 1 })),
        );
      }
      return m;
    }, [data]);

    // Representative counter drawn in a metrics group's header (e.g. "SMs Active")
    const groupCounter = useMemo(() => {
      const m = new Map<string, CounterTrack>();
      for (const g of Object.values(data.groups)) {
        if (g.kind !== 'metrics') continue;
        const cs = g.children
          .map((c) => ('track' in c ? data.tracks[c.track] : null))
          .filter((t): t is CounterTrack => !!t && t.type === 'counter');
        const pick = cs.find((c) => /SMs? Active/i.test(c.label)) ?? cs.find((c) => c.isPercent) ?? cs[0];
        if (pick) m.set(g.id, pick);
      }
      return m;
    }, [data]);

    // Whole-profile activity for the minimap
    const minimap = useMemo(() => {
      const ev = data.tracks.filter((t): t is EventTrack => t.type === 'events');
      const gpu = ev.filter((t) => t.role === 'gpu');
      const v: ViewWindow = { t0: fullView.t0, t1: fullView.t1, w: MINIMAP_BINS };
      const out = new Float32Array(MINIMAP_BINS);
      if (gpu.length) {
        const devs = [...new Set(gpu.map((t) => t.deviceId))];
        for (const d of devs) {
          const tmp = new Float32Array(MINIMAP_BINS);
          for (const t of gpu.filter((x) => x.deviceId === d)) accumulateCoverage(t, 0, t.rows, v, tmp);
          for (let i = 0; i < MINIMAP_BINS; i++) out[i] += Math.min(1, tmp[i]) / devs.length;
        }
      } else {
        const api = ev.filter((t) => t.role === 'api');
        const src = api.length ? api : ev;
        for (const t of src) accumulateCoverage(t, 0, 1, v, out);
        let mx = 0;
        for (let i = 0; i < MINIMAP_BINS; i++) mx = Math.max(mx, out[i]);
        if (mx > 0) for (let i = 0; i < MINIMAP_BINS; i++) out[i] /= mx;
      }
      return { cov: out, gpu: gpu.length > 0 };
    }, [data, fullView]);

    // ------------------------------------------------------------------------
    // Geometry helpers

    const scrollTop = () => scrollRef.current?.scrollTop ?? 0;
    const timeAt = (x: number) => {
      const v = view.current;
      return v.t0 + (x / size.current.w) * (v.t1 - v.t0);
    };
    const xAt = (t: number) => {
      const v = view.current;
      return ((t - v.t0) / (v.t1 - v.t0)) * size.current.w;
    };

    const itemAt = (yAbs: number): LayoutItem | null => {
      const items = P.current.layout.items;
      let lo = 0;
      let hi = items.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const it = items[mid];
        if (yAbs < it.y) hi = mid - 1;
        else if (yAbs >= it.y + it.h) lo = mid + 1;
        else return it;
      }
      return null;
    };

    /** Canvas-space rectangle of an event (or of the collapsed group that hides it). */
    const eventRect = (r: EventRef) => {
      const t = P.current.data.tracks[r.track];
      if (!t || t.type !== 'events') return null;
      const owner = P.current.layout.ownerOf(r.track);
      if (!owner) return null;
      const st = scrollTop();
      const x0 = xAt(t.start[r.index]);
      const x1 = xAt(t.end[r.index]);
      if (owner.kind === 'group') return { x0, x1, y: owner.y - st + 4, h: GROUP_H - 8, hidden: true };
      const d = depthOf(t, r.index);
      return { x0, x1, y: owner.y - st + TRACK_PAD + d * owner.rowH, h: owner.rowH - 2, hidden: false };
    };

    const hitTest = (x: number, yCanvas: number): { ref: EventRef | null; item: LayoutItem | null } => {
      const yAbs = yCanvas + scrollTop();
      const it = itemAt(yAbs);
      if (!it || it.kind !== 'track' || !it.track || it.track.type !== 'events') return { ref: null, item: it };
      const t = it.track;
      const d = Math.floor((yAbs - it.y - TRACK_PAD) / it.rowH);
      if (d < 0 || d >= t.rows) return { ref: null, item: it };
      const time = timeAt(x);
      const tol = (4 * (view.current.t1 - view.current.t0)) / size.current.w;
      const a = t.rowOffsets[d];
      const b = t.rowOffsets[d + 1];
      let k = firstEndAfter(t.end, null, a, b, time - tol);
      let best = -1;
      let bestDist = Infinity;
      for (let n = 0; k < b && n < 256; k++, n++) {
        const s = t.start[k];
        const e = t.end[k];
        if (s > time + tol) break;
        const dist = time < s ? s - time : time > e ? time - e : 0;
        if (dist < bestDist || (dist === 0 && bestDist === 0 && e - s < t.end[best] - t.start[best])) {
          bestDist = dist;
          best = k;
        }
      }
      return { ref: best >= 0 && bestDist <= tol ? { track: t.id, index: best } : null, item: it };
    };

    // ------------------------------------------------------------------------
    // Drawing

    const draw = useCallback(() => {
      raf.current = 0;
      const p = P.current;
      const th = p.theme;
      const { w, h, dpr } = size.current;
      const v = view.current;
      const vw: ViewWindow = { t0: v.t0, t1: v.t1, w };
      const st = scrollTop();
      const ticks = computeTicks(vw);
      const range = liveRange.current ?? p.range;

      // --- tracks
      const cv = canvasRef.current;
      const ctx = cv?.getContext('2d');
      if (cv && ctx) {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.fillStyle = th.bg;
        ctx.fillRect(0, 0, w, h);
        ctx.font = FONT;
        ctx.textBaseline = 'middle';

        const items = p.layout.items;
        // first visible item
        let lo = 0;
        let hi = items.length;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (items[mid].y + items[mid].h <= st) lo = mid + 1;
          else hi = mid;
        }
        // backgrounds
        for (let i = lo; i < items.length && items[i].y < st + h; i++) {
          const it = items[i];
          const y = it.y - st;
          if (it.kind === 'group') {
            ctx.fillStyle = th.groupBg;
            ctx.fillRect(0, y, w, it.h);
            ctx.fillStyle = th.groupLine;
            ctx.fillRect(0, y + it.h - 1, w, 1);
          } else if (it.odd) {
            ctx.fillStyle = th.trackAlt;
            ctx.fillRect(0, y, w, it.h);
          }
        }
        drawGrid(ctx, vw, h, th, ticks);

        const cov = new Float32Array(w + 2);
        const filt = p.filter;
        for (let i = lo; i < items.length && items[i].y < st + h; i++) {
          const it = items[i];
          const y = it.y - st;
          if (it.kind === 'group') {
            const rep = groupCounter.get(it.group!.id);
            if (rep) {
              drawCounter(ctx, rep, y + 1, it.h - 1, vw, th);
              continue;
            }
            const list = groupCover.get(it.group!.id);
            if (!list || !list.length) continue;
            cov.fill(0);
            for (const { t, rows } of list) accumulateCoverage(t, 0, rows, vw, cov);
            const color = it.group!.kind === 'gpu' ? th.gpuActivity : th.cpuActivity;
            ctx.globalAlpha = p.collapsed.has(it.group!.id) ? 0.85 : 0.55;
            drawCoverage(ctx, cov, w, y + 4, it.h - 8, color);
            ctx.globalAlpha = 1;
            continue;
          }
          const t = it.track!;
          if (t.type === 'counter') {
            drawCounter(ctx, t, y, it.h, vw, th);
            continue;
          }
          const opts = {
            strings: p.data.strings,
            theme: th,
            labels: true,
            useAlt: p.useAlt,
            alpha: 1,
            measure: measure.current,
            clipTop: 0,
            clipBottom: h,
          };
          if (filt) {
            drawEventTrack(ctx, t, y, it.rowH, TRACK_PAD, vw, { ...opts, labels: false, alpha: th.dimAlpha }, null);
            const sub = filt.subsets.get(t.id);
            if (sub) drawEventTrack(ctx, t, y, it.rowH, TRACK_PAD, vw, opts, sub);
          } else {
            drawEventTrack(ctx, t, y, it.rowH, TRACK_PAD, vw, opts, null);
          }
        }

        // range selection
        if (range) {
          const xa = xAt(range.t0);
          const xb = xAt(range.t1);
          ctx.fillStyle = th.rangeFill;
          ctx.fillRect(xa, 0, xb - xa, h);
          ctx.fillStyle = th.rangeEdge;
          ctx.fillRect(Math.round(xa), 0, 1, h);
          ctx.fillRect(Math.round(xb), 0, 1, h);
        }

        // correlation arrows + partner outlines
        const sel = p.selection;
        if (sel) {
          const sr = eventRect(sel);
          const selTrack = p.data.tracks[sel.track] as EventTrack;
          const fromGpu = selTrack?.role === 'gpu';
          ctx.lineWidth = 1.5;
          let drawn = 0;
          for (const pr of p.partners) {
            const r2 = eventRect(pr);
            if (!r2 || !sr) continue;
            if (drawn++ > 60) break;
            ctx.strokeStyle = th.partner;
            ctx.strokeRect(r2.x0 - 1, r2.y - 1, Math.max(3, r2.x1 - r2.x0) + 2, r2.h + 2);
            const api = fromGpu ? r2 : sr;
            const gpu = fromGpu ? sr : r2;
            const ax = Math.max(api.x0, Math.min(api.x1, api.x0 + 2));
            const ay = api.y + api.h;
            const gx = gpu.x0;
            const gy = gpu.y;
            const down = gy > ay;
            const y1 = down ? ay : api.y;
            const y2 = down ? gy : gpu.y + gpu.h;
            const dy = Math.max(30, Math.abs(y2 - y1) * 0.5);
            ctx.strokeStyle = th.flow;
            ctx.beginPath();
            ctx.moveTo(ax, y1);
            ctx.bezierCurveTo(ax, y1 + (down ? dy : -dy), gx, y2 - (down ? dy : -dy), gx, y2);
            ctx.stroke();
            // arrow head
            ctx.fillStyle = th.flow;
            ctx.beginPath();
            const dir = down ? -1 : 1;
            ctx.moveTo(gx, y2);
            ctx.lineTo(gx - 4, y2 + dir * 7);
            ctx.lineTo(gx + 4, y2 + dir * 7);
            ctx.closePath();
            ctx.fill();
          }
          if (sr) {
            ctx.strokeStyle = th.selection;
            ctx.lineWidth = 2;
            const wsel = Math.max(3, sr.x1 - sr.x0);
            ctx.strokeRect(sr.x0 - 1, sr.y - 1, wsel + 2, sr.h + 2);
          }
          ctx.lineWidth = 1;
        }

        // hover line
        if (hover.current.inside && !drag.current) {
          ctx.fillStyle = th.hoverLine;
          ctx.fillRect(Math.round(hover.current.x), 0, 1, h);
        }
      }

      // --- ruler
      const rc = rulerRef.current;
      const rctx = rc?.getContext('2d');
      if (rc && rctx) {
        rctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        drawRuler(rctx, vw, RULER_H, th, ticks, (ns) => fmtTime(ns));
        if (range) {
          const xa = xAt(range.t0);
          const xb = xAt(range.t1);
          rctx.fillStyle = th.rangeFill;
          rctx.fillRect(xa, 0, xb - xa, RULER_H);
          rctx.fillStyle = th.rangeEdge;
          rctx.fillRect(Math.round(xa), 0, 1, RULER_H);
          rctx.fillRect(Math.round(xb), 0, 1, RULER_H);
          const label = fmtDur(range.t1 - range.t0);
          rctx.font = FONT;
          const tw = rctx.measureText(label).width + 12;
          const cx = Math.min(Math.max((xa + xb) / 2, tw / 2 + 2), w - tw / 2 - 2);
          rctx.fillStyle = th.rangeEdge;
          roundRect(rctx, cx - tw / 2, 4, tw, RULER_H - 8, 4);
          rctx.fill();
          rctx.fillStyle = '#fff';
          rctx.textAlign = 'center';
          rctx.fillText(label, cx, RULER_H / 2);
          rctx.textAlign = 'left';
        }
        if (hover.current.inside) {
          const x = hover.current.x;
          const label = fmtTime(timeAt(x));
          rctx.font = FONT_MONO;
          const tw = rctx.measureText(label).width + 10;
          const lx = Math.min(Math.max(x - tw / 2, 0), w - tw);
          rctx.fillStyle = th.text;
          roundRect(rctx, lx, RULER_H - 17, tw, 15, 3);
          rctx.fill();
          rctx.fillStyle = th.bg;
          rctx.fillText(label, lx + 5, RULER_H - 9);
        }
      }

      // --- minimap
      const mc = miniRef.current;
      const mctx = mc?.getContext('2d');
      if (mc && mctx) {
        mctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        mctx.fillStyle = th.minimapBg;
        mctx.fillRect(0, 0, w, MINIMAP_H);
        const full = fullView;
        const fx = (t: number) => ((t - full.t0) / (full.t1 - full.t0)) * w;
        // resample minimap bins to width
        const buf = new Float32Array(w);
        for (let px = 0; px < w; px++) {
          const b0 = Math.floor((px / w) * MINIMAP_BINS);
          const b1 = Math.max(b0 + 1, Math.floor(((px + 1) / w) * MINIMAP_BINS));
          let s = 0;
          for (let b = b0; b < b1; b++) s += minimap.cov[b];
          buf[px] = s / (b1 - b0);
        }
        mctx.globalAlpha = 0.9;
        drawCoverage(mctx, buf, w, 4, MINIMAP_H - 8, minimap.gpu ? th.gpuActivity : th.cpuActivity);
        mctx.globalAlpha = 1;
        if (range) {
          mctx.fillStyle = th.rangeEdge;
          mctx.globalAlpha = 0.35;
          mctx.fillRect(fx(range.t0), 0, Math.max(1, fx(range.t1) - fx(range.t0)), MINIMAP_H);
          mctx.globalAlpha = 1;
        }
        const xa = fx(v.t0);
        const xb = fx(v.t1);
        mctx.fillStyle = th.minimapWindow;
        mctx.fillRect(xa, 0, Math.max(2, xb - xa), MINIMAP_H);
        mctx.strokeStyle = th.textDim;
        mctx.lineWidth = 1;
        mctx.strokeRect(Math.round(xa) + 0.5, 0.5, Math.max(2, Math.round(xb - xa)) - 1, MINIMAP_H - 1);
        // dim outside
        mctx.fillStyle = th.bg;
        mctx.globalAlpha = 0.45;
        mctx.fillRect(0, 0, Math.max(0, xa), MINIMAP_H);
        mctx.fillRect(xb, 0, Math.max(0, w - xb), MINIMAP_H);
        mctx.globalAlpha = 1;
      }
    }, [fullView, groupCover, groupCounter, minimap]);

    const requestDraw = useCallback(() => {
      if (!raf.current) raf.current = requestAnimationFrame(draw);
    }, [draw]);

    const notifyView = useRef(0);
    const setView = useCallback(
      (t0: number, t1: number) => {
        let span = Math.max(MIN_SPAN, t1 - t0);
        const maxSpan = (fullView.t1 - fullView.t0) * 1.5;
        if (span > maxSpan) span = maxSpan;
        const c = (t0 + t1) / 2;
        let a = c - span / 2;
        const lim0 = fullView.t0 - (fullView.t1 - fullView.t0) * 0.25;
        const lim1 = fullView.t1 + (fullView.t1 - fullView.t0) * 0.25;
        if (a < lim0) a = lim0;
        if (a + span > lim1) a = lim1 - span;
        view.current = { t0: a, t1: a + span };
        requestDraw();
        if (P.current.onViewChange) {
          cancelAnimationFrame(notifyView.current);
          notifyView.current = requestAnimationFrame(() => P.current.onViewChange?.(view.current));
        }
      },
      [fullView, requestDraw],
    );

    const zoomAround = useCallback(
      (factor: number, x: number) => {
        const v = view.current;
        const t = timeAt(x);
        setView(t - (t - v.t0) * factor, t + (v.t1 - t) * factor);
      },
      [setView],
    );

    const scrollIntoView = (trackId: number) => {
      const it = P.current.layout.ownerOf(trackId);
      const sc = scrollRef.current;
      if (!it || !sc) return;
      const st = sc.scrollTop;
      const vh = sc.clientHeight;
      if (it.y < st + 8 || it.y + Math.min(it.h, vh * 0.5) > st + vh - 8) {
        sc.scrollTop = Math.max(0, it.y - vh * 0.3);
      }
    };

    const reveal = useCallback(
      (r: EventRef, zoom = true) => {
        const t = P.current.data.tracks[r.track];
        if (!t || t.type !== 'events') return;
        const s = t.start[r.index];
        const e = t.end[r.index];
        const v = view.current;
        if (zoom) {
          const span = Math.max((e - s) / 0.6, 4000);
          const c = (s + e) / 2;
          setView(c - span / 2, c + span / 2);
        } else if (e < v.t0 || s > v.t1) {
          const span = v.t1 - v.t0;
          const c = (s + e) / 2;
          setView(c - span / 2, c + span / 2);
        }
        const owner = P.current.layout.ownerOf(r.track);
        if (owner && owner.kind === 'group') {
          pendingReveal.current = r;
          P.current.onExpandTo(r.track);
        } else scrollIntoView(r.track);
        requestDraw();
      },
      [setView, requestDraw],
    );

    useImperativeHandle(
      ref,
      () => ({
        zoomTo: (t0, t1) => setView(t0, t1),
        reveal,
        fitAll: () => setView(fullView.t0, fullView.t1),
        zoomToSelection: () => {
          const p = P.current;
          if (p.selection) reveal(p.selection, true);
          else if (p.range) {
            const pad = (p.range.t1 - p.range.t0) * 0.04;
            setView(p.range.t0 - pad, p.range.t1 + pad);
          } else setView(fullView.t0, fullView.t1);
        },
        getView: () => ({ ...view.current }),
      }),
      [setView, reveal, fullView],
    );

    // After a layout change (e.g. expanding a group to reveal an event), scroll to it.
    useLayoutEffect(() => {
      if (pendingReveal.current) {
        const r = pendingReveal.current;
        pendingReveal.current = null;
        scrollIntoView(r.track);
      }
      requestDraw();
    });

    // Reset view when a new profile is loaded.
    useEffect(() => {
      view.current = { ...fullView };
      if (scrollRef.current) scrollRef.current.scrollTop = 0;
      requestDraw();
    }, [fullView, requestDraw]);

    // ------------------------------------------------------------------------
    // Sizing

    useLayoutEffect(() => {
      const col = colRef.current;
      const sc = scrollRef.current;
      if (!col || !sc) return;
      const resize = () => {
        const dpr = window.devicePixelRatio || 1;
        const w = Math.max(50, Math.floor(col.clientWidth));
        const h = Math.max(50, Math.floor(sc.clientHeight));
        size.current = { w, h, dpr };
        const setup = (c: HTMLCanvasElement | null, ch: number) => {
          if (!c) return;
          c.width = Math.round(w * dpr);
          c.height = Math.round(ch * dpr);
          c.style.width = `${w}px`;
          c.style.height = `${ch}px`;
        };
        setup(canvasRef.current, h);
        setup(rulerRef.current, RULER_H);
        setup(miniRef.current, MINIMAP_H);
        draw();
      };
      const ro = new ResizeObserver(resize);
      ro.observe(col);
      ro.observe(sc);
      resize();
      return () => ro.disconnect();
    }, [draw, labelWidth]);

    // ------------------------------------------------------------------------
    // Tooltip

    const showTip = (clientX: number, clientY: number, html: string | null) => {
      const tip = tipRef.current;
      const root = rootRef.current;
      if (!tip || !root) return;
      if (!html) {
        tip.style.display = 'none';
        return;
      }
      tip.innerHTML = html;
      tip.style.display = 'block';
      const rb = root.getBoundingClientRect();
      const tw = tip.offsetWidth;
      const tht = tip.offsetHeight;
      let x = clientX - rb.left + 14;
      let y = clientY - rb.top + 16;
      if (x + tw > rb.width - 8) x = clientX - rb.left - tw - 14;
      if (y + tht > rb.height - 8) y = clientY - rb.top - tht - 12;
      tip.style.transform = `translate(${Math.max(4, x)}px, ${Math.max(4, y)}px)`;
    };

    const tipFor = (r: EventRef | null, it: LayoutItem | null, x: number): string | null => {
      const p = P.current;
      if (r) {
        const t = p.data.tracks[r.track] as EventTrack;
        const i = r.index;
        const nm = p.data.strings[t.name[i]];
        const alt = t.alt ? p.data.strings[t.alt[i]] : null;
        const k = t.kind[i];
        const d = t.end[i] - t.start[i];
        const rows: string[] = [];
        rows.push(`<div class="tip-title">${escapeHtml(p.useAlt && alt ? alt : nm)}</div>`);
        if (alt && alt !== nm && !p.useAlt) rows.push(`<div class="tip-sub">${escapeHtml(alt.length > 260 ? alt.slice(0, 260) + '…' : alt)}</div>`);
        const instant = d === 0 && k === Kind.Nvtx;
        rows.push(
          `<div class="tip-grid"><span>${instant ? 'NVTX mark' : KIND_LABEL[k]}</span><span>${escapeHtml(t.label)}</span>` +
            (instant ? '' : `<span>Duration</span><b>${fmtDur(d)}</b>`) +
            `<span>Start</span><span>${fmtTime(t.start[i])}</span>` +
            (t.bytes && t.bytes[i] === t.bytes[i]
              ? `<span>Size</span><span>${fmtBytes(t.bytes[i])}</span>` +
                (k === Kind.Memcpy || k === Kind.Memset ? `<span>Throughput</span><span>${fmtRate(t.bytes[i], d)}</span>` : '')
              : '') +
            `</div>`,
        );
        return rows.join('');
      }
      if (it && it.kind === 'track' && it.track?.type === 'counter') {
        const c = it.track;
        const val = counterValueAt(c, timeAt(x));
        if (val === null) return null;
        return `<div class="tip-title">${escapeHtml(c.label)}</div><div class="tip-grid"><span>Value</span><b>${
          Number.isInteger(val) ? val : val.toFixed(2)
        }${c.unit ? ' ' + escapeHtml(c.unit) : ''}</b><span>At</span><span>${fmtTime(timeAt(x))}</span></div>`;
      }
      return null;
    };

    // ------------------------------------------------------------------------
    // Pointer interactions on the track canvas

    const localXY = (e: { clientX: number; clientY: number }) => {
      const r = canvasRef.current!.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };

    const onPointerDown = (e: React.PointerEvent) => {
      if (e.button !== 0 && e.button !== 1) return;
      const { x, y } = localXY(e);
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      const pan = e.button === 1 || e.altKey || spaceDown.current;
      drag.current = {
        mode: 'pending',
        x,
        y,
        t: timeAt(x),
        pan,
        scrollTop: scrollTop(),
        t0: view.current.t0,
        t1: view.current.t1,
      };
      showTip(0, 0, null);
      e.preventDefault();
    };

    const onPointerMove = (e: React.PointerEvent) => {
      const { x, y } = localXY(e);
      hover.current.x = x;
      hover.current.y = y;
      hover.current.inside = true;
      const dr = drag.current;
      if (dr) {
        if (dr.mode === 'pending' && (Math.abs(x - dr.x) > 3 || Math.abs(y - dr.y) > 3)) {
          drag.current = dr.pan
            ? { mode: 'pan', x: dr.x, y: dr.y, scrollTop: dr.scrollTop, t0: dr.t0, t1: dr.t1 }
            : { mode: 'range', t: dr.t };
        }
        const d2 = drag.current!;
        if (d2.mode === 'range') {
          const t = timeAt(x);
          liveRange.current = { t0: Math.min(d2.t, t), t1: Math.max(d2.t, t) };
        } else if (d2.mode === 'pan') {
          const dt = ((x - d2.x) / size.current.w) * (d2.t1 - d2.t0);
          setView(d2.t0 - dt, d2.t1 - dt);
          if (scrollRef.current) scrollRef.current.scrollTop = d2.scrollTop - (y - d2.y);
        }
        requestDraw();
        return;
      }
      const { ref: r, item } = hitTest(x, y);
      hover.current.ref = r;
      canvasRef.current!.style.cursor = spaceDown.current || e.altKey ? 'grab' : r ? 'pointer' : 'crosshair';
      showTip(e.clientX, e.clientY, tipFor(r, item, x));
      requestDraw();
    };

    const onPointerUp = (e: React.PointerEvent) => {
      const dr = drag.current;
      drag.current = null;
      if (!dr) return;
      const { x, y } = localXY(e);
      if (dr.mode === 'pending') {
        const { ref: r, item } = hitTest(x, y);
        if (r) P.current.onSelect(r);
        else if (item && item.kind === 'group') {
          /* clicking a group header band does nothing */
        } else {
          P.current.onSelect(null);
          P.current.onRange(null);
        }
      } else if (dr.mode === 'range') {
        const r = liveRange.current;
        liveRange.current = null;
        if (r && r.t1 - r.t0 > 0) P.current.onRange(r);
      }
      requestDraw();
    };

    const onDoubleClick = (e: React.MouseEvent) => {
      const { x, y } = localXY(e);
      const { ref: r, item } = hitTest(x, y);
      if (r) reveal(r, true);
      else if (item?.kind === 'group') P.current.onToggle(item.group!.id);
    };

    const onPointerLeave = () => {
      hover.current.inside = false;
      hover.current.ref = null;
      showTip(0, 0, null);
      requestDraw();
    };

    // Wheel: pinch / ⌘ / ctrl → zoom, horizontal → pan, vertical → native scroll
    useEffect(() => {
      const sc = scrollRef.current;
      if (!sc) return;
      const onWheel = (e: WheelEvent) => {
        const mult = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
        const dx = e.deltaX * mult;
        const dy = e.deltaY * mult;
        const r = canvasRef.current?.getBoundingClientRect();
        const x = r ? e.clientX - r.left : size.current.w / 2;
        const overLabels = r ? e.clientX < r.left : false;
        if (e.ctrlKey || e.metaKey || e.altKey) {
          e.preventDefault();
          const factor = Math.exp(dy * (e.ctrlKey && !e.metaKey ? 0.012 : 0.004));
          zoomAround(factor, overLabels ? size.current.w / 2 : x);
          return;
        }
        if (e.shiftKey && Math.abs(dx) < 1) {
          e.preventDefault();
          const v = view.current;
          const dt = (dy / size.current.w) * (v.t1 - v.t0);
          setView(v.t0 + dt, v.t1 + dt);
          return;
        }
        if (Math.abs(dx) > Math.abs(dy)) {
          e.preventDefault();
          const v = view.current;
          const dt = (dx / size.current.w) * (v.t1 - v.t0);
          setView(v.t0 + dt, v.t1 + dt);
        }
      };
      sc.addEventListener('wheel', onWheel, { passive: false });
      // Safari reports trackpad pinch as gesture events rather than ctrl+wheel.
      let lastScale = 1;
      const onGestureStart = (e: Event) => {
        e.preventDefault();
        lastScale = 1;
      };
      const onGestureChange = (e: Event) => {
        e.preventDefault();
        const ge = e as Event & { scale: number; clientX: number };
        const r = canvasRef.current?.getBoundingClientRect();
        const x = r ? ge.clientX - r.left : size.current.w / 2;
        zoomAround(lastScale / ge.scale, x);
        lastScale = ge.scale;
      };
      sc.addEventListener('gesturestart', onGestureStart as EventListener);
      sc.addEventListener('gesturechange', onGestureChange as EventListener);
      const onScroll = () => {
        showTip(0, 0, null);
        requestDraw();
      };
      sc.addEventListener('scroll', onScroll, { passive: true });
      return () => {
        sc.removeEventListener('gesturestart', onGestureStart as EventListener);
        sc.removeEventListener('gesturechange', onGestureChange as EventListener);
        sc.removeEventListener('wheel', onWheel);
        sc.removeEventListener('scroll', onScroll);
      };
    }, [zoomAround, setView, requestDraw]);

    // Keyboard: WASD navigation with smooth animation, arrows to step through events
    useEffect(() => {
      const tick = () => {
        keyRaf.current = 0;
        const k = keys.current;
        if (!k.size) return;
        const v = view.current;
        const span = v.t1 - v.t0;
        const fast = k.has('shift') ? 2.5 : 1;
        const anchor = hover.current.inside ? hover.current.x : size.current.w / 2;
        if (k.has('w')) zoomAround(Math.pow(0.93, fast), anchor);
        if (k.has('s')) zoomAround(Math.pow(1 / 0.93, fast), anchor);
        if (k.has('a')) setView(view.current.t0 - span * 0.02 * fast, view.current.t1 - span * 0.02 * fast);
        if (k.has('d')) setView(view.current.t0 + span * 0.02 * fast, view.current.t1 + span * 0.02 * fast);
        keyRaf.current = requestAnimationFrame(tick);
      };
      const down = (e: KeyboardEvent) => {
        if (isTyping(e) || e.metaKey || e.ctrlKey) return;
        const key = e.key.toLowerCase();
        if (key === ' ') {
          spaceDown.current = true;
          if (canvasRef.current) canvasRef.current.style.cursor = 'grab';
          e.preventDefault();
          return;
        }
        if (e.shiftKey) keys.current.add('shift');
        if (['w', 'a', 's', 'd'].includes(key)) {
          keys.current.add(key);
          if (!keyRaf.current) keyRaf.current = requestAnimationFrame(tick);
          e.preventDefault();
          return;
        }
        const p = P.current;
        if ((key === 'arrowleft' || key === 'arrowright') && p.selection) {
          const t = p.data.tracks[p.selection.track] as EventTrack;
          const d = depthOf(t, p.selection.index);
          const ni = p.selection.index + (key === 'arrowleft' ? -1 : 1);
          if (ni >= t.rowOffsets[d] && ni < t.rowOffsets[d + 1]) {
            const r = { track: t.id, index: ni };
            p.onSelect(r);
            reveal(r, false);
          }
          e.preventDefault();
        }
      };
      const up = (e: KeyboardEvent) => {
        const key = e.key.toLowerCase();
        if (key === ' ') {
          spaceDown.current = false;
          if (canvasRef.current) canvasRef.current.style.cursor = 'crosshair';
        }
        if (key === 'shift') keys.current.delete('shift');
        keys.current.delete(key);
      };
      const blur = () => keys.current.clear();
      window.addEventListener('keydown', down);
      window.addEventListener('keyup', up);
      window.addEventListener('blur', blur);
      return () => {
        window.removeEventListener('keydown', down);
        window.removeEventListener('keyup', up);
        window.removeEventListener('blur', blur);
        cancelAnimationFrame(keyRaf.current);
      };
    }, [zoomAround, setView, reveal]);

    // ------------------------------------------------------------------------
    // Ruler & minimap interactions

    const onRulerDown = (e: React.PointerEvent) => {
      const r = rulerRef.current!.getBoundingClientRect();
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      drag.current = { mode: 'ruler', t: timeAt(e.clientX - r.left) };
    };
    const onRulerMove = (e: React.PointerEvent) => {
      const r = rulerRef.current!.getBoundingClientRect();
      const x = e.clientX - r.left;
      hover.current.x = x;
      hover.current.inside = true;
      const dr = drag.current;
      if (dr && dr.mode === 'ruler') {
        const t = timeAt(x);
        liveRange.current = { t0: Math.min(dr.t, t), t1: Math.max(dr.t, t) };
      }
      requestDraw();
    };
    const onRulerUp = () => {
      const dr = drag.current;
      drag.current = null;
      if (dr && dr.mode === 'ruler') {
        const r = liveRange.current;
        liveRange.current = null;
        const px = r ? xAt(r.t1) - xAt(r.t0) : 0;
        if (r && px > 2) P.current.onRange(r);
        else P.current.onRange(null);
      }
      requestDraw();
    };

    const miniTime = (clientX: number) => {
      const r = miniRef.current!.getBoundingClientRect();
      return fullView.t0 + ((clientX - r.left) / r.width) * (fullView.t1 - fullView.t0);
    };
    const onMiniDown = (e: React.PointerEvent) => {
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      const t = miniTime(e.clientX);
      const v = view.current;
      const span = v.t1 - v.t0;
      if (t >= v.t0 && t <= v.t1) drag.current = { mode: 'minimap', offset: t - v.t0 };
      else {
        setView(t - span / 2, t + span / 2);
        drag.current = { mode: 'minimap', offset: span / 2 };
      }
    };
    const onMiniMove = (e: React.PointerEvent) => {
      const dr = drag.current;
      if (!dr || dr.mode !== 'minimap') return;
      const t = miniTime(e.clientX);
      const v = view.current;
      const span = v.t1 - v.t0;
      setView(t - dr.offset, t - dr.offset + span);
    };
    const onMiniUp = () => {
      drag.current = null;
    };
    const onMiniDouble = () => setView(fullView.t0, fullView.t1);

    // Redraw on any prop change
    useEffect(() => {
      requestDraw();
    }, [props.theme, props.selection, props.range, props.filter, props.useAlt, props.partners, layout, requestDraw]);

    // Label-column resizing
    const onResizeDown = (e: React.PointerEvent) => {
      const startX = e.clientX;
      const startW = labelWidth;
      const move = (ev: PointerEvent) => P.current.onLabelWidth(Math.min(520, Math.max(150, startW + ev.clientX - startX)));
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        document.body.classList.remove('col-resizing');
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      document.body.classList.add('col-resizing');
      e.preventDefault();
    };

    return (
      <div className="tl" ref={rootRef} style={{ ['--label-w' as any]: `${labelWidth}px` }}>
        <div className="tl-top">
          <div className="tl-corner">
            <span className="tl-corner-title">Overview</span>
            <span className="tl-corner-hint">{minimap.gpu ? 'GPU activity' : 'CPU activity'}</span>
          </div>
          <div className="tl-top-right">
            <canvas
              ref={miniRef}
              className="tl-minimap"
              onPointerDown={onMiniDown}
              onPointerMove={onMiniMove}
              onPointerUp={onMiniUp}
              onDoubleClick={onMiniDouble}
            />
          </div>
          <div className="tl-corner tl-corner-ruler" />
          <div className="tl-top-right">
            <canvas
              ref={rulerRef}
              className="tl-ruler"
              onPointerDown={onRulerDown}
              onPointerMove={onRulerMove}
              onPointerUp={onRulerUp}
              onPointerLeave={onPointerLeave}
            />
          </div>
        </div>
        <div className="tl-scroll" ref={scrollRef}>
          <div className="tl-inner" style={{ height: layout.height }}>
            <Labels layout={layout} collapsed={props.collapsed} onToggle={props.onToggle} />
            <div className="tl-canvas-col" ref={colRef}>
              <canvas
                ref={canvasRef}
                className="tl-canvas"
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerLeave={onPointerLeave}
                onDoubleClick={onDoubleClick}
                onContextMenu={(e) => e.preventDefault()}
              />
            </div>
          </div>
        </div>
        <div className="tl-resize" onPointerDown={onResizeDown} />
        <div className="tl-tooltip" ref={tipRef} />
      </div>
    );
  }),
);

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

const GROUP_ICON = { gpu: Layers, process: Cpu, thread: null, metrics: Gauge } as const;

const Labels = memo(function Labels({
  layout,
  collapsed,
  onToggle,
}: {
  layout: Layout;
  collapsed: Set<string>;
  onToggle: (gid: string) => void;
}) {
  return (
    <div className="tl-labels">
      {layout.items.map((it) => {
        if (it.kind === 'group') {
          const g = it.group!;
          const Icon = GROUP_ICON[g.kind];
          const open = !collapsed.has(g.id);
          return (
            <div
              key={'g' + g.id}
              className={`tl-label tl-group tl-group-${g.kind}`}
              style={{ top: it.y, height: it.h, paddingLeft: 6 + it.indent * 14 }}
              onClick={() => onToggle(g.id)}
              title={g.tooltip}
            >
              <ChevronRight size={14} className={`tl-chev ${open ? 'open' : ''}`} />
              {Icon && <Icon size={13} className="tl-gicon" />}
              <span className="tl-name">{g.label}</span>
              {g.sublabel && <span className="tl-sub">{g.sublabel}</span>}
              {g.kind === 'metrics' && !open && <span className="tl-count">{g.children.length} metrics</span>}
            </div>
          );
        }
        const t = it.track!;
        return (
          <div
            key={'t' + t.id}
            className={`tl-label tl-track ${it.odd ? 'odd' : ''}`}
            style={{ top: it.y, height: it.h, paddingLeft: 10 + it.indent * 14 }}
            title={trackTitle(t)}
          >
            <span className="tl-name">{t.label}</span>
            <span className="tl-count">
              {t.type === 'events' ? fmtCompact(t.n) : t.unit || (t.isPercent ? '%' : '')}
            </span>
          </div>
        );
      })}
    </div>
  );
});

function trackTitle(t: Track): string {
  if (t.type === 'counter') return `${t.label}${t.unit ? ` (${t.unit})` : ''}\nMax ${t.max.toFixed(0)}`;
  return `${t.label}\n${t.n.toLocaleString()} events${t.rows > 1 ? ` · ${t.rows} rows` : ''}`;
}
