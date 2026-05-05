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
  type Journey as RawJourney,
} from 'raptor-journey-planner';
import {
  buildRaptorInputs,
  hydrateJourneys,
  findNearbyStops,
  loadStopLocations,
  planByCoordinates,
  type BuildRaptorInputsOptions,
  type RaptorInputs,
  type StopLocation,
} from 'gtfs-sqljs-raptor';
import type {
  WorkerApi,
  LoadResult,
  PlanInput,
  PlanResult,
  PlanByCoordinatesInput,
  PlanByCoordinatesResult,
  HydratedCoordinateJourney,
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
let inputs: RaptorInputs | null = null;
let stops: StopLocation[] | null = null;

async function buildAndIndex(
  options: BuildRaptorInputsOptions,
  onProgress: ProgressCallback,
  phase: 'build-raptor' | 'rebuild',
): Promise<{ inputsMs: number; indexMs: number; tripCount: number }> {
  if (!gtfs) throw new Error('GTFS not loaded');
  const t0 = performance.now();
  onProgress({ phase, percent: null, message: 'Reading trips and stop_times…' });
  inputs = await buildRaptorInputs(gtfs, options);
  const inputsMs = performance.now() - t0;
  onProgress({
    phase,
    percent: null,
    message: `Indexing ${inputs.trips.length.toLocaleString()} trips into raptor routes…`,
  });
  const t1 = performance.now();
  raptor = RaptorAlgorithmFactory.create(inputs.trips, inputs.transfers, inputs.interchange);
  const indexMs = performance.now() - t1;
  return { inputsMs, indexMs, tripCount: inputs.trips.length };
}

async function gatherFeedStats(): Promise<{
  stopCount: number;
  routeCount: number;
  serviceIdsRunningSomeDay: number;
  feedTimezone: string | null;
  feedBounds: LoadResult['feedBounds'];
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

  // Cache stop locations for coordinate lookups + compute bounding box at the same time.
  stops = await loadStopLocations(gtfs);
  let bounds: LoadResult['feedBounds'] = null;
  if (stops.length > 0) {
    let minLat = Infinity, minLon = Infinity, maxLat = -Infinity, maxLon = -Infinity;
    for (const s of stops) {
      if (s.lat < minLat) minLat = s.lat;
      if (s.lon < minLon) minLon = s.lon;
      if (s.lat > maxLat) maxLat = s.lat;
      if (s.lon > maxLon) maxLon = s.lon;
    }
    bounds = { minLat, minLon, maxLat, maxLon };
  }

  return {
    stopCount,
    routeCount,
    serviceIdsRunningSomeDay: serviceCount,
    feedTimezone: tzRow?.agency_timezone ?? null,
    feedBounds: bounds,
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
    feedBounds: stats.feedBounds,
  };
}

interface TripShape {
  tripId: string;
  shapeId: string | null;
}

/**
 * For a set of trip ids, fetch each trip's shape_id and then load all referenced
 * shape points in two batched queries. Returns `[lon, lat]` arrays keyed by trip id;
 * trips without a shape get an empty array (callers can fall back to stop coords).
 */
async function fetchShapesByTripId(tripIds: string[]): Promise<Record<string, [number, number][]>> {
  if (!gtfs || tripIds.length === 0) return {};
  const db = gtfs.getDatabase();

  const placeholders = tripIds.map(() => '?').join(',');
  const tripShapes: TripShape[] = [];
  const tripStmt = await db.prepare(
    `SELECT trip_id, shape_id FROM trips WHERE trip_id IN (${placeholders})`,
  );
  await tripStmt.bind(tripIds);
  while (await tripStmt.step()) {
    const row = (await tripStmt.getAsObject()) as { trip_id: string; shape_id: string | null };
    tripShapes.push({
      tripId: String(row.trip_id),
      shapeId: row.shape_id == null || row.shape_id === '' ? null : String(row.shape_id),
    });
  }
  await tripStmt.free();

  const shapeIds = [...new Set(tripShapes.map((t) => t.shapeId).filter((s): s is string => !!s))];
  const pointsByShape: Record<string, [number, number][]> = {};
  if (shapeIds.length > 0) {
    const shapeRows = await gtfs.getShapes({ shapeId: shapeIds });
    // Order by shape_pt_sequence within each shape.
    const grouped: Record<string, { seq: number; lat: number; lon: number }[]> = {};
    for (const r of shapeRows) {
      (grouped[r.shape_id] ??= []).push({
        seq: Number(r.shape_pt_sequence),
        lat: Number(r.shape_pt_lat),
        lon: Number(r.shape_pt_lon),
      });
    }
    for (const [sid, pts] of Object.entries(grouped)) {
      pts.sort((a, b) => a.seq - b.seq);
      pointsByShape[sid] = pts.map((p): [number, number] => [p.lon, p.lat]);
    }
  }

  const out: Record<string, [number, number][]> = {};
  for (const t of tripShapes) {
    out[t.tripId] = t.shapeId ? pointsByShape[t.shapeId] ?? [] : [];
  }
  return out;
}

function collectTripIds(journeys: { legs: ReadonlyArray<unknown> }[]): string[] {
  const out = new Set<string>();
  for (const j of journeys) {
    for (const leg of j.legs) {
      const trip = (leg as { trip?: { tripId?: unknown } }).trip;
      if (trip && typeof trip.tripId === 'string') out.add(trip.tripId);
    }
  }
  return [...out];
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
    const list = await gtfs.getStops({ name: trimmed });
    const platforms = list.filter((s) => s.location_type !== 1);
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
    const shapesByTripId = await fetchShapesByTripId(collectTripIds(journeys));
    const hydrateMs = performance.now() - t1;

    return { computeMs, hydrateMs, rawCount: raw.length, journeys, shapesByTripId };
  },

  async planByCoordinates(input: PlanByCoordinatesInput): Promise<PlanByCoordinatesResult> {
    if (!gtfs || !inputs || !stops) throw new Error('GTFS not loaded');
    const {
      origin,
      destination,
      date,
      departAfterSeconds,
      radiusMeters = 1500,
      walkingSpeedMps = 1.2,
      maxNearbyStops = 12,
    } = input;
    if (origin.id === destination.id) {
      throw new Error('origin and destination coordinates share the same id');
    }

    const findOpts = { radiusMeters, walkingSpeedMps, maxNearbyStops };
    const originNearby = findNearbyStops(origin, stops, findOpts);
    const destinationNearby = findNearbyStops(destination, stops, findOpts);
    if (originNearby.length === 0) throw new Error('No transit stops near the origin coordinate');
    if (destinationNearby.length === 0) throw new Error('No transit stops near the destination coordinate');

    const t0 = performance.now();
    const raw = planByCoordinates({
      inputs,
      origin,
      destination,
      originNearby,
      destinationNearby,
      date: new Date(`${date}T12:00:00Z`),
      departAfterSeconds,
    });
    const computeMs = performance.now() - t0;

    const t1 = performance.now();
    // Strip the synthetic walking legs at the journey's ends and prepare the
    // middle for hydration in one pass.
    interface PreparedJourney {
      raw: RawJourney;
      partial: Omit<HydratedCoordinateJourney, 'middleLegs'>;
    }
    const prepared: PreparedJourney[] = [];
    for (const j of raw) {
      const partial = stripCoordinateOuterLegs(j, origin, destination);
      if (partial) prepared.push({ raw: j, partial });
    }
    const middleAsRawJourneys: RawJourney[] = prepared.map((p) => ({
      legs: p.raw.legs.slice(1, -1),
      departureTime: p.raw.departureTime,
      arrivalTime: p.raw.arrivalTime,
    }));
    const hydratedMiddle = await hydrateJourneys(gtfs, middleAsRawJourneys);

    const out: HydratedCoordinateJourney[] = prepared.map((p, i) => ({
      ...p.partial,
      middleLegs: hydratedMiddle[i]?.legs ?? [],
    }));

    const shapesByTripId = await fetchShapesByTripId(
      collectTripIds(out.map((j) => ({ legs: j.middleLegs }))),
    );
    const hydrateMs = performance.now() - t1;

    return { computeMs, hydrateMs, rawCount: raw.length, journeys: out, shapesByTripId };
  },

  async close() {
    if (gtfs) {
      await gtfs.close();
      gtfs = null;
    }
    raptor = null;
    inputs = null;
    stops = null;
  },
};

