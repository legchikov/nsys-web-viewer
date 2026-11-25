/// <reference lib="webworker" />
// Loads an Nsight Systems SQLite export with sql.js and converts it into compact,
// render-ready typed arrays. The database stays open afterwards so the UI can fetch
// full event details and run ad-hoc SQL.

import initSqlJs, { type Database, type SqlJsStatic, type SqlValue } from 'sql.js';
import wasmUrl from 'sql.js/dist/sql-wasm.wasm?url';
import {
  Kind,
  type CounterTrack,
  type EventTrack,
  type Group,
  type ProfileData,
  type Track,
  type TrackRole,
} from '../model/types';

declare const self: DedicatedWorkerGlobalScope;

let SQL: SqlJsStatic | null = null;
let db: Database | null = null;
let originSql = '0';
let sid: string[] = [];
let nvtxDomains = new Map<number, string>();
let nvtxCategories = new Map<number, string>();
const colCache = new Map<string, Set<string>>();

// ---------------------------------------------------------------------------
// Small helpers

function post(msg: unknown, transfer: Transferable[] = []) {
  self.postMessage(msg, transfer);
}

function progress(stage: string, pct?: number) {
  post({ type: 'progress', stage, pct });
}

function each(sql: string, cb: (row: SqlValue[]) => void, params?: SqlValue[]) {
  const stmt = db!.prepare(sql);
  try {
    if (params) stmt.bind(params);
    while (stmt.step()) cb(stmt.get());
  } finally {
    stmt.free();
  }
}

function scalar(sql: string): SqlValue {
  let v: SqlValue = null;
  each(sql, (r) => (v = r[0]));
  return v;
}

function tables(): Set<string> {
  const out = new Set<string>();
  each("SELECT name FROM sqlite_master WHERE type IN ('table','view')", (r) => out.add(String(r[0])));
  return out;
}

function cols(table: string): Set<string> {
  let c = colCache.get(table);
  if (!c) {
    c = new Set();
    each(`PRAGMA table_info("${table}")`, (r) => c!.add(String(r[1])));
    colCache.set(table, c);
  }
  return c;
}

const q = (name: string) => `"${name.replace(/"/g, '""')}"`;

/** Growable typed array. */
class Grow<T extends Float64Array | Int32Array | Uint8Array | Uint32Array> {
  buf: T;
  n = 0;
  constructor(private ctor: new (n: number) => T, cap = 1024) {
    this.buf = new ctor(cap);
  }
  push(v: number) {
    if (this.n === this.buf.length) {
      const nb = new this.ctor(this.buf.length * 2);
      nb.set(this.buf as any);
      this.buf = nb;
    }
    this.buf[this.n++] = v;
  }
}

// ---------------------------------------------------------------------------
// Names

const names: string[] = [];
const nameIndex = new Map<string, number>();
let sidToName = new Int32Array(0);

function intern(s: string): number {
  let i = nameIndex.get(s);
  if (i === undefined) {
    i = names.length;
    names.push(s);
    nameIndex.set(s, i);
  }
  return i;
}

function internSid(id: number): number {
  if (id >= 0 && id < sidToName.length) {
    const c = sidToName[id];
    if (c >= 0) return c;
    const v = intern(sid[id] ?? `<string ${id}>`);
    sidToName[id] = v;
    return v;
  }
  return intern(sid[id] ?? `<string ${id}>`);
}

/** A name column may hold a StringIds id (number) or the text itself. */
function nameOf(v: SqlValue, fallback = '(unnamed)'): number {
  if (typeof v === 'number') return internSid(v);
  if (typeof v === 'string') return intern(v);
  return intern(fallback);
}

function sidText(v: SqlValue): string | null {
  if (typeof v === 'number') return sid[v] ?? null;
  if (typeof v === 'string') return v;
  return null;
}

// ---------------------------------------------------------------------------
// Track building

interface Builder {
  key: string;
  groupId: string;
  label: string;
  role: TrackRole;
  pid: number;
  tid: number;
  deviceId: number;
  streamId: number;
  contextId: number;
  tables: string[];
  start: Grow<Float64Array>;
  end: Grow<Float64Array>;
  name: Grow<Int32Array>;
  alt: Grow<Int32Array> | null;
  kind: Grow<Uint8Array>;
  src: Grow<Uint8Array>;
  rowid: Grow<Float64Array>;
  corr: Grow<Float64Array>;
  color: Grow<Uint32Array> | null;
  bytes: Grow<Float64Array> | null;
}

const builders = new Map<string, Builder>();

function builder(
  key: string,
  init: Pick<Builder, 'groupId' | 'label' | 'role' | 'pid' | 'tid' | 'deviceId' | 'streamId' | 'contextId'>,
  opts: { alt?: boolean; color?: boolean; bytes?: boolean } = {},
): Builder {
  let b = builders.get(key);
  if (!b) {
    b = {
      key,
      ...init,
      tables: [],
      start: new Grow(Float64Array),
      end: new Grow(Float64Array),
      name: new Grow(Int32Array),
      alt: null,
      kind: new Grow(Uint8Array),
      src: new Grow(Uint8Array),
      rowid: new Grow(Float64Array),
      corr: new Grow(Float64Array),
      color: null,
      bytes: null,
    };
    builders.set(key, b);
  }
  if (opts.alt && !b.alt) {
    b.alt = new Grow(Int32Array);
    for (let i = 0; i < b.name.n; i++) b.alt.push(b.name.buf[i]);
  }
  if (opts.color && !b.color) {
    b.color = new Grow(Uint32Array);
    for (let i = 0; i < b.start.n; i++) b.color.push(0);
  }
  if (opts.bytes && !b.bytes) {
    b.bytes = new Grow(Float64Array);
    for (let i = 0; i < b.start.n; i++) b.bytes.push(NaN);
  }
  return b;
}

function srcIndex(b: Builder, table: string) {
  let i = b.tables.indexOf(table);
  if (i < 0) {
    i = b.tables.length;
    b.tables.push(table);
  }
  return i;
}

