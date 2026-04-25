import type { GtfsDatabase, Row, SqlValue } from 'gtfs-sqljs';

export async function* iterateRows(
  db: GtfsDatabase,
  sql: string,
  params: SqlValue[] = [],
): AsyncGenerator<Row> {
  const stmt = await db.prepare(sql);
  try {
    if (params.length > 0) await stmt.bind(params);
    while (await stmt.step()) {
      yield await stmt.getAsObject();
    }
  } finally {
    await stmt.free();
  }
}

export async function fetchAll(
  db: GtfsDatabase,
  sql: string,
  params: SqlValue[] = [],
): Promise<Row[]> {
  const out: Row[] = [];
  for await (const row of iterateRows(db, sql, params)) out.push(row);
  return out;
}
