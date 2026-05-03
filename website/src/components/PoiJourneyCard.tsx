import type { HydratedTimetableLeg, HydratedJourney } from 'gtfs-sqljs-raptor';
import type { PoiHydratedJourney } from '../worker/api';
import { fmtDuration, fmtTime } from '../util/format';
import { RouteBadge } from './RouteBadge';

function isTimetableLeg(leg: HydratedJourney['legs'][number]): leg is HydratedTimetableLeg {
  return leg.type === 'timetable';
}

interface Props {
  journey: PoiHydratedJourney;
  index: number;
  selected: boolean;
  onSelect: () => void;
}

export function PoiJourneyCard({ journey, index, selected, onSelect }: Props) {
  const total = journey.arrivalTime - journey.departureTime;
  const transfers = journey.middleLegs.filter(isTimetableLeg).length - 1;
  return (
    <article
      className={`journey${selected ? ' journey--selected' : ''}`}
      onClick={onSelect}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
        }
      }}
    >
      <header className="journey__header">
        <div className="journey__times">
          <span className="journey__depart">{fmtTime(journey.departureTime)}</span>
          <span className="journey__arrow" aria-hidden>→</span>
          <span className="journey__arrive">{fmtTime(journey.arrivalTime)}</span>
        </div>
        <div className="journey__meta">
          <span className="journey__pill">{fmtDuration(total)}</span>
          <span className="journey__pill journey__pill--muted">
            {transfers <= 0 ? 'direct' : `${transfers} transfer${transfers > 1 ? 's' : ''}`}
          </span>
          <span className="journey__pill journey__pill--muted">#{index + 1}</span>
        </div>
      </header>
      <ol className="journey__legs">
        <li className="leg leg--transfer">
          <span className="leg__transfer-icon" aria-hidden>⏷</span>
          <div className="leg__body">
            <div className="leg__row leg__row--small">
              <span className="leg__transfer-label">Walk {journey.originWalk.duration}s</span>
              <span className="leg__stop">Origin → boarding stop</span>
            </div>
          </div>
        </li>
        {journey.middleLegs.map((leg, i) => {
          if (leg.type === 'timetable') {
            return (
              <li key={i} className="leg leg--timetable">
                <RouteBadge route={leg.trip.route} />
                <div className="leg__body">
                  <div className="leg__row">
                    <span className="leg__time">{fmtTime(leg.departureTime)}</span>
                    <span className="leg__stop">{leg.origin.stop_name}</span>
                  </div>
                  <div className="leg__row">
                    <span className="leg__time">{fmtTime(leg.arrivalTime)}</span>
                    <span className="leg__stop">{leg.destination.stop_name}</span>
                  </div>
                  <div className="leg__details">
                    {leg.trip.headsign && <span className="leg__headsign">→ {leg.trip.headsign}</span>}
                    <span className="leg__stops">
                      {leg.stopTimes.length} stop{leg.stopTimes.length > 1 ? 's' : ''}
                    </span>
                  </div>
                </div>
              </li>
            );
          }
          return (
            <li key={i} className="leg leg--transfer">
              <span className="leg__transfer-icon" aria-hidden>⏷</span>
              <div className="leg__body">
                <div className="leg__row leg__row--small">
                  <span className="leg__transfer-label">Walk {leg.duration}s</span>
                  <span className="leg__stop">
                    {leg.origin.stop_name === leg.destination.stop_name
                      ? `${leg.origin.stop_name} (transfer)`
                      : `${leg.origin.stop_name} → ${leg.destination.stop_name}`}
                  </span>
                </div>
              </div>
            </li>
          );
        })}
        <li className="leg leg--transfer">
          <span className="leg__transfer-icon" aria-hidden>⏷</span>
          <div className="leg__body">
            <div className="leg__row leg__row--small">
              <span className="leg__transfer-label">Walk {journey.destinationWalk.duration}s</span>
              <span className="leg__stop">Alighting stop → destination</span>
            </div>
          </div>
        </li>
      </ol>
    </article>
  );
}
