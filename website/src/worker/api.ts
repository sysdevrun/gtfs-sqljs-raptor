import type { Stop } from 'gtfs-sqljs';
import type { HydratedJourney, BuildRaptorInputsOptions } from 'gtfs-sqljs-raptor';

export interface LoadResult {
  loadMs: number;
  inputsMs: number;
  indexMs: number;
  tripCount: number;
  stopCount: number;
  routeCount: number;
  serviceIdsRunningSomeDay: number;
  feedTimezone: string | null;
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

export interface PlanResult {
  computeMs: number;
  hydrateMs: number;
  rawCount: number;
  journeys: HydratedJourney[];
}

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
  close(): Promise<void>;
}
