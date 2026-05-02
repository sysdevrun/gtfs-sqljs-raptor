import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GtfsSqlJs } from 'gtfs-sqljs';
import {
  buildRaptorInputs,
  findNearbyStops,
  hydrateJourneys,
  loadStopLocations,
  planForPois,
  type Poi,
} from '../../src/index.js';
import { loadFixture } from '../helpers/loadFixture.js';

// Hôtel de Ville de Saint-Louis (south of Réunion).
const HOTEL_DE_VILLE_ST_LOUIS: Poi = {
  id: 'POI_HDV_ST_LOUIS',
  lat: -21.28663,
  lon: 55.40921,
};
// Hôtel de Ville de Saint-Denis (capital, north).
const HOTEL_DE_VILLE_ST_DENIS: Poi = {
  id: 'POI_HDV_ST_DENIS',
  lat: -20.87877,
  lon: 55.44845,
};

describe('Car Jaune e2e: Hôtel de Ville Saint-Louis → Hôtel de Ville Saint-Denis (POIs)', () => {
  let gtfs: GtfsSqlJs;

  beforeAll(async () => {
    gtfs = await loadFixture('gtfs-car-jaune.zip');
  }, 60_000);
  afterAll(async () => {
    await gtfs.close();
  });

  it('plans a journey between the two hôtels de ville', async () => {
    const inputs = await buildRaptorInputs(gtfs, { bridgeSameNameStops: true });
    const stops = await loadStopLocations(gtfs);

    // Gare de St-Denis sits ~900 m from the Hôtel de Ville de Saint-Denis,
    // so the default 400 m radius isn't enough — widen it.
    const findOpts = { radiusMeters: 1500, walkingSpeedMps: 1.2, maxNearbyStops: 12 };
    const originNearby = findNearbyStops(HOTEL_DE_VILLE_ST_LOUIS, stops, findOpts);
    const destinationNearby = findNearbyStops(HOTEL_DE_VILLE_ST_DENIS, stops, findOpts);

    expect(originNearby.length).toBeGreaterThan(0);
    expect(destinationNearby.length).toBeGreaterThan(0);

    // 2026-05-04 is a Monday in Indian/Reunion (UTC+4); noon UTC keeps date and
    // dow on the same calendar day for raptor.
    const journeys = planForPois({
      inputs,
      origin: HOTEL_DE_VILLE_ST_LOUIS,
      destination: HOTEL_DE_VILLE_ST_DENIS,
      originNearby,
      destinationNearby,
      date: new Date('2026-05-04T12:00:00Z'),
      departAfterSeconds: 8 * 3600,
    });

    if (journeys.length === 0) {
      throw new Error(
        `No journeys found. originNearby=${JSON.stringify(originNearby)} ` +
          `destinationNearby=${JSON.stringify(destinationNearby)}`,
      );
    }

    const j = journeys[0];

    // Outer legs are walks from/to the POIs.
    expect(j.legs[0].origin).toBe(HOTEL_DE_VILLE_ST_LOUIS.id);
    expect(j.legs[j.legs.length - 1].destination).toBe(HOTEL_DE_VILLE_ST_DENIS.id);

    // The journey must contain at least one timetable leg between real stops.
    const timetable = j.legs.find((l) => 'stopTimes' in l && Array.isArray(l.stopTimes));
    expect(timetable).toBeDefined();

    // Hydrate the real-stop legs (POI legs aren't in stops.txt, strip them off).
    const middle = j.legs.slice(1, -1);
    const stripped = [{ ...j, legs: middle }];
    const hydrated = await hydrateJourneys(gtfs, stripped);
    expect(hydrated[0].legs.length).toBe(middle.length);

    const firstTimetable = hydrated[0].legs.find((l) => l.type === 'timetable');
    expect(firstTimetable).toBeDefined();
    if (firstTimetable && firstTimetable.type === 'timetable') {
      // The originating real stop should be reachable on foot from the
      // Saint-Louis hôtel de ville (the planner usually picks Gare de St-Louis
      // ~390 m away).
      expect(firstTimetable.origin.stop_name).toBeTruthy();
    }
  }, 120_000);
});
