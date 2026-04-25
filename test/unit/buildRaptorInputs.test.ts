import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GtfsSqlJs } from 'gtfs-sqljs';
import {
  RaptorAlgorithmFactory,
  DepartAfterQuery,
  JourneyFactory,
} from 'raptor-journey-planner';
import { buildRaptorInputs } from '../../src/index.js';
import { loadFixture } from '../helpers/loadFixture.js';

describe('buildRaptorInputs (Google sample)', () => {
  let gtfs: GtfsSqlJs;

  beforeAll(async () => {
    gtfs = await loadFixture('gtfs-google-sample.zip');
  });
  afterAll(async () => {
    await gtfs.close();
  });

  it('builds 11 trips matching the fixture', async () => {
    const { trips } = await buildRaptorInputs(gtfs);
    expect(trips).toHaveLength(11);
  });

  it('parses STBA stop times correctly', async () => {
    const { trips } = await buildRaptorInputs(gtfs);
    const stba = trips.find((t) => t.tripId === 'STBA');
    expect(stba).toBeDefined();
    expect(stba!.stopTimes).toHaveLength(2);
    expect(stba!.stopTimes[0]).toMatchObject({
      stop: 'STAGECOACH',
      arrivalTime: 6 * 3600,
      departureTime: 6 * 3600,
      pickUp: true,
      dropOff: true,
    });
    expect(stba!.stopTimes[1]).toMatchObject({
      stop: 'BEATTY_AIRPORT',
      arrivalTime: 6 * 3600 + 20 * 60,
    });
  });

  it('attaches Service to each trip', async () => {
    const { trips } = await buildRaptorInputs(gtfs);
    const stba = trips.find((t) => t.tripId === 'STBA')!;
    // Mon 2007-01-08, dow=1
    expect(stba.service.runsOn(20070108, 1)).toBe(true);
  });

  it('interchange Proxy returns 0 for unknown stop ids', async () => {
    const { interchange } = await buildRaptorInputs(gtfs);
    expect(interchange['NEVER_HEARD_OF_THIS']).toBe(0);
  });

  it('end-to-end: plans STAGECOACH → BEATTY_AIRPORT on 2007-01-08', async () => {
    const { trips, transfers, interchange } = await buildRaptorInputs(gtfs);
    const raptor = RaptorAlgorithmFactory.create(trips, transfers, interchange);
    const query = new DepartAfterQuery(raptor, new JourneyFactory());
    // Noon UTC keeps date number (UTC) and getDay (local) on the same calendar day across timezones.
    const journeys = query.plan(
      'STAGECOACH',
      'BEATTY_AIRPORT',
      new Date('2007-01-08T12:00:00Z'),
      6 * 3600,
    );
    expect(journeys.length).toBeGreaterThan(0);
    const j = journeys[0];
    expect(j.legs).toHaveLength(1);
    expect(j.legs[0].origin).toBe('STAGECOACH');
    expect(j.legs[0].destination).toBe('BEATTY_AIRPORT');
  });
});
