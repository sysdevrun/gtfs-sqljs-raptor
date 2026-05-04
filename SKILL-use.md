---
name: gtfs-sqljs-raptor
description: Use the gtfs-sqljs-raptor library to bridge a gtfs-sqljs SQLite-backed GTFS feed into raptor-journey-planner and hydrate the resulting journeys with stop/route metadata. Trigger when the user wants to plan journeys from a GTFS feed in browser or Node, or imports `gtfs-sqljs-raptor`. The library is not yet published to npm, so it must be fetched from GitHub and built from source.
---

# gtfs-sqljs-raptor

Bridge between [`gtfs-sqljs`](https://github.com/sysdevrun/gtfs-sqljs) and [`raptor-journey-planner`](https://github.com/planarnetwork/raptor). Two pure functions:

- `buildRaptorInputs(gtfs, options?)` → `{ trips, transfers, interchange }` ready for `RaptorAlgorithmFactory.create`.
- `hydrateJourneys(gtfs, journeys)` → replaces raptor's bare stop/trip IDs with full `Stop` and `Route` records.

Both run in browsers and Node.

## Installing (from GitHub — no npm release yet)

The package is **not on npm**. Install it directly from the GitHub repo and run its `build` script so consumers can import from `dist/`.

```bash
# Peer dependencies first
npm install gtfs-sqljs raptor-journey-planner sql.js

# Library itself, from GitHub. Pick one:
npm install github:sysdevrun/gtfs-sqljs-raptor                    # latest main
npm install github:sysdevrun/gtfs-sqljs-raptor#<commit-or-tag>    # pinned
```

`package.json` has `"main": "./dist/index.js"`, but `dist/` is **not** committed. After install, build it:

```bash
# In the consumer project, run the dependency's build once:
npm --prefix node_modules/gtfs-sqljs-raptor install
npm --prefix node_modules/gtfs-sqljs-raptor run build
```

Or add a `postinstall` to the consumer's `package.json`:

```json
{
  "scripts": {
    "postinstall": "npm --prefix node_modules/gtfs-sqljs-raptor install && npm --prefix node_modules/gtfs-sqljs-raptor run build"
  }
}
```

If the consumer uses a lockfile-pinned, no-scripts install (CI), use a prepare hook in a fork or vendor the built `dist/` instead.

### Alternative: clone + npm link (local dev)

```bash
git clone https://github.com/sysdevrun/gtfs-sqljs-raptor.git
cd gtfs-sqljs-raptor
npm install
npm run build
npm link

cd /path/to/consumer
npm link gtfs-sqljs-raptor
```

### Verifying the install

After build, check that `node_modules/gtfs-sqljs-raptor/dist/index.js` and `dist/index.d.ts` exist. If not, the build did not run — re-run it before importing.

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
  bridgeSameNameStops: true,
});

const raptor = RaptorAlgorithmFactory.create(trips, transfers, interchange);
const query = new GroupStationDepartAfterQuery(raptor, new JourneyFactory());

const raw = query.plan(
  originStopIds,                     // string[] of platform-level stop_ids
  destinationStopIds,                // string[] of platform-level stop_ids
  new Date('2026-05-27T12:00:00Z'),  // local-noon-UTC; see Dates gotcha
  9 * 3600,                          // depart-after, seconds since service-day midnight
);

const journeys = await hydrateJourneys(gtfs, raw);
```

Each hydrated leg is either a `timetable` leg (with `trip.route`, `stopTimes[]`, `origin`/`destination` `Stop`s) or a `transfer` leg (`origin`, `destination`, `duration`, `startTime`, `endTime`). `Stop` and `Route` use gtfs-sqljs's snake_case shape (`stop_id`, `route_short_name`, …).

## `buildRaptorInputs` options

| Option | Default | Effect |
| --- | --- | --- |
| `bridgeSameNameStops` | `false` | Synthesise transfers between stops sharing `stop_name` within `sameNameMaxMeters`. Many feeds split a logical station into per-route platforms without `parent_station`. |
| `sameNameMaxMeters` | `250` | Distance ceiling for same-name bridging. |
| `walkingSpeedMps` | `1.2` | Speed used to convert geo distance → seconds. |
| `transferFallbackSpeedMps` | `0.8` | Used to price `transfers.txt` rows whose `min_transfer_time` is empty. Set to `null` for legacy 0-second behaviour. |
| `bridgeParentStations` | `false` | Zero-duration transfers between parent ↔ child stops. Largely cosmetic — raptor doesn't track parent-only stops anyway. |
| `defaultInterchangeSeconds` | `0` | Returned for stops not present in `transfers.txt` (via a `Proxy` on `interchange`). |

## Gotchas — apply these without being asked

1. **Filter out parent stations before passing IDs to `query.plan()`.** `raptor-journey-planner` tracks only stops seen in `stop_times`. Pure parent stations (`location_type=1`) cause `Cannot convert undefined or null to object`.
   ```ts
   const ids = (await gtfs.getStops({ name: 'My Station' }))
     .filter((s) => s.location_type !== 1)
     .map((s) => s.stop_id);
   ```

2. **Date construction.** Raptor uses `Date.toISOString().slice(0,10)` (UTC) for the date number but `Date.getDay()` (local) for day-of-week. Use `new Date('YYYY-MM-DDT12:00:00Z')` so both agree across timezones.

3. **Time is seconds since service-day midnight**, not a `Date`. `9 * 3600` = 09:00.

4. **`interchange` must default-resolve to a number.** The library wraps it in a `Proxy` for that reason. If you copy/spread it (`{...interchange}`) you lose the proxy and arrival times become `NaN`. Pass it through as-is.

5. **Browser usage:** run load + build + plan + hydrate inside a Web Worker (Comlink works) so the algorithm doesn't block the UI.

6. **License:** `raptor-journey-planner` is GPL-3.0. Combining it with this MIT wrapper means the consumer's distribution is governed by GPL-3.0.

## Quick sanity check

If raptor returns no journeys for a feed you know covers the OD pair:

- Confirm the date falls within `calendar`/`calendar_dates` for relevant services.
- Confirm origin/destination are platform-level (`location_type=0` or null), not parents.
- Try `bridgeSameNameStops: true` — many real-world feeds need it.
- Confirm `time` is seconds since midnight, not milliseconds or hours.
