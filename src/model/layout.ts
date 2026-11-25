import type { Group, ProfileData, Track } from './types';

export const GROUP_H = 26;
export const ROW_H = 18;
export const GPU_ROW_H = 22;
export const COUNTER_H = 34;
export const TRACK_PAD = 3;

export interface LayoutItem {
  kind: 'group' | 'track';
  y: number;
  h: number;
  indent: number;
  group?: Group;
  track?: Track;
  rowH: number;
  /** Index of the layout item in `items`. */
  i: number;
  odd: boolean;
}

export interface Layout {
  items: LayoutItem[];
  height: number;
  byTrack: Map<number, LayoutItem>;
  byGroup: Map<string, LayoutItem>;
  /** The item a track is drawn in: itself, or its closest collapsed ancestor. */
  ownerOf: (trackId: number) => LayoutItem | undefined;
}

export function rowHeight(t: Track): number {
  if (t.type === 'counter') return COUNTER_H;
  return t.role === 'gpu' ? GPU_ROW_H : ROW_H;
}

export function trackHeight(t: Track): number {
  if (t.type === 'counter') return COUNTER_H;
  return Math.max(1, t.rows) * rowHeight(t) + TRACK_PAD * 2;
}

export function buildLayout(data: ProfileData, collapsed: Set<string>): Layout {
  const items: LayoutItem[] = [];
  const byTrack = new Map<number, LayoutItem>();
  const byGroup = new Map<string, LayoutItem>();
  const hiddenOwner = new Map<number, string>();
  let y = 0;
  let odd = false;

  const walk = (gid: string, indent: number, hiddenUnder: string | null) => {
    const g = data.groups[gid];
    if (!g) return;
    if (hiddenUnder === null) {
      const it: LayoutItem = { kind: 'group', y, h: GROUP_H, indent, group: g, rowH: GROUP_H, i: items.length, odd: false };
      items.push(it);
      byGroup.set(gid, it);
      y += GROUP_H;
    }
    const isCollapsed = collapsed.has(gid);
    const under = hiddenUnder ?? (isCollapsed ? gid : null);
    for (const ch of g.children) {
      if ('track' in ch) {
        const t = data.tracks[ch.track];
        if (under !== null) {
          hiddenOwner.set(t.id, under);
          continue;
        }
        const h = trackHeight(t);
        const it: LayoutItem = { kind: 'track', y, h, indent: indent + 1, track: t, rowH: rowHeight(t), i: items.length, odd };
        odd = !odd;
        items.push(it);
        byTrack.set(t.id, it);
        y += h;
      } else {
        walk(ch.group, indent + 1, under);
      }
    }
  };
  for (const r of data.rootGroups) walk(r, 0, null);

  return {
    items,
    height: y,
    byTrack,
    byGroup,
    ownerOf: (id) => byTrack.get(id) ?? byGroup.get(hiddenOwner.get(id) ?? ''),
  };
}

/** All event tracks under a group (recursively). */
export function tracksUnder(data: ProfileData, gid: string, out: Track[] = []): Track[] {
  const g = data.groups[gid];
  if (!g) return out;
  for (const ch of g.children) {
    if ('track' in ch) out.push(data.tracks[ch.track]);
    else tracksUnder(data, ch.group, out);
  }
  return out;
}

export function initialCollapsed(data: ProfileData): Set<string> {
  const s = new Set<string>();
  for (const g of Object.values(data.groups)) if (g.collapsed) s.add(g.id);
  return s;
}
