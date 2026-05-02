/// <reference lib="webworker" />
import * as Comlink from 'comlink';
import { GtfsSqlJs } from 'gtfs-sqljs';
import { createSqlJsAdapter } from 'gtfs-sqljs/adapters/sql-js';
import {
  RaptorAlgorithmFactory,
  GroupStationDepartAfterQuery,
  RangeQuery,
  JourneyFactory,
  MultipleCriteriaFilter,
  type RaptorAlgorithm,
} from 'raptor-journey-planner';
import {
  buildRaptorInputs,
  hydrateJourneys,
  type BuildRaptorInputsOptions,
} from 'gtfs-sqljs-raptor';
import type {
  WorkerApi,
  LoadResult,
  PlanInput,
  PlanResult,
  NamedStopGroup,
  ProgressCallback,
} from './api.js';

// WASM is shipped statically from website/public/sql-wasm.wasm. The main
// thread computes the correct absolute URL (using Vite's BASE_URL resolved
// against window.location) and passes it into each load call — the worker
// itself can't reliably derive the deployment root because `self.location`
// points into the assets/ chunk directory.

let gtfs: GtfsSqlJs | null = null;
let raptor: RaptorAlgorithm | null = null;

async function buildAndIndex(
  options: BuildRaptorInputsOptions,
  onProgress: ProgressCallback,
  phase: 'build-raptor' | 'rebuild',
): Promise<{ inputsMs: number; indexMs: number; tripCount: number }> {
  if (!gtfs) throw new Error('GTFS not loaded');
  const t0 = performance.now();
  onProgress({ phase, percent: null, message: 'Reading trips and stop_times…' });
  const { trips, transfers, interchange } = await buildRaptorInputs(gtfs, options);
  const inputsMs = performance.now() - t0;
  onProgress({
    phase,
    percent: null,
    message: `Indexing ${trips.length.toLocaleString()} trips into raptor routes…`,
  });
  const t1 = performance.now();
  raptor = RaptorAlgorithmFactory.create(trips, transfers, interchange);
  const indexMs = performance.now() - t1;
  return { inputsMs, indexMs, tripCount: trips.length };
}

async function gatherFeedStats(): Promise<{
  stopCount: number;
  routeCount: number;
  serviceIdsRunningSomeDay: number;
  feedTimezone: string | null;
}> {
  if (!gtfs) throw new Error('GTFS not loaded');
  const db = gtfs.getDatabase();

  const stopStmt = await db.prepare(
    'SELECT COUNT(*) AS c FROM stops WHERE location_type IS NULL OR location_type = 0',
  );
  await stopStmt.step();
  const stopCount = Number(((await stopStmt.getAsObject()) as { c: number }).c);
  await stopStmt.free();

  const routeStmt = await db.prepare('SELECT COUNT(*) AS c FROM routes');
  await routeStmt.step();
  const routeCount = Number(((await routeStmt.getAsObject()) as { c: number }).c);
  await routeStmt.free();

  const serviceStmt = await db.prepare('SELECT COUNT(DISTINCT service_id) AS c FROM trips');
  await serviceStmt.step();
  const serviceCount = Number(((await serviceStmt.getAsObject()) as { c: number }).c);
  await serviceStmt.free();

  const tzStmt = await db.prepare('SELECT agency_timezone FROM agency LIMIT 1');
  const tzRow = (await tzStmt.step())
    ? ((await tzStmt.getAsObject()) as { agency_timezone?: string })
    : null;
  await tzStmt.free();

  return {
    stopCount,
    routeCount,
    serviceIdsRunningSomeDay: serviceCount,
    feedTimezone: tzRow?.agency_timezone ?? null,
  };
}

async function loadCommon(
  loadMs: number,
  options: BuildRaptorInputsOptions,
  onProgress: ProgressCallback,
): Promise<LoadResult> {
  const { inputsMs, indexMs, tripCount } = await buildAndIndex(options, onProgress, 'build-raptor');
  onProgress({ phase: 'gather-stats', percent: null, message: 'Counting routes and stops…' });
  const stats = await gatherFeedStats();
  return {
    loadMs,
    inputsMs,
    indexMs,
    tripCount,
    stopCount: stats.stopCount,
    routeCount: stats.routeCount,
    serviceIdsRunningSomeDay: stats.serviceIdsRunningSomeDay,
    feedTimezone: stats.feedTimezone,
  };
}

