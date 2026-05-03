# gtfs-sqljs-raptor

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

### `planByCoordinates(params)`

Plan an itinerary between two arbitrary geographic coordinates that are not in
`stops.txt` (a typed address, a pin on a map, anything with a lat/lon).
Returns a `Journey[]` from `raptor-journey-planner`.

The function takes a `RaptorInputs` (built once), an `origin` and `destination`
coordinate, and the lists of nearby real stops the planner is allowed to walk
to/from at each end. **The planner picks the best nearby stop on each side
itself**, taking walking time into account — so for a given origin coordinate,
the cheapest combined `(walk + transit + walk)` itinerary wins, not just the
geographically closest stop.

How it works internally: per query, two phantom trips are appended to a clone
of `inputs.trips` (one per endpoint coordinate, with `pickUp: false / dropOff:
false` so the algorithm never tries to board them) plus a few walking edges
into a clone of `inputs.transfers`. `RaptorAlgorithmFactory.create` then sees
the coordinates as first-class stops, but no real journey can ever traverse
the phantom trips. The base `inputs` are not mutated — the function is safe
to call concurrently for different queries.

```ts
import {
  buildRaptorInputs,
  findNearbyStops,
  loadStopLocations,
  planByCoordinates,
  hydrateJourneys,
} from 'gtfs-sqljs-raptor';

const inputs = await buildRaptorInputs(gtfs, { bridgeSameNameStops: true });
const stops = await loadStopLocations(gtfs); // one SQL pass, cache it

const origin      = { id: '__origin__',      lat: -21.28663, lon: 55.40921 };
const destination = { id: '__destination__', lat: -20.87877, lon: 55.44845 };

const findOpts = { radiusMeters: 1500, walkingSpeedMps: 1.2, maxNearbyStops: 12 };
const journeys = planByCoordinates({
  inputs,
  origin,
  destination,
  originNearby:      findNearbyStops(origin,      stops, findOpts),
  destinationNearby: findNearbyStops(destination, stops, findOpts),
  date: new Date('2026-05-04T12:00:00Z'),
  departAfterSeconds: 8 * 3600,
});

// First and last legs reference the input ids (synthetic walks).
// hydrateJourneys can't look those up — strip them off and render the
// outer walks from the input coordinates yourself.
const middle = journeys[0].legs.slice(1, -1);
const hydrated = await hydrateJourneys(gtfs, [{ ...journeys[0], legs: middle }]);
```

The `id` on `Coordinate` is an internal handle for the synthetic phantom stop;
it must be different between origin and destination, and must not collide with
any real `stop_id` in your feed. Pick something obviously synthetic
(e.g. `'__origin__'`) — it shows up in the returned journey's outer walking
legs so callers can recognise them when stripping for hydration.

`scripts/coordinate-demo.mjs` is a runnable example over the Car Jaune fixture.

#### Helpers

`findNearbyStops(point, stops, options?)` — linear-scan haversine lookup.
Sorts closest first, caps at `maxNearbyStops` (default 8). Default radius
400 m, default walking speed 1.2 m/s. For larger feeds, plug in a kd-tree
or geohash index and build the `NearbyStop[]` array yourself.

`loadStopLocations(gtfs)` — convenience: one SQL pass over `stops.stop_lat /
stop_lon`, returns `{ id, lat, lon }[]`. Run once at startup, hand the result
to `findNearbyStops` per query.

#### Performance

Per query: clone `{trips, transfers, interchange}`, append 2 phantom trips
and a handful of walking edges, call `RaptorAlgorithmFactory.create`, run
the query. On the Car Jaune feed (~2k trips, ~33k stop_times) the whole
thing runs in ~70 ms — independent of how many candidate origin/destination
coordinates you might have on file, because only the two for the current
query are ever passed in. On Astuce (Rouen, ~22k trips, ~600k stop_times)
the per-query cost is ~115 ms.

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