function push(
  b: Builder,
  src: number,
  rowid: number,
  start: number,
  end: number,
  name: number,
  kind: number,
  corr: number,
  extra?: { alt?: number; color?: number; bytes?: number },
) {
  if (!(end >= start)) end = start;
  b.start.push(start);
  b.end.push(end);
  b.name.push(name);
  b.kind.push(kind);
  b.src.push(src);
  b.rowid.push(rowid);
  b.corr.push(corr);
  if (b.alt) b.alt.push(extra?.alt ?? name);
  if (b.color) b.color.push(extra?.color ?? 0);
  if (b.bytes) b.bytes.push(extra?.bytes ?? NaN);
}

const MAX_ROWS = 64;

function finalize(b: Builder, id: number): EventTrack {
  const n = b.start.n;
  const S = b.start.buf;
  const E = b.end.buf;
  const order = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  // Sort by start; for equal starts put the longer (enclosing) event first.
  order.sort((a, c) => S[a] - S[c] || E[c] - E[a]);

  const depth = new Uint8Array(n);
  let rows = 0;
  if (b.role === 'gpu') {
    // Greedy interval packing: GPU work on one stream rarely overlaps.
    const rowEnd: number[] = [];
    for (let k = 0; k < n; k++) {
      const i = order[k];
      let r = 0;
      while (r < rowEnd.length && rowEnd[r] > S[i]) r++;
      if (r >= MAX_ROWS) r = MAX_ROWS - 1;
      rowEnd[r] = Math.max(rowEnd[r] ?? -Infinity, E[i]);
      depth[i] = r;
      if (r + 1 > rows) rows = r + 1;
    }
  } else {
    // Call-stack nesting.
    const stack: number[] = [];
    for (let k = 0; k < n; k++) {
      const i = order[k];
      while (stack.length && stack[stack.length - 1] <= S[i]) stack.pop();
      let d = stack.length;
      if (d >= MAX_ROWS) d = MAX_ROWS - 1;
      else stack.push(E[i]);
      depth[i] = d;
      if (d + 1 > rows) rows = d + 1;
    }
  }
  if (n === 0) rows = 1;

  const rowOffsets = new Int32Array(rows + 1);
  for (let i = 0; i < n; i++) rowOffsets[depth[i] + 1]++;
  for (let d = 0; d < rows; d++) rowOffsets[d + 1] += rowOffsets[d];
  const fill = rowOffsets.slice(0, rows);
  const perm = new Uint32Array(n); // perm[newPos] = oldIndex
  for (let k = 0; k < n; k++) {
    const i = order[k];
    perm[fill[depth[i]]++] = i;
  }

  const take64 = (src: Float64Array) => {
    const out = new Float64Array(n);
    for (let k = 0; k < n; k++) out[k] = src[perm[k]];
    return out;
  };
  const take32 = (src: Int32Array) => {
    const out = new Int32Array(n);
    for (let k = 0; k < n; k++) out[k] = src[perm[k]];
    return out;
  };
  const takeU32 = (src: Uint32Array) => {
    const out = new Uint32Array(n);
    for (let k = 0; k < n; k++) out[k] = src[perm[k]];
    return out;
  };
  const take8 = (src: Uint8Array) => {
    const out = new Uint8Array(n);
    for (let k = 0; k < n; k++) out[k] = src[perm[k]];
    return out;
  };

  const start = take64(S);
  const end = take64(E);
  const cum = new Float64Array(n + 1);
  for (let k = 0; k < n; k++) cum[k + 1] = cum[k] + (end[k] - start[k]);

  return {
    type: 'events',
    id,
    groupId: b.groupId,
    label: b.label,
    role: b.role,
    pid: b.pid,
    tid: b.tid,
    deviceId: b.deviceId,
    streamId: b.streamId,
    n,
    tables: b.tables,
    rowOffsets,
    rows,
    start,
    end,
    cum,
    name: take32(b.name.buf),
    alt: b.alt ? take32(b.alt.buf) : null,
    kind: take8(b.kind.buf),
    src: take8(b.src.buf),
    rowid: take64(b.rowid.buf),
    corr: take64(b.corr.buf),
    color: b.color ? takeU32(b.color.buf) : null,
    bytes: b.bytes ? take64(b.bytes.buf) : null,
  };
}

// ---------------------------------------------------------------------------
// Enumerations

const COPY_KIND: Record<number, string> = {
  0: 'Unknown',
  1: 'HtoD',
  2: 'DtoH',
  3: 'HtoA',
  4: 'AtoH',
  5: 'AtoA',
  6: 'AtoD',
  7: 'DtoA',
  8: 'DtoD',
  9: 'HtoH',
  10: 'PtoP',
};
const MEM_KIND: Record<number, string> = {
  0: 'Unknown',
  1: 'Pageable',
  2: 'Pinned',
  3: 'Device',
  4: 'Array',
  5: 'Managed',
  6: 'Device static',
  7: 'Managed static',
};

/** Thread-scoped range tables with a friendly label. Unknown tables with the same shape are picked up too. */
const THREAD_TABLES: Record<string, { label: string; role: TrackRole; kind: number }> = {
  CUPTI_ACTIVITY_KIND_RUNTIME: { label: 'CUDA API', role: 'api', kind: Kind.Api },
  OSRT_API: { label: 'OS runtime', role: 'osrt', kind: Kind.Osrt },
  CUDNN_EVENTS: { label: 'cuDNN', role: 'lib', kind: Kind.Lib },
  CUBLAS_EVENTS: { label: 'cuBLAS', role: 'lib', kind: Kind.Lib },
  CUSPARSE_EVENTS: { label: 'cuSPARSE', role: 'lib', kind: Kind.Lib },
  CUDA_GRAPH_EVENTS: { label: 'CUDA graphs', role: 'lib', kind: Kind.Graph },
  CUDA_GRAPH_NODE_EVENTS: { label: 'CUDA graphs', role: 'lib', kind: Kind.Graph },
  PROFILER_OVERHEAD: { label: 'Profiler overhead', role: 'overhead', kind: Kind.Overhead },
};

