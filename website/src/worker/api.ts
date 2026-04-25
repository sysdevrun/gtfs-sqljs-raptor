import type { Stop } from 'gtfs-sqljs';
import type { HydratedJourney, BuildRaptorInputsOptions } from 'gtfs-sqljs-raptor';

export interface LoadResult {
  loadMs: number;
  buildMs: number;
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

export interface WorkerApi {
  loadFromUrl(url: string, options: BuildRaptorInputsOptions): Promise<LoadResult>;
  loadFromBuffer(buffer: ArrayBuffer, options: BuildRaptorInputsOptions): Promise<LoadResult>;
  rebuild(options: BuildRaptorInputsOptions): Promise<{ buildMs: number }>;
  searchStopGroups(query: string, limit?: number): Promise<NamedStopGroup[]>;
  plan(input: PlanInput): Promise<PlanResult>;
  close(): Promise<void>;
}
