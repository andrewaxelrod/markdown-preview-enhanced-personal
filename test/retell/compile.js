'use strict';

/**
 * The on-the-fly compile every retell suite uses (`featrues/15-convert-readable/
 * spec.md` §17): esbuild over one `src/` entry with `vscode` and `crossnote`
 * external and the same `.md` text loader `build.js` gives the bundles, so
 * the built-in persona package is importable here exactly as it is shipped.
 */

const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const ROOT = path.join(__dirname, '..', '..');

async function compileEntry(relativeEntry, outFile) {
  const result = await esbuild.build({
    entryPoints: [path.join(ROOT, relativeEntry)],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    write: false,
    logLevel: 'silent',
    external: ['vscode', 'crossnote'],
    loader: { '.md': 'text' },
  });
  fs.writeFileSync(outFile, result.outputFiles[0].text);
  return require(outFile);
}

function fixture(name) {
  return fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
}

module.exports = { compileEntry, fixture, ROOT };
