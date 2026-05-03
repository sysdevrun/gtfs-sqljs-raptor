import type { HydratedJourney, HydratedTimetableLeg } from 'gtfs-sqljs-raptor';
import { lineString, point } from '@turf/helpers';
import lineSlice from '@turf/line-slice';
import type { HydratedCoordinateJourney } from '../worker/api';
import { asHex, readableTextColor } from './contrast';

export interface WalkFeature {
  coordinates: [number, number][];
  durationSeconds: number;
  label: string;
}

export interface TransitFeature {
  coordinates: [number, number][];
  fillColor: string;
  contourColor: string;
  routeLabel: string;
  headsign: string | null;
}

export interface JourneyGeometry {
  walks: WalkFeature[];
  transits: TransitFeature[];
  /** Bounding box of all drawn coords; null if nothing to draw. */
  bounds: { minLat: number; minLon: number; maxLat: number; maxLon: number } | null;
}

function isTimetableLeg(leg: HydratedJourney['legs'][number]): leg is HydratedTimetableLeg {
  return leg.type === 'timetable';
}

/**
 * Slice the shape between the leg's boarding and alighting stops by projecting
 * both onto the polyline with turf and keeping the segment in between. Returns
 * `null` if either stop lacks coordinates (caller falls back to the full shape).
 */
function sliceShapeForLeg(
  leg: HydratedTimetableLeg,
  shape: [number, number][],
): [number, number][] | null {
  const o = leg.origin;
  const d = leg.destination;
  if (
    typeof o.stop_lon !== 'number' || typeof o.stop_lat !== 'number' ||
    typeof d.stop_lon !== 'number' || typeof d.stop_lat !== 'number'
  ) {
    return null;
  }
  const line = lineString(shape);
  const sliced = lineSlice(
    point([o.stop_lon, o.stop_lat]),
    point([d.stop_lon, d.stop_lat]),
    line,
  );
  return sliced.geometry.coordinates as [number, number][];
}

function legCoords(leg: HydratedTimetableLeg, shape: [number, number][] | undefined): [number, number][] {
  if (shape && shape.length >= 2) {
    const sliced = sliceShapeForLeg(leg, shape);
    if (sliced && sliced.length >= 2) return sliced;
    return shape;
  }
  // Fall back to a polyline through the leg's stop_times.
  const out: [number, number][] = [];
  for (const st of leg.stopTimes) {
    if (typeof st.stop.stop_lon === 'number' && typeof st.stop.stop_lat === 'number') {
      out.push([st.stop.stop_lon, st.stop.stop_lat]);
    }
  }
  return out;
}

function transitColors(leg: HydratedTimetableLeg): { fillColor: string; contourColor: string } {
  const fill = asHex(leg.trip.route.route_color, '#1d4ed8');
  const contour = leg.trip.route.route_text_color
    ? asHex(leg.trip.route.route_text_color, readableTextColor(leg.trip.route.route_color))
    : readableTextColor(leg.trip.route.route_color);
  return { fillColor: fill, contourColor: contour };
}

function trackBounds(coords: [number, number][], box: number[]): void {
  for (const [lon, lat] of coords) {
    if (lon < box[0]) box[0] = lon;
    if (lon > box[2]) box[2] = lon;
    if (lat < box[1]) box[1] = lat;
    if (lat > box[3]) box[3] = lat;
  }
}

/**
 * Build map-friendly geometry for a regular (stop-to-stop) journey. Walking
 * "transfer" legs are drawn as straight lines between the two stop coordinates.
 */
