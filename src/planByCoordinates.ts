import type { GtfsSqlJs } from 'gtfs-sqljs';
import {
  Service,
  RaptorAlgorithmFactory,
  JourneyFactory,
  DepartAfterQuery,
  type Trip,
  type Transfer,
  type TransfersByOrigin,
  type Interchange,
  type Journey,
} from 'raptor-journey-planner';
import type { RaptorInputs } from './buildRaptorInputs.js';
import { iterateRows } from './internal/sqlHelpers.js';

/**
 * A geographic endpoint of a query: an arbitrary `{ lat, lon }` plus an `id`.
 * The `id` is an internal handle used to register the coordinate as a phantom
 * stop in the per-query raptor index, and to identify the synthetic walking
 * legs in the returned `Journey`. It must not collide with any real GTFS
 * `stop_id` and must differ between origin and destination.
 */
export interface Coordinate {
  id: string;
  lat: number;
  lon: number;
}

export interface StopLocation {
  id: string;
  lat: number;
  lon: number;
}

export interface NearbyStop {
  stopId: string;
  walkSeconds: number;
}

export interface FindNearbyStopsOptions {
  /** Maximum walking distance in meters. Default: 400. */
  radiusMeters?: number;
  /** Walking speed in m/s used to convert distance into seconds. Default: 1.2. */
  walkingSpeedMps?: number;
  /** Cap on the number of stops returned (closest first). Default: 8. */
  maxNearbyStops?: number;
}

export interface PlanByCoordinatesParams {
  inputs: RaptorInputs;
  origin: Coordinate;
  destination: Coordinate;
  /**
   * Pre-resolved nearby real stops with walk durations from `origin` to each.
   * Use `findNearbyStops(origin, stops)` if you don't have a spatial index.
   */
  originNearby: NearbyStop[];
  /**
   * Pre-resolved nearby real stops with walk durations from each to `destination`.
   * Walks are symmetric so the same duration applies in either direction.
   */
  destinationNearby: NearbyStop[];
  /** Search date. A fresh `Date` is passed to the query so the caller's value is not mutated. */
  date: Date;
  /** Seconds since midnight (e.g. `9 * 3600` for 09:00). */
  departAfterSeconds: number;
  /** Interchange seconds applied to both endpoints. Default: 0. */
  endpointInterchangeSeconds?: number;
}

const ALWAYS_ON_SERVICE = new Service(
  0,
  99999999,
  { 0: true, 1: true, 2: true, 3: true, 4: true, 5: true, 6: true },
  {},
);

const PHANTOM_SERVICE_ID = '__coord_always';

/**
 * Plan an itinerary between two arbitrary geographic coordinates that are not
 * GTFS stops, taking walking legs from each coordinate to nearby real stops
 * into account. Per query, the function appends two phantom trips (one per
 * endpoint, with `pickUp: false / dropOff: false` so the algorithm never tries
 * to board them) plus walking edges, then calls `RaptorAlgorithmFactory.create`
 * and runs a `DepartAfterQuery`. The base `inputs` (trips / transfers /
 * interchange) are not mutated.
 */
export function planByCoordinates(params: PlanByCoordinatesParams): Journey[] {
  const {
    inputs,
    origin,
    destination,
    originNearby,
    destinationNearby,
    date,
    departAfterSeconds,
    endpointInterchangeSeconds = 0,
  } = params;

  if (origin.id === destination.id) {
    throw new Error('planByCoordinates: origin.id and destination.id must differ');
  }

  const trips: Trip[] = inputs.trips.concat(
    phantomTripFor(origin.id),
    phantomTripFor(destination.id),
  );

  const transfers: TransfersByOrigin = { ...inputs.transfers };
  transfers[origin.id] = originNearby.map((n) =>
    walkEdge(origin.id, n.stopId, n.walkSeconds),
  );
  for (const n of destinationNearby) {
    transfers[n.stopId] = (inputs.transfers[n.stopId] ?? []).concat(
      walkEdge(n.stopId, destination.id, n.walkSeconds),
    );
  }

  const interchange = withEndpointInterchange(inputs.interchange, {
    [origin.id]: endpointInterchangeSeconds,
    [destination.id]: endpointInterchangeSeconds,
  });

  const raptor = RaptorAlgorithmFactory.create(trips, transfers, interchange);
  const query = new DepartAfterQuery(raptor, new JourneyFactory());
  return query.plan(origin.id, destination.id, new Date(date.getTime()), departAfterSeconds);
}

