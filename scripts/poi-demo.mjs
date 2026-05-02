#!/usr/bin/env node
// Demo: plan an itinerary between two POIs over the Car Jaune fixture.
// Run with `npm run build && node scripts/poi-demo.mjs`.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { GtfsSqlJs } from 'gtfs-sqljs';
import { createSqlJsAdapter } from 'gtfs-sqljs/adapters/sql-js';
import {
  buildRaptorInputs,
  findNearbyStops,
  hydrateJourneys,
  loadStopLocations,
  planForPois,
} from '../dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const buf = await readFile(resolve(here, '..', 'fixtures', 'gtfs-car-jaune.zip'));
const adapter = await createSqlJsAdapter();
const gtfs = await GtfsSqlJs.fromZipData(buf, { adapter });

const HDV_ST_LOUIS = { id: 'HDV_ST_LOUIS', lat: -21.28663, lon: 55.40921 };
const HDV_ST_DENIS = { id: 'HDV_ST_DENIS', lat: -20.87877, lon: 55.44845 };

console.log('Loading raptor inputs…');
const inputs = await buildRaptorInputs(gtfs, { bridgeSameNameStops: true });
const stops = await loadStopLocations(gtfs);
console.log(`Stops: ${stops.length}, trips: ${inputs.trips.length}`);

const findOpts = { radiusMeters: 1500, walkingSpeedMps: 1.2, maxNearbyStops: 12 };
const originNearby = findNearbyStops(HDV_ST_LOUIS, stops, findOpts);
const destinationNearby = findNearbyStops(HDV_ST_DENIS, stops, findOpts);

console.log(`\nNearby to Hôtel de Ville Saint-Louis (${originNearby.length}):`);
for (const n of originNearby.slice(0, 5)) console.log(`  ${n.stopId}  walk ${n.walkSeconds}s`);
console.log(`Nearby to Hôtel de Ville Saint-Denis (${destinationNearby.length}):`);
for (const n of destinationNearby.slice(0, 5)) console.log(`  ${n.stopId}  walk ${n.walkSeconds}s`);

const t0 = Date.now();
const journeys = planForPois({
  inputs,
  origin: HDV_ST_LOUIS,
  destination: HDV_ST_DENIS,
  originNearby,
  destinationNearby,
  date: new Date('2026-05-04T12:00:00Z'),
  departAfterSeconds: 8 * 3600,
});
const planMs = Date.now() - t0;

console.log(`\nplanForPois: ${journeys.length} journeys in ${planMs} ms`);

if (journeys.length === 0) {
  console.log('No journey found.');
  await gtfs.close();
  process.exit(0);
}

const j = journeys[0];
const middle = j.legs.slice(1, -1);
const hydrated = (await hydrateJourneys(gtfs, [{ ...j, legs: middle }]))[0];

const fmt = (s) =>
  `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`;

console.log(`\nJourney 0: depart ${fmt(j.departureTime)} → arrive ${fmt(j.arrivalTime)}`);
const firstWalk = j.legs[0];
console.log(`  walk ${firstWalk.duration}s: Hôtel de Ville Saint-Louis → ${firstWalk.destination}`);
for (const leg of hydrated.legs) {
  if (leg.type === 'timetable') {
    const route = leg.trip.route.route_short_name || leg.trip.route.route_long_name || leg.trip.route.route_id;
    console.log(
      `  ride ${route}: ${leg.origin.stop_name} ${fmt(leg.departureTime)} → ${leg.destination.stop_name} ${fmt(leg.arrivalTime)}`,
    );
  } else {
    console.log(`  walk ${leg.duration}s: ${leg.origin.stop_name} → ${leg.destination.stop_name}`);
  }
}
const lastWalk = j.legs[j.legs.length - 1];
console.log(`  walk ${lastWalk.duration}s: ${lastWalk.origin} → Hôtel de Ville Saint-Denis`);

await gtfs.close();
