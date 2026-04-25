import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GtfsSqlJs } from 'gtfs-sqljs';
import {
  RaptorAlgorithmFactory,
  GroupStationDepartAfterQuery,
  JourneyFactory,
} from 'raptor-journey-planner';
import { buildRaptorInputs, hydrateJourneys } from '../../src/index.js';
import { loadFixture } from '../helpers/loadFixture.js';

describe('Car Jaune e2e: Mairie de La Possession → Pyramide Fleurie 2026-05-27 09:00', () => {
  let gtfs: GtfsSqlJs;

  beforeAll(async () => {
    gtfs = await loadFixture('gtfs-car-jaune.zip');
  }, 60_000);
  afterAll(async () => {
    await gtfs.close();
  });

  it('finds at least one hydrated journey', async () => {
    // location_type=1 is a parent station and never appears in stop_times; raptor's
    // ScanResultsFactory only initializes kConnections for stops it sees in trip
    // stop_times, so passing a parent-only ID as origin/destination crashes raptor.
    // Filter to platforms (location_type 0/null).
    const possessionStops = (await gtfs.getStops({ name: 'Mairie de La Possession' })).filter(
      (s) => s.location_type !== 1,
    );
    const pyramideStops = (await gtfs.getStops({ name: 'Pyramide Fleurie' })).filter(
      (s) => s.location_type !== 1,
    );
    expect(possessionStops.length).toBeGreaterThan(0);
    expect(pyramideStops.length).toBeGreaterThan(0);

    const origins = possessionStops.map((s) => s.stop_id);
    const destinations = pyramideStops.map((s) => s.stop_id);

    const { trips, transfers, interchange } = await buildRaptorInputs(gtfs, {
      bridgeSameNameStops: true,
    });
    const raptor = RaptorAlgorithmFactory.create(trips, transfers, interchange);
    const query = new GroupStationDepartAfterQuery(raptor, new JourneyFactory());

    // 2026-05-27 is a Wednesday in Indian/Reunion (UTC+4). Noon UTC keeps date and dow on the same day for raptor.
    const journeys = query.plan(
      origins,
      destinations,
      new Date('2026-05-27T12:00:00Z'),
      9 * 3600,
    );

    if (journeys.length === 0) {
      throw new Error(
        `No journeys found for 2026-05-27. ` +
          `origins=${origins.join(',')} destinations=${destinations.join(',')}`,
      );
    }

    const hydrated = await hydrateJourneys(gtfs, journeys);
    expect(hydrated.length).toBe(journeys.length);

    const journey = hydrated[0];
    expect(journey.legs.length).toBeGreaterThan(0);

    const firstTimetableLeg = journey.legs.find((l) => l.type === 'timetable');
    expect(firstTimetableLeg).toBeDefined();
    if (firstTimetableLeg && firstTimetableLeg.type === 'timetable') {
      expect(firstTimetableLeg.trip.route.route_id).toBeTruthy();
      // Route long name OR short name should be populated.
      expect(
        firstTimetableLeg.trip.route.route_long_name ||
          firstTimetableLeg.trip.route.route_short_name,
      ).toBeTruthy();
      expect(firstTimetableLeg.origin.stop_name).toBeTruthy();
    }

    const allOrigins = journey.legs[0]?.origin.stop_name ?? '';
    const allDestinations = journey.legs[journey.legs.length - 1]?.destination.stop_name ?? '';
    // Origin/destination names should reference one of the requested endpoints
    // (could be parent station name or platform name — both share the same display name in this feed).
    expect(allOrigins).toMatch(/Possession/i);
    expect(allDestinations).toMatch(/Pyramide Fleurie/i);
  }, 120_000);
});
