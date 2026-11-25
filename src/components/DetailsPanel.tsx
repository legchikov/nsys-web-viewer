import { ArrowRight, ChevronDown, ChevronRight, Copy, Crosshair, Highlighter, X } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { ProfileClient, RowDetails } from '../data/client';
import { argbColor, eventColor } from '../model/colors';
import { fmtBytes, fmtCount, fmtDur, fmtPct, fmtRate, fmtTime } from '../model/format';
import { computeStats, eventTracks, gpuBusy } from '../model/stats';
import { KIND_LABEL, Kind, type EventRef, type EventTrack, type ProfileData, type TimeRange } from '../model/types';

interface Props {
  data: ProfileData;
  client: ProfileClient;
  selection: EventRef | null;
  partners: EventRef[];
  range: TimeRange | null;
  useAlt: boolean;
  onJump: (r: EventRef, zoom?: boolean) => void;
  onPickName: (name: string) => void;
  onZoomRange: (r: TimeRange) => void;
  onClearRange: () => void;
  onClose: () => void;
}

export function DetailsPanel(p: Props) {
  let body: ReactNode;
  let title = 'Profile';
  if (p.selection) {
    title = 'Event';
    body = <EventDetails {...p} selection={p.selection} />;
  } else if (p.range) {
    title = 'Time range';
    body = <RangeDetails {...p} range={p.range} />;
  } else body = <ProfileSummary data={p.data} />;
  return (
    <aside className="details">
      <div className="panel-head">
        <span className="panel-title">{title}</span>
        <button className="icon-btn sm" onClick={p.onClose} title="Hide panel">
          <X size={14} />
        </button>
      </div>
      <div className="details-body">{body}</div>
    </aside>
  );
}

function Swatch({ color }: { color: string }) {
  return <span className="swatch" style={{ background: color }} />;
}

function KV({ rows }: { rows: Array<[string, ReactNode] | null | false> }) {
  return (
    <dl className="kv">
      {rows.filter(Boolean).map((r) => {
        const [k, v] = r as [string, ReactNode];
        return (
          <div key={k} className="kv-row">
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        );
      })}
    </dl>
  );
}

function threadLabel(data: ProfileData, t: EventTrack) {
  const g = data.groups[t.groupId];
  if (!g) return t.label;
  return `${g.label} (${g.sublabel ?? ''})`;
}

