import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { GtfsSqlJs } from 'gtfs-sqljs';
import { createSqlJsAdapter } from 'gtfs-sqljs/adapters/sql-js';

const fixturesDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures');

export async function loadFixture(filename: string): Promise<GtfsSqlJs> {
  const buf = await readFile(resolve(fixturesDir, filename));
  const adapter = await createSqlJsAdapter();
  return GtfsSqlJs.fromZipData(buf, { adapter });
}
