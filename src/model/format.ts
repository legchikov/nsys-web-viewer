/** Human-friendly duration, e.g. 850 ns, 12.3 µs, 4.56 ms, 1.234 s */
export function fmtDur(ns: number): string {
  if (!isFinite(ns)) return '—';
  const a = Math.abs(ns);
  if (a < 1e3) return `${trim(ns, a < 10 ? 1 : 0)} ns`;
  if (a < 1e6) return `${trim(ns / 1e3, a < 1e4 ? 2 : a < 1e5 ? 1 : 0)} µs`;
  if (a < 1e9) return `${trim(ns / 1e6, a < 1e7 ? 3 : a < 1e8 ? 2 : 1)} ms`;
  if (a < 60e9) return `${trim(ns / 1e9, 3)} s`;
  const m = Math.floor(a / 60e9);
  return `${ns < 0 ? '-' : ''}${m}m ${trim((a - m * 60e9) / 1e9, 1)}s`;
}

function trim(v: number, decimals: number) {
  return v.toFixed(decimals);
}

/** Timestamp relative to session start with enough precision to be useful. */
export function fmtTime(ns: number): string {
  const a = Math.abs(ns);
  if (a < 1e9) return `${(ns / 1e6).toFixed(3)} ms`;
  return `${(ns / 1e9).toFixed(6)} s`;
}

export function fmtBytes(b: number): string {
  if (!isFinite(b)) return '—';
  const u = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let i = 0;
  let v = b;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : v < 10 ? 2 : 1)} ${u[i]}`;
}

/** Bytes over nanoseconds → GB/s */
export function fmtRate(bytes: number, ns: number): string {
  if (!(ns > 0) || !isFinite(bytes)) return '—';
  const gbs = bytes / ns; // bytes per ns == GB/s
  if (gbs >= 1) return `${gbs.toFixed(gbs >= 100 ? 0 : 1)} GB/s`;
  return `${(gbs * 1000).toFixed(1)} MB/s`;
}

export function fmtCount(n: number): string {
  return n.toLocaleString('en-GB');
}

export function fmtCompact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1e6) return `${(n / 1e3).toFixed(n < 1e4 ? 1 : 0)}k`;
  return `${(n / 1e6).toFixed(n < 1e7 ? 1 : 0)}M`;
}

export function fmtPct(f: number): string {
  if (!isFinite(f)) return '—';
  const p = f * 100;
  return `${p < 10 ? p.toFixed(1) : p.toFixed(0)}%`;
}

const TICK_STEPS = [1, 2, 5];

/** Pick a "nice" tick step (ns) so that ticks are roughly `targetPx` apart. */
export function niceStep(nsPerPx: number, targetPx = 110): number {
  const raw = nsPerPx * targetPx;
  const p = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1e-3))));
  for (const s of TICK_STEPS) if (s * p >= raw) return s * p;
  return 10 * p;
}

/** Tick label at the precision implied by the step. */
export function fmtTick(ns: number, step: number): string {
  let unit = 'ns';
  let div = 1;
  if (step >= 1e8) {
    unit = 's';
    div = 1e9;
  } else if (step >= 1e5) {
    unit = 'ms';
    div = 1e6;
  } else if (step >= 1e2) {
    unit = 'µs';
    div = 1e3;
  }
  const decimals = Math.max(0, Math.ceil(-Math.log10(step / div) - 1e-9));
  return `${(ns / div).toFixed(decimals)} ${unit}`;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
