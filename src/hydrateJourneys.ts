import type { GtfsSqlJs, Stop as GtfsStop, Route } from 'gtfs-sqljs';
import type { Journey, AnyLeg, TimetableLeg } from 'raptor-journey-planner';
import type {
  HydratedJourney,
  HydratedLeg,
  HydratedStopTime,
  HydratedTimetableLeg,
  HydratedTransferLeg,
  HydratedTripMeta,
} from './types.js';
import { fetchAll } from './internal/sqlHelpers.js';

function isTimetableLeg(leg: AnyLeg): leg is TimetableLeg {
  return Array.isArray((leg as TimetableLeg).stopTimes);
}

export async function hydrateJourneys(
  gtfs: GtfsSqlJs,
  journeys: Journey[],
): Promise<HydratedJourney[]> {
  if (journeys.length === 0) return [];

  const stopIds = new Set<string>();
  const tripIds = new Set<string>();
  for (const j of journeys) {
    for (const leg of j.legs) {
      stopIds.add(leg.origin);
      stopIds.add(leg.destination);
      if (isTimetableLeg(leg)) {
        tripIds.add(leg.trip.tripId);
        for (const st of leg.stopTimes) stopIds.add(st.stop);
      }
    }
  }

  const stops = await fetchStops(gtfs, [...stopIds]);
  const trips = await fetchTrips(gtfs, [...tripIds]);

  const lookupStop = (id: string): GtfsStop => {
    const s = stops.get(id);
    if (!s) throw new Error(`hydrateJourneys: stop_id "${id}" not found in feed`);
    return s;
  };
  const lookupTrip = (id: string): HydratedTripMeta => {
    const t = trips.get(id);
    if (!t) throw new Error(`hydrateJourneys: trip_id "${id}" not found in feed`);
    return t;
  };

  return journeys.map((j) => ({
    legs: j.legs.map((leg) => hydrateLeg(leg, lookupStop, lookupTrip)),
    departureTime: j.departureTime,
    arrivalTime: j.arrivalTime,
  }));
}

function hydrateLeg(
  leg: AnyLeg,
  lookupStop: (id: string) => GtfsStop,
  lookupTrip: (id: string) => HydratedTripMeta,
): HydratedLeg {
  if (isTimetableLeg(leg)) {
    const stopTimes: HydratedStopTime[] = leg.stopTimes.map((st) => ({
      stop: lookupStop(st.stop),
      arrivalTime: st.arrivalTime,
      departureTime: st.departureTime,
      pickUp: st.pickUp,
      dropOff: st.dropOff,
    }));
    const out: HydratedTimetableLeg = {
      type: 'timetable',
      origin: lookupStop(leg.origin),
      destination: lookupStop(leg.destination),
      stopTimes,
      trip: lookupTrip(leg.trip.tripId),
      departureTime: stopTimes[0]?.departureTime ?? 0,
      arrivalTime: stopTimes[stopTimes.length - 1]?.arrivalTime ?? 0,
    };
    return out;
  }
  const out: HydratedTransferLeg = {
    type: 'transfer',
    origin: lookupStop(leg.origin),
    destination: lookupStop(leg.destination),
    duration: leg.duration,
    startTime: leg.startTime,
    endTime: leg.endTime,
  };
  return out;
}

async function fetchStops(
  gtfs: GtfsSqlJs,
  ids: string[],
): Promise<Map<string, GtfsStop>> {
  if (ids.length === 0) return new Map();
  const list = await gtfs.getStops({ stopId: ids });
  return new Map(list.map((s) => [s.stop_id, s]));
}

async function fetchTrips(
  gtfs: GtfsSqlJs,
  ids: string[],
): Promise<Map<string, HydratedTripMeta>> {
  if (ids.length === 0) return new Map();
  const db = gtfs.getDatabase();
  const placeholders = ids.map(() => '?').join(', ');
  const rows = await fetchAll(
    db,
    `SELECT t.trip_id, t.service_id, t.trip_headsign, t.trip_short_name, t.direction_id,
            r.*
     FROM trips t
     JOIN routes r USING (route_id)
     WHERE t.trip_id IN (${placeholders})`,
    ids,
  );
  const out = new Map<string, HydratedTripMeta>();
  for (const r of rows) {
    const route: Route = {
      route_id: String(r.route_id),
      route_short_name: r.route_short_name == null ? undefined : String(r.route_short_name),
      route_long_name: r.route_long_name == null ? undefined : String(r.route_long_name),
      route_type: Number(r.route_type),
      agency_id: r.agency_id == null ? undefined : String(r.agency_id),
      route_desc: r.route_desc == null ? undefined : String(r.route_desc),
      route_url: r.route_url == null ? undefined : String(r.route_url),
      route_color: r.route_color == null ? undefined : String(r.route_color),
      route_text_color: r.route_text_color == null ? undefined : String(r.route_text_color),
      route_sort_order: r.route_sort_order == null ? undefined : Number(r.route_sort_order),
    };
    out.set(String(r.trip_id), {
      tripId: String(r.trip_id),
      serviceId: String(r.service_id),
      headsign: r.trip_headsign == null ? null : String(r.trip_headsign),
      directionId: r.direction_id == null ? null : Number(r.direction_id),
      shortName: r.trip_short_name == null ? null : String(r.trip_short_name),
      route,
    });
  }
  return out;
}
