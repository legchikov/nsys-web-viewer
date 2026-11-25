/** Event categories. Stored per event as a Uint8 code. */
export const Kind = {
  Kernel: 0,
  Memcpy: 1,
  Memset: 2,
  Api: 3,
  Nvtx: 4,
  Osrt: 5,
  Lib: 6,
  Overhead: 7,
  Graph: 8,
} as const;
export type KindCode = (typeof Kind)[keyof typeof Kind];

export const KIND_LABEL: Record<number, string> = {
  [Kind.Kernel]: 'CUDA kernel',
  [Kind.Memcpy]: 'Memory copy',
  [Kind.Memset]: 'Memory set',
  [Kind.Api]: 'CUDA API',
  [Kind.Nvtx]: 'NVTX range',
  [Kind.Osrt]: 'OS runtime',
  [Kind.Lib]: 'Library call',
  [Kind.Overhead]: 'Profiler overhead',
  [Kind.Graph]: 'CUDA graph',
};

export type TrackRole = 'gpu' | 'api' | 'nvtx' | 'osrt' | 'lib' | 'overhead';

export interface EventTrack {
  type: 'events';
  id: number;
  groupId: string;
  label: string;
  role: TrackRole;
  /** Process id that owns the events (for API ↔ GPU correlation); -1 if unknown. */
  pid: number;
  tid: number;
  deviceId: number;
  streamId: number;
  n: number;
  /** Source tables referenced by `src`. */
  tables: string[];
  /**
   * Events are stored grouped by nesting row (depth), each row sorted by start.
   * Row d occupies [rowOffsets[d], rowOffsets[d + 1]). Events in a row never overlap,
   * so both `start` and `end` are non-decreasing inside a row.
   */
  rowOffsets: Int32Array;
  rows: number;
  start: Float64Array;
  end: Float64Array;
  /** Prefix sums of durations (length n + 1), in storage order. */
  cum: Float64Array;
  name: Int32Array;
  /** Alternate (long) name, e.g. demangled kernel names. */
  alt: Int32Array | null;
  kind: Uint8Array;
  src: Uint8Array;
  rowid: Float64Array;
  corr: Float64Array;
  /** Explicit ARGB colour (NVTX); 0 = none. */
  color: Uint32Array | null;
  /** Bytes for memcpy / memset, NaN otherwise. */
  bytes: Float64Array | null;
}

export interface CounterTrack {
  type: 'counter';
  id: number;
  groupId: string;
  label: string;
  unit: string;
  isPercent: boolean;
  t: Float64Array;
  v: Float32Array;
  max: number;
}

export type Track = EventTrack | CounterTrack;

export type GroupKind = 'gpu' | 'process' | 'thread' | 'metrics';

export interface Group {
  id: string;
  parentId: string | null;
  kind: GroupKind;
  label: string;
  sublabel?: string;
  tooltip?: string;
  collapsed: boolean;
  /** Ordered children: tracks (by id) and sub-groups (by id). */
  children: Array<{ track: number } | { group: string }>;
}

export interface ProfileData {
  fileName: string;
  fileSize: number;
  /** Earliest and latest event timestamps (ns, relative to the session origin). */
  minTime: number;
  maxTime: number;
  /** Session duration from ANALYSIS_DETAILS when available. */
  sessionDuration: number;
  strings: string[];
  tracks: Track[];
  groups: Record<string, Group>;
  rootGroups: string[];
  info: Array<[string, string]>;
  counts: Record<string, number>;
  tables: string[];
  loadMs: number;
  warnings: string[];
}

export interface EventRef {
  track: number;
  index: number;
}

export interface TimeRange {
  t0: number;
  t1: number;
}
