import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

const stubGtfsStream = resolve(here, 'src/empty.ts');

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // raptor-journey-planner re-exports `./gtfs/GTFSLoader` from its index
      // barrel, and that file does `import { plain as gtfs } from "gtfs-stream"`.
      // gtfs-stream is solidly Node-only (unzipper / readable-stream / fs).
      // We never call loadGTFS in this app, so stub gtfs-stream to a harmless
      // module — that lets esbuild pre-bundle raptor for the browser worker
      // without trying to resolve Node built-ins.
      'gtfs-stream': stubGtfsStream,
    },
  },
  worker: {
    format: 'es',
  },
  optimizeDeps: {
    // Force pre-bundling. sql.js itself is CommonJS — without going through
    // esbuild's CJS-to-ESM wrapping, `import initSqlJs from 'sql.js'` fails
    // with "does not provide an export named 'default'". The WASM is loaded
    // separately at runtime via locateFile() (see worker, sqlWasmUrl).
    include: [
      'comlink',
      'gtfs-sqljs',
      'gtfs-sqljs/adapters/sql-js',
      'gtfs-sqljs-raptor',
      'raptor-journey-planner',
      'sql.js',
    ],
  },
});