function threadTableInfo(t: string) {
  if (THREAD_TABLES[t]) return THREAD_TABLES[t];
  if (t.startsWith('MPI_')) return { label: 'MPI', role: 'lib' as const, kind: Kind.Lib };
  if (t.startsWith('OPENMP_')) return { label: 'OpenMP', role: 'lib' as const, kind: Kind.Lib };
  if (t.startsWith('UCP_')) return { label: 'UCX', role: 'lib' as const, kind: Kind.Lib };
  if (t.startsWith('NVSHMEM_')) return { label: 'NVSHMEM', role: 'lib' as const, kind: Kind.Lib };
  if (t.startsWith('OPENACC_')) return { label: 'OpenACC', role: 'lib' as const, kind: Kind.Lib };
  const pretty = t
    .replace(/_EVENTS?$/, '')
    .replace(/_API$/, '')
    .toLowerCase()
    .replace(/(^|_)([a-z])/g, (_, s, c) => (s ? ' ' : '') + c.toUpperCase());
  return { label: pretty, role: 'lib' as const, kind: Kind.Lib };
}

/** Run an optional extraction step; on failure record a note instead of aborting the load. */
function section(warnings: string[], label: string, fn: () => void) {
  try {
    fn();
  } catch (err) {
    warnings.push(`${label} skipped: ${(err as Error).message}`);
  }
}

const SKIP_TABLE = /^(ENUM_|TARGET_INFO_|META_DATA_|StringIds$|ThreadNames$|PROCESSES$|NVTX_EVENTS$|SCHED_EVENTS$|COMPOSITE_EVENTS$|SAMPLING_CALLCHAINS$|GPU_METRICS$|sqlite_)/;

// ---------------------------------------------------------------------------
// Main extraction

