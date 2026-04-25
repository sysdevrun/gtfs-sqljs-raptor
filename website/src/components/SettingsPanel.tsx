import type { BuildRaptorInputsOptions } from 'gtfs-sqljs-raptor';

export interface PlannerSettings extends BuildRaptorInputsOptions {
  rangeMinutes: number;
}

interface Props {
  value: PlannerSettings;
  onChange: (next: PlannerSettings) => void;
  onApply: () => void;
  rebuilding: boolean;
  feedTimezone: string | null;
}

export function SettingsPanel({ value, onChange, onApply, rebuilding, feedTimezone }: Props) {
  const set = <K extends keyof PlannerSettings>(key: K, v: PlannerSettings[K]) =>
    onChange({ ...value, [key]: v });

  return (
    <details className="settings" open>
      <summary>
        <span>Settings</span>
        {feedTimezone && <span className="settings__tz">feed tz: {feedTimezone}</span>}
      </summary>
      <div className="settings__grid">
        <label className="settings__row">
          <input
            type="checkbox"
            checked={value.bridgeSameNameStops ?? false}
            onChange={(e) => set('bridgeSameNameStops', e.target.checked)}
          />
          <span>
            <strong>Bridge same-name stops</strong>
            <small>
              Add walk transfers between platforms sharing the same <code>stop_name</code>. Needed
              when feeds split a station into per-route platforms without <code>parent_station</code>.
            </small>
          </span>
        </label>
        <label className="settings__row">
          <span className="settings__field">
            Same-name max distance
            <small>{(value.sameNameMaxMeters ?? 250)} m</small>
          </span>
          <input
            type="range"
            min={50}
            max={1000}
            step={10}
            value={value.sameNameMaxMeters ?? 250}
            disabled={!value.bridgeSameNameStops}
            onChange={(e) => set('sameNameMaxMeters', Number(e.target.value))}
          />
        </label>
        <label className="settings__row">
          <span className="settings__field">
            Walking speed
            <small>{(value.walkingSpeedMps ?? 1.2).toFixed(2)} m/s</small>
          </span>
          <input
            type="range"
            min={0.5}
            max={2}
            step={0.1}
            value={value.walkingSpeedMps ?? 1.2}
            disabled={!value.bridgeSameNameStops}
            onChange={(e) => set('walkingSpeedMps', Number(e.target.value))}
          />
        </label>
        <label className="settings__row">
          <input
            type="checkbox"
            checked={value.bridgeParentStations ?? false}
            onChange={(e) => set('bridgeParentStations', e.target.checked)}
          />
          <span>
            <strong>Bridge parent stations</strong>
            <small>Cosmetic: raptor can't update parent IDs that don't appear in stop_times.</small>
          </span>
        </label>
        <label className="settings__row">
          <span className="settings__field">
            Default interchange
            <small>{value.defaultInterchangeSeconds ?? 0} s</small>
          </span>
          <input
            type="range"
            min={0}
            max={300}
            step={10}
            value={value.defaultInterchangeSeconds ?? 0}
            onChange={(e) => set('defaultInterchangeSeconds', Number(e.target.value))}
          />
        </label>
        <label className="settings__row">
          <span className="settings__field">
            Range query window
            <small>{value.rangeMinutes} min (0 = single depart-after pass)</small>
          </span>
          <input
            type="range"
            min={0}
            max={240}
            step={15}
            value={value.rangeMinutes}
            onChange={(e) => set('rangeMinutes', Number(e.target.value))}
          />
        </label>
      </div>
      <div className="settings__actions">
        <button type="button" onClick={onApply} disabled={rebuilding}>
          {rebuilding ? 'Re-building…' : 'Re-build raptor index'}
        </button>
        <small>
          Toggling bridges or interchange requires re-building the index. Range and stop selection
          do not.
        </small>
      </div>
    </details>
  );
}
