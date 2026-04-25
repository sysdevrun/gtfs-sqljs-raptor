// Measures the on-disk size of a serialized RaptorInputs payload for a fixture.
// Usage: node scripts/measure-size.mjs [fixture-name]
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { gzipSync, brotliCompressSync, constants as zlibConstants } from 'node:zlib';
import { GtfsSqlJs } from 'gtfs-sqljs';
import { createSqlJsAdapter } from 'gtfs-sqljs/adapters/sql-js';
import { buildRaptorInputs, serializeRaptorInputs } from '../dist/index.js';

const fixturesDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const fixture = process.argv[2] ?? 'gtfs-car-jaune.zip';

const fmt = (bytes) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 ** 2).toFixed(2)} MiB`;
};

const zipBuf = await readFile(resolve(fixturesDir, fixture));
const adapter = await createSqlJsAdapter();
const gtfs = await GtfsSqlJs.fromZipData(zipBuf, { adapter });

const t0 = performance.now();
const inputs = await buildRaptorInputs(gtfs, { bridgeSameNameStops: true });
const buildMs = performance.now() - t0;

const t1 = performance.now();
const serialized = serializeRaptorInputs(inputs, { defaultInterchangeSeconds: 0 });
const serializeMs = performance.now() - t1;

const json = JSON.stringify(serialized);
const jsonMin = Buffer.byteLength(json, 'utf8');
const jsonPretty = Buffer.byteLength(JSON.stringify(serialized, null, 2), 'utf8');
const gzipped = gzipSync(json, { level: zlibConstants.Z_BEST_COMPRESSION }).length;
const brotli = brotliCompressSync(json, {
  params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11 },
}).length;

const stopTimeCount = inputs.trips.reduce((n, t) => n + t.stopTimes.length, 0);
const transferOriginCount = Object.keys(inputs.transfers).length;
const transferEdgeCount = Object.values(inputs.transfers).reduce((n, l) => n + l.length, 0);
const serviceCount = Object.keys(serialized.services).length;

console.log(`Fixture: ${fixture}`);
console.log(`  Source ZIP:     ${fmt(zipBuf.length)}`);
console.log(`Counts:`);
console.log(`  trips:          ${inputs.trips.length.toLocaleString()}`);
console.log(`  stop_times:     ${stopTimeCount.toLocaleString()}`);
console.log(`  services:       ${serviceCount.toLocaleString()}`);
console.log(`  transfer origs: ${transferOriginCount.toLocaleString()}  edges: ${transferEdgeCount.toLocaleString()}`);
console.log(`  interchange:    ${Object.keys(serialized.interchange).length.toLocaleString()} explicit entries`);
console.log(`Timings:`);
console.log(`  buildRaptorInputs:      ${buildMs.toFixed(0)} ms`);
console.log(`  serializeRaptorInputs:  ${serializeMs.toFixed(0)} ms`);
console.log(`Sizes:`);
console.log(`  JSON (minified):        ${fmt(jsonMin)}`);
console.log(`  JSON (pretty-printed):  ${fmt(jsonPretty)}`);
console.log(`  JSON + gzip (level 9):  ${fmt(gzipped)}   (${((gzipped / jsonMin) * 100).toFixed(1)}% of raw)`);
console.log(`  JSON + brotli (q=11):   ${fmt(brotli)}   (${((brotli / jsonMin) * 100).toFixed(1)}% of raw)`);

await gtfs.close();