async function open(buffer: ArrayBuffer, fileName: string) {
  const t0 = performance.now();
  const head = new Uint8Array(buffer, 0, Math.min(16, buffer.byteLength));
  const magic = String.fromCharCode(...head);
  if (!magic.startsWith('SQLite format 3')) {
    throw new Error(
      `“${fileName}” is not a SQLite database. Export the report first: nsys export --type sqlite ${fileName}`,
    );
  }

  progress('Starting SQLite engine…', 2);
  if (!SQL) SQL = await initSqlJs({ locateFile: () => wasmUrl });
  if (db) db.close();
  colCache.clear();
  builders.clear();
  names.length = 0;
  nameIndex.clear();

  progress('Opening database…', 4);
  db = new SQL.Database(new Uint8Array(buffer));
  const T = tables();
  const warnings: string[] = [];
  const counts: Record<string, number> = {};

  // Strings
  progress('Reading string table…', 6);
  sid = [];
  if (T.has('StringIds')) each('SELECT id, value FROM StringIds', (r) => (sid[r[0] as number] = String(r[1])));
  sidToName = new Int32Array(Math.min(sid.length, 50_000_000)).fill(-1);
  intern('(unnamed)');

  // Time origin: keep all math in SQLite's 64-bit integers, then subtract.
  originSql = '0';
  let sessionDuration = 0;
  if (T.has('ANALYSIS_DETAILS') && cols('ANALYSIS_DETAILS').has('startTime')) {
    const s = scalar('SELECT CAST(MIN(startTime) AS TEXT) FROM ANALYSIS_DETAILS');
    if (s !== null && /^-?\d+$/.test(String(s))) originSql = String(s);
    if (cols('ANALYSIS_DETAILS').has('stopTime'))
      sessionDuration = Number(scalar('SELECT MAX(stopTime) - MIN(startTime) FROM ANALYSIS_DETAILS') ?? 0);
  }
  if (originSql === '0') {
    // Without session info, use the earliest event if timestamps look absolute.
    const cand = ['CUPTI_ACTIVITY_KIND_KERNEL', 'CUPTI_ACTIVITY_KIND_RUNTIME', 'NVTX_EVENTS', 'OSRT_API'].filter((t) =>
      T.has(t),
    );
    if (cand.length) {
      const m = scalar(`SELECT CAST(MIN(m) AS TEXT) FROM (${cand.map((t) => `SELECT MIN(start) AS m FROM ${t}`).join(' UNION ALL ')})`);
      if (m !== null && Number(m) > 1e15) originSql = String(m);
    }
  }
  const O = originSql;

  // Processes & threads
  const procNames = new Map<number, string>();
  if (T.has('PROCESSES') && cols('PROCESSES').has('pid') && cols('PROCESSES').has('name')) {
    section(warnings, 'Process names', () =>
      each('SELECT pid, name FROM PROCESSES', (r) => {
        if (r[1] != null) procNames.set(r[0] as number, String(r[1]).split('/').pop()!);
      }),
    );
  }
  const threadNames = new Map<string, string>();
  if (T.has('ThreadNames') && cols('ThreadNames').has('globalTid') && cols('ThreadNames').has('nameId')) {
    section(warnings, 'Thread names', () =>
      each(
        'SELECT (globalTid >> 24) & 16777215, globalTid & 16777215, nameId FROM ThreadNames ORDER BY rowid',
        (r) => {
          const s = sidText(r[2]);
          if (s) threadNames.set(`${r[0]}:${r[1]}`, s);
        },
      ),
    );
  }

  // GPUs
  const gpuInfo = new Map<number, { name: string; details: string[] }>();
  section(warnings, 'GPU info', () => readGpuInfo(T, gpuInfo));

  // NVTX domains / categories (needed for labels and details)
  nvtxDomains = new Map();
  nvtxCategories = new Map();
  const nc = T.has('NVTX_EVENTS') ? cols('NVTX_EVENTS') : new Set<string>();
  const hasNvtx = nc.has('start') && nc.has('eventType') && nc.has('globalTid');
  const nvtxText =
    nc.has('textId') && T.has('StringIds')
      ? nc.has('text')
        ? 'COALESCE(text, (SELECT value FROM StringIds WHERE id = textId))'
        : '(SELECT value FROM StringIds WHERE id = textId)'
      : nc.has('text')
        ? 'text'
        : 'NULL';
  if (hasNvtx) {
    section(warnings, 'NVTX domains', () =>
      each(
        `SELECT eventType, ${nc.has('domainId') ? 'domainId' : 'NULL'}, ${nc.has('category') ? 'category' : 'NULL'}, ${nvtxText} FROM NVTX_EVENTS WHERE eventType IN (33, 75)`,
        (r) => {
          if (r[0] === 75 && r[1] != null) nvtxDomains.set(r[1] as number, String(r[3] ?? `Domain ${r[1]}`));
          if (r[0] === 33 && r[2] != null) nvtxCategories.set(r[2] as number, String(r[3] ?? `Category ${r[2]}`));
        },
      ),
    );
    section(warnings, 'NVTX thread names', () =>
      each(
        `SELECT (globalTid >> 24) & 16777215, globalTid & 16777215, ${nvtxText} FROM NVTX_EVENTS WHERE eventType = 39`,
        (r) => {
          const key = `${r[0]}:${r[1]}`;
          if (r[2] && !threadNames.has(key)) threadNames.set(key, String(r[2]));
        },
      ),
    );
  }

  // ---- GPU activity -------------------------------------------------------
  const gpuTables = [
    { t: T.has('CUPTI_ACTIVITY_KIND_KERNEL') ? 'CUPTI_ACTIVITY_KIND_KERNEL' : 'CUPTI_ACTIVITY_KIND_CONCURRENT_KERNEL', kind: Kind.Kernel },
    { t: 'CUPTI_ACTIVITY_KIND_MEMCPY', kind: Kind.Memcpy },
    { t: 'CUPTI_ACTIVITY_KIND_MEMSET', kind: Kind.Memset },
    { t: 'CUPTI_ACTIVITY_KIND_GRAPH_TRACE', kind: Kind.Graph },
  ].filter((g) => T.has(g.t));

  let stage = 10;
  for (const { t, kind } of gpuTables) section(warnings, t, () => {
    const c = cols(t);
    if (!c.has('start') || !c.has('end') || !c.has('deviceId')) return;
    const total = Number(scalar(`SELECT COUNT(*) FROM ${q(t)}`));
    counts[t] = total;
    if (!total) return;
    const label = kind === Kind.Kernel ? 'kernels' : kind === Kind.Memcpy ? 'memory copies' : kind === Kind.Memset ? 'memsets' : 'graph launches';
    progress(`Reading ${total.toLocaleString()} ${label}…`, stage);

    const sel = [
      'rowid',
      `start - ${O}`,
      `end - ${O}`,
      'deviceId',
      c.has('contextId') ? 'contextId' : '0',
      c.has('streamId') ? 'streamId' : '0',
      c.has('correlationId') ? 'correlationId' : '0',
      c.has('globalPid') ? '(globalPid >> 24) & 16777215' : '-1',
    ];
    if (kind === Kind.Kernel) {
      const nameCol = ['shortName', 'demangledName', 'name', 'mangledName'].find((x) => c.has(x));
      const altCol = ['demangledName', 'mangledName'].find((x) => c.has(x) && x !== nameCol);
      sel.push(nameCol ?? 'NULL', altCol ?? 'NULL');
    } else if (kind === Kind.Memcpy) {
      sel.push(c.has('copyKind') ? 'copyKind' : 'NULL', c.has('srcKind') ? 'srcKind' : 'NULL', c.has('dstKind') ? 'dstKind' : 'NULL', c.has('bytes') ? 'bytes' : 'NULL');
    } else if (kind === Kind.Memset) {
      sel.push(c.has('memKind') ? 'memKind' : 'NULL', 'NULL', 'NULL', c.has('bytes') ? 'bytes' : 'NULL');
    } else {
      sel.push(c.has('graphId') ? 'graphId' : 'NULL', 'NULL', 'NULL', 'NULL');
    }
    let seen = 0;
    const memsetName = intern('Memset');
    each(`SELECT ${sel.join(', ')} FROM ${q(t)}`, (r) => {
      const dev = r[3] as number;
      const ctxId = r[4] as number;
      const stream = r[5] as number;
      const pid = (r[7] as number) ?? -1;
      const key = `gpu:${dev}:${ctxId}:${stream}`;
      const b = builder(
        key,
        { groupId: `gpu:${dev}`, label: `Stream ${stream}`, role: 'gpu', pid, tid: -1, deviceId: dev, streamId: stream, contextId: ctxId },
        { alt: kind === Kind.Kernel, bytes: kind === Kind.Memcpy || kind === Kind.Memset },
      );
      const s = srcIndex(b, t);
      if (kind === Kind.Kernel) {
        const nm = nameOf(r[8]);
        push(b, s, r[0] as number, r[1] as number, r[2] as number, nm, kind, (r[6] as number) ?? 0, {
          alt: r[9] != null ? nameOf(r[9]) : nm,
        });
      } else if (kind === Kind.Memcpy) {
        const ck = (r[8] as number) ?? 0;
        let nm = `Memcpy ${COPY_KIND[ck] ?? ck}`;
        const hostKind = ck === 1 ? r[9] : ck === 2 ? r[10] : null;
        if (typeof hostKind === 'number' && MEM_KIND[hostKind] && hostKind !== 0) nm += ` (${MEM_KIND[hostKind]})`;
        push(b, s, r[0] as number, r[1] as number, r[2] as number, intern(nm), kind, (r[6] as number) ?? 0, {
          bytes: (r[11] as number) ?? NaN,
        });
      } else if (kind === Kind.Memset) {
        push(b, s, r[0] as number, r[1] as number, r[2] as number, memsetName, kind, (r[6] as number) ?? 0, {
          bytes: (r[11] as number) ?? NaN,
        });
      } else {
        push(b, s, r[0] as number, r[1] as number, r[2] as number, intern(r[8] != null ? `CUDA Graph ${r[8]}` : 'CUDA Graph'), kind, (r[6] as number) ?? 0);
      }
      if (++seen % 250_000 === 0) progress(`Reading ${label}… ${seen.toLocaleString()} / ${total.toLocaleString()}`, stage);
    });
    stage += 8;
  });

  // ---- Thread-scoped ranges (CUDA API, OS runtime, libraries, …) ----------
  const threadTables = [...T].filter((t) => {
    if (SKIP_TABLE.test(t)) return false;
    if (t.startsWith('CUPTI_ACTIVITY_KIND_') && t !== 'CUPTI_ACTIVITY_KIND_RUNTIME') return false;
    const c = cols(t);
    return c.has('start') && c.has('end') && c.has('globalTid') && (c.has('nameId') || c.has('textId') || c.has('text') || c.has('name'));
  });
  threadTables.sort((a, b) => (a === 'CUPTI_ACTIVITY_KIND_RUNTIME' ? -1 : b === 'CUPTI_ACTIVITY_KIND_RUNTIME' ? 1 : a.localeCompare(b)));

  for (const t of threadTables) section(warnings, t, () => {
    const c = cols(t);
    const info = threadTableInfo(t);
    const total = Number(scalar(`SELECT COUNT(*) FROM ${q(t)}`));
    counts[t] = total;
    if (!total) return;
    progress(`Reading ${total.toLocaleString()} ${info.label} events…`, Math.min(stage, 70));
    const nameCol = c.has('nameId') ? 'nameId' : c.has('textId') ? 'textId' : c.has('text') ? 'text' : 'name';
    const sql = `SELECT rowid, start - ${O}, end - ${O}, (globalTid >> 24) & 16777215, globalTid & 16777215, ${nameCol}, ${
      c.has('correlationId') ? 'correlationId' : '0'
    } FROM ${q(t)} WHERE globalTid IS NOT NULL`;
    let seen = 0;
    each(sql, (r) => {
      const pid = r[3] as number;
      const tid = r[4] as number;
      const key = `thr:${pid}:${tid}:${info.label}`;
      const b = builder(key, {
        groupId: `thr:${pid}:${tid}`,
        label: info.label,
        role: info.role,
        pid,
        tid,
        deviceId: -1,
        streamId: -1,
        contextId: -1,
      });
      push(b, srcIndex(b, t), r[0] as number, r[1] as number, r[2] as number, nameOf(r[5]), info.kind, (r[6] as number) ?? 0);
      if (++seen % 250_000 === 0) progress(`Reading ${info.label}… ${seen.toLocaleString()} / ${total.toLocaleString()}`, Math.min(stage, 70));
    });
    stage += 5;
  });

  // ---- NVTX ----------------------------------------------------------------
  if (hasNvtx) section(warnings, 'NVTX ranges', () => {
    const c = nc;
    const total = Number(scalar('SELECT COUNT(*) FROM NVTX_EVENTS'));
    counts.NVTX_EVENTS = total;
    progress(`Reading ${total.toLocaleString()} NVTX events…`, Math.min(stage, 75));
    const textExpr = `${c.has('text') ? 'text' : 'NULL'}, ${c.has('textId') ? 'textId' : 'NULL'}`;
    const endExpr = c.has('end') ? `CASE WHEN end IS NULL THEN NULL ELSE end - ${O} END` : 'NULL';
    const sql = `SELECT rowid, start - ${O}, ${endExpr}, (globalTid >> 24) & 16777215, globalTid & 16777215, ${textExpr}, ${
      c.has('color') ? 'color' : 'NULL'
    }, ${c.has('domainId') ? 'domainId' : '0'}, eventType FROM NVTX_EVENTS WHERE globalTid IS NOT NULL AND eventType NOT IN (33, 39, 75, 76)`;
    each(sql, (r) => {
      const pid = r[3] as number;
      const tid = r[4] as number;
      const dom = (r[8] as number) ?? 0;
      const domName = dom ? nvtxDomains.get(dom) ?? `Domain ${dom}` : '';
      const key = `thr:${pid}:${tid}:nvtx:${dom}`;
      const b = builder(
        key,
        {
          groupId: `thr:${pid}:${tid}`,
          label: domName ? `NVTX · ${domName}` : 'NVTX',
          role: 'nvtx',
          pid,
          tid,
          deviceId: -1,
          streamId: -1,
          contextId: -1,
        },
        { color: true },
      );
      const text = r[5] != null ? intern(String(r[5])) : r[6] != null ? internSid(r[6] as number) : intern('(unnamed)');
      const st = r[1] as number;
      const en = r[2] == null ? st : (r[2] as number);
      const col = r[7] == null ? 0 : ((r[7] as number) >>> 0) | 0xff000000;
      push(b, srcIndex(b, 'NVTX_EVENTS'), r[0] as number, st, en, text, Kind.Nvtx, 0, { color: col >>> 0 });
    });
  });

  // ---- Finalize tracks --------------------------------------------------------
  progress('Building timeline…', 80);
  const tracks: Track[] = [];
  const all = [...builders.values()];
  for (const b of all) tracks.push(finalize(b, tracks.length));

  // ---- GPU metrics counters --------------------------------------------------
  const counterGroups: Array<{ id: string; label: string; dev: number | null; tracks: number[] }> = [];
  if (T.has('GPU_METRICS') && T.has('TARGET_INFO_GPU_METRICS')) {
    progress('Reading GPU metrics…', 85);
    try {
      readGpuMetrics(O, tracks, counterGroups, gpuInfo);
    } catch (err) {
      warnings.push(`GPU metrics skipped: ${(err as Error).message}`);
    }
  }

  // ---- Groups ----------------------------------------------------------------
  progress('Organising tracks…', 92);
  const { groups, rootGroups } = buildGroups(tracks, counterGroups, procNames, threadNames, gpuInfo);

  // ---- Time bounds -------------------------------------------------------------
  let minTime = Infinity;
  let maxTime = -Infinity;
  for (const tr of tracks) {
    if (tr.type === 'events') {
      for (let d = 0; d < tr.rows; d++) {
        const a = tr.rowOffsets[d];
        const b = tr.rowOffsets[d + 1];
        if (b > a) {
          minTime = Math.min(minTime, tr.start[a]);
          maxTime = Math.max(maxTime, tr.end[b - 1]);
        }
      }
      // ends are only monotonic per row; to be safe scan maxima of a few rows above
    } else if (tr.t.length) {
      minTime = Math.min(minTime, tr.t[0]);
      maxTime = Math.max(maxTime, tr.t[tr.t.length - 1]);
    }
  }
  if (!isFinite(minTime)) {
    minTime = 0;
    maxTime = Math.max(1, sessionDuration);
    warnings.push('No timeline events were found in this file.');
  }
  if (!sessionDuration) sessionDuration = maxTime;

  let info: Array<[string, string]> = [];
  section(warnings, 'Capture info', () => (info = readInfo(T)));
  const data: ProfileData = {
    fileName,
    fileSize: buffer.byteLength,
    minTime,
    maxTime,
    sessionDuration,
    strings: names.slice(),
    tracks,
    groups,
    rootGroups,
    info,
    counts,
    tables: [...T].sort(),
    loadMs: performance.now() - t0,
    warnings,
  };

  const transfer: Transferable[] = [];
  for (const tr of tracks) {
    if (tr.type === 'events') {
      for (const a of [tr.rowOffsets, tr.start, tr.end, tr.cum, tr.name, tr.alt, tr.kind, tr.src, tr.rowid, tr.corr, tr.color, tr.bytes])
        if (a) transfer.push(a.buffer);
    } else {
      transfer.push(tr.t.buffer, tr.v.buffer);
    }
  }
  builders.clear();
  progress('Rendering…', 99);
  post({ type: 'loaded', data }, transfer);
}

