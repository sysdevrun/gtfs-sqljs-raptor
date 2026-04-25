import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GtfsSqlJs } from 'gtfs-sqljs';
import { buildServices } from '../../src/internal/services.js';
import { loadFixture } from '../helpers/loadFixture.js';

describe('buildServices (Google sample)', () => {
  let gtfs: GtfsSqlJs;

  beforeAll(async () => {
    gtfs = await loadFixture('gtfs-google-sample.zip');
  });
  afterAll(async () => {
    await gtfs.close();
  });

  it('builds Service entries for FULLW and WE', async () => {
    const services = await buildServices(gtfs.getDatabase());
    expect(Object.keys(services).sort()).toEqual(['FULLW', 'WE']);
  });

  it('FULLW runs every day in range, WE only weekends', async () => {
    const services = await buildServices(gtfs.getDatabase());
    // 2007-01-08 is a Monday (dow=1)
    expect(services.FULLW.runsOn(20070108, 1)).toBe(true);
    expect(services.WE.runsOn(20070108, 1)).toBe(false);
    // 2007-01-06 is a Saturday (dow=6)
    expect(services.WE.runsOn(20070106, 6)).toBe(true);
  });

  it('honors calendar_dates exceptions (FULLW excluded on 2007-06-04)', async () => {
    const services = await buildServices(gtfs.getDatabase());
    // 2007-06-04 is a Monday — FULLW would normally run, but the fixture has an exception type=2.
    expect(services.FULLW.runsOn(20070604, 1)).toBe(false);
  });

  it('returns false outside the validity window', async () => {
    const services = await buildServices(gtfs.getDatabase());
    expect(services.FULLW.runsOn(20060101, 0)).toBe(false);
    expect(services.FULLW.runsOn(20110101, 0)).toBe(false);
  });
});
