import type { Stop } from 'gtfs-sqljs';
import type {
  HydratedJourney,
  HydratedTransferLeg,
  BuildRaptorInputsOptions,
} from 'gtfs-sqljs-raptor';

export interface LoadResult {
  loadMs: number;
  inputsMs: number;
  indexMs: number;
  tripCount: number;
  stopCount: number;
  routeCount: number;
  serviceIdsRunningSomeDay: number;
  feedTimezone: string | null;
  /** Bounding box of all stops with valid coords, or null if the feed has none. */
  feedBounds: { minLat: number; minLon: number; maxLat: number; maxLon: number } | null;
}

export interface PlanInput {
  originStopIds: string[];
  destinationStopIds: string[];
  /** YYYY-MM-DD (interpreted as that date at noon UTC for raptor). */
  date: string;
  /** Seconds since midnight, e.g. 9*3600 for 09:00. */
  departAfterSeconds: number;
  /** Range query mode: search up to this seconds after departAfterSeconds. */
  rangeSeconds?: number;
}

export interface PoiPlanInput {
  origin: { id: string; lat: number; lon: number };
  destination: { id: string; lat: number; lon: number };
  date: string;
  departAfterSeconds: number;
  /** Default 1500 m. */
  radiusMeters?: number;
  /** Default 1.2 m/s. */
  walkingSpeedMps?: number;
  /** Default 12. */
  maxNearbyStops?: number;
}

export interface PoiHydratedJourney {
  departureTime: number;
  arrivalTime: number;
  origin: { id: string; lat: number; lon: number };
  destination: { id: string; lat: number; lon: number };
  /** Walk from the origin POI to the first transit stop. */
  originWalk: { duration: number; toStopId: string; toStopLat: number; toStopLon: number };
  /** Walk from the last transit stop to the destination POI. */
  destinationWalk: { duration: number; fromStopId: string; fromStopLat: number; fromStopLon: number };
  /** All non-POI legs (timetable + intra-feed transfer walks). */
  middleLegs: HydratedJourney['legs'];
}

export interface PlanResult {
  computeMs: number;
  hydrateMs: number;
  rawCount: number;
  journeys: HydratedJourney[];
  /** [lon, lat] pairs from shapes.txt, keyed by trip_id. Empty array when missing. */
  shapesByTripId: Record<string, [number, number][]>;
}

export interface PoiPlanResult {
  computeMs: number;
  hydrateMs: number;
  rawCount: number;
  journeys: PoiHydratedJourney[];
  shapesByTripId: Record<string, [number, number][]>;
}

export type HydratedTransferLegRef = HydratedTransferLeg;

export interface NamedStopGroup {
  name: string;
  /** Platform stop_ids (location_type !== 1). */
  stopIds: string[];
  /** A representative stop for display (first non-parent). */
  representative: Stop;
}

/**
 * Streaming progress reported during load + raptor pre-compute. `percent` is
 * 0–100 for `load` (driven by gtfs-sqljs's onProgress); `null` for the other
 * phases since we don't have a meaningful denominator there.
 */
export interface PlannerProgress {
  phase: 'load' | 'build-raptor' | 'gather-stats' | 'rebuild';
  percent: number | null;
  message: string;
  currentFile?: string | null;
}

export type ProgressCallback = (p: PlannerProgress) => void;

export interface WorkerApi {
  /** `wasmUrl` is the absolute URL to sql-wasm.wasm, resolved from the page's base. */
  loadFromUrl(
    url: string,
    options: BuildRaptorInputsOptions,
    wasmUrl: string,
    onProgress: ProgressCallback,
  ): Promise<LoadResult>;
  loadFromBuffer(
    buffer: ArrayBuffer,
    options: BuildRaptorInputsOptions,
    wasmUrl: string,
    onProgress: ProgressCallback,
  ): Promise<LoadResult>;
  rebuild(
    options: BuildRaptorInputsOptions,
    onProgress: ProgressCallback,
  ): Promise<{ inputsMs: number; indexMs: number }>;
  searchStopGroups(query: string, limit?: number): Promise<NamedStopGroup[]>;
  plan(input: PlanInput): Promise<PlanResult>;
  planForPois(input: PoiPlanInput): Promise<PoiPlanResult>;
  close(): Promise<void>;
}