function readGpuInfo(T: Set<string>, out: Map<number, { name: string; details: string[] }>) {
  const byGpuId = new Map<number, { name: string; details: string[] }>();
  if (T.has('TARGET_INFO_GPU')) {
    const c = cols('TARGET_INFO_GPU');
    if (c.has('id')) {
      const pick = ['name', 'busLocation', 'totalMemory', 'smCount', 'clockRate', 'memoryBandwidth', 'chipName'].filter((x) => c.has(x));
      each(`SELECT id${pick.map((p) => ', ' + p).join('')} FROM TARGET_INFO_GPU`, (r) => {
        const rec: Record<string, SqlValue> = {};
        pick.forEach((p, i) => (rec[p] = r[i + 1]));
        const details: string[] = [];
        if (rec.chipName) details.push(`Chip: ${rec.chipName}`);
        if (rec.totalMemory) details.push(`Memory: ${(Number(rec.totalMemory) / 2 ** 30).toFixed(1)} GiB`);
        if (rec.smCount) details.push(`SMs: ${rec.smCount}`);
        if (rec.clockRate) details.push(`Clock: ${(Number(rec.clockRate) / 1000).toFixed(0)} MHz`);
        if (rec.memoryBandwidth) details.push(`Bandwidth: ${(Number(rec.memoryBandwidth) / 1e9).toFixed(0)} GB/s`);
        if (rec.busLocation) details.push(`Bus: ${rec.busLocation}`);
        byGpuId.set(r[0] as number, { name: String(rec.name ?? `GPU ${r[0]}`), details });
      });
    }
  }
  let mapped = false;
  if (T.has('TARGET_INFO_CUDA_DEVICE')) {
    const c = cols('TARGET_INFO_CUDA_DEVICE');
    if (c.has('cudaId')) {
      each(
        `SELECT cudaId, ${c.has('gpuId') ? 'gpuId' : 'NULL'}, ${c.has('name') ? 'name' : 'NULL'}, ${
          c.has('numMultiprocessors') ? 'numMultiprocessors' : 'NULL'
        }, ${c.has('computeMajor') ? "computeMajor || '.' || computeMinor" : 'NULL'} FROM TARGET_INFO_CUDA_DEVICE`,
        (r) => {
          const base = r[1] != null ? byGpuId.get(r[1] as number) : undefined;
          const details = base ? base.details.slice() : [];
          if (r[4] && !details.some((d) => d.startsWith('Compute'))) details.push(`Compute capability: ${r[4]}`);
          if (!base && r[3]) details.push(`SMs: ${r[3]}`);
          out.set(r[0] as number, { name: String(r[2] ?? base?.name ?? `GPU ${r[0]}`), details });
          mapped = true;
        },
      );
    }
  }
  if (!mapped) for (const [k, v] of byGpuId) out.set(k, v);
}

