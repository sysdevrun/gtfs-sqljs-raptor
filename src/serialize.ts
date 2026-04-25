import {
  Service,
  type Trip,
  type StopTime,
  type Transfer,
  type TransfersByOrigin,
  type DayOfWeek,
} from 'raptor-journey-planner';
import type { RaptorInputs } from './buildRaptorInputs.js';
import { withDefaultInterchange } from './internal/interchangeProxy.js';

export const SERIALIZATION_VERSION = 1 as const;

export interface SerializedService {
  startDate: number;
  endDate: number;
  /** Sun..Sat (indexes 0..6). */
  days: [boolean, boolean, boolean, boolean, boolean, boolean, boolean];
  /** include=true / exclude=false, keyed by YYYYMMDD. */
  dates: Record<number, boolean>;
}

/** [stop_id, arrivalTime, departureTime, flags]. flags: bit0=pickUp, bit1=dropOff. */
export type SerializedStopTime = [string, number, number, number];

export interface SerializedTrip {
  tripId: string;
  serviceId: string;
  stopTimes: SerializedStopTime[];
}

/** [destination, duration, startTime, endTime]. origin is the map key. */
export type SerializedTransfer = [string, number, number, number];

export interface SerializedRaptorInputs {
  version: typeof SERIALIZATION_VERSION;
  defaultInterchangeSeconds: number;
  services: Record<string, SerializedService>;
  trips: SerializedTrip[];
  transfers: Record<string, SerializedTransfer[]>;
  interchange: Record<string, number>;
}

export interface SerializeRaptorInputsOptions {
  /**
   * Default interchange (seconds) used to reconstruct the interchange Proxy on
   * import. Pass the same value you gave to `buildRaptorInputs` — it can't be
   * recovered from the Proxy after the fact.
   */
  defaultInterchangeSeconds?: number;
}

export function serializeRaptorInputs(
  inputs: RaptorInputs,
  options: SerializeRaptorInputsOptions = {},
): SerializedRaptorInputs {
  const { defaultInterchangeSeconds = 0 } = options;

  const services: Record<string, SerializedService> = {};
  for (const trip of inputs.trips) {
    if (!services[trip.serviceId]) services[trip.serviceId] = serializeService(trip.service);
  }

  const trips: SerializedTrip[] = inputs.trips.map((t) => ({
    tripId: t.tripId,
    serviceId: t.serviceId,
    stopTimes: t.stopTimes.map(stopTimeToTuple),
  }));

  const transfers: Record<string, SerializedTransfer[]> = {};
  for (const [origin, list] of Object.entries(inputs.transfers)) {
    transfers[origin] = list.map(
      (t) => [t.destination, t.duration, t.startTime, t.endTime] as SerializedTransfer,
    );
  }

  // The interchange is a Proxy whose target is the underlying explicit map;
  // Object.keys returns only those explicit keys (the Proxy doesn't claim others).
  const interchange: Record<string, number> = {};
  for (const k of Object.keys(inputs.interchange)) {
    interchange[k] = (inputs.interchange as Record<string, number>)[k];
  }

  return {
    version: SERIALIZATION_VERSION,
    defaultInterchangeSeconds,
    services,
    trips,
    transfers,
    interchange,
  };
}

export function deserializeRaptorInputs(data: SerializedRaptorInputs): RaptorInputs {
  if (data.version !== SERIALIZATION_VERSION) {
    throw new Error(
      `deserializeRaptorInputs: unsupported version ${data.version} (expected ${SERIALIZATION_VERSION})`,
    );
  }

  const services: Record<string, Service> = {};
  for (const [sid, s] of Object.entries(data.services)) services[sid] = deserializeService(s);

  const trips: Trip[] = data.trips.map((t) => {
    const service = services[t.serviceId];
    if (!service) {
      throw new Error(
        `deserializeRaptorInputs: trip "${t.tripId}" references unknown service "${t.serviceId}"`,
      );
    }
    const stopTimes: StopTime[] = t.stopTimes.map(tupleToStopTime);
    return { tripId: t.tripId, serviceId: t.serviceId, stopTimes, service };
  });

  const transfers: TransfersByOrigin = {};
  for (const [origin, list] of Object.entries(data.transfers)) {
    transfers[origin] = list.map(
      ([destination, duration, startTime, endTime]): Transfer => ({
        origin,
        destination,
        duration,
        startTime,
        endTime,
      }),
    );
  }

  return {
    trips,
    transfers,
    interchange: withDefaultInterchange({ ...data.interchange }, data.defaultInterchangeSeconds),
  };
}

function stopTimeToTuple(st: StopTime): SerializedStopTime {
  const flags = (st.pickUp ? 1 : 0) | (st.dropOff ? 2 : 0);
  return [st.stop, st.arrivalTime, st.departureTime, flags];
}

function tupleToStopTime([stop, arrivalTime, departureTime, flags]: SerializedStopTime): StopTime {
  return {
    stop,
    arrivalTime,
    departureTime,
    pickUp: (flags & 1) !== 0,
    dropOff: (flags & 2) !== 0,
  };
}

// `Service` declares its fields `private` in TypeScript, but TS `private` is a
// compile-time check — at runtime they're regular instance properties.
type ServiceFields = {
  startDate: number;
  endDate: number;
  days: Record<DayOfWeek, boolean>;
  dates: Record<number, boolean>;
};

function serializeService(service: Service): SerializedService {
  const s = service as unknown as ServiceFields;
  return {
    startDate: s.startDate,
    endDate: s.endDate,
    days: [s.days[0], s.days[1], s.days[2], s.days[3], s.days[4], s.days[5], s.days[6]],
    dates: { ...s.dates },
  };
}

function deserializeService(s: SerializedService): Service {
  const days: Record<DayOfWeek, boolean> = {
    0: s.days[0],
    1: s.days[1],
    2: s.days[2],
    3: s.days[3],
    4: s.days[4],
    5: s.days[5],
    6: s.days[6],
  };
  return new Service(s.startDate, s.endDate, days, { ...s.dates });
}
