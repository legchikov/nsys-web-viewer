import { useCallback, useEffect, useRef, useState } from 'react';
import { Landing } from './components/Landing';
import { Loading } from './components/Loading';
import { Viewer } from './components/Viewer';
import { convertReport, isReportFile, ProfileClient, serverStatus, type Progress, type ServerStatus } from './data/client';
import type { ThemeName } from './model/colors';
import type { ProfileData } from './model/types';

type State =
  | { phase: 'landing'; error?: string }
  | { phase: 'loading'; fileName: string; progress: Progress }
  | { phase: 'ready'; data: ProfileData; client: ProfileClient };

function loadTheme(): ThemeName {
  try {
    const t = localStorage.getItem('nsv-theme');
    if (t === 'dark' || t === 'light') return t;
  } catch {
    /* storage unavailable */
  }
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

export function App() {
  const [state, setState] = useState<State>({ phase: 'landing' });
  const [theme, setTheme] = useState<ThemeName>(loadTheme);
  const [server, setServer] = useState<ServerStatus | null>(null);
  const [dragging, setDragging] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const clientRef = useRef<ProfileClient | null>(null);
  const prevRef = useRef<State | null>(null);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem('nsv-theme', theme);
    } catch {
      /* ignore */
    }
  }, [theme]);

  useEffect(() => {
    serverStatus().then(setServer);
  }, []);

  const loadBuffer = useCallback(async (buffer: ArrayBuffer, fileName: string) => {
    const client = new ProfileClient();
    try {
      const data = await client.open(buffer, fileName, (progress) =>
        setState({ phase: 'loading', fileName, progress }),
      );
      clientRef.current?.dispose();
      clientRef.current = client;
      setState({ phase: 'ready', data, client });
      document.title = `${fileName} · Nsight Systems Web Viewer`;
    } catch (err) {
      client.dispose();
      throw err;
    }
  }, []);

  const openFile = useCallback(
    async (file: File) => {
      prevRef.current = state.phase === 'ready' ? state : null;
      setState({ phase: 'loading', fileName: file.name, progress: { stage: 'Reading file…', pct: 0 } });
      try {
        let buffer: ArrayBuffer;
        let name = file.name;
        if (isReportFile(file.name)) {
          buffer = await convertReport(file, (progress) => setState({ phase: 'loading', fileName: file.name, progress }));
          name = file.name.replace(/\.(nsys-rep|qdrep)$/i, '.sqlite');
        } else {
          buffer = await file.arrayBuffer();
        }
        await loadBuffer(buffer, name);
      } catch (err) {
        const message = (err as Error).message;
        if (prevRef.current) {
          setState(prevRef.current);
          setToast(message);
        } else setState({ phase: 'landing', error: message });
      }
    },
    [loadBuffer, state],
  );

  const openSample = useCallback(async () => {
    setState({ phase: 'loading', fileName: 'sample.sqlite', progress: { stage: 'Downloading sample…', pct: 0 } });
    try {
      const r = await fetch('/sample.sqlite');
      if (!r.ok) throw new Error(`Could not load the sample profile (HTTP ${r.status}).`);
      await loadBuffer(await r.arrayBuffer(), 'sample.sqlite');
    } catch (err) {
      setState({ phase: 'landing', error: (err as Error).message });
    }
  }, [loadBuffer]);

  // Drag & drop anywhere in the window
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth++;
      setDragging(true);
      e.preventDefault();
    };
    const over = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    const leave = () => {
      depth = Math.max(0, depth - 1);
      if (!depth) setDragging(false);
    };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      const f = e.dataTransfer?.files?.[0];
      if (f) openFile(f);
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
    };
  }, [openFile]);

  const close = useCallback(() => {
    clientRef.current?.dispose();
    clientRef.current = null;
    setState({ phase: 'landing' });
    document.title = 'Nsight Systems Web Viewer';
  }, []);

  return (
    <>
      {state.phase === 'landing' && (
        <Landing
          error={state.error}
          server={server}
          onFile={openFile}
          onSample={openSample}
          theme={theme}
          onTheme={setTheme}
        />
      )}
      {state.phase === 'loading' && <Loading fileName={state.fileName} progress={state.progress} />}
      {state.phase === 'ready' && (
        <Viewer
          key={state.data.fileName + state.data.loadMs}
          data={state.data}
          client={state.client}
          theme={theme}
          onTheme={setTheme}
          onOpenFile={openFile}
          onClose={close}
        />
      )}
      {toast && (
        <div className="toast" role="alert">
          <div className="toast-body">{toast}</div>
          <button className="btn ghost sm" onClick={() => setToast(null)}>
            Dismiss
          </button>
        </div>
      )}
      {dragging && (
        <div className="drop-overlay">
          <div className="drop-card">
            <div className="drop-title">Drop to open</div>
            <div className="drop-sub">.sqlite export or .nsys-rep report</div>
          </div>
        </div>
      )}
    </>
  );
}
