import { ArrowDown, ArrowUp, Crosshair, Play, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ProfileClient, QueryResult } from '../data/client';
import { eventColor } from '../model/colors';
import { buildMatcher, type Filter } from '../model/filter';
import { fmtBytes, fmtCount, fmtDur, fmtPct, fmtRate } from '../model/format';
import { computeStats, eventTracks, type StatRow } from '../model/stats';
import { Kind, type EventRef, type ProfileData, type TimeRange } from '../model/types';

interface Props {
  data: ProfileData;
  client: ProfileClient;
  range: TimeRange | null;
  useAlt: boolean;
  filter: Filter;
  onPickName: (name: string) => void;
  onJump: (r: EventRef, zoom?: boolean) => void;
  onClose: () => void;
}

interface TabDef {
  id: string;
  label: string;
  kinds: number[];
  memory?: boolean;
}

const ALL_TABS: TabDef[] = [
  { id: 'kernels', label: 'Kernels', kinds: [Kind.Kernel] },
  { id: 'memory', label: 'Memory', kinds: [Kind.Memcpy, Kind.Memset], memory: true },
  { id: 'api', label: 'CUDA API', kinds: [Kind.Api] },
  { id: 'nvtx', label: 'NVTX', kinds: [Kind.Nvtx] },
  { id: 'osrt', label: 'OS runtime', kinds: [Kind.Osrt] },
  { id: 'lib', label: 'Libraries', kinds: [Kind.Lib, Kind.Graph] },
];

