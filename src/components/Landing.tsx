import { Check, Copy, FileUp, Lock, Moon, Play, Sun, TriangleAlert } from 'lucide-react';
import { useRef, useState } from 'react';
import type { ServerStatus } from '../data/client';
import type { ThemeName } from '../model/colors';
import { Logo } from './Logo';

interface Props {
  error?: string;
  server: ServerStatus | null;
  onFile: (f: File) => void;
  onSample: () => void;
  theme: ThemeName;
  onTheme: (t: ThemeName) => void;
}

export function Landing({ error, server, onFile, onSample, theme, onTheme }: Props) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="landing">
      <header className="landing-header">
        <div className="brand">
          <Logo size={22} />
          <span>Nsight Systems Web Viewer</span>
        </div>
        <button
          className="icon-btn"
          title={theme === 'dark' ? 'Light theme' : 'Dark theme'}
          onClick={() => onTheme(theme === 'dark' ? 'light' : 'dark')}
        >
          {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
        </button>
      </header>

      <main className="landing-main">
        <h1>
          See what your GPU is <em>really</em> doing.
        </h1>
        <p className="lede">
          Open an Nsight Systems profile to explore kernels, memory transfers, CUDA API calls and NVTX ranges on a fast,
          zoomable timeline.
        </p>

        {error && (
          <div className="landing-error" role="alert">
            <TriangleAlert size={16} />
            <pre>{error}</pre>
          </div>
        )}

        <div
          className="dropzone"
          onClick={() => input.current?.click()}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && input.current?.click()}
        >
          <div className="dropzone-icon">
            <FileUp size={26} />
          </div>
          <div className="dropzone-title">Drop a profile here, or click to choose</div>
          <div className="dropzone-sub">
            <code>.sqlite</code> exports from <code>nsys export</code>
            {' · '}
            <code>.nsys-rep</code> reports {server?.nsys ? '(converted locally)' : '(needs nsys installed)'}
          </div>
          <input
            ref={input}
            type="file"
            hidden
            accept=".sqlite,.sqlite3,.db,.nsys-rep,.qdrep"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onFile(f);
              e.target.value = '';
            }}
          />
        </div>

        <div className="landing-actions">
          <button className="btn primary" onClick={onSample}>
            <Play size={14} /> Open the sample profile
          </button>
          <ServerPill server={server} />
        </div>

        <section className="howto">
          <h2>Getting a SQLite export</h2>
          <p>On the machine where you profiled (or anywhere nsys is installed):</p>
          <Cmd text="nsys export --type sqlite --output report.sqlite report.nsys-rep" />
          <p>Or export while profiling:</p>
          <Cmd text="nsys profile --trace cuda,nvtx,osrt --export sqlite -o report python train.py" />
          <p className="dim">
            If the Nsight Systems app is installed on this Mac, <code>.nsys-rep</code> files are converted automatically. Set{' '}
            <code>NSYS_PATH</code> if it isn&rsquo;t found.
          </p>
        </section>

        <p className="privacy">
          <Lock size={13} /> Everything runs on your computer. Profiles are never uploaded anywhere.
        </p>
      </main>
    </div>
  );
}

function ServerPill({ server }: { server: ServerStatus | null }) {
  if (!server) return <span className="pill">Checking for nsys…</span>;
  if (!server.available) return <span className="pill warn">Static mode · .sqlite files only</span>;
  if (server.nsys)
    return (
      <span className="pill ok" title={server.nsys}>
        <span className="dot" /> nsys found{server.version ? ` · ${server.version.replace(/^NVIDIA Nsight Systems version\s*/i, '')}` : ''}
      </span>
    );
  return (
    <span className="pill warn" title="Install Nsight Systems or set NSYS_PATH to open .nsys-rep files directly">
      nsys not found · .sqlite files only
    </span>
  );
}

function Cmd({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="cmd">
      <code>{text}</code>
      <button
        className="icon-btn sm"
        title="Copy"
        onClick={() => {
          navigator.clipboard?.writeText(text).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          });
        }}
      >
        {copied ? <Check size={14} /> : <Copy size={14} />}
      </button>
    </div>
  );
}