function readGpuMetrics(
  O: string,
  tracks: Track[],
  groupsOut: Array<{ id: string; label: string; dev: number | null; tracks: number[] }>,
  gpuInfo: Map<number, unknown>,
) {
  const mc = cols('GPU_METRICS');
  const ic = cols('TARGET_INFO_GPU_METRICS');
  if (!mc.has('typeId') || !mc.has('timestamp') || !mc.has('metricId') || !mc.has('value')) return;
  if (!ic.has('typeId') || !ic.has('metricId') || !ic.has('metricName')) return;
  const meta = new Map<string, { typeName: string; metricName: string; sourceId: number | null }>();
  each(
    `SELECT typeId, metricId, ${ic.has('typeName') ? 'typeName' : "'GPU'"}, metricName, ${ic.has('sourceId') ? 'sourceId' : 'NULL'} FROM TARGET_INFO_GPU_METRICS`,
    (r) => meta.set(`${r[0]}:${r[1]}`, { typeName: String(r[2]), metricName: String(r[3]), sourceId: r[4] as number | null }),
  );
  const series = new Map<string, { t: Grow<Float64Array>; v: Grow<Float64Array> }>();
  each(`SELECT typeId, metricId, timestamp - ${O}, value FROM GPU_METRICS WHERE timestamp IS NOT NULL`, (r) => {
    const key = `${r[0]}:${r[1]}`;
    let s = series.get(key);
    if (!s) {
      s = { t: new Grow(Float64Array, 4096), v: new Grow(Float64Array, 4096) };
      series.set(key, s);
    }
    s.t.push(r[2] as number);
    s.v.push(Number(r[3]));
  });
  const byType = new Map<number, string[]>();
  for (const key of series.keys()) {
    const typeId = Number(key.split(':')[0]);
    if (!byType.has(typeId)) byType.set(typeId, []);
    byType.get(typeId)!.push(key);
  }
  for (const [typeId, keys] of byType) {
    keys.sort((a, b) => Number(a.split(':')[1]) - Number(b.split(':')[1]));
    const first = meta.get(keys[0]);
    const typeName = first?.typeName ?? `GPU metrics ${typeId}`;
    let dev: number | null = null;
    const m = /GPU\s*(\d+)/i.exec(typeName);
    if (m && gpuInfo.has(Number(m[1]))) dev = Number(m[1]);
    else if (first?.sourceId != null && gpuInfo.has(first.sourceId)) dev = first.sourceId;
    const g = { id: `metrics:${typeId}`, label: dev != null ? 'GPU metrics' : `GPU metrics · ${typeName}`, dev, tracks: [] as number[] };
    for (const key of keys) {
      const s = series.get(key)!;
      const n = s.t.n;
      const order = new Uint32Array(n);
      for (let i = 0; i < n; i++) order[i] = i;
      let sorted = true;
      for (let i = 1; i < n && sorted; i++) if (s.t.buf[i] < s.t.buf[i - 1]) sorted = false;
      if (!sorted) order.sort((a, b) => s.t.buf[a] - s.t.buf[b]);
      const t = new Float64Array(n);
      const v = new Float32Array(n);
      let max = 0;
      for (let i = 0; i < n; i++) {
        t[i] = s.t.buf[order[i]];
        v[i] = s.v.buf[order[i]];
        if (v[i] > max) max = v[i];
      }
      const name = meta.get(key)?.metricName ?? `Metric ${key}`;
      const unitMatch = /\[([^\]]+)\]\s*$/.exec(name);
      const unit = unitMatch ? unitMatch[1] : '';
      const isPercent = /%/.test(unit) || /%/.test(name);
      const ct: CounterTrack = {
        type: 'counter',
        id: tracks.length,
        groupId: g.id,
        label: name.replace(/\s*\[[^\]]+\]\s*$/, ''),
        unit: unit.replace(/^Throughput\s*/, ''),
        isPercent,
        t,
        v,
        max: isPercent ? Math.max(100, max) : max || 1,
      };
      tracks.push(ct);
      g.tracks.push(ct.id);
    }
    groupsOut.push(g);
  }
}

