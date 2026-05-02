import { useEffect, useMemo, useRef, useState } from 'react';
import * as Comlink from 'comlink';
import type { HydratedJourney } from 'gtfs-sqljs-raptor';
import type { LoadResult, NamedStopGroup, PlannerProgress, WorkerApi } from './worker/api';
import { GtfsSelectorPanel } from './components/GtfsSelectorPanel';
import { StopAutocomplete } from './components/StopAutocomplete';
import { SettingsPanel, type PlannerSettings } from './components/SettingsPanel';
import { TimingsBar, type Timings } from './components/TimingsBar';
import { JourneyCard } from './components/JourneyCard';
import { ProgressBar } from './components/ProgressBar';
import { getProxyUrl } from './util/proxy';
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

export function App() {
  const workerRef = useRef<{ raw: Worker; api: Comlink.Remote<WorkerApi> } | null>(null);
  const [feedTitle, setFeedTitle] = useState<string | null>(null);
  const [loadResult, setLoadResult] = useState<LoadResult | null>(null);
  const [phase, setPhase] = useState<'idle' | 'loading' | 'ready' | 'planning' | 'rebuilding'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [showSelector, setShowSelector] = useState(true);
  const [progress, setProgress] = useState<PlannerProgress | null>(null);

  const [settings, setSettings] = useState<PlannerSettings>(DEFAULT_SETTINGS);
  const [origin, setOrigin] = useState<NamedStopGroup | null>(null);
  const [destination, setDestination] = useState<NamedStopGroup | null>(null);
  const [date, setDate] = useState<string>(todayLocalISODate());
  const [timeSec, setTimeSec] = useState<number>(nowLocalSecondsSinceMidnight());
  const [journeys, setJourneys] = useState<HydratedJourney[]>([]);
  const [timings, setTimings] = useState<Timings>({});

  // Boot the worker on mount. The worker posts a one-shot `__workerReady`
  // message as soon as its module finishes evaluating; we intercept it before
  // handing the worker over to Comlink (Comlink consumes every other message).
  // Without the handshake, a module-eval failure leaves Comlink calls hanging
  // silently because the worker exited before any onmessage handler attached.
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

  // Absolute URL for sql-wasm.wasm, computed against the page's deployment
  // root so it works under any base path (`/` in dev, `/raptor/` in prod).
  // BASE_URL is set from Vite's `base` config and ends with `/`.
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
    setJourneys([]);
    setTimings({});
    setOrigin(null);
    setDestination(null);
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

  const plan = async () => {
    if (!workerRef.current || !origin || !destination) return;
    setPhase('planning');
    setError(null);
    setJourneys([]);
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
      setJourneys(result.journeys);
      setPhase('ready');
    } catch (e) {
      console.error(e);
      setError(e instanceof Error ? e.message : String(e));
      setPhase('ready');
    }
  };

  const ready = phase === 'ready' || phase === 'planning' || phase === 'rebuilding';
  const planning = phase === 'planning';

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
            </header>
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
                disabled={!origin || !destination || planning}
                onClick={plan}
              >
                {planning ? 'Computing…' : 'Find itineraries'}
              </button>
            </div>
          </section>

          <TimingsBar timings={timings} />

          <section className="panel panel--results">
            <header className="panel__header">
              <h2>3. Results {journeys.length > 0 && <small>({journeys.length})</small>}</h2>
            </header>
            {journeys.length === 0 && phase !== 'planning' && (
              <p className="empty">No journey computed yet.</p>
            )}
            {journeys.length === 0 && phase === 'planning' && (
              <p className="empty">Working…</p>
            )}
            <div className="journeys">
              {journeys.map((j, i) => (
                <JourneyCard key={i} journey={j} index={i} />
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
        . Loading, pre-computation, planning and hydration all happen in a Web Worker.
      </footer>
    </div>
  );
}
