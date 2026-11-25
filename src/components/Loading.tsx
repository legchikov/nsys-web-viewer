import type { Progress } from '../data/client';

export function Loading({ fileName, progress }: { fileName: string; progress: Progress }) {
  const pct = progress.pct;
  return (
    <div className="loading">
      <div className="loading-card">
        <div className="loading-spinner" />
        <div className="loading-file">{fileName}</div>
        <div className="loading-stage">{progress.stage}</div>
        <div className={`loading-bar ${pct === undefined ? 'indeterminate' : ''}`}>
          <div style={{ width: pct === undefined ? '35%' : `${Math.max(3, pct)}%` }} />
        </div>
      </div>
    </div>
  );
}
