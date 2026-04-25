import type { Stop as GtfsStop, Route } from 'gtfs-sqljs';

export interface HydratedStopTime {
  stop: GtfsStop;
  arrivalTime: number;
  departureTime: number;
  pickUp: boolean;
  dropOff: boolean;
}

export interface HydratedTripMeta {
  tripId: string;
  serviceId: string;
  headsign: string | null;
  directionId: number | null;
  shortName: string | null;
  route: Route;
}

export interface HydratedTimetableLeg {
  type: 'timetable';
  origin: GtfsStop;
  destination: GtfsStop;
  stopTimes: HydratedStopTime[];
  trip: HydratedTripMeta;
  departureTime: number;
  arrivalTime: number;
}

export interface HydratedTransferLeg {
  type: 'transfer';
  origin: GtfsStop;
  destination: GtfsStop;
  duration: number;
  startTime: number;
  endTime: number;
}

export type HydratedLeg = HydratedTimetableLeg | HydratedTransferLeg;

export interface HydratedJourney {
  legs: HydratedLeg[];
  departureTime: number;
  arrivalTime: number;
}
