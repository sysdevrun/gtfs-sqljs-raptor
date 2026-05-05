import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GtfsSqlJs } from 'gtfs-sqljs';
import {
  buildRaptorInputs,
  findNearbyStops,
  hydrateJourneys,
  loadStopLocations,
  planByCoordinates,
  type Coordinate,
} from '../../src/index.js';
import { loadFixture } from '../helpers/loadFixture.js';

// Stagecoach Hotel & Casino is at 36.915682, -116.751677.
// Nye County Airport is at 36.868446, -116.784582.
// Place phantom endpoints ~80 m from each so a 400 m search radius picks them up.
const NEAR_STAGECOACH: Coordinate = {
  id: 'POINT_HOTEL',
  lat: 36.916400,
  lon: -116.751677,
};
const NEAR_BEATTY: Coordinate = {
  id: 'POINT_TERMINAL',
  lat: 36.867730,
  lon: -116.784582,
};

describe('planByCoordinates (Google sample)', () => {
  let gtfs: GtfsSqlJs;

  beforeAll(async () => {
    gtfs = await loadFixture('gtfs-google-sample.zip');
  });
  afterAll(async () => {
    await gtfs.close();
  });

  it('plans a journey between two coordinates not present in stops.txt', async () => {
    const inputs = await buildRaptorInputs(gtfs);
    const stops = await loadStopLocations(gtfs);

    const originNearby = findNearbyStops(NEAR_STAGECOACH, stops);
    const destinationNearby = findNearbyStops(NEAR_BEATTY, stops);

    expect(originNearby.map((n) => n.stopId)).toContain('STAGECOACH');
    expect(destinationNearby.map((n) => n.stopId)).toContain('BEATTY_AIRPORT');

    const journeys = planByCoordinates({
      inputs,
      origin: NEAR_STAGECOACH,
      destination: NEAR_BEATTY,
      originNearby,
      destinationNearby,
      date: new Date('2007-01-08T12:00:00Z'),
      departAfterSeconds: 6 * 3600,
    });

    expect(journeys.length).toBeGreaterThan(0);
    const j = journeys[0];

    // Journey must start at the origin coordinate and end at the destination coordinate.
    expect(j.legs[0].origin).toBe(NEAR_STAGECOACH.id);
    expect(j.legs[j.legs.length - 1].destination).toBe(NEAR_BEATTY.id);

    // First and last leg are walking edges (transfer legs); a real timetable
    // leg sits in the middle covering STAGECOACH → BEATTY_AIRPORT.
    const first = j.legs[0];
    const last = j.legs[j.legs.length - 1];
    expect('duration' in first ? first.duration : null).toBeGreaterThan(0);
    expect('duration' in last ? last.duration : null).toBeGreaterThan(0);

    const timetable = j.legs.find((l) => 'stopTimes' in l && Array.isArray(l.stopTimes));
    expect(timetable).toBeDefined();
    if (timetable && 'stopTimes' in timetable) {
      expect(timetable.origin).toBe('STAGECOACH');
      expect(timetable.destination).toBe('BEATTY_AIRPORT');
    }
  });

  it('hydrates middle legs after stripping the synthetic walking legs', async () => {
    const inputs = await buildRaptorInputs(gtfs);
    const stops = await loadStopLocations(gtfs);
    const journeys = planByCoordinates({
      inputs,
      origin: NEAR_STAGECOACH,
      destination: NEAR_BEATTY,
      originNearby: findNearbyStops(NEAR_STAGECOACH, stops),
      destinationNearby: findNearbyStops(NEAR_BEATTY, stops),
      date: new Date('2007-01-08T12:00:00Z'),
      departAfterSeconds: 6 * 3600,
    });

    // hydrateJourneys would throw on the outer legs because the endpoint ids
    // are not in stops.txt — strip them off before hydration. The two outer
    // transfer legs are local walks the caller can render from the input coords.
    const middle = journeys[0].legs.slice(1, -1);
    const stripped = [{ ...journeys[0], legs: middle }];
    const hydrated = await hydrateJourneys(gtfs, stripped);
    expect(hydrated[0].legs.length).toBe(middle.length);
  });

  it('does not mutate the base inputs across queries', async () => {
    const inputs = await buildRaptorInputs(gtfs);
    const tripsBefore = inputs.trips.length;
    const stagecoachTransfersBefore = (inputs.transfers['STAGECOACH'] ?? []).length;
    const beattyTransfersBefore = (inputs.transfers['BEATTY_AIRPORT'] ?? []).length;

    const stops = await loadStopLocations(gtfs);
    for (let i = 0; i < 3; i++) {
      planByCoordinates({
        inputs,
        origin: NEAR_STAGECOACH,
        destination: NEAR_BEATTY,
        originNearby: findNearbyStops(NEAR_STAGECOACH, stops),
        destinationNearby: findNearbyStops(NEAR_BEATTY, stops),
        date: new Date('2007-01-08T12:00:00Z'),
        departAfterSeconds: 6 * 3600,
      });
    }

    expect(inputs.trips.length).toBe(tripsBefore);
    expect((inputs.transfers['STAGECOACH'] ?? []).length).toBe(stagecoachTransfersBefore);
    expect((inputs.transfers['BEATTY_AIRPORT'] ?? []).length).toBe(beattyTransfersBefore);
    expect(inputs.transfers['POINT_HOTEL']).toBeUndefined();
    expect(inputs.transfers['POINT_TERMINAL']).toBeUndefined();
  });

  it('throws when origin and destination ids collide', async () => {
    const inputs = await buildRaptorInputs(gtfs);
    expect(() =>
      planByCoordinates({
        inputs,
        origin: { id: 'X', lat: 0, lon: 0 },
        destination: { id: 'X', lat: 0, lon: 0 },
        originNearby: [],
        destinationNearby: [],
        date: new Date('2007-01-08T12:00:00Z'),
        departAfterSeconds: 0,
      }),
    ).toThrow(/must differ/i);
  });
});

describe('findNearbyStops', () => {
  it('returns closest stops first, capped at maxNearbyStops', () => {
    const stops = [
      { id: 'A', lat: 0.0, lon: 0.0 },
      { id: 'B', lat: 0.001, lon: 0.0 }, // ~111 m
      { id: 'C', lat: 0.0, lon: 0.005 }, // ~556 m (out of default 400 m radius)
      { id: 'D', lat: 0.002, lon: 0.0 }, // ~222 m
    ];
    const result = findNearbyStops({ id: 'P', lat: 0, lon: 0 }, stops, {
      radiusMeters: 400,
      walkingSpeedMps: 1.2,
      maxNearbyStops: 5,
    });
    expect(result.map((r) => r.stopId)).toEqual(['A', 'B', 'D']);
    for (const r of result) {
      expect(r.walkSeconds).toBeGreaterThanOrEqual(1);
    }
  });

  it('skips stops with non-finite coordinates', () => {
    const stops = [
      { id: 'A', lat: 0.0, lon: 0.0 },
      { id: 'BAD', lat: NaN, lon: 0 },
    ];
    const result = findNearbyStops({ id: 'P', lat: 0, lon: 0 }, stops);
    expect(result.map((r) => r.stopId)).toEqual(['A']);
  });

  it('accepts a bare { lat, lon } point', () => {
    const stops = [{ id: 'A', lat: 0, lon: 0 }];
    const result = findNearbyStops({ lat: 0.0005, lon: 0 }, stops);
    expect(result.map((r) => r.stopId)).toEqual(['A']);
  });
});
