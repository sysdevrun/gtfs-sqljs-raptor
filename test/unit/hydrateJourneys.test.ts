import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GtfsSqlJs } from 'gtfs-sqljs';
import {
  RaptorAlgorithmFactory,
  DepartAfterQuery,
  JourneyFactory,
} from 'raptor-journey-planner';
import { buildRaptorInputs, hydrateJourneys } from '../../src/index.js';
import { loadFixture } from '../helpers/loadFixture.js';

describe('hydrateJourneys (Google sample)', () => {
  let gtfs: GtfsSqlJs;

  beforeAll(async () => {
    gtfs = await loadFixture('gtfs-google-sample.zip');
  });
  afterAll(async () => {
    await gtfs.close();
  });

  it('hydrates STAGECOACH → BEATTY_AIRPORT with stop and route metadata', async () => {
    const { trips, transfers, interchange } = await buildRaptorInputs(gtfs);
    const raptor = RaptorAlgorithmFactory.create(trips, transfers, interchange);
    const query = new DepartAfterQuery(raptor, new JourneyFactory());
    const journeys = query.plan(
      'STAGECOACH',
      'BEATTY_AIRPORT',
      new Date('2007-01-08T12:00:00Z'),
      6 * 3600,
    );
    expect(journeys.length).toBeGreaterThan(0);

    const hydrated = await hydrateJourneys(gtfs, journeys);
    expect(hydrated).toHaveLength(journeys.length);

    const leg = hydrated[0].legs[0];
    if (leg.type !== 'timetable') throw new Error('expected timetable leg');

    expect(leg.origin.stop_id).toBe('STAGECOACH');
    expect(leg.origin.stop_name).toBe('Stagecoach Hotel & Casino (Demo)');
    expect(leg.destination.stop_id).toBe('BEATTY_AIRPORT');
    expect(leg.destination.stop_name).toBe('Nye County Airport (Demo)');

    expect(leg.trip.tripId).toBe('STBA');
    expect(leg.trip.headsign).toBe('Shuttle');
    expect(leg.trip.route.route_id).toBe('STBA');
    expect(leg.trip.route.route_short_name).toBe('30');

    expect(leg.stopTimes).toHaveLength(2);
    expect(leg.stopTimes[0].stop.stop_id).toBe('STAGECOACH');
    expect(leg.stopTimes[1].stop.stop_id).toBe('BEATTY_AIRPORT');

    expect(leg.departureTime).toBe(6 * 3600);
    expect(leg.arrivalTime).toBe(6 * 3600 + 20 * 60);
  });

  it('returns [] for empty input', async () => {
    expect(await hydrateJourneys(gtfs, [])).toEqual([]);
  });
});