const api: WorkerApi = {
  async loadFromUrl(url, options, wasmUrl, onProgress) {
    const t0 = performance.now();
    const adapter = await createSqlJsAdapter({ locateFile: () => wasmUrl });
    if (gtfs) await gtfs.close();
    gtfs = await GtfsSqlJs.fromZip(url, {
      adapter,
      onProgress: (p) =>
        onProgress({
          phase: 'load',
          percent: p.percentComplete,
          message: p.message ?? gtfsPhaseLabel(p.phase),
          currentFile: p.currentFile ?? undefined,
        }),
    });
    return loadCommon(performance.now() - t0, options, onProgress);
  },

  async loadFromBuffer(buffer, options, wasmUrl, onProgress) {
    const t0 = performance.now();
    const adapter = await createSqlJsAdapter({ locateFile: () => wasmUrl });
    if (gtfs) await gtfs.close();
    gtfs = await GtfsSqlJs.fromZipData(new Uint8Array(buffer), {
      adapter,
      onProgress: (p) =>
        onProgress({
          phase: 'load',
          percent: p.percentComplete,
          message: p.message ?? gtfsPhaseLabel(p.phase),
          currentFile: p.currentFile ?? undefined,
        }),
    });
    return loadCommon(performance.now() - t0, options, onProgress);
  },

  async rebuild(options, onProgress) {
    if (!gtfs) throw new Error('GTFS not loaded');
    const { inputsMs, indexMs } = await buildAndIndex(options, onProgress, 'rebuild');
    return { inputsMs, indexMs };
  },

  async searchStopGroups(query, limit = 12) {
    if (!gtfs) throw new Error('GTFS not loaded');
    const trimmed = query.trim();
    if (trimmed.length < 2) return [];
    const stops = await gtfs.getStops({ name: trimmed });
    const platforms = stops.filter((s) => s.location_type !== 1);
    const byName = new Map<string, NamedStopGroup>();
    for (const s of platforms) {
      const existing = byName.get(s.stop_name);
      if (existing) existing.stopIds.push(s.stop_id);
      else byName.set(s.stop_name, { name: s.stop_name, stopIds: [s.stop_id], representative: s });
    }
    return [...byName.values()].slice(0, limit);
  },

  async plan(input: PlanInput): Promise<PlanResult> {
    if (!gtfs || !raptor) throw new Error('GTFS not loaded');
    const date = new Date(`${input.date}T12:00:00Z`);
    const t0 = performance.now();
    let raw;
    if (input.rangeSeconds && input.rangeSeconds > 0) {
      const query = new RangeQuery(raptor, new JourneyFactory(), 3, [new MultipleCriteriaFilter()]);
      raw = query.plan(
        input.originStopIds[0],
        input.destinationStopIds[0],
        date,
        input.departAfterSeconds,
        input.departAfterSeconds + input.rangeSeconds,
      );
    } else {
      const query = new GroupStationDepartAfterQuery(raptor, new JourneyFactory(), 3, [
        new MultipleCriteriaFilter(),
      ]);
      raw = query.plan(input.originStopIds, input.destinationStopIds, date, input.departAfterSeconds);
    }
    const computeMs = performance.now() - t0;

    const t1 = performance.now();
    const journeys = await hydrateJourneys(gtfs, raw);
    const hydrateMs = performance.now() - t1;

    return { computeMs, hydrateMs, rawCount: raw.length, journeys };
  },

  async close() {
    if (gtfs) {
      await gtfs.close();
      gtfs = null;
    }
    raptor = null;
  },
};

function gtfsPhaseLabel(phase: string): string {
  switch (phase) {
    case 'checking_cache': return 'Checking cache…';
    case 'loading_from_cache': return 'Loading from cache…';
    case 'downloading': return 'Downloading GTFS feed…';
    case 'extracting': return 'Extracting ZIP archive…';
    case 'creating_schema': return 'Creating SQLite schema…';
    case 'inserting_data': return 'Inserting rows into SQLite…';
    case 'creating_indexes': return 'Creating SQL indexes…';
    case 'analyzing': return 'Analyzing tables…';
    case 'loading_realtime': return 'Loading GTFS-RT feed…';
    case 'saving_cache': return 'Saving cache…';
    case 'complete': return 'Load complete';
    default: return phase;
  }
}

// One-shot handshake — the App waits for this before letting Comlink wrap us.
// Without it, a module-eval failure in the worker leaves Comlink calls
// hanging silently because the worker exited before any onmessage handler.
self.postMessage({ __workerReady: true });

Comlink.expose(api);

export {};
