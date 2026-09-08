// web/build.js — bundles web/entry.js (and, through it, the REAL
// renderer/studio.js, renderer/tools.js, renderer/route.js and
// renderer/bus.js) into web/dist/app.js.
//
// Uses the esbuild JS API rather than an npm script, so this stays entirely
// inside web/ — package.json is not ours to edit. esbuild is already a
// devDependency of this repo; nothing new is installed.
//
//   node web/build.js            one-shot
//   node web/build.js --watch    rebuild on change
//   node web/build.js --minify   production bundle
'use strict';

const path = require('node:path');
const esbuild = require(path.join(__dirname, '..', 'node_modules', 'esbuild'));

const watch = process.argv.includes('--watch');
const minify = process.argv.includes('--minify');

const options = {
  entryPoints: [path.join(__dirname, 'entry.js')],
  outfile: path.join(__dirname, 'dist', 'app.js'),
  bundle: true,
  // ESM + browser, matching the desktop app's own build:renderer target, so
  // renderer/studio.js is compiled exactly the way it is compiled for Electron.
  format: 'esm',
  platform: 'browser',
  target: ['chrome110', 'firefox115', 'safari16'],
  // A sourcemap is what makes a studio.js stack trace in the browser point at
  // studio.js rather than at line 4 of a 90 KB bundle.
  sourcemap: true,
  minify,
  logLevel: 'info',
};

(async () => {
  if (watch) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
    console.log('[web/build] watching web/entry.js and renderer/*.js');
  } else {
    await esbuild.build(options);
    console.log(`[web/build] wrote ${path.relative(process.cwd(), options.outfile)}`);
  }
})().catch((err) => {
  console.error('[web/build] failed', err);
  process.exit(1);
});