export function geometryForJourney(
  journey: HydratedJourney,
  shapesByTripId: Record<string, [number, number][]>,
): JourneyGeometry {
  const walks: WalkFeature[] = [];
  const transits: TransitFeature[] = [];
  const box = [Infinity, Infinity, -Infinity, -Infinity];

  for (const leg of journey.legs) {
    if (isTimetableLeg(leg)) {
      const coords = legCoords(leg, shapesByTripId[leg.trip.tripId]);
      if (coords.length < 2) continue;
      const { fillColor, contourColor } = transitColors(leg);
      transits.push({
        coordinates: coords,
        fillColor,
        contourColor,
        routeLabel:
          leg.trip.route.route_short_name ||
          leg.trip.route.route_long_name ||
          leg.trip.route.route_id,
        headsign: leg.trip.headsign,
      });
      trackBounds(coords, box);
    } else {
      const a = leg.origin;
      const b = leg.destination;
      if (
        typeof a.stop_lon === 'number' && typeof a.stop_lat === 'number' &&
        typeof b.stop_lon === 'number' && typeof b.stop_lat === 'number'
      ) {
        const coords: [number, number][] = [[a.stop_lon, a.stop_lat], [b.stop_lon, b.stop_lat]];
        walks.push({
          coordinates: coords,
          durationSeconds: leg.duration,
          label: a.stop_name === b.stop_name ? `${a.stop_name} (transfer)` : `${a.stop_name} → ${b.stop_name}`,
        });
        trackBounds(coords, box);
      }
    }
  }

  return {
    walks,
    transits,
    bounds: Number.isFinite(box[0])
      ? { minLon: box[0], minLat: box[1], maxLon: box[2], maxLat: box[3] }
      : null,
  };
}

/**
 * Build map-friendly geometry for a coordinate journey
 * (origin walk → middle → destination walk).
 */
export function geometryForCoordinateJourney(
  journey: HydratedCoordinateJourney,
  shapesByTripId: Record<string, [number, number][]>,
): JourneyGeometry {
  const walks: WalkFeature[] = [];
  const transits: TransitFeature[] = [];
  const box = [Infinity, Infinity, -Infinity, -Infinity];

  // Origin walk: coordinate → first transit stop.
  if (Number.isFinite(journey.originWalk.toStopLat) && Number.isFinite(journey.originWalk.toStopLon)) {
    const coords: [number, number][] = [
      [journey.origin.lon, journey.origin.lat],
      [journey.originWalk.toStopLon, journey.originWalk.toStopLat],
    ];
    walks.push({ coordinates: coords, durationSeconds: journey.originWalk.duration, label: 'Walk to transit' });
    trackBounds(coords, box);
  }

  for (const leg of journey.middleLegs) {
    if (isTimetableLeg(leg)) {
      const coords = legCoords(leg, shapesByTripId[leg.trip.tripId]);
      if (coords.length < 2) continue;
      const { fillColor, contourColor } = transitColors(leg);
      transits.push({
        coordinates: coords,
        fillColor,
        contourColor,
        routeLabel:
          leg.trip.route.route_short_name ||
          leg.trip.route.route_long_name ||
          leg.trip.route.route_id,
        headsign: leg.trip.headsign,
      });
      trackBounds(coords, box);
    } else {
      const a = leg.origin;
      const b = leg.destination;
      if (
        typeof a.stop_lon === 'number' && typeof a.stop_lat === 'number' &&
        typeof b.stop_lon === 'number' && typeof b.stop_lat === 'number'
      ) {
        const coords: [number, number][] = [[a.stop_lon, a.stop_lat], [b.stop_lon, b.stop_lat]];
        walks.push({
          coordinates: coords,
          durationSeconds: leg.duration,
          label: a.stop_name === b.stop_name ? `${a.stop_name} (transfer)` : `${a.stop_name} → ${b.stop_name}`,
        });
        trackBounds(coords, box);
      }
    }
  }

  // Destination walk: last transit stop → coordinate.
  if (
    Number.isFinite(journey.destinationWalk.fromStopLat) &&
    Number.isFinite(journey.destinationWalk.fromStopLon)
  ) {
    const coords: [number, number][] = [
      [journey.destinationWalk.fromStopLon, journey.destinationWalk.fromStopLat],
      [journey.destination.lon, journey.destination.lat],
    ];
    walks.push({
      coordinates: coords,
      durationSeconds: journey.destinationWalk.duration,
      label: 'Walk to destination',
    });
    trackBounds(coords, box);
  }

  return {
    walks,
    transits,
    bounds: Number.isFinite(box[0])
      ? { minLon: box[0], minLat: box[1], maxLon: box[2], maxLat: box[3] }
      : null,
  };
}
