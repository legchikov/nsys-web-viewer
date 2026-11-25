import type { ProfileData } from '../model/types';

export interface RowDetails {
  fields: Array<{ key: string; value: string }>;
  stack: Array<{ symbol: string; module: string }>;
}

export interface QueryResult {
  columns: string[];
  rows: string[][];
  truncated: boolean;
  statements: number;
  ms: number;
}

export type Progress = { stage: string; pct?: number };

/** Owns the SQLite worker for one opened profile. */
export class ProfileClient {
  private worker: Worker;
  private seq = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

  constructor() {
    this.worker = new Worker(new URL('../worker/db.worker.ts', import.meta.url), { type: 'module' });
  }

  open(buffer: ArrayBuffer, fileName: string, onProgress: (p: Progress) => void): Promise<ProfileData> {
    return new Promise((resolve, reject) => {
      this.worker.onmessage = (e: MessageEvent) => {
        const m = e.data;
        if (m.type === 'progress') onProgress({ stage: m.stage, pct: m.pct });
        else if (m.type === 'loaded') resolve(m.data as ProfileData);
        else if (m.type === 'error') reject(new Error(m.message));
        else if (m.type === 'reply') {
          const p = this.pending.get(m.id);
          if (!p) return;
          this.pending.delete(m.id);
          if (m.error) p.reject(new Error(m.error));
          else p.resolve(m.result);
        }
      };
      this.worker.onerror = (e) => reject(new Error(e.message || 'Worker failed to start'));
      this.worker.postMessage({ type: 'open', buffer, fileName }, [buffer]);
    });
  }

  private call<T>(msg: Record<string, unknown>): Promise<T> {
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ ...msg, id });
    });
  }

  row(table: string, rowid: number) {
    return this.call<RowDetails>({ type: 'row', table, rowid });
  }

  query(sql: string) {
    return this.call<QueryResult>({ type: 'query', sql });
  }

  dispose() {
    this.worker.terminate();
    for (const p of this.pending.values()) p.reject(new Error('closed'));
    this.pending.clear();
  }
}

export function isReportFile(name: string) {
  return /\.(nsys-rep|qdrep)$/i.test(name);
}

export interface ServerStatus {
  available: boolean;
  nsys: string | null;
  version: string | null;
}

export async function serverStatus(): Promise<ServerStatus> {
  try {
    const r = await fetch('/api/status');
    if (!r.ok) return { available: false, nsys: null, version: null };
    const j = await r.json();
    return { available: true, nsys: j.nsys ?? null, version: j.version ?? null };
  } catch {
    return { available: false, nsys: null, version: null };
  }
}

/** Send a .nsys-rep to the local server, which runs `nsys export --type sqlite`. */
export async function convertReport(file: File, onProgress: (p: Progress) => void): Promise<ArrayBuffer> {
  const started = Date.now();
  const timer = setInterval(() => {
    const s = Math.round((Date.now() - started) / 1000);
    onProgress({ stage: `Converting with nsys export… ${s}s` });
  }, 500);
  onProgress({ stage: 'Uploading report to the local converter…' });
  try {
    const r = await fetch(`/api/convert?name=${encodeURIComponent(file.name)}`, {
      method: 'POST',
      body: file,
      headers: { 'Content-Type': 'application/octet-stream' },
    });
    if (!r.ok) {
      let msg = `Conversion failed (HTTP ${r.status}).`;
      try {
        const j = await r.json();
        msg = j.error + (j.log ? `\n\n${j.log}` : '');
      } catch {
        /* not JSON */
      }
      if (r.status === 404) msg = 'The local converter is not running. Start the app with `npm start` or `npm run dev`.';
      throw new Error(msg);
    }
    clearInterval(timer);
    onProgress({ stage: 'Downloading SQLite export…' });
    return await r.arrayBuffer();
  } finally {
    clearInterval(timer);
  }
}
