import { Kind, type EventRef, type EventTrack, type ProfileData, type TimeRange } from './types';

export interface StatRow {
  name: number;
  count: number;
  total: number;
  min: number;
  max: number;
  avg: number;
  std: number;
  bytes: number;
  /** Fraction of the summed time of all rows. */
  share: number;
  /** Longest instance, for "jump to". */
  longest: EventRef;
}

export interface StatResult {
  rows: StatRow[];
  total: number;
  count: number;
}

export function eventTracks(data: ProfileData): EventTrack[] {
  return data.tracks.filter((t): t is EventTrack => t.type === 'events');
}

/** Aggregate events by name for the given kinds, optionally restricted to a time range. */
export function computeStats(
  data: ProfileData,
  kinds: number[],
  opts: { range?: TimeRange | null; useAlt?: boolean } = {},
): StatResult {
  const N = data.strings.length;
  const cnt = new Float64Array(N);
  const tot = new Float64Array(N);
  const sq = new Float64Array(N);
  const mn = new Float64Array(N).fill(Infinity);
  const mx = new Float64Array(N).fill(-Infinity);
  const by = new Float64Array(N);
  const lt = new Int32Array(N).fill(-1);
  const li = new Int32Array(N).fill(-1);
  const want = new Uint8Array(16);
  for (const k of kinds) want[k] = 1;
  const r = opts.range;
  let total = 0;
  let count = 0;

  for (const t of eventTracks(data)) {
    const names = opts.useAlt && t.alt ? t.alt : t.name;
    const { start, end, kind, bytes } = t;
    // Quick check: does the track hold any of the wanted kinds?
    if (t.n === 0 || !want[kind[0]]) {
      let any = false;
      for (let i = 0; i < t.n && !any; i += Math.max(1, (t.n / 64) | 0)) any = !!want[kind[i]];
      if (!any) continue;
    }
    for (let i = 0; i < t.n; i++) {
      if (!want[kind[i]]) continue;
      const s = start[i];
      const e = end[i];
      if (r && (e < r.t0 || s > r.t1)) continue;
      const d = e - s;
      const nm = names[i];
      cnt[nm]++;
      tot[nm] += d;
      sq[nm] += d * d;
      if (d < mn[nm]) mn[nm] = d;
      if (d > mx[nm]) {
        mx[nm] = d;
        lt[nm] = t.id;
        li[nm] = i;
      }
      if (bytes) {
        const b = bytes[i];
        if (b === b) by[nm] += b;
      }
      total += d;
      count++;
    }
  }

  const rows: StatRow[] = [];
  for (let nm = 0; nm < N; nm++) {
    if (!cnt[nm]) continue;
    const c = cnt[nm];
    const avg = tot[nm] / c;
    rows.push({
      name: nm,
      count: c,
      total: tot[nm],
      min: mn[nm],
      max: mx[nm],
      avg,
      std: Math.sqrt(Math.max(0, sq[nm] / c - avg * avg)),
      bytes: by[nm],
      share: total > 0 ? tot[nm] / total : 0,
      longest: { track: lt[nm], index: li[nm] },
    });
  }
  rows.sort((a, b) => b.total - a.total);
  return { rows, total, count };
}

/** Busy fraction of each GPU in a range (union of activity across its streams). */
export function gpuBusy(data: ProfileData, range: TimeRange): Array<{ deviceId: number; busy: number }> {
  const byDev = new Map<number, Array<[number, number]>>();
  for (const t of eventTracks(data)) {
    if (t.role !== 'gpu') continue;
    let arr = byDev.get(t.deviceId);
    if (!arr) byDev.set(t.deviceId, (arr = []));
    for (let i = 0; i < t.n; i++) {
      const s = Math.max(t.start[i], range.t0);
      const e = Math.min(t.end[i], range.t1);
      if (e > s) arr.push([s, e]);
    }
  }
  const out: Array<{ deviceId: number; busy: number }> = [];
  for (const [dev, arr] of [...byDev].sort((a, b) => a[0] - b[0])) {
    arr.sort((a, b) => a[0] - b[0]);
    let busy = 0;
    let cs = -Infinity;
    let ce = -Infinity;
    for (const [s, e] of arr) {
      if (s > ce) {
        if (ce > cs) busy += ce - cs;
        cs = s;
        ce = e;
      } else if (e > ce) ce = e;
    }
    if (ce > cs) busy += ce - cs;
    out.push({ deviceId: dev, busy: busy / Math.max(1, range.t1 - range.t0) });
  }
  return out;
}

export const GPU_KINDS = [Kind.Kernel, Kind.Memcpy, Kind.Memset, Kind.Graph];
export const isGpuKind = (k: number) => k === Kind.Kernel || k === Kind.Memcpy || k === Kind.Memset || k === Kind.Graph;

/** Find events correlated with the given one (CUDA API call ↔ GPU work). */
export function correlated(data: ProfileData, ref: EventRef): EventRef[] {
  const t = data.tracks[ref.track];
  if (!t || t.type !== 'events') return [];
  const corr = t.corr[ref.index];
  if (!corr) return [];
  const fromGpu = t.role === 'gpu';
  const out: EventRef[] = [];
  for (const o of eventTracks(data)) {
    if (fromGpu ? o.role !== 'api' : o.role !== 'gpu') continue;
    if (t.pid >= 0 && o.pid >= 0 && o.pid !== t.pid) continue;
    const c = o.corr;
    for (let i = 0; i < o.n; i++) {
      if (c[i] === corr) {
        out.push({ track: o.id, index: i });
        if (fromGpu || out.length >= 500) return out;
      }
    }
  }
  return out;
}

/** Row (nesting depth) of an event inside its track. */
export function depthOf(t: EventTrack, index: number): number {
  const ro = t.rowOffsets;
  let lo = 0;
  let hi = t.rows - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ro[mid] <= index) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}
