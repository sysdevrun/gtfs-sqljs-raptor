# Pre-computing RaptorInputs as a static asset

`buildRaptorInputs` reads `trips`, `stop_times`, `calendar`, `calendar_dates`,
and `transfers` out of a SQLite-backed GTFS feed and produces the data
structure RAPTOR consumes. For a fixed feed this is the same work every time —
you can do it once, persist the result, and ship it as a static asset.

The natural cache boundary is the `RaptorInputs` object (`trips`, `transfers`,
`interchange`). Skipping its construction lets the browser go straight to
`RaptorAlgorithmFactory.create`, bypassing both the ZIP decode and the SQL
scan over `stop_times`.

## Recommended format

**JSON, served compressed.**

- JSON is browser-native, debuggable, and version-tolerant.
- Hosts that gzip/brotli automatically (Cloudflare, Netlify, Vercel, modern
  nginx) handle the wire compression for free.
- Hosts that don't compress on the fly (GitHub Pages, raw S3) can serve a
  pre-compressed `.json.gz` or `.json.br`; decompress in the browser with
  `DecompressionStream`.

Going binary (MessagePack, custom typed-array layout) saves another ~30 % on
the wire but adds a runtime dependency and loses debuggability. Worth it only
if the gzipped JSON is too large for your deployment.

## API

Both functions live in `gtfs-sqljs-raptor`:

```ts
import {
  buildRaptorInputs,
  serializeRaptorInputs,
  deserializeRaptorInputs,
  type SerializedRaptorInputs,
} from 'gtfs-sqljs-raptor';
```

### `serializeRaptorInputs(inputs, options?): SerializedRaptorInputs`

Returns a JSON-safe POJO. Stop times and transfers use compact tuples to drop
key repetition; `Service` instances are flattened to
`{ startDate, endDate, days[7], dates }`.

```ts
const inputs = await buildRaptorInputs(gtfs, { defaultInterchangeSeconds: 60 });
const serialized = serializeRaptorInputs(inputs, { defaultInterchangeSeconds: 60 });
fs.writeFileSync('feed.raptor.json', JSON.stringify(serialized));
```

The interchange `Proxy`'s default value is captured in a closure and cannot be
recovered at runtime. **You must pass `defaultInterchangeSeconds` to
`serializeRaptorInputs` — use the same value you gave to `buildRaptorInputs`.**

### `deserializeRaptorInputs(data): RaptorInputs`

Reconstructs `Service` instances and re-wraps the interchange in the
default-fallback `Proxy`. Versioned (`SERIALIZATION_VERSION = 1`); rejects
mismatched payloads with a clear error.

```ts
const data = await fetch('/feed.raptor.json').then((r) => r.json());
const inputs = deserializeRaptorInputs(data);
const raptor = RaptorAlgorithmFactory.create(inputs.trips, inputs.transfers, inputs.interchange);
```

For pre-compressed payloads on hosts that don't auto-decompress:

```ts
const stream = (await fetch('/feed.raptor.json.gz'))
  .body!.pipeThrough(new DecompressionStream('gzip'));
const data = (await new Response(stream).json()) as SerializedRaptorInputs;
const inputs = deserializeRaptorInputs(data);
```

## Sizes on real feeds

Measured with `scripts/measure-size.mjs`, options `{ bridgeSameNameStops: true }`,
gzip level 9, brotli quality 11. Build/serialize times on an Apple Silicon
laptop.

| Feed | ZIP | Trips | StopTimes | Services | JSON | gzip | brotli | build / serialize |
|---|---|---|---|---|---|---|---|---|
| Car Jaune (Réunion) | 1.0 MiB | 2,130 | 33.8 K | 6 | 890 KiB | **169 KiB** | **60 KiB** | 101 / 1 ms |
| Astuce (Rouen) | 5.0 MiB | 22,606 | 590.8 K | 42 | 18.7 MiB | **3.10 MiB** | **974 KiB** | 1,379 / 6 ms |
| Ilévia (Lille) | 10.7 MiB | 52,282 | 1,551.8 K | 9,125 | 44.4 MiB | **8.64 MiB** | **3.06 MiB** | 3,866 / 53 ms |

Things to read out of this:

- **Compression ratios are stable across feeds**: gzip ~17–20 % of raw JSON,
  brotli ~5–7 %. Brotli wins by ~3× and is worth it for any feed bigger than
  Car Jaune — especially because you can pre-compress once and serve the
  static `.json.br`.
- **Build time scales with `stop_times`** (~330 K rows/sec on this machine).
  Serialization is negligible.
- **Lille has 9,125 services**, where most feeds have a handful. The
  `calendar_dates` overrides are part of the per-service payload, so this
  shows up directly in the output size. Most of those services are likely
  near-duplicates that could be deduplicated by structural hash — not done in
  v1.
- **The pre-compute payload is comparable in size to the source GTFS ZIP.**
  The win is not "smaller download" — it's "no SQL scan and no parse." On
  Lille that saves ~4 seconds of CPU on first load and frees you from
  shipping `sql.js`'s WASM if pre-computed feeds are the only entry point.

## Future work

If gzipped JSON is still too large for your deployment, the highest-leverage
optimization is a top-level stop-id dictionary plus varint-packed stop-times
(roughly: a 16-bit stop index + two times + a 2-bit flags byte per
stop-time). Estimated wins:

- raw payload: ~2× smaller
- compressed payload: ~1.5–2× smaller (compression already handles much of
  the string repetition)

That would put Lille's raw payload in the 8–12 MiB range and brotli around
1.5–2 MiB. Format would bump to `SERIALIZATION_VERSION = 2`; the deserializer
would accept both.
