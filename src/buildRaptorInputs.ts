import type { GtfsSqlJs } from 'gtfs-sqljs';
// raptor-journey-planner@2.2.3 is shipped as CommonJS. Importing deep `.js`
// subpaths breaks in ESM workers because they use `require`. Only the package
// barrel works after Vite pre-bundles it through esbuild's CJS→ESM transform.
import {
  TimeParser,
  type Service,
  type StopTime,
  type Trip,
  type Interchange,
  type Transfer,
  type TransfersByOrigin,
} from 'raptor-journey-planner';
import { buildServices } from './internal/services.js';
import { withDefaultInterchange } from './internal/interchangeProxy.js';
import { iterateRows } from './internal/sqlHelpers.js';

export interface RaptorInputs {
  trips: Trip[];
  transfers: TransfersByOrigin;
  /** Proxy: missing keys resolve to 0. */
  interchange: Interchange;
}

export interface BuildRaptorInputsOptions {
  /**
   * Synthesize zero-duration two-way Transfer rows between every parent station
   * and its child platforms (from `stops.parent_station`).
   *
   * NOTE: this is largely cosmetic with the current `raptor-journey-planner`
   * algorithm — its `ScanResultsFactory` only tracks stops that appear in some
   * trip's `stop_times`, so origins/destinations passed to `query.plan()` MUST
   * be platform-level stop_ids, never parent IDs. Off by default.
   */
  bridgeParentStations?: boolean;
  /**
   * Synthesize Transfer rows between stops that share the same `stop_name` and
   * lie within `sameNameMaxMeters` of each other. Many feeds split a logical
   * station into per-route platforms without using `parent_station`, leaving
   * raptor unable to change routes there. Off by default — only enable for feeds
   * you've verified do not reuse names across distant locations.
   */
  bridgeSameNameStops?: boolean;
  /** Maximum distance for `bridgeSameNameStops` (meters). Default: 250. */
  sameNameMaxMeters?: number;
  /** Walking speed used to convert geo distance into seconds. Default: 1.2 m/s. */
  walkingSpeedMps?: number;
  /** Default interchange (in seconds) for stops not present in `transfers.txt`. */
  defaultInterchangeSeconds?: number;
}

export async function buildRaptorInputs(
  gtfs: GtfsSqlJs,
  options: BuildRaptorInputsOptions = {},
): Promise<RaptorInputs> {
  const {
    bridgeParentStations = false,
    bridgeSameNameStops = false,
    sameNameMaxMeters = 250,
    walkingSpeedMps = 1.2,
    defaultInterchangeSeconds = 0,
  } = options;
  const db = gtfs.getDatabase();
  const timeParser = new TimeParser();

  const services = await buildServices(db);
  const trips = await buildTrips(db, services, timeParser);
  const { transfers, interchangeBase } = await buildTransfers(db);

  if (bridgeParentStations) {
    await addParentStationBridges(db, transfers);
  }
  if (bridgeSameNameStops) {
    await addSameNameBridges(db, transfers, sameNameMaxMeters, walkingSpeedMps);
  }

  return {
    trips,
    transfers,
    interchange: withDefaultInterchange(interchangeBase, defaultInterchangeSeconds),
  };
}

async function buildTrips(
  db: ReturnType<GtfsSqlJs['getDatabase']>,
  services: Record<string, Service>,
  timeParser: TimeParser,
): Promise<Trip[]> {
  const trips: Trip[] = [];
  let current: Trip | null = null;
  const sql = `
    SELECT t.trip_id, t.service_id,
           st.stop_id, st.arrival_time, st.departure_time,
           st.pickup_type, st.drop_off_type
    FROM trips t
    JOIN stop_times st USING (trip_id)
    ORDER BY t.trip_id, st.stop_sequence
  `;

  for await (const row of iterateRows(db, sql)) {
    const tripId = String(row.trip_id);
    const serviceId = String(row.service_id);
    if (!current || current.tripId !== tripId) {
      const service = services[serviceId];
      if (!service) continue;
      current = { tripId, serviceId, stopTimes: [], service };
      trips.push(current);
    }
    const arrival = row.arrival_time ?? row.departure_time;
    const departure = row.departure_time ?? row.arrival_time;
    if (arrival == null || departure == null) continue;
    const st: StopTime = {
      stop: String(row.stop_id),
      arrivalTime: timeParser.getTime(String(arrival)),
      departureTime: timeParser.getTime(String(departure)),
      pickUp: row.pickup_type === 0 || row.pickup_type == null,
      dropOff: row.drop_off_type === 0 || row.drop_off_type == null,
    };
    current.stopTimes.push(st);
  }

  return trips;
}

