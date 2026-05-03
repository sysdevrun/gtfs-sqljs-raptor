import { useEffect, useMemo, useRef, useState } from 'react';
import * as Comlink from 'comlink';
import type { HydratedJourney } from 'gtfs-sqljs-raptor';
import type {
  LoadResult,
  NamedStopGroup,
  PlannerProgress,
  PoiHydratedJourney,
  WorkerApi,
} from './worker/api';
import { GtfsSelectorPanel } from './components/GtfsSelectorPanel';
import { StopAutocomplete } from './components/StopAutocomplete';
import { SettingsPanel, type PlannerSettings } from './components/SettingsPanel';
import { TimingsBar, type Timings } from './components/TimingsBar';
import { JourneyCard } from './components/JourneyCard';
import { PoiJourneyCard } from './components/PoiJourneyCard';
import { MapView, type PickMode, type PoiPick } from './components/MapView';
import { ProgressBar } from './components/ProgressBar';
import { getProxyUrl } from './util/proxy';
import {
  geometryForJourney,
  geometryForPoiJourney,
  type JourneyGeometry,
} from './util/journeyGeometry';
import {
  fmtHHMMInput,
  nowLocalSecondsSinceMidnight,
  parseHHMM,
  todayLocalISODate,
} from './util/format';

const DEFAULT_SETTINGS: PlannerSettings = {
  bridgeSameNameStops: true,
  sameNameMaxMeters: 250,
  walkingSpeedMps: 1.2,
  bridgeParentStations: false,
  defaultInterchangeSeconds: 0,
  // Default 60 minutes so the planner uses RangeQuery and returns multiple
  // departure options rather than a single optimum.
  rangeMinutes: 60,
};

type Mode = 'stops' | 'pois';