interface RawTransferLeg {
  origin: string;
  destination: string;
  duration: number;
  startTime: number;
  endTime: number;
}

function isTransferLeg(leg: unknown): leg is RawTransferLeg {
  return (
    typeof leg === 'object' &&
    leg !== null &&
    typeof (leg as { duration?: unknown }).duration === 'number' &&
    !('stopTimes' in leg)
  );
}

/**
 * For a raw journey produced by planByCoordinates, take the first and last
 * legs (which must be the synthetic endpoint walks) and turn them into
 * structured info, returning a partial HydratedCoordinateJourney without the
 * hydrated middle.
 */
function stripCoordinateOuterLegs(
  raw: RawJourney,
  originCoord: PlanByCoordinatesInput['origin'],
  destinationCoord: PlanByCoordinatesInput['destination'],
): Omit<HydratedCoordinateJourney, 'middleLegs'> | null {
  if (raw.legs.length < 2) return null;
  const first = raw.legs[0];
  const last = raw.legs[raw.legs.length - 1];
  if (!isTransferLeg(first) || !isTransferLeg(last)) return null;
  if (first.origin !== originCoord.id || last.destination !== destinationCoord.id) return null;

  const firstStopId = first.destination;
  const lastStopId = last.origin;
  const firstStopCoords = stops?.find((s) => s.id === firstStopId);
  const lastStopCoords = stops?.find((s) => s.id === lastStopId);
  return {
    departureTime: raw.departureTime,
    arrivalTime: raw.arrivalTime,
    origin: { id: originCoord.id, lat: originCoord.lat, lon: originCoord.lon },
    destination: { id: destinationCoord.id, lat: destinationCoord.lat, lon: destinationCoord.lon },
    originWalk: {
      duration: first.duration,
      toStopId: firstStopId,
      toStopLat: firstStopCoords?.lat ?? NaN,
      toStopLon: firstStopCoords?.lon ?? NaN,
    },
    destinationWalk: {
      duration: last.duration,
      fromStopId: lastStopId,
      fromStopLat: lastStopCoords?.lat ?? NaN,
      fromStopLon: lastStopCoords?.lon ?? NaN,
    },
  };
}

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