async function buildTransfers(
  db: ReturnType<GtfsSqlJs['getDatabase']>,
): Promise<{ transfers: TransfersByOrigin; interchangeBase: Record<string, number> }> {
  const transfers: TransfersByOrigin = {};
  const interchangeBase: Record<string, number> = {};

  // transfers.txt is optional; tolerate missing table.
  try {
    for await (const row of iterateRows(db, 'SELECT * FROM transfers')) {
      const from = String(row.from_stop_id);
      const to = String(row.to_stop_id);
      const seconds = row.min_transfer_time == null ? 0 : Number(row.min_transfer_time);
      if (from === to) {
        interchangeBase[from] = seconds;
      } else {
        const t: Transfer = {
          origin: from,
          destination: to,
          duration: seconds,
          startTime: 0,
          endTime: Number.MAX_SAFE_INTEGER,
        };
        (transfers[from] ??= []).push(t);
      }
    }
  } catch {
    // No transfers table — that is fine.
  }

  return { transfers, interchangeBase };
}

async function addParentStationBridges(
  db: ReturnType<GtfsSqlJs['getDatabase']>,
  transfers: TransfersByOrigin,
): Promise<void> {
  const sql = `
    SELECT stop_id, parent_station
    FROM stops
    WHERE parent_station IS NOT NULL AND parent_station != ''
  `;
  const seen = new Set<string>();
  const push = (from: string, to: string) => {
    const key = `${from}|${to}`;
    if (seen.has(key)) return;
    seen.add(key);
    (transfers[from] ??= []).push({
      origin: from,
      destination: to,
      duration: 0,
      startTime: 0,
      endTime: Number.MAX_SAFE_INTEGER,
    });
  };

  for await (const row of iterateRows(db, sql)) {
    const child = String(row.stop_id);
    const parent = String(row.parent_station);
    push(child, parent);
    push(parent, child);
  }
}

async function addSameNameBridges(
  db: ReturnType<GtfsSqlJs['getDatabase']>,
  transfers: TransfersByOrigin,
  maxMeters: number,
  walkingSpeedMps: number,
): Promise<void> {
  type StopRow = { stop_id: string; stop_name: string; lat: number; lon: number };
  const byName = new Map<string, StopRow[]>();
  const sql = `
    SELECT stop_id, stop_name, stop_lat, stop_lon
    FROM stops
    WHERE stop_name IS NOT NULL AND stop_name != ''
  `;
  for await (const row of iterateRows(db, sql)) {
    const lat = row.stop_lat == null ? NaN : Number(row.stop_lat);
    const lon = row.stop_lon == null ? NaN : Number(row.stop_lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const name = String(row.stop_name);
    const stopRow: StopRow = { stop_id: String(row.stop_id), stop_name: name, lat, lon };
    const arr = byName.get(name) ?? [];
    arr.push(stopRow);
    byName.set(name, arr);
  }

  const seen = new Set<string>();
  const push = (from: string, to: string, durationSeconds: number) => {
    const key = `${from}|${to}`;
    if (seen.has(key)) return;
    seen.add(key);
    (transfers[from] ??= []).push({
      origin: from,
      destination: to,
      duration: durationSeconds,
      startTime: 0,
      endTime: Number.MAX_SAFE_INTEGER,
    });
  };

  for (const group of byName.values()) {
    if (group.length < 2) continue;
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i];
        const b = group[j];
        const meters = haversineMeters(a.lat, a.lon, b.lat, b.lon);
        if (meters > maxMeters) continue;
        const seconds = Math.max(1, Math.round(meters / walkingSpeedMps));
        push(a.stop_id, b.stop_id, seconds);
        push(b.stop_id, a.stop_id, seconds);
      }
    }
  }
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
