import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GtfsSqlJs } from 'gtfs-sqljs';
import {
  RaptorAlgorithmFactory,
  DepartAfterQuery,
  JourneyFactory,
} from 'raptor-journey-planner';
import {
  buildRaptorInputs,
  serializeRaptorInputs,
  deserializeRaptorInputs,
  SERIALIZATION_VERSION,
} from '../../src/index.js';
import { loadFixture } from '../helpers/loadFixture.js';

describe('serializeRaptorInputs / deserializeRaptorInputs (Google sample)', () => {
  let gtfs: GtfsSqlJs;

  beforeAll(async () => {
    gtfs = await loadFixture('gtfs-google-sample.zip');
  });
  afterAll(async () => {
    await gtfs.close();
  });

  it('round-trips through JSON and produces equivalent plans', async () => {
    const original = await buildRaptorInputs(gtfs, { defaultInterchangeSeconds: 60 });
    const serialized = serializeRaptorInputs(original, { defaultInterchangeSeconds: 60 });

    expect(serialized.version).toBe(SERIALIZATION_VERSION);
    expect(serialized.defaultInterchangeSeconds).toBe(60);
    expect(serialized.trips.length).toBe(original.trips.length);

    const json = JSON.stringify(serialized);
    const restored = deserializeRaptorInputs(JSON.parse(json));

    expect(restored.trips.length).toBe(original.trips.length);
    expect(restored.interchange['NEVER_HEARD_OF_THIS']).toBe(60);

    const stbaOriginal = original.trips.find((t) => t.tripId === 'STBA')!;
    const stbaRestored = restored.trips.find((t) => t.tripId === 'STBA')!;
    expect(stbaRestored.stopTimes).toEqual(stbaOriginal.stopTimes);
    // Mon 2007-01-08 — service must still resolve.
    expect(stbaRestored.service.runsOn(20070108, 1)).toBe(true);

    const planFrom = (inputs: typeof original) => {
      const raptor = RaptorAlgorithmFactory.create(inputs.trips, inputs.transfers, inputs.interchange);
      const query = new DepartAfterQuery(raptor, new JourneyFactory());
      return query.plan(
        'STAGECOACH',
        'BEATTY_AIRPORT',
        new Date('2007-01-08T12:00:00Z'),
        6 * 3600,
      );
    };
    const before = planFrom(original);
    const after = planFrom(restored);
    expect(after.length).toBe(before.length);
    expect(after[0].arrivalTime).toBe(before[0].arrivalTime);
    expect(after[0].legs.length).toBe(before[0].legs.length);
  });

  it('rejects an unknown version', () => {
    expect(() =>
      deserializeRaptorInputs({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        version: 999 as any,
        defaultInterchangeSeconds: 0,
        services: {},
        trips: [],
        transfers: {},
        interchange: {},
      }),
    ).toThrow(/unsupported version/i);
  });
});
