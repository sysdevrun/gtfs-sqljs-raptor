import { Service, type DateIndex, type DayOfWeek, type ServiceID } from 'raptor-journey-planner';
import type { GtfsDatabase } from 'gtfs-sqljs';
import { iterateRows } from './sqlHelpers.js';

export async function buildServices(db: GtfsDatabase): Promise<Record<ServiceID, Service>> {
  const days: Record<ServiceID, Record<DayOfWeek, boolean>> = {};
  const ranges: Record<ServiceID, { start: number; end: number }> = {};
  const dates: Record<ServiceID, DateIndex> = {};

  for await (const r of iterateRows(db, 'SELECT * FROM calendar')) {
    const sid = String(r.service_id);
    days[sid] = {
      0: r.sunday === 1,
      1: r.monday === 1,
      2: r.tuesday === 1,
      3: r.wednesday === 1,
      4: r.thursday === 1,
      5: r.friday === 1,
      6: r.saturday === 1,
    };
    ranges[sid] = { start: Number(r.start_date), end: Number(r.end_date) };
    dates[sid] ??= {};
  }

  for await (const r of iterateRows(db, 'SELECT * FROM calendar_dates')) {
    const sid = String(r.service_id);
    const d = Number(r.date);
    const exception = Number(r.exception_type);
    dates[sid] ??= {};
    dates[sid][d] = exception === 1;
  }

  const services: Record<ServiceID, Service> = {};
  const allServiceIds = new Set([...Object.keys(ranges), ...Object.keys(dates)]);

  for (const sid of allServiceIds) {
    const range = ranges[sid] ?? { start: 0, end: 0 };
    const dayMap =
      days[sid] ?? ({ 0: false, 1: false, 2: false, 3: false, 4: false, 5: false, 6: false } as Record<DayOfWeek, boolean>);
    services[sid] = new Service(range.start, range.end, dayMap, dates[sid] ?? {});
  }

  return services;
}