function EventDetails({ data, client, selection, partners, useAlt, onJump, onPickName }: Props & { selection: EventRef }) {
  const t = data.tracks[selection.track] as EventTrack;
  const i = selection.index;
  const [row, setRow] = useState<RowDetails | null>(null);
  const [showAll, setShowAll] = useState(false);
  const table = t.tables[t.src[i]];
  const rowid = t.rowid[i];

  useEffect(() => {
    let alive = true;
    setRow(null);
    client
      .row(table, rowid)
      .then((r) => alive && setRow(r))
      .catch(() => alive && setRow({ fields: [], stack: [] }));
    return () => {
      alive = false;
    };
  }, [client, table, rowid]);

  const kind = t.kind[i];
  const name = data.strings[t.name[i]];
  const alt = t.alt ? data.strings[t.alt[i]] : null;
  const shown = useAlt && alt ? alt : name;
  const dur = t.end[i] - t.start[i];
  const f = useMemo(() => Object.fromEntries((row?.fields ?? []).map((x) => [x.key, x.value])), [row]);
  const color = t.color && t.color[i] ? argbColor(t.color[i]) : eventColor(kind, name);
  const instant = kind === Kind.Nvtx && dur === 0;

  // Stats for all events with the same name
  const same = useMemo(() => {
    const s = computeStats(data, [kind], { useAlt: useAlt && !!alt });
    const nm = useAlt && t.alt ? t.alt[i] : t.name[i];
    return s.rows.find((r) => r.name === nm) ?? null;
  }, [data, kind, useAlt, alt, t, i]);

  const isGpu = t.role === 'gpu';
  const gpuRows: Array<[string, ReactNode] | null> = isGpu
    ? [
        ['Device', `GPU ${t.deviceId}${data.groups[t.groupId]?.sublabel ? ` · ${data.groups[t.groupId]!.sublabel}` : ''}`],
        ['Stream', String(t.streamId)],
        f.contextId ? ['Context', f.contextId] : null,
        kind === Kind.Kernel && f.gridX ? ['Grid', `${f.gridX} × ${f.gridY} × ${f.gridZ}`] : null,
        kind === Kind.Kernel && f.blockX ? ['Block', `${f.blockX} × ${f.blockY} × ${f.blockZ}`] : null,
        kind === Kind.Kernel && f.registersPerThread ? ['Registers / thread', f.registersPerThread] : null,
        kind === Kind.Kernel && f.staticSharedMemory !== undefined
          ? ['Shared memory', `${fmtBytes(Number(f.staticSharedMemory))} static · ${fmtBytes(Number(f.dynamicSharedMemory ?? 0))} dynamic`]
          : null,
        kind === Kind.Kernel && Number(f.localMemoryTotal) > 0 ? ['Local memory', fmtBytes(Number(f.localMemoryTotal))] : null,
        kind === Kind.Kernel && f.graphNodeId && f.graphNodeId !== '—' ? ['Graph node', f.graphNodeId] : null,
        t.bytes && t.bytes[i] === t.bytes[i] ? ['Size', fmtBytes(t.bytes[i])] : null,
        t.bytes && t.bytes[i] === t.bytes[i] ? ['Throughput', fmtRate(t.bytes[i], dur)] : null,
        f.srcKind && f.srcKind !== '—' ? ['Source memory', f.srcKind] : null,
        f.dstKind && f.dstKind !== '—' ? ['Destination memory', f.dstKind] : null,
      ]
    : [
        ['Thread', threadLabel(data, t)],
        f.returnValue !== undefined ? ['Return value', f.returnValue] : null,
        kind === Kind.Nvtx && f.domainId ? ['Domain', f.domainId] : null,
        kind === Kind.Nvtx && f.category && f.category !== '—' ? ['Category', f.category] : null,
      ];

  const payload =
    kind === Kind.Nvtx
      ? ['int64Value', 'uint64Value', 'doubleValue', 'int32Value', 'uint32Value', 'floatValue', 'jsonText']
          .filter((k) => f[k] && f[k] !== '—')
          .map((k) => [k.replace(/Value$/, ''), f[k]] as [string, string])
      : [];

  return (
    <div className="ev">
      <div className="ev-head">
        <Swatch color={color} />
        <span className="ev-kind">{instant ? 'NVTX mark' : KIND_LABEL[kind]}</span>
        <span className="ev-track">{t.label}</span>
      </div>
      <div className={`ev-name ${kind === Kind.Kernel ? 'mono' : ''}`}>{shown}</div>
      {alt && alt !== shown && (
        <details className="ev-alt">
          <summary>{useAlt ? 'Short name' : 'Demangled name'}</summary>
          <div className="mono">{useAlt ? name : alt}</div>
        </details>
      )}

      <div className="ev-actions">
        <button className="btn sm" onClick={() => onJump(selection, true)} title="Zoom to event (F)">
          <Crosshair size={13} /> Zoom
        </button>
        <button className="btn sm" onClick={() => onPickName(shown)} title="Highlight all events with this name">
          <Highlighter size={13} /> Highlight all
        </button>
        <button className="btn sm" onClick={() => navigator.clipboard?.writeText(shown)} title="Copy name">
          <Copy size={13} /> Copy
        </button>
      </div>

      <div className="ev-timing">
        <div>
          <span>Duration</span>
          <b>{instant ? '—' : fmtDur(dur)}</b>
        </div>
        <div>
          <span>Start</span>
          <b>{fmtTime(t.start[i])}</b>
        </div>
        <div>
          <span>End</span>
          <b>{fmtTime(t.end[i])}</b>
        </div>
      </div>

      <KV rows={gpuRows} />
      {payload.length > 0 && (
        <>
          <h4>Payload</h4>
          <KV rows={payload} />
        </>
      )}

      {partners.length > 0 && (
        <>
          <h4>{isGpu ? 'Launched by' : partners.length === 1 ? 'Launched GPU work' : `Launched ${partners.length} GPU operations`}</h4>
          <div className="links">
            {partners.slice(0, 8).map((pr) => {
              const pt = data.tracks[pr.track] as EventTrack;
              const nm = data.strings[(useAlt && pt.alt ? pt.alt : pt.name)[pr.index]];
              const lat = isGpu ? t.start[i] - pt.start[pr.index] : pt.start[pr.index] - t.start[i];
              return (
                <button key={`${pr.track}:${pr.index}`} className="link-row" onClick={() => onJump(pr, false)}>
                  <Swatch color={eventColor(pt.kind[pr.index], data.strings[pt.name[pr.index]])} />
                  <span className="link-name">{nm}</span>
                  <span className="link-meta">
                    {isGpu ? threadLabel(data, pt) : pt.label} · {isGpu ? 'launch → start' : 'start after'} {fmtDur(lat)}
                  </span>
                  <ArrowRight size={13} />
                </button>
              );
            })}
            {partners.length > 8 && <div className="dim small">…and {partners.length - 8} more</div>}
          </div>
        </>
      )}

      {same && same.count > 1 && (
        <>
          <h4>All instances of this name</h4>
          <KV
            rows={[
              ['Instances', fmtCount(same.count)],
              ['Total time', fmtDur(same.total)],
              ['Average', fmtDur(same.avg)],
              ['Min / max', `${fmtDur(same.min)} / ${fmtDur(same.max)}`],
              ['This one', dur > same.avg ? `${(dur / same.avg).toFixed(2)}× average` : `${fmtPct(dur / same.avg)} of average`],
            ]}
          />
          {same.longest.track >= 0 && (same.longest.track !== selection.track || same.longest.index !== selection.index) && (
            <button className="btn sm ghost" onClick={() => onJump(same.longest, true)}>
              Jump to longest ({fmtDur(same.max)})
            </button>
          )}
        </>
      )}

      {row && row.stack.length > 0 && (
        <>
          <h4>Call stack</h4>
          <ol className="stack">
            {row.stack.map((s, k) => (
              <li key={k}>
                <span className="mono">{s.symbol}</span>
                {s.module && <span className="dim"> · {s.module.split('/').pop()}</span>}
              </li>
            ))}
          </ol>
        </>
      )}

      <button className="disclosure" onClick={() => setShowAll(!showAll)}>
        {showAll ? <ChevronDown size={14} /> : <ChevronRight size={14} />} All fields
        <span className="dim small">
          {table} · row {rowid}
        </span>
      </button>
      {showAll && (
        <dl className="kv raw">
          {(row?.fields ?? []).map((x) => (
            <div key={x.key} className="kv-row">
              <dt>{x.key}</dt>
              <dd className="mono">{x.value}</dd>
            </div>
          ))}
          {!row && <div className="dim">Loading…</div>}
        </dl>
      )}
    </div>
  );
}