export function App() {
  const workerRef = useRef<{ raw: Worker; api: Comlink.Remote<WorkerApi> } | null>(null);
  const [feedTitle, setFeedTitle] = useState<string | null>(null);
  const [loadResult, setLoadResult] = useState<LoadResult | null>(null);
  const [phase, setPhase] = useState<'idle' | 'loading' | 'ready' | 'planning' | 'rebuilding'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [showSelector, setShowSelector] = useState(true);
  const [progress, setProgress] = useState<PlannerProgress | null>(null);

  const [settings, setSettings] = useState<PlannerSettings>(DEFAULT_SETTINGS);
  const [mode, setMode] = useState<Mode>('stops');

  // Stop-mode endpoints.
  const [origin, setOrigin] = useState<NamedStopGroup | null>(null);
  const [destination, setDestination] = useState<NamedStopGroup | null>(null);

  // POI-mode endpoints (lat/lon).
  const [originPoi, setOriginPoi] = useState<PoiPick | null>(null);
  const [destinationPoi, setDestinationPoi] = useState<PoiPick | null>(null);
  const [pickMode, setPickMode] = useState<PickMode>(null);

  const [date, setDate] = useState<string>(todayLocalISODate());
  const [timeSec, setTimeSec] = useState<number>(nowLocalSecondsSinceMidnight());

  // Results for both modes — one of these is populated at a time.
  const [stopJourneys, setStopJourneys] = useState<HydratedJourney[]>([]);
  const [poiJourneys, setPoiJourneys] = useState<PoiHydratedJourney[]>([]);
  const [shapesByTripId, setShapesByTripId] = useState<Record<string, [number, number][]>>({});
  const [selectedJourney, setSelectedJourney] = useState<number>(0);

  const [timings, setTimings] = useState<Timings>({});

  const [workerReady, setWorkerReady] = useState(false);
  useEffect(() => {
    const w = new Worker(new URL('./worker/gtfsRaptor.worker.ts', import.meta.url), {
      type: 'module',
    });
    let resolved = false;
    const onReady = (e: MessageEvent) => {
      if (e.data && e.data.__workerReady) {
        resolved = true;
        w.removeEventListener('message', onReady);
        workerRef.current = { raw: w, api: Comlink.wrap<WorkerApi>(w) };
        setWorkerReady(true);
      }
    };
    w.addEventListener('message', onReady);
    const timeout = setTimeout(() => {
      if (!resolved) {
        setError(
          'Worker failed to send ready handshake within 5 s. Open DevTools → Sources to inspect the worker context.',
        );
      }
    }, 5000);
    return () => {
      clearTimeout(timeout);
      w.terminate();
      workerRef.current = null;
      setWorkerReady(false);
    };
  }, []);

  const buildOptions = useMemo(
    () => ({
      bridgeSameNameStops: settings.bridgeSameNameStops,
      sameNameMaxMeters: settings.sameNameMaxMeters,
      walkingSpeedMps: settings.walkingSpeedMps,
      bridgeParentStations: settings.bridgeParentStations,
      defaultInterchangeSeconds: settings.defaultInterchangeSeconds,
    }),
    [settings],
  );

  const wasmUrl = useMemo(
    () => new URL(`${import.meta.env.BASE_URL}sql-wasm.wasm`, window.location.href).href,
    [],
  );

  const handleLoad = async (
    selection:
      | { kind: 'file'; buffer: ArrayBuffer; name: string }
      | { kind: 'url'; url: string; useProxy: boolean; title: string },
  ) => {
    if (!workerRef.current) {
      setError('Worker is not ready yet — wait a moment, or check DevTools for a startup error.');
      return;
    }
    setError(null);
    setStopJourneys([]);
    setPoiJourneys([]);
    setShapesByTripId({});
    setTimings({});
    setOrigin(null);
    setDestination(null);
    setOriginPoi(null);
    setDestinationPoi(null);
    setLoadResult(null);
    setProgress({ phase: 'load', percent: 0, message: 'Starting…' });
    setPhase('loading');
    const onProgress = Comlink.proxy((p: PlannerProgress) => setProgress(p));
    try {
      let result: LoadResult;
      if (selection.kind === 'file') {
        setFeedTitle(selection.name);
        result = await workerRef.current.api.loadFromBuffer(
          Comlink.transfer(selection.buffer, [selection.buffer]),
          buildOptions,
          wasmUrl,
          onProgress,
        );
      } else {
        const url = selection.useProxy ? getProxyUrl(selection.url) : selection.url;
        setFeedTitle(selection.title);
        result = await workerRef.current.api.loadFromUrl(url, buildOptions, wasmUrl, onProgress);
      }
      setLoadResult(result);
      setTimings({ loadMs: result.loadMs, inputsMs: result.inputsMs, indexMs: result.indexMs });
      setPhase('ready');
      setShowSelector(false);
      setProgress(null);
    } catch (e) {
      console.error(e);
      setError(e instanceof Error ? e.message : String(e));
      setPhase('idle');
      setProgress(null);
    }
  };

  const rebuild = async () => {
    if (!workerRef.current || phase === 'rebuilding') return;
    setPhase('rebuilding');
    setError(null);
    setProgress({ phase: 'rebuild', percent: null, message: 'Re-building raptor index…' });
    const onProgress = Comlink.proxy((p: PlannerProgress) => setProgress(p));
    try {
      const r = await workerRef.current.api.rebuild(buildOptions, onProgress);
      setTimings((t) => ({ ...t, inputsMs: r.inputsMs, indexMs: r.indexMs }));
      setPhase('ready');
      setProgress(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase('ready');
      setProgress(null);
    }
  };

  const planStops = async () => {
    if (!workerRef.current || !origin || !destination) return;
    setPhase('planning');
    setError(null);
    setStopJourneys([]);
    setPoiJourneys([]);
    setShapesByTripId({});
    try {
      const result = await workerRef.current.api.plan({
        originStopIds: origin.stopIds,
        destinationStopIds: destination.stopIds,
        date,
        departAfterSeconds: timeSec,
        rangeSeconds: settings.rangeMinutes > 0 ? settings.rangeMinutes * 60 : undefined,
      });
      setTimings((t) => ({
        loadMs: t.loadMs,
        inputsMs: t.inputsMs,
        indexMs: t.indexMs,
        computeMs: result.computeMs,
        hydrateMs: result.hydrateMs,
        rawCount: result.rawCount,
      }));
      setStopJourneys(result.journeys);
      setShapesByTripId(result.shapesByTripId);
      setSelectedJourney(0);
      setPhase('ready');
    } catch (e) {
      console.error(e);
      setError(e instanceof Error ? e.message : String(e));
      setPhase('ready');
    }
  };

  const planPois = async () => {
    if (!workerRef.current || !originPoi || !destinationPoi) return;
    setPhase('planning');
    setError(null);
    setStopJourneys([]);
    setPoiJourneys([]);
    setShapesByTripId({});
    try {
      const result = await workerRef.current.api.planForPois({
        origin: { id: '__poi_origin__', lat: originPoi.lat, lon: originPoi.lon },
        destination: { id: '__poi_destination__', lat: destinationPoi.lat, lon: destinationPoi.lon },
        date,
        departAfterSeconds: timeSec,
      });
      setTimings((t) => ({
        loadMs: t.loadMs,
        inputsMs: t.inputsMs,
        indexMs: t.indexMs,
        computeMs: result.computeMs,
        hydrateMs: result.hydrateMs,
        rawCount: result.rawCount,
      }));
      setPoiJourneys(result.journeys);
      setShapesByTripId(result.shapesByTripId);
      setSelectedJourney(0);
      setPhase('ready');
    } catch (e) {
      console.error(e);
      setError(e instanceof Error ? e.message : String(e));
      setPhase('ready');
    }
  };

  // Map-mode picking: clicking the map sets origin/destination POI based on
  // pickMode. When the slot is filled, advance the picker so the user can pick
  // the next slot without an extra click.
  const onMapPick = (slot: 'origin' | 'destination', point: PoiPick) => {
    if (slot === 'origin') {
      setOriginPoi(point);
      if (!destinationPoi) setPickMode('destination');
      else setPickMode(null);
    } else {
      setDestinationPoi(point);
      if (!originPoi) setPickMode('origin');
      else setPickMode(null);
    }
  };

  // Geometry for the currently-selected journey.
  const geometry: JourneyGeometry | null = useMemo(() => {
    if (mode === 'pois' && poiJourneys[selectedJourney]) {
      return geometryForPoiJourney(poiJourneys[selectedJourney], shapesByTripId);
    }
    if (mode === 'stops' && stopJourneys[selectedJourney]) {
      return geometryForJourney(stopJourneys[selectedJourney], shapesByTripId);
    }
    return null;
  }, [mode, poiJourneys, stopJourneys, selectedJourney, shapesByTripId]);

  const initialBounds = loadResult?.feedBounds ?? null;

  const ready = phase === 'ready' || phase === 'planning' || phase === 'rebuilding';
  const planning = phase === 'planning';
  const canPlanStops = !!origin && !!destination;
  const canPlanPois = !!originPoi && !!destinationPoi;

  return (
    <div className="app">
      <header className="app__header">
        <div>
          <h1>Browser journey planner</h1>
          <p>
            <code>gtfs-sqljs</code> + <code>raptor-journey-planner</code> running entirely client-side
            inside a Web Worker.
          </p>
        </div>
        {feedTitle && (
          <div className="feed-pill" title={feedTitle}>
            <div className="feed-pill__text">
              <span className="feed-pill__label">Feed</span>
              <span className="feed-pill__value">{feedTitle}</span>
              {loadResult && (
                <span className="feed-pill__meta">
                  {loadResult.tripCount.toLocaleString()} trips · {loadResult.routeCount} routes ·{' '}
                  {loadResult.stopCount.toLocaleString()} stops
                </span>
              )}
            </div>
            <button
              type="button"
              className="feed-pill__change"
              onClick={() => {
                setShowSelector(true);
                setError(null);
              }}
              disabled={phase === 'loading'}
            >
              Change feed
            </button>
          </div>
        )}
      </header>

      {showSelector && (
        <GtfsSelectorPanel onSelected={handleLoad} disabled={phase === 'loading'} />
      )}

      {(phase === 'loading' || phase === 'rebuilding') && progress && (
        <ProgressBar progress={progress} />
      )}
      {error && <div className="status status--error">Error: {error}</div>}

      {ready && loadResult && (
        <>
          <SettingsPanel
            value={settings}
            onChange={setSettings}
            onApply={rebuild}
            rebuilding={phase === 'rebuilding'}
            feedTimezone={loadResult.feedTimezone}
          />

          <section className="panel panel--planner">
            <header className="panel__header">
              <h2>2. Plan a journey</h2>
              <div className="mode-toggle" role="tablist" aria-label="Endpoint selection mode">
                <button
                  type="button"
                  role="tab"
                  aria-selected={mode === 'stops'}
                  className={`mode-toggle__btn${mode === 'stops' ? ' mode-toggle__btn--active' : ''}`}
                  onClick={() => {
                    setMode('stops');
                    setPickMode(null);
                  }}
                >
                  Stops
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={mode === 'pois'}
                  className={`mode-toggle__btn${mode === 'pois' ? ' mode-toggle__btn--active' : ''}`}
                  onClick={() => setMode('pois')}
                >
                  Pick on map
                </button>
              </div>
            </header>
            {mode === 'stops' ? (
              <div className="planner-grid">
                {workerRef.current && (
                  <>
                    <StopAutocomplete
                      label="Origin"
                      placeholder="Type at least 2 characters…"
                      value={origin}
                      onChange={setOrigin}
                      worker={workerRef.current.api}
                    />
                    <StopAutocomplete
                      label="Destination"
                      placeholder="Type at least 2 characters…"
                      value={destination}
                      onChange={setDestination}
                      worker={workerRef.current.api}
                    />
                  </>
                )}
                <label className="field">
                  <span className="field__label">Date</span>
                  <input
                    type="date"
                    value={date}
                    onChange={(e) => setDate(e.target.value)}
                    className="field__input"
                  />
                </label>
                <label className="field">
                  <span className="field__label">Depart at</span>
                  <input
                    type="time"
                    value={fmtHHMMInput(timeSec)}
                    onChange={(e) => setTimeSec(parseHHMM(e.target.value))}
                    className="field__input"
                  />
                </label>
                <button
                  className="planner-grid__submit"
                  type="button"
                  disabled={!canPlanStops || planning}
                  onClick={planStops}
                >
                  {planning ? 'Computing…' : 'Find itineraries'}
                </button>
              </div>
            ) : (
              <div className="poi-planner">
                <div className="poi-planner__row">
                  <button
                    type="button"
                    className={`poi-pick${pickMode === 'origin' ? ' poi-pick--active' : ''}${
                      originPoi ? ' poi-pick--filled' : ''
                    }`}
                    onClick={() => setPickMode((m) => (m === 'origin' ? null : 'origin'))}
                  >
                    <span className="poi-pick__label">A — Origin</span>
                    <span className="poi-pick__value">
                      {originPoi
                        ? `${originPoi.lat.toFixed(5)}, ${originPoi.lon.toFixed(5)}`
                        : pickMode === 'origin'
                          ? 'Click on the map…'
                          : 'Pick on map'}
                    </span>
                  </button>
                  <button
                    type="button"
                    className={`poi-pick${pickMode === 'destination' ? ' poi-pick--active' : ''}${
                      destinationPoi ? ' poi-pick--filled' : ''
                    }`}
                    onClick={() => setPickMode((m) => (m === 'destination' ? null : 'destination'))}
                  >
                    <span className="poi-pick__label">B — Destination</span>
                    <span className="poi-pick__value">
                      {destinationPoi
                        ? `${destinationPoi.lat.toFixed(5)}, ${destinationPoi.lon.toFixed(5)}`
                        : pickMode === 'destination'
                          ? 'Click on the map…'
                          : 'Pick on map'}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="poi-pick poi-pick--clear"
                    onClick={() => {
                      setOriginPoi(null);
                      setDestinationPoi(null);
                      setPickMode(null);
                      setPoiJourneys([]);
                      setShapesByTripId({});
                    }}
                    disabled={!originPoi && !destinationPoi}
                  >
                    Clear
                  </button>
                </div>
                <div className="poi-planner__row">
                  <label className="field">
                    <span className="field__label">Date</span>
                    <input
                      type="date"
                      value={date}
                      onChange={(e) => setDate(e.target.value)}
                      className="field__input"
                    />
                  </label>
                  <label className="field">
                    <span className="field__label">Depart at</span>
                    <input
                      type="time"
                      value={fmtHHMMInput(timeSec)}
                      onChange={(e) => setTimeSec(parseHHMM(e.target.value))}
                      className="field__input"
                    />
                  </label>
                  <button
                    className="planner-grid__submit"
                    type="button"
                    disabled={!canPlanPois || planning}
                    onClick={planPois}
                  >
                    {planning ? 'Computing…' : 'Find itineraries'}
                  </button>
                </div>
              </div>
            )}
          </section>

          <section className="panel panel--map">
            <header className="panel__header">
              <h2>Map</h2>
              {mode === 'pois' && (
                <span className="panel__hint">
                  {pickMode === 'origin'
                    ? 'Click the map to set the origin POI'
                    : pickMode === 'destination'
                      ? 'Click the map to set the destination POI'
                      : 'Use the A / B buttons above, then click the map'}
                </span>
              )}
            </header>
            <MapView
              origin={mode === 'pois' ? originPoi : null}
              destination={mode === 'pois' ? destinationPoi : null}
              pickMode={mode === 'pois' ? pickMode : null}
              onPick={onMapPick}
              geometry={geometry}
              initialBounds={initialBounds}
            />
          </section>

          <TimingsBar timings={timings} />

          <section className="panel panel--results">
            <header className="panel__header">
              <h2>
                3. Results{' '}
                {(mode === 'stops' ? stopJourneys.length : poiJourneys.length) > 0 && (
                  <small>({mode === 'stops' ? stopJourneys.length : poiJourneys.length})</small>
                )}
              </h2>
              {(mode === 'stops' ? stopJourneys.length : poiJourneys.length) > 1 && (
                <span className="panel__hint">Click a result to highlight it on the map</span>
              )}
            </header>
            {((mode === 'stops' && stopJourneys.length === 0) ||
              (mode === 'pois' && poiJourneys.length === 0)) &&
              phase !== 'planning' && <p className="empty">No journey computed yet.</p>}
            {phase === 'planning' && <p className="empty">Working…</p>}
            <div className="journeys">
              {mode === 'stops'
                ? stopJourneys.map((j, i) => (
                    <div
                      key={i}
                      className={`journey-wrap${i === selectedJourney ? ' journey-wrap--selected' : ''}`}
                      onClick={() => setSelectedJourney(i)}
                    >
                      <JourneyCard journey={j} index={i} />
                    </div>
                  ))
                : poiJourneys.map((j, i) => (
                    <PoiJourneyCard
                      key={i}
                      journey={j}
                      index={i}
                      selected={i === selectedJourney}
                      onSelect={() => setSelectedJourney(i)}
                    />
                  ))}
            </div>
          </section>
        </>
      )}

      <footer className="app__footer">
        <a href="https://github.com/sysdevrun/gtfs-sqljs" target="_blank" rel="noreferrer">
          gtfs-sqljs
        </a>{' '}
        +{' '}
        <a href="https://github.com/planarnetwork/raptor" target="_blank" rel="noreferrer">
          raptor-journey-planner
        </a>
        . Loading, pre-computation, planning and hydration all happen in a Web Worker. Map tiles ©{' '}
        <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">
          OpenStreetMap
        </a>{' '}
        contributors.
      </footer>

      {!workerReady && phase === 'idle' && <p className="empty">Booting worker…</p>}
    </div>
  );
}
