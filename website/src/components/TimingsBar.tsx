import { fmtMs } from '../util/format';

export interface Timings {
  loadMs?: number;
  inputsMs?: number;
  indexMs?: number;
  computeMs?: number;
  hydrateMs?: number;
  rawCount?: number;
}

export function TimingsBar({ timings }: { timings: Timings }) {
  const items: Array<[string, string, string]> = [];
  if (timings.loadMs !== undefined) items.push(['Load + parse', fmtMs(timings.loadMs), 'GTFS zip → SQLite']);
  if (timings.inputsMs !== undefined) items.push(['Read inputs', fmtMs(timings.inputsMs), 'buildRaptorInputs']);
  if (timings.indexMs !== undefined) items.push(['Build index', fmtMs(timings.indexMs), 'RaptorAlgorithmFactory.create']);
  if (timings.computeMs !== undefined) items.push(['Compute', fmtMs(timings.computeMs), 'raptor scan']);
  if (timings.hydrateMs !== undefined) items.push(['Hydrate', fmtMs(timings.hydrateMs), 'stop + route join']);
  if (items.length === 0) return null;
  return (
    <div className="timings">
      {items.map(([label, value, hint]) => (
        <div key={label} className="timings__item" title={hint}>
          <span className="timings__label">{label}</span>
          <span className="timings__value">{value}</span>
        </div>
      ))}
      {timings.rawCount !== undefined && (
        <div className="timings__item timings__item--muted" title="Raw journeys before hydration">
          <span className="timings__label">Raw journeys</span>
          <span className="timings__value">{timings.rawCount}</span>
        </div>
      )}
    </div>
  );
}