function RangeDetails({ data, range, onZoomRange, onClearRange, onJump, useAlt }: Props & { range: TimeRange }) {
  const busy = useMemo(() => gpuBusy(data, range), [data, range]);
  const kernels = useMemo(() => computeStats(data, [Kind.Kernel], { range, useAlt }), [data, range, useAlt]);
  const counts = useMemo(() => {
    const c: Record<number, number> = {};
    for (const t of eventTracks(data)) {
      for (let i = 0; i < t.n; i++) {
        if (t.end[i] >= range.t0 && t.start[i] <= range.t1) c[t.kind[i]] = (c[t.kind[i]] ?? 0) + 1;
      }
    }
    return c;
  }, [data, range]);

  return (
    <div className="ev">
      <div className="range-dur">{fmtDur(range.t1 - range.t0)}</div>
      <div className="dim small">
        {fmtTime(range.t0)} → {fmtTime(range.t1)}
      </div>
      <div className="ev-actions">
        <button className="btn sm" onClick={() => onZoomRange(range)}>
          <Crosshair size={13} /> Zoom to range
        </button>
        <button className="btn sm ghost" onClick={onClearRange}>
          Clear
        </button>
      </div>
      {busy.length > 0 && (
        <>
          <h4>GPU utilisation</h4>
          {busy.map((b) => (
            <div key={b.deviceId} className="meter">
              <span>GPU {b.deviceId}</span>
              <div className="meter-bar">
                <div style={{ width: `${Math.min(100, b.busy * 100)}%` }} />
              </div>
              <b>{fmtPct(b.busy)}</b>
            </div>
          ))}
          <p className="dim small">Share of the range with at least one kernel or memory operation running.</p>
        </>
      )}
      <h4>Events in range</h4>
      <KV
        rows={Object.entries(counts)
          .sort((a, b) => b[1] - a[1])
          .map(([k, v]) => [KIND_LABEL[Number(k)], fmtCount(v)] as [string, string])}
      />
      {kernels.rows.length > 0 && (
        <>
          <h4>Top kernels in range</h4>
          <div className="links">
            {kernels.rows.slice(0, 6).map((r) => (
              <button key={r.name} className="link-row" onClick={() => onJump(r.longest, false)}>
                <Swatch color={eventColor(Kind.Kernel, data.strings[r.name])} />
                <span className="link-name">{data.strings[r.name]}</span>
                <span className="link-meta">
                  {fmtPct(r.share)} · {fmtCount(r.count)}×
                </span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function ProfileSummary({ data }: { data: ProfileData }) {
  const counts = useMemo(() => {
    const c: Record<number, number> = {};
    for (const t of eventTracks(data)) for (let i = 0; i < t.n; i++) c[t.kind[i]] = (c[t.kind[i]] ?? 0) + 1;
    return c;
  }, [data]);
  const gpus = Object.values(data.groups).filter((g) => g.kind === 'gpu');
  const procs = Object.values(data.groups).filter((g) => g.kind === 'process');
  const threads = Object.values(data.groups).filter((g) => g.kind === 'thread');
  const busy = useMemo(() => gpuBusy(data, { t0: data.minTime, t1: data.maxTime }), [data]);
  return (
    <div className="ev">
      <div className="ev-name">{data.fileName}</div>
      <KV
        rows={[
          ['Session length', fmtDur(data.sessionDuration)],
          ['Activity span', `${fmtTime(data.minTime)} → ${fmtTime(data.maxTime)}`],
          ['File size', fmtBytes(data.fileSize)],
          ['Processes', String(procs.length)],
          ['Threads with events', String(threads.length)],
        ]}
      />
      {gpus.length > 0 && (
        <>
          <h4>GPUs</h4>
          {gpus.map((g) => {
            const dev = Number(g.id.split(':')[1]);
            const b = busy.find((x) => x.deviceId === dev);
            return (
              <div key={g.id} className="gpu-card" title={g.tooltip}>
                <div>
                  <b>{g.label}</b> <span className="dim">{g.sublabel}</span>
                </div>
                {b && (
                  <div className="meter">
                    <span>busy</span>
                    <div className="meter-bar">
                      <div style={{ width: `${Math.min(100, b.busy * 100)}%` }} />
                    </div>
                    <b>{fmtPct(b.busy)}</b>
                  </div>
                )}
              </div>
            );
          })}
        </>
      )}
      <h4>Events</h4>
      <KV
        rows={Object.entries(counts)
          .sort((a, b) => b[1] - a[1])
          .map(([k, v]) => [KIND_LABEL[Number(k)], fmtCount(v)] as [string, string])}
      />
      {data.info.length > 0 && (
        <>
          <h4>Capture info</h4>
          <KV rows={data.info.slice(0, 24).map(([k, v]) => [k, v] as [string, string])} />
        </>
      )}
      {data.warnings.length > 0 && (
        <>
          <h4>Notes</h4>
          {data.warnings.map((w) => (
            <p key={w} className="dim small">
              {w}
            </p>
          ))}
        </>
      )}
      <p className="hint">Click an event for details, or drag across the timeline to analyse a time range.</p>
    </div>
  );
}