function buildGroups(
  tracks: Track[],
  counterGroups: Array<{ id: string; label: string; dev: number | null; tracks: number[] }>,
  procNames: Map<number, string>,
  threadNames: Map<string, string>,
  gpuInfo: Map<number, { name: string; details: string[] }>,
) {
  const groups: Record<string, Group> = {};
  const roots: string[] = [];
  const ensure = (id: string, init: () => Omit<Group, 'id' | 'children'>) => {
    if (!groups[id]) groups[id] = { id, children: [], ...init() };
    return groups[id];
  };

  const ev = tracks.filter((t): t is EventTrack => t.type === 'events');

  // GPUs
  const gpuTracks = ev.filter((t) => t.role === 'gpu');
  const devices = [...new Set(gpuTracks.map((t) => t.deviceId))].sort((a, b) => a - b);
  for (const dev of devices) {
    const info = gpuInfo.get(dev);
    const g = ensure(`gpu:${dev}`, () => ({
      parentId: null,
      kind: 'gpu',
      label: `GPU ${dev}`,
      sublabel: info?.name,
      tooltip: [info?.name ?? `GPU ${dev}`, ...(info?.details ?? [])].join('\n'),
      collapsed: false,
    }));
    roots.push(g.id);
    const mine = gpuTracks.filter((t) => t.deviceId === dev);
    const pids = new Set(mine.map((t) => t.pid));
    mine.sort((a, b) => a.pid - b.pid || a.streamId - b.streamId);
    for (const t of mine) {
      if (pids.size > 1) t.label = `Stream ${t.streamId} · pid ${t.pid}`;
      g.children.push({ track: t.id });
    }
    const cg = counterGroups.find((c) => c.dev === dev);
    if (cg) {
      const sub = ensure(cg.id, () => ({ parentId: g.id, kind: 'metrics', label: cg.label, collapsed: true }));
      for (const id of cg.tracks) sub.children.push({ track: id });
      g.children.push({ group: sub.id });
    }
  }
  for (const cg of counterGroups.filter((c) => c.dev == null || !groups[`gpu:${c.dev}`])) {
    const sub = ensure(cg.id, () => ({ parentId: null, kind: 'metrics', label: cg.label, collapsed: true }));
    for (const id of cg.tracks) sub.children.push({ track: id });
    roots.push(sub.id);
  }

  // Processes → threads
  const threadTracks = ev.filter((t) => t.role !== 'gpu');
  const pids = [...new Set(threadTracks.map((t) => t.pid))].sort((a, b) => a - b);
  const roleOrder: Record<string, number> = { nvtx: 0, api: 1, lib: 2, osrt: 3, overhead: 4 };
  for (const pid of pids) {
    const pname = procNames.get(pid) ?? 'Process';
    const pg = ensure(`proc:${pid}`, () => ({
      parentId: null,
      kind: 'process',
      label: pname,
      sublabel: `pid ${pid}`,
      tooltip: `${pname}\nProcess ID ${pid}`,
      collapsed: false,
    }));
    roots.push(pg.id);
    const mine = threadTracks.filter((t) => t.pid === pid);
    const tids = [...new Set(mine.map((t) => t.tid))];
    const score = (tid: number) => {
      const ts = mine.filter((t) => t.tid === tid);
      const important = ts.some((t) => t.role === 'api' || t.role === 'nvtx' || t.role === 'lib');
      return { important, n: ts.reduce((s, t) => s + t.n, 0) };
    };
    const scored = tids.map((tid) => ({ tid, ...score(tid) }));
    scored.sort((a, b) => {
      if (a.tid === pid) return -1;
      if (b.tid === pid) return 1;
      if (a.important !== b.important) return a.important ? -1 : 1;
      return b.n - a.n;
    });
    for (const { tid, important } of scored) {
      const tname = threadNames.get(`${pid}:${tid}`) ?? (tid === pid ? pname : 'Thread');
      const tg = ensure(`thr:${pid}:${tid}`, () => ({
        parentId: pg.id,
        kind: 'thread',
        label: tname,
        sublabel: `tid ${tid}`,
        tooltip: `${tname}\nThread ID ${tid}`,
        collapsed: !important,
      }));
      const ts = mine.filter((t) => t.tid === tid);
      ts.sort((a, b) => roleOrder[a.role] - roleOrder[b.role] || a.label.localeCompare(b.label));
      for (const t of ts) tg.children.push({ track: t.id });
      pg.children.push({ group: tg.id });
    }
  }
  return { groups, rootGroups: roots };
}

