import {
  ChevronDown,
  ChevronUp,
  FolderOpen,
  Keyboard,
  Maximize2,
  Moon,
  PanelBottom,
  PanelRight,
  Search,
  Sun,
  X,
} from 'lucide-react';
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import type { ProfileClient } from '../data/client';
import { assignKernelColors, THEMES, type ThemeName } from '../model/colors';
import { buildFilterIndex, type Filter } from '../model/filter';
import { fmtBytes, fmtCount, fmtDur } from '../model/format';
import { buildLayout, initialCollapsed } from '../model/layout';
import { computeStats, correlated } from '../model/stats';
import { Kind, type EventRef, type ProfileData, type TimeRange } from '../model/types';
import { resetColorCache } from '../timeline/draw';
import { Timeline, type TimelineHandle } from '../timeline/Timeline';
import { BottomPanel } from './BottomPanel';
import { DetailsPanel } from './DetailsPanel';
import { HelpOverlay } from './HelpOverlay';
import { Logo } from './Logo';

interface Props {
  data: ProfileData;
  client: ProfileClient;
  theme: ThemeName;
  onTheme: (t: ThemeName) => void;
  onOpenFile: (f: File) => void;
  onClose: () => void;
}

function usePersisted<T>(key: string, initial: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try {
      const s = localStorage.getItem(key);
      return s ? (JSON.parse(s) as T) : initial;
    } catch {
      return initial;
    }
  });
  const set = useCallback(
    (nv: T) => {
      setV(nv);
      try {
        localStorage.setItem(key, JSON.stringify(nv));
      } catch {
        /* ignore */
      }
    },
    [key],
  );
  return [v, set];
}

/** Shows the visible time window without re-rendering the whole viewer on every frame. */
function ViewSpan({ listen, initial }: { listen: React.MutableRefObject<((v: TimeRange) => void) | null>; initial: number }) {
  const [span, setSpan] = useState(initial);
  useEffect(() => {
    listen.current = (v) => setSpan(v.t1 - v.t0);
    return () => {
      listen.current = null;
    };
  }, [listen]);
  return <span title="Visible time window">view {fmtDur(span)}</span>;
}

