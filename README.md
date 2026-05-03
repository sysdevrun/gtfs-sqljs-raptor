# gtfs-sqljs-raptor

[Live demo](https://sysdevrun.github.io/gtfs-sqljs-raptor/)

Bridge between [`gtfs-sqljs`](https://github.com/sysdevrun/gtfs-sqljs) (a SQLite-backed GTFS loader that runs in browsers and Node) and [`raptor-journey-planner`](https://github.com/planarnetwork/raptor) (an in-memory implementation of the Raptor journey-planning algorithm).

Two pure functions:

- `buildRaptorInputs(gtfs)` — turn a `GtfsSqlJs` instance into the `[trips, transfers, interchange]` triple raptor expects.
- `hydrateJourneys(gtfs, journeys)` — replace raptor's bare stop/trip IDs with full `Stop` and `Route` records pulled from the same SQLite database.

Both work in browsers and Node.

## Why

`raptor-journey-planner`'s bundled `loadGTFS()` reads a Node `Readable` stream through `gtfs-stream`, so it cannot run in a browser. Its result is also referentially minimal — `Journey.legs[]` carry only `StopID` strings and a stripped `Trip` record, no stop names, no route, no headsign. This package fills both gaps.

## Install

```bash
npm install gtfs-sqljs-raptor gtfs-sqljs raptor-journey-planner
# Pick one gtfs-sqljs adapter:
npm install sql.js                 # browser / Node WASM
# or: npm install better-sqlite3  # Node native
```

`gtfs-sqljs` and `raptor-journey-planner` are peer dependencies. `raptor-journey-planner` is **GPL-3.0**; this wrapper is MIT but your installed combination is governed by the strictest of the licences.

## Usage

```ts
import { GtfsSqlJs } from 'gtfs-sqljs';
import { createSqlJsAdapter } from 'gtfs-sqljs/adapters/sql-js';
import {
  RaptorAlgorithmFactory,
  GroupStationDepartAfterQuery,
  JourneyFactory,
} from 'raptor-journey-planner';
import { buildRaptorInputs, hydrateJourneys } from 'gtfs-sqljs-raptor';

const adapter = await createSqlJsAdapter();
const gtfs = await GtfsSqlJs.fromZip('https://example.com/gtfs.zip', { adapter });

const { trips, transfers, interchange } = await buildRaptorInputs(gtfs, {
  bridgeSameNameStops: true,  // see notes below
});
const raptor = RaptorAlgorithmFactory.create(trips, transfers, interchange);
const query = new GroupStationDepartAfterQuery(raptor, new JourneyFactory());

const rawJourneys = query.plan(
  ['174', '321'],                    // origin platform stop_ids
  ['278', '416'],                    // destination platform stop_ids
  new Date('2026-05-27T12:00:00Z'),  // see "Dates" below
  9 * 3600,                          // depart-after time, seconds since midnight
);

const journeys = await hydrateJourneys(gtfs, rawJourneys);
for (const j of journeys) {
  for (const leg of j.legs) {
    if (leg.type === 'timetable') {
      console.log(`${leg.trip.route.route_short_name}: ${leg.origin.stop_name} → ${leg.destination.stop_name}`);
    } else {
      console.log(`walk ${leg.duration}s: ${leg.origin.stop_name} → ${leg.destination.stop_name}`);
    }
  }
}
```

## API

### `buildRaptorInputs(gtfs, options?)`

Returns `Promise<{ trips, transfers, interchange }>`:

- `trips: Trip[]` — raptor's `Trip` shape, stop_times ordered by `stop_sequence`, times converted to seconds since midnight via raptor's `TimeParser`. Each trip has its `Service` reconstructed from `calendar` + `calendar_dates`.
- `transfers: TransfersByOrigin` — raptor's `Record<from_stop_id, Transfer[]>`. Sourced from `transfers.txt` (where present) plus any synthetic bridges enabled via options.
- `interchange: Interchange` — `Record<stop_id, seconds>` wrapped in a `Proxy` so that any stop not explicitly listed resolves to `defaultInterchangeSeconds` (default `0`). Without this, raptor's `RouteScanner` reads `undefined` for stops without an explicit interchange and arrival times become `NaN`.

Options:

| Option | Default | Effect |
| --- | --- | --- |
| `bridgeSameNameStops` | `false` | Adds Transfer rows between every pair of stops sharing the same `stop_name` and within `sameNameMaxMeters`. Many feeds split a logical station into per-route platforms without using `parent_station`; without bridging, raptor cannot change routes there. |
| `sameNameMaxMeters` | `250` | Distance ceiling for `bridgeSameNameStops`. |
| `walkingSpeedMps` | `1.2` | Walking speed used to convert geo distance to seconds. |
| `transferFallbackSpeedMps` | `0.8` | Walking speed used to *price* `transfers.txt` rows whose `min_transfer_time` is empty/`NULL`. The GTFS spec leaves the time unspecified for those rows; raptor needs a number. Pricing them by haversine distance ÷ this speed approximates real-world non-straight walking and prevents the planner from chaining many "free" transfer edges into long zero-second walks. Set to `null` to fall back to 0 seconds (legacy behaviour). |
| `bridgeParentStations` | `false` | Adds zero-duration transfers between `parent_station` ↔ children. **Largely cosmetic** — see the gotcha below. |
| `defaultInterchangeSeconds` | `0` | Interchange time for stops not in `transfers.txt`. |

### `hydrateJourneys(gtfs, journeys)`

Returns `Promise<HydratedJourney[]>`. Each leg becomes either:

```ts
{ type: 'timetable',
  origin: Stop, destination: Stop,
  stopTimes: { stop: Stop, arrivalTime, departureTime, pickUp, dropOff }[],
  trip: { tripId, serviceId, headsign, directionId, shortName, route: Route },
  departureTime, arrivalTime }
```

or

```ts
{ type: 'transfer',
  origin: Stop, destination: Stop,
  duration, startTime, endTime }
```

`Stop` and `Route` are the gtfs-sqljs types (snake_case fields like `stop_id`, `route_short_name`).

Lookups are batched: one query for all referenced stops, one for all referenced trips JOINed with `routes`. Hydration cost scales with the size of the result set, not the size of the feed.

## Gotchas

### Origins and destinations must appear in `stop_times`

`raptor-journey-planner`'s `ScanResultsFactory` initializes its tracking only for stops it sees while walking trip `stop_times`. Pure parent stations (`location_type=1`, never referenced in `stop_times`) cannot be passed as origin or destination — raptor will throw `Cannot convert undefined or null to object`. Filter them out before calling `query.plan()`:

```ts
const origins = (await gtfs.getStops({ name: 'My Station' }))
  .filter((s) => s.location_type !== 1)
  .map((s) => s.stop_id);
```

This is also why `bridgeParentStations` is largely cosmetic.

### Same-name station bridging

Many real-world feeds (e.g. France's Car Jaune) split a logical station into per-route platforms without linking them via `parent_station`. Stops named `"Gare de St-Pierre"` may exist as multiple distinct `stop_id`s a few metres apart, and raptor cannot transfer between them. `bridgeSameNameStops: true` synthesises walk transfers when names match and stops are within `sameNameMaxMeters`. Disabled by default because some feeds reuse names across distant locations.

### Dates

`raptor-journey-planner` derives the `YYYYMMDD` date number with `Date.toISOString().slice(0,10)` (UTC) but uses `Date.getDay()` (local time) for day-of-week. Use a local-noon-UTC date such as `new Date('2026-05-27T12:00:00Z')` to keep both consistent across timezones.

`time` is seconds since midnight in service-day-local terms (e.g. `9 * 3600` for 09:00).

## Performance

`buildRaptorInputs` reads each feed table once with a single ordered `JOIN` for `trips ⨝ stop_times` — no N+1 queries. On a typical 50k stop_times feed the build takes around 100 ms in Node + sql.js.

For browser use, run the whole pipeline (load + build + plan + hydrate) inside a Web Worker so the algorithm doesn't block the UI. Comlink works well; see the gtfs-sqljs README for the worker pattern.

## Tests

```bash
npm install
npm test            # unit + e2e
npm run test:unit   # Google sample fixture only
npm run test:e2e    # Car Jaune fixture (Mairie de La Possession → Pyramide Fleurie 2026-05-27 09:00)
```

All tests run in Node with `gtfs-sqljs/adapters/sql-js`, which uses the same WASM/sql.js path that runs in browsers.

## License

MIT (see top note about combined-license effects of `raptor-journey-planner`).