function readInfo(T: Set<string>): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const kv = (table: string, k: string, v: string) => {
    if (!T.has(table)) return;
    const c = cols(table);
    if (!c.has(k) || !c.has(v)) return;
    each(`SELECT ${k}, ${v} FROM ${table}`, (r) => {
      if (r[0] != null && r[1] != null) out.push([String(r[0]), String(r[1])]);
    });
  };
  if (T.has('TARGET_INFO_SESSION_START_TIME') && cols('TARGET_INFO_SESSION_START_TIME').has('utcTime')) {
    const v = scalar('SELECT utcTime FROM TARGET_INFO_SESSION_START_TIME');
    if (v) out.push(['Session start (UTC)', String(v)]);
  }
  kv('TARGET_INFO_SYSTEM_ENV', 'name', 'value');
  kv('META_DATA_CAPTURE', 'name', 'value');
  kv('META_DATA_EXPORT', 'name', 'value');
  return out;
}

// ---------------------------------------------------------------------------
// Event details

const SID_COLUMNS = new Set([
  'nameId',
  'demangledName',
  'shortName',
  'mangledName',
  'textId',
  'jsonTextId',
  'filenameId',
  'contentId',
  'symbol',
  'module',
]);

function fmtValue(table: string, col: string, v: SqlValue): string {
  if (v === null) return '—';
  if (v instanceof Uint8Array) return `<blob ${v.length} bytes>`;
  if (typeof v === 'number') {
    if (SID_COLUMNS.has(col) && sid[v] !== undefined) return sid[v];
    if (col === 'copyKind') return COPY_KIND[v] ?? String(v);
    if (col === 'srcKind' || col === 'dstKind' || col === 'memKind') return MEM_KIND[v] ?? String(v);
    if (table === 'NVTX_EVENTS' && col === 'domainId') return v ? nvtxDomains.get(v) ?? String(v) : 'default';
    if (table === 'NVTX_EVENTS' && col === 'category') return nvtxCategories.get(v) ?? String(v);
    if (col === 'color') return '#' + ((v >>> 0) & 0xffffff).toString(16).padStart(6, '0');
  }
  return String(v);
}

function rowDetails(table: string, rowid: number) {
  const c = cols(table);
  const extra: string[] = [];
  if (c.has('start')) extra.push(`start - ${originSql} AS __start`);
  if (c.has('end')) extra.push(`end - ${originSql} AS __end`);
  if (c.has('globalTid')) extra.push('(globalTid >> 24) & 16777215 AS __pid', 'globalTid & 16777215 AS __tid');
  if (c.has('globalPid')) extra.push('(globalPid >> 24) & 16777215 AS __gpid');
  const stmt = db!.prepare(`SELECT *${extra.map((e) => ', ' + e).join('')} FROM ${q(table)} WHERE rowid = ?`);
  const fields: Array<{ key: string; value: string }> = [];
  const raw: Record<string, SqlValue> = {};
  try {
    stmt.bind([rowid]);
    if (stmt.step()) {
      const names = stmt.getColumnNames();
      const vals = stmt.get();
      names.forEach((n, i) => (raw[n] = vals[i]));
      for (let i = 0; i < names.length; i++) {
        const n = names[i];
        if (n.startsWith('__')) continue;
        let value = fmtValue(table, n, vals[i]);
        if (n === 'start' && raw.__start != null) value = String(raw.__start);
        if (n === 'end' && raw.__end != null) value = String(raw.__end);
        if (n === 'globalTid' && raw.__pid != null) value = `pid ${raw.__pid}, tid ${raw.__tid}`;
        if (n === 'globalPid' && raw.__gpid != null) value = `pid ${raw.__gpid}`;
        fields.push({ key: n, value });
      }
    }
  } finally {
    stmt.free();
  }

  // Backtrace, when the event carries a call chain
  let stack: Array<{ symbol: string; module: string }> = [];
  const chain = raw.callchainId;
  if (typeof chain === 'number' && chain > 0) {
    const t = table === 'OSRT_API' ? 'OSRT_CALLCHAINS' : 'CUDA_CALLCHAINS';
    try {
      const cc = cols(t);
      if (cc.has('id') && cc.has('symbol')) {
        each(
          `SELECT symbol, ${cc.has('module') ? 'module' : 'NULL'} FROM ${t} WHERE id = ? ORDER BY ${cc.has('stackDepth') ? 'stackDepth' : 'rowid'}`,
          (r) => stack.push({ symbol: sidText(r[0]) ?? String(r[0]), module: sidText(r[1]) ?? '' }),
          [chain],
        );
      }
    } catch {
      stack = [];
    }
  }
  return { fields, stack };
}

function runQuery(sql: string, limit = 2000) {
  const t0 = performance.now();
  let columns: string[] = [];
  let rows: string[][] = [];
  let truncated = false;
  let statements = 0;
  for (const stmt of db!.iterateStatements(sql)) {
    statements++;
    const cn = stmt.getColumnNames();
    const out: string[][] = [];
    let more = false;
    while (stmt.step()) {
      if (out.length >= limit) {
        more = true;
        break;
      }
      out.push(stmt.get().map((v) => (v instanceof Uint8Array ? `<blob ${v.length} B>` : v === null ? 'NULL' : String(v))));
    }
    if (cn.length) {
      columns = cn;
      rows = out;
      truncated = more;
    }
    stmt.free();
  }
  return { columns, rows, truncated, statements, ms: performance.now() - t0 };
}

// ---------------------------------------------------------------------------

self.onmessage = async (e: MessageEvent) => {
  const msg = e.data;
  try {
    if (msg.type === 'open') {
      await open(msg.buffer as ArrayBuffer, msg.fileName as string);
    } else if (msg.type === 'row') {
      post({ type: 'reply', id: msg.id, result: rowDetails(msg.table, msg.rowid) });
    } else if (msg.type === 'query') {
      post({ type: 'reply', id: msg.id, result: runQuery(msg.sql) });
    } else if (msg.type === 'export') {
      const bytes = db!.export();
      post({ type: 'reply', id: msg.id, result: bytes }, [bytes.buffer]);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (msg.type === 'open') post({ type: 'error', message });
    else post({ type: 'reply', id: msg.id, error: message });
  }
};