export function Viewer({ data, client, theme, onTheme, onOpenFile, onClose }: Props) {
  const tl = useRef<TimelineHandle>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Most expensive kernels get the most distinct colours.
  useState(() => {
    assignKernelColors(computeStats(data, [Kind.Kernel]).rows.map((r) => data.strings[r.name]));
    resetColorCache();
  });
  const [collapsed, setCollapsed] = useState(() => initialCollapsed(data));
  const [selection, setSelection] = useState<EventRef | null>(null);
  const [range, setRange] = useState<TimeRange | null>(null);
  const [filter, setFilter] = useState<Filter>({ text: '', exact: false });
  const [useAlt, setUseAlt] = usePersisted('nsv-demangled', false);
  const [labelWidth, setLabelWidth] = usePersisted('nsv-label-w', 236);
  const [showDetails, setShowDetails] = usePersisted('nsv-details', true);
  const [showBottom, setShowBottom] = usePersisted('nsv-bottom', true);
  const [bottomH, setBottomH] = usePersisted('nsv-bottom-h', 280);
  const [help, setHelp] = useState(false);
  const viewListener = useRef<((v: TimeRange) => void) | null>(null);
  const onViewChange = useCallback((v: TimeRange) => viewListener.current?.(v), []);
  const matchCursor = useRef(-1);

  const layout = useMemo(() => buildLayout(data, collapsed), [data, collapsed]);
  const deferredFilter = useDeferredValue(filter);
  const filterIndex = useMemo(() => buildFilterIndex(data, deferredFilter), [data, deferredFilter]);
  const partners = useMemo(() => (selection ? correlated(data, selection) : []), [data, selection]);

  useEffect(() => {
    matchCursor.current = -1;
  }, [filterIndex]);

  const onToggle = useCallback((gid: string) => {
    setCollapsed((prev) => {
      const n = new Set(prev);
      if (n.has(gid)) n.delete(gid);
      else n.add(gid);
      return n;
    });
  }, []);

  const onExpandTo = useCallback(
    (trackId: number) => {
      const t = data.tracks[trackId];
      setCollapsed((prev) => {
        const n = new Set(prev);
        let g: string | null = t.groupId;
        while (g) {
          n.delete(g);
          g = data.groups[g]?.parentId ?? null;
        }
        return n;
      });
    },
    [data],
  );

  const select = useCallback((r: EventRef | null) => {
    setSelection(r);
    if (r) setShowDetails(true);
  }, [setShowDetails]);

  const jumpTo = useCallback(
    (r: EventRef, zoom = true) => {
      setSelection(r);
      tl.current?.reveal(r, zoom);
    },
    [],
  );

  const stepMatch = useCallback(
    (dir: 1 | -1) => {
      const fi = filterIndex;
      if (!fi || !fi.count) return;
      const o = fi.order;
      let i = matchCursor.current;
      if (i < 0) {
        // start from the current view
        const c = tl.current?.getView();
        const t = c ? c.t0 : data.minTime;
        let lo = 0;
        let hi = fi.count;
        while (lo < hi) {
          const m = (lo + hi) >> 1;
          if (o.start[m] < t) lo = m + 1;
          else hi = m;
        }
        i = dir > 0 ? lo : lo - 1;
      } else i += dir;
      i = (i + fi.count) % fi.count;
      matchCursor.current = i;
      const r = { track: o.track[i], index: o.index[i] };
      setSelection(r);
      tl.current?.reveal(r, false);
    },
    [filterIndex, data],
  );

  // Global shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      const typing = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        fileInput.current?.click();
        return;
      }
      if (typing) {
        if (e.key === 'Escape') (el as HTMLInputElement).blur();
        return;
      }
      if (e.metaKey || e.ctrlKey) return;
      switch (e.key) {
        case '/':
          e.preventDefault();
          searchRef.current?.focus();
          break;
        case 'Escape':
          if (help) setHelp(false);
          else if (selection) setSelection(null);
          else if (range) setRange(null);
          else if (filter.text) setFilter({ text: '', exact: false });
          break;
        case 'f':
        case 'F':
          tl.current?.zoomToSelection();
          break;
        case '0':
          tl.current?.fitAll();
          break;
        case '?':
          setHelp((h) => !h);
          break;
        case 'n':
          stepMatch(1);
          break;
        case 'N':
          stepMatch(-1);
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [help, selection, range, filter, stepMatch]);

  const pickName = useCallback((name: string) => {
    setFilter((f) => (f.exact && f.text === name ? { text: '', exact: false } : { text: name, exact: true }));
  }, []);

  const onBottomResize = (e: React.PointerEvent) => {
    const startY = e.clientY;
    const startH = bottomH;
    let latest = startH;
    const move = (ev: PointerEvent) => {
      latest = Math.min(window.innerHeight - 220, Math.max(120, startH - (ev.clientY - startY)));
      document.documentElement.style.setProperty('--bottom-h', `${latest}px`);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.classList.remove('row-resizing');
      setBottomH(latest);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    document.body.classList.add('row-resizing');
    e.preventDefault();
  };

  useEffect(() => {
    document.documentElement.style.setProperty('--bottom-h', `${bottomH}px`);
  }, [bottomH]);

  const matchInfo = filterIndex
    ? filterIndex.error
      ? 'invalid regex'
      : `${fmtCount(filterIndex.count)} match${filterIndex.count === 1 ? '' : 'es'}`
    : '';

  return (
    <div className={`viewer ${showDetails ? 'with-details' : ''} ${showBottom ? 'with-bottom' : ''}`}>
      <header className="topbar">
        <button className="brand-btn" onClick={onClose} title="Close profile">
          <Logo size={20} />
        </button>
        <div className="file-info">
          <div className="file-name" title={data.fileName}>
            {data.fileName}
          </div>
          <div className="file-meta">
            {fmtDur(data.sessionDuration)} · {fmtBytes(data.fileSize)} ·{' '}
            <ViewSpan listen={viewListener} initial={data.maxTime - data.minTime} />
          </div>
        </div>

        <div className={`search ${filter.text ? 'active' : ''}`}>
          <Search size={14} className="search-icon" />
          <input
            ref={searchRef}
            placeholder="Search events…  (/ or ⌘F, /regex/ supported)"
            value={filter.text}
            spellCheck={false}
            onChange={(e) => setFilter({ text: e.target.value, exact: false })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                stepMatch(e.shiftKey ? -1 : 1);
              }
            }}
          />
          {filter.text && (
            <>
              <span className="search-count">{matchInfo}</span>
              <button className="icon-btn sm" title="Previous match (Shift+Enter)" onClick={() => stepMatch(-1)}>
                <ChevronUp size={14} />
              </button>
              <button className="icon-btn sm" title="Next match (Enter)" onClick={() => stepMatch(1)}>
                <ChevronDown size={14} />
              </button>
              <button className="icon-btn sm" title="Clear (Esc)" onClick={() => setFilter({ text: '', exact: false })}>
                <X size={14} />
              </button>
            </>
          )}
        </div>

        <div className="topbar-actions">
          <div className="seg" title="How kernel names are shown">
            <button className={!useAlt ? 'on' : ''} onClick={() => setUseAlt(false)}>
              Short names
            </button>
            <button className={useAlt ? 'on' : ''} onClick={() => setUseAlt(true)}>
              Demangled
            </button>
          </div>
          <button className="icon-btn" title="Fit whole profile (0)" onClick={() => tl.current?.fitAll()}>
            <Maximize2 size={16} />
          </button>
          <button
            className={`icon-btn ${showBottom ? 'on' : ''}`}
            title="Toggle statistics panel"
            onClick={() => setShowBottom(!showBottom)}
          >
            <PanelBottom size={16} />
          </button>
          <button
            className={`icon-btn ${showDetails ? 'on' : ''}`}
            title="Toggle details panel"
            onClick={() => setShowDetails(!showDetails)}
          >
            <PanelRight size={16} />
          </button>
          <button className="icon-btn" title="Keyboard shortcuts (?)" onClick={() => setHelp(true)}>
            <Keyboard size={16} />
          </button>
          <button
            className="icon-btn"
            title={theme === 'dark' ? 'Light theme' : 'Dark theme'}
            onClick={() => onTheme(theme === 'dark' ? 'light' : 'dark')}
          >
            {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
          </button>
          <button className="btn" onClick={() => fileInput.current?.click()} title="Open another profile (⌘O)">
            <FolderOpen size={14} /> Open
          </button>
          <input
            ref={fileInput}
            type="file"
            hidden
            accept=".sqlite,.sqlite3,.db,.nsys-rep,.qdrep"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onOpenFile(f);
              e.target.value = '';
            }}
          />
        </div>
      </header>

      <div className="main">
        <div className="center">
          <div className="timeline-wrap">
            <Timeline
              ref={tl}
              data={data}
              layout={layout}
              theme={THEMES[theme]}
              collapsed={collapsed}
              onToggle={onToggle}
              onExpandTo={onExpandTo}
              selection={selection}
              onSelect={select}
              range={range}
              onRange={setRange}
              filter={filterIndex}
              useAlt={useAlt}
              partners={partners}
              labelWidth={labelWidth}
              onLabelWidth={setLabelWidth}
              onViewChange={onViewChange}
            />
          </div>
          {showBottom && (
            <>
              <div className="hresize" onPointerDown={onBottomResize} />
              <BottomPanel
                data={data}
                client={client}
                range={range}
                useAlt={useAlt}
                filter={filter}
                onPickName={pickName}
                onJump={jumpTo}
                onClose={() => setShowBottom(false)}
              />
            </>
          )}
        </div>
        {showDetails && (
          <DetailsPanel
            data={data}
            client={client}
            selection={selection}
            partners={partners}
            range={range}
            useAlt={useAlt}
            onJump={jumpTo}
            onPickName={pickName}
            onZoomRange={(r) => {
              const pad = (r.t1 - r.t0) * 0.04;
              tl.current?.zoomTo(r.t0 - pad, r.t1 + pad);
            }}
            onClearRange={() => setRange(null)}
            onClose={() => setShowDetails(false)}
          />
        )}
      </div>

      <footer className="statusbar">
        <span>
          <kbd>drag</kbd> select range · <kbd>⌥</kbd>/<kbd>space</kbd>+drag pan · <kbd>pinch</kbd>/<kbd>⌘</kbd>+scroll zoom ·{' '}
          <kbd>W</kbd>
          <kbd>A</kbd>
          <kbd>S</kbd>
          <kbd>D</kbd> navigate · <kbd>F</kbd> fit selection · <kbd>?</kbd> all shortcuts
        </span>
        <span className="statusbar-right">
          {data.tracks.length} tracks · loaded in {(data.loadMs / 1000).toFixed(2)} s
        </span>
      </footer>

      {help && <HelpOverlay onClose={() => setHelp(false)} />}
    </div>
  );
}
