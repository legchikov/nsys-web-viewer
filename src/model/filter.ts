import type { EventTrack, ProfileData } from './types';

export interface Filter {
  text: string;
  /** Exact name match (set when picking a row in the stats tables). */
  exact: boolean;
}

/** The matching events of one track, kept in the same row-grouped order as the track. */
export interface Subset {
  idx: Int32Array;
  rowOffsets: Int32Array;
  cum: Float64Array;
}

export interface FilterIndex {
  match: Uint8Array;
  subsets: Map<number, Subset>;
  count: number;
  /** All matches sorted by start time (for next / previous navigation). */
  order: { start: Float64Array; track: Int32Array; index: Int32Array };
  error?: string;
}

export function buildMatcher(f: Filter): { test: (s: string) => boolean; error?: string } | null {
  const text = f.text.trim();
  if (!text) return null;
  if (f.exact) return { test: (s) => s === f.text };
  const re = /^\/(.+)\/([a-z]*)$/.exec(text);
  if (re) {
    try {
      const r = new RegExp(re[1], re[2].includes('i') ? re[2] : re[2] + 'i');
      return { test: (s) => r.test(s) };
    } catch (e) {
      return { test: () => false, error: (e as Error).message };
    }
  }
  const needle = text.toLowerCase();
  return { test: (s) => s.toLowerCase().includes(needle) };
}

export function buildFilterIndex(data: ProfileData, f: Filter): FilterIndex | null {
  const m = buildMatcher(f);
  if (!m) return null;
  const match = new Uint8Array(data.strings.length);
  for (let i = 0; i < data.strings.length; i++) if (m.test(data.strings[i])) match[i] = 1;

  const subsets = new Map<number, Subset>();
  let count = 0;
  for (const t of data.tracks) {
    if (t.type !== 'events') continue;
    const s = subsetOf(t, match);
    if (s) {
      subsets.set(t.id, s);
      count += s.idx.length;
    }
  }

  const start = new Float64Array(count);
  const track = new Int32Array(count);
  const index = new Int32Array(count);
  let k = 0;
  for (const [tid, s] of subsets) {
    const t = data.tracks[tid] as EventTrack;
    for (let j = 0; j < s.idx.length; j++) {
      start[k] = t.start[s.idx[j]];
      track[k] = tid;
      index[k] = s.idx[j];
      k++;
    }
  }
  const ord = new Uint32Array(count);
  for (let i = 0; i < count; i++) ord[i] = i;
  ord.sort((a, b) => start[a] - start[b]);
  const order = { start: new Float64Array(count), track: new Int32Array(count), index: new Int32Array(count) };
  for (let i = 0; i < count; i++) {
    order.start[i] = start[ord[i]];
    order.track[i] = track[ord[i]];
    order.index[i] = index[ord[i]];
  }
  return { match, subsets, count, order, error: m.error };
}

function subsetOf(t: EventTrack, match: Uint8Array): Subset | null {
  const { name, alt } = t;
  let n = 0;
  for (let i = 0; i < t.n; i++) if (match[name[i]] || (alt && match[alt[i]])) n++;
  if (!n) return null;
  const idx = new Int32Array(n);
  const rowOffsets = new Int32Array(t.rows + 1);
  const cum = new Float64Array(n + 1);
  let k = 0;
  for (let d = 0; d < t.rows; d++) {
    rowOffsets[d] = k;
    for (let i = t.rowOffsets[d]; i < t.rowOffsets[d + 1]; i++) {
      if (match[name[i]] || (alt && match[alt[i]])) {
        idx[k] = i;
        cum[k + 1] = cum[k] + (t.end[i] - t.start[i]);
        k++;
      }
    }
  }
  rowOffsets[t.rows] = k;
  return { idx, rowOffsets, cum };
}