export function BottomPanel(p: Props) {
  const present = useMemo(() => {
    const has = new Set<number>();
    for (const t of eventTracks(p.data)) {
      for (let i = 0; i < t.n; i += Math.max(1, Math.floor(t.n / 32))) has.add(t.kind[i]);
    }
    return ALL_TABS.filter((t) => t.kinds.some((k) => has.has(k)));
  }, [p.data]);
  const [tab, setTab] = useState(() => present[0]?.id ?? 'sql');
  const [limit, setLimit] = useState(true);
  const def = present.find((t) => t.id === tab);

  return (
    <section className="bottom">
      <div className="panel-head tabs">
        {present.map((t) => (
          <button key={t.id} className={`tab ${tab === t.id ? 'on' : ''}`} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
        <button className={`tab ${tab === 'sql' ? 'on' : ''}`} onClick={() => setTab('sql')}>
          SQL
        </button>
        <div className="tabs-spacer" />
        {p.range && tab !== 'sql' && (
          <label className="check" title="Only count events overlapping the selected time range">
            <input type="checkbox" checked={limit} onChange={(e) => setLimit(e.target.checked)} />
            Selected range only ({fmtDur(p.range.t1 - p.range.t0)})
          </label>
        )}
        <button className="icon-btn sm" onClick={p.onClose} title="Hide panel">
          <X size={14} />
        </button>
      </div>
      <div className="bottom-body">
        {def ? (
          <StatsTable key={def.id} {...p} def={def} range={limit ? p.range : null} />
        ) : (
          <SqlConsole client={p.client} data={p.data} />
        )}
      </div>
    </section>
  );
}

type SortKey = 'name' | 'count' | 'total' | 'share' | 'avg' | 'min' | 'max' | 'std' | 'bytes' | 'rate';

function StatsTable({ data, def, range, useAlt, filter, onPickName, onJump }: Props & { def: TabDef }) {
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'total', desc: true });
  const alt = useAlt && def.id === 'kernels';
  const stats = useMemo(() => computeStats(data, def.kinds, { range, useAlt: alt }), [data, def, range, alt]);
  const matcher = useMemo(() => (filter.exact ? null : buildMatcher(filter)), [filter]);
  const rows = useMemo(() => {
    let r = stats.rows;
    if (matcher) r = r.filter((x) => matcher.test(data.strings[x.name]));
    const k = sort.key;
    const val = (x: StatRow): number | string =>
      k === 'name' ? data.strings[x.name] : k === 'rate' ? (x.total ? x.bytes / x.total : 0) : (x[k] as number);
    const out = r.slice().sort((a, b) => {
      const va = val(a);
      const vb = val(b);
      const c = typeof va === 'string' ? va.localeCompare(vb as string) : (va as number) - (vb as number);
      return sort.desc ? -c : c;
    });
    return out;
  }, [stats, matcher, sort, data]);

  const shown = rows.slice(0, 1000);
  const totals = useMemo(() => {
    let c = 0;
    let t = 0;
    for (const r of rows) {
      c += r.count;
      t += r.total;
    }
    return { c, t };
  }, [rows]);
  const head = (key: SortKey, label: string, cls = 'num') => (
    <th
      className={`${cls} ${sort.key === key ? 'sorted' : ''}`}
      onClick={() => setSort((s) => ({ key, desc: s.key === key ? !s.desc : key !== 'name' }))}
    >
      {label}
      {sort.key === key && (sort.desc ? <ArrowDown size={11} /> : <ArrowUp size={11} />)}
    </th>
  );

  if (!stats.rows.length) {
    return <div className="empty">No {def.label.toLowerCase()} events{range ? ' in the selected range' : ''}.</div>;
  }

  return (
    <div className="table-wrap">
      <table className="stats">
        <thead>
          <tr>
            {head('name', 'Name', 'name')}
            {head('total', 'Total time')}
            {head('share', '%')}
            {head('count', 'Count')}
            {head('avg', 'Avg')}
            {head('min', 'Min')}
            {head('max', 'Max')}
            {head('std', 'Std dev')}
            {def.memory && head('bytes', 'Total size')}
            {def.memory && head('rate', 'Avg throughput')}
            <th />
          </tr>
        </thead>
        <tbody>
          {shown.map((r) => {
            const name = data.strings[r.name];
            const active = filter.exact && filter.text === name;
            return (
              <tr key={r.name} className={active ? 'active' : ''} onClick={() => onPickName(name)} title={name}>
                <td className="name">
                  <span className="swatch" style={{ background: eventColor(def.kinds[0] === Kind.Memcpy ? (name === 'Memset' ? Kind.Memset : Kind.Memcpy) : def.kinds[0], name) }} />
                  <span className="name-text">{name}</span>
                </td>
                <td className="num strong">{fmtDur(r.total)}</td>
                <td className="num share">
                  <div className="share-cell">
                    <div className="share-track">
                      <div style={{ width: `${Math.max(2, r.share * 100)}%` }} />
                    </div>
                    <span>{fmtPct(r.share)}</span>
                  </div>
                </td>
                <td className="num">{fmtCount(r.count)}</td>
                <td className="num">{fmtDur(r.avg)}</td>
                <td className="num">{fmtDur(r.min)}</td>
                <td className="num">{fmtDur(r.max)}</td>
                <td className="num">{fmtDur(r.std)}</td>
                {def.memory && <td className="num">{fmtBytes(r.bytes)}</td>}
                {def.memory && <td className="num">{fmtRate(r.bytes, r.total)}</td>}
                <td className="act">
                  <button
                    className="icon-btn sm"
                    title="Jump to the longest instance"
                    onClick={(e) => {
                      e.stopPropagation();
                      onJump(r.longest, true);
                    }}
                  >
                    <Crosshair size={13} />
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="table-foot">
        {fmtCount(rows.length)} names · {fmtCount(totals.c)} events · {fmtDur(totals.t)} total
        {matcher && ` (filtered by “${filter.text}”)`}
        {rows.length > shown.length && ` · showing top ${shown.length}`} · click a row to highlight it on the timeline
      </div>
    </div>
  );
}

const PRESETS: Array<{ label: string; sql: string }> = [
  { label: 'Tables', sql: "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name;" },
  {
    label: 'Top kernels',
    sql: `SELECT s.value AS kernel, COUNT(*) AS launches,
       ROUND(SUM(k.end - k.start) / 1e6, 3) AS total_ms,
       ROUND(AVG(k.end - k.start) / 1e3, 2) AS avg_us
FROM CUPTI_ACTIVITY_KIND_KERNEL AS k
JOIN StringIds AS s ON s.id = k.shortName
GROUP BY kernel ORDER BY total_ms DESC LIMIT 25;`,
  },
  {
    label: 'Launch latency',
    sql: `SELECT s.value AS api,
       COUNT(*) AS launches,
       ROUND(AVG(k.start - r.end) / 1e3, 2) AS avg_queue_us,
       ROUND(MAX(k.start - r.end) / 1e3, 2) AS max_queue_us
FROM CUPTI_ACTIVITY_KIND_KERNEL AS k
JOIN CUPTI_ACTIVITY_KIND_RUNTIME AS r ON r.correlationId = k.correlationId
JOIN StringIds AS s ON s.id = r.nameId
GROUP BY api ORDER BY launches DESC;`,
  },
  {
    label: 'Memcpy by kind',
    sql: `SELECT copyKind, COUNT(*) AS copies,
       ROUND(SUM(bytes) / 1048576.0, 1) AS total_mib,
       ROUND(SUM(bytes) * 1.0 / SUM(end - start), 2) AS avg_gb_per_s
FROM CUPTI_ACTIVITY_KIND_MEMCPY GROUP BY copyKind;`,
  },
  {
    label: 'NVTX ranges',
    sql: `SELECT COALESCE(n.text, s.value) AS range, COUNT(*) AS count,
       ROUND(SUM(n.end - n.start) / 1e6, 3) AS total_ms
FROM NVTX_EVENTS AS n LEFT JOIN StringIds AS s ON s.id = n.textId
WHERE n.end IS NOT NULL GROUP BY range ORDER BY total_ms DESC LIMIT 25;`,
  },
];

function SqlConsole({ client, data }: { client: ProfileClient; data: ProfileData }) {
  const [sql, setSql] = useState(PRESETS[1].sql);
  const [res, setRes] = useState<QueryResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ta = useRef<HTMLTextAreaElement>(null);

  const run = async (q = sql) => {
    setBusy(true);
    setErr(null);
    try {
      setRes(await client.query(q));
    } catch (e) {
      setErr((e as Error).message);
      setRes(null);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!data.tables.includes('CUPTI_ACTIVITY_KIND_KERNEL')) setSql(PRESETS[0].sql);
  }, [data]);

  return (
    <div className="sql">
      <div className="sql-editor">
        <textarea
          ref={ta}
          value={sql}
          spellCheck={false}
          onChange={(e) => setSql(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault();
              run();
            }
          }}
        />
        <div className="sql-bar">
          <button className="btn primary sm" onClick={() => run()} disabled={busy}>
            <Play size={12} /> Run <kbd>⌘↵</kbd>
          </button>
          {PRESETS.map((p) => (
            <button
              key={p.label}
              className="chip"
              onClick={() => {
                setSql(p.sql);
                run(p.sql);
              }}
            >
              {p.label}
            </button>
          ))}
          <span className="dim small sql-note">Runs on an in-memory copy of the file.</span>
        </div>
      </div>
      <div className="sql-result">
        {err && <pre className="sql-error">{err}</pre>}
        {res && !err && (
          <>
            <div className="table-wrap">
              <table className="stats sql-table">
                <thead>
                  <tr>
                    {res.columns.map((c, k) => (
                      <th key={k}>{c}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {res.rows.map((r, k) => (
                    <tr key={k}>
                      {r.map((v, j) => (
                        <td key={j} className={/^-?\d+(\.\d+)?$/.test(v) ? 'num' : ''}>
                          {v}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="table-foot">
              {res.columns.length ? `${fmtCount(res.rows.length)} rows${res.truncated ? ' (truncated)' : ''}` : 'Done'} ·{' '}
              {res.ms.toFixed(1)} ms
            </div>
          </>
        )}
        {!res && !err && <div className="empty">Write a query and press ⌘↵. All tables from the export are available.</div>}
      </div>
    </div>
  );
}