/**
 * Linear-scan nearest-stops lookup. Suitable for stop universes up to a few
 * thousand entries. For larger feeds, plug in a kd-tree / geohash index and
 * build the `NearbyStop[]` array yourself.
 */
export function findNearbyStops(
  point: Coordinate | { lat: number; lon: number },
  stops: StopLocation[],
  options: FindNearbyStopsOptions = {},
): NearbyStop[] {
  const { radiusMeters = 400, walkingSpeedMps = 1.2, maxNearbyStops = 8 } = options;
  const within: { stopId: string; meters: number }[] = [];
  for (const s of stops) {
    if (!Number.isFinite(s.lat) || !Number.isFinite(s.lon)) continue;
    const meters = haversineMeters(point.lat, point.lon, s.lat, s.lon);
    if (meters <= radiusMeters) within.push({ stopId: s.id, meters });
  }
  within.sort((a, b) => a.meters - b.meters);
  return within.slice(0, maxNearbyStops).map((x) => ({
    stopId: x.stopId,
    walkSeconds: Math.max(1, Math.round(x.meters / walkingSpeedMps)),
  }));
}

function phantomTripFor(coordId: string): Trip {
  return {
    tripId: `__coord_${coordId}`,
    serviceId: PHANTOM_SERVICE_ID,
    service: ALWAYS_ON_SERVICE,
    stopTimes: [
      {
        stop: coordId,
        arrivalTime: 0,
        departureTime: 0,
        pickUp: false,
        dropOff: false,
      },
    ],
  };
}

function walkEdge(origin: string, destination: string, duration: number): Transfer {
  return {
    origin,
    destination,
    duration,
    startTime: 0,
    endTime: Number.MAX_SAFE_INTEGER,
  };
}

/**
 * Add per-query endpoint overrides on top of the base interchange while preserving
 * the base Proxy's default-fallback for any other stop. `RaptorAlgorithmFactory.create`
 * default-fills missing entries by writing `0` into the interchange — those writes
 * land on the per-query overrides object, never on the underlying base map.
 */
function withEndpointInterchange(
  base: Interchange,
  overrides: Record<string, number>,
): Interchange {
  const explicit: Record<string, number> = {
    ...(base as Record<string, number>),
    ...overrides,
  };
  return new Proxy(explicit, {
    get(target, prop) {
      if (typeof prop === 'symbol') return (target as Record<string | symbol, unknown>)[prop];
      if (prop in target) return target[prop as string];
      return (base as Record<string, number>)[prop as string];
    },
  });
}

/**
 * Load `{ id, lat, lon }` rows for every stop with valid coordinates. Useful for
 * building a spatial index in a worker right after `buildRaptorInputs`.
 */
export async function loadStopLocations(gtfs: GtfsSqlJs): Promise<StopLocation[]> {
  const out: StopLocation[] = [];
  for await (const row of iterateRows(
    gtfs.getDatabase(),
    'SELECT stop_id, stop_lat, stop_lon FROM stops WHERE stop_lat IS NOT NULL AND stop_lon IS NOT NULL',
  )) {
    const lat = Number(row.stop_lat);
    const lon = Number(row.stop_lon);
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      out.push({ id: String(row.stop_id), lat, lon });
    }
  }
  return out;
}

function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6_371_000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
