import type { PlannerProgress } from '../worker/api';

const phaseLabel: Record<PlannerProgress['phase'], string> = {
  load: '1. Loading GTFS',
  'build-raptor': '2. Pre-computing raptor index',
  'gather-stats': '3. Gathering stats',
  rebuild: 'Re-building raptor index',
};

export function ProgressBar({ progress }: { progress: PlannerProgress }) {
  const indeterminate = progress.percent == null;
  const pct = indeterminate ? null : Math.max(0, Math.min(100, progress.percent ?? 0));
  return (
    <section className="progress" aria-live="polite">
      <header className="progress__head">
        <span className="progress__phase">{phaseLabel[progress.phase]}</span>
        {pct !== null && <span className="progress__pct">{pct.toFixed(0)}%</span>}
      </header>
      <div className={`progress__track${indeterminate ? ' progress__track--indeterminate' : ''}`}>
        {pct !== null && <div className="progress__fill" style={{ width: `${pct}%` }} />}
        {indeterminate && <div className="progress__fill progress__fill--indeterminate" />}
      </div>
      <p className="progress__message">
        {progress.message}
        {progress.currentFile && <span className="progress__file"> · {progress.currentFile}</span>}
      </p>
    </section>
  );
}
