// Bundle the Chrome validation harness's host shim
// (featrues/07-eye-strain-2/spec.md §18.2): the pure host modules — the
// chunker, the speakable filter, the Kokoro alignment and the message
// parsers — for a plain browser tab. `node test/harness/build.mjs`.
import { build } from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: [join(here, 'host-shim.ts')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['chrome114'],
  outfile: join(here, 'dist', 'host-shim.js'),
  sourcemap: 'inline',
  logLevel: 'info',
});
