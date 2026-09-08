#!/usr/bin/env node
/**
 * Guards the decision that unblocked the first release.
 *
 * ClawSCAD does NOT rebuild native modules for Electron: `build.npmRebuild` is
 * false and there is no electron-rebuild postinstall. That is correct *only*
 * because every native dependency it has is **N-API** (Node-API), whose ABI is
 * stable across Node and Electron alike — node-pty 1.1.0 depends on
 * `node-addon-api` and ships prebuildify binaries under `prebuilds/`, which is
 * what actually gets loaded and packaged.
 *
 * The risk that buys is specific and silent: add a native dependency that is
 * NOT N-API, and electron-builder will happily package a binary built for
 * Node's ABI. The app then throws on `require()` at runtime — in the installed
 * build only, never in `npm start` — and the first symptom is a dead terminal
 * in a shipped release.
 *
 * So this asserts the premise instead of trusting it: every dependency that
 * carries a native addon must ship `prebuilds/` (prebuildify, N-API). A new
 * native dep that doesn't turns the suite red here, with the reason, rather
 * than turning up as a broken installer.
 *
 * Run: node scripts/check-native-deps.js   (wired into `npm run test:harness`)
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MODULES = path.join(ROOT, 'node_modules');

/** A package is "native" if it has a binding.gyp or any compiled .node file. */
function inspect(pkgDir) {
  const hasGyp = fs.existsSync(path.join(pkgDir, 'binding.gyp'));
  const hasPrebuilds = fs.existsSync(path.join(pkgDir, 'prebuilds'));

  let compiled = [];
  for (const sub of ['build/Release', 'build/Debug']) {
    const dir = path.join(pkgDir, sub);
    try {
      compiled = compiled.concat(
        fs.readdirSync(dir).filter((f) => f.endsWith('.node')).map((f) => path.join(sub, f))
      );
    } catch {}
  }

  let pkg = {};
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf-8'));
  } catch {}

  const deps = { ...(pkg.dependencies || {}) };
  const napi =
    hasPrebuilds ||
    Boolean(deps['node-addon-api']) ||
    Boolean(deps['node-api-headers']) ||
    Array.isArray(pkg.binary && pkg.binary.napi_versions);

  return { name: pkg.name || path.basename(pkgDir), version: pkg.version || '?', hasGyp, hasPrebuilds, compiled, napi };
}

function main() {
  if (!fs.existsSync(MODULES)) {
    console.log('  skip — node_modules is not installed');
    return 0;
  }

  const rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
  const names = Object.keys(rootPkg.dependencies || {});

  const native = [];
  for (const name of names) {
    const dir = path.join(MODULES, ...name.split('/'));
    if (!fs.existsSync(dir)) continue;
    const info = inspect(dir);
    if (info.hasGyp || info.compiled.length || info.hasPrebuilds) native.push(info);
  }

  let failed = 0;

  if (!native.length) {
    console.log('  ok — no native runtime dependencies');
  }

  for (const info of native) {
    if (info.napi) {
      console.log(`  ok — ${info.name}@${info.version} is N-API (prebuilds: ${info.hasPrebuilds ? 'yes' : 'no'})`);
    } else {
      failed++;
      console.log(`FAIL — ${info.name}@${info.version} is a native addon but does NOT look like N-API.`);
      console.log('       This build does not run electron-rebuild (build.npmRebuild is false), so');
      console.log("       electron-builder would package a binary built for Node's ABI. The installed");
      console.log('       app would throw on require() while `npm start` kept working.');
      console.log('       Fix by one of: use an N-API build of this package; or re-enable');
      console.log('       electron-rebuild for it and accept the MSVC Spectre-library requirement');
      console.log('       on Windows build machines. Do not just delete this check.');
    }
  }

  // The premise is also false if someone re-adds an electron-rebuild postinstall
  // without re-enabling npmRebuild, or vice versa — the two must agree.
  const postinstall = (rootPkg.scripts || {}).postinstall || '';
  const npmRebuild = rootPkg.build && rootPkg.build.npmRebuild;
  if (/electron-rebuild/.test(postinstall) && npmRebuild === false) {
    failed++;
    console.log('FAIL — postinstall runs electron-rebuild but build.npmRebuild is false.');
    console.log('       Those two disagree about whether native modules are rebuilt for Electron.');
  }

  console.log(`\n  ${native.length} native dependency check(s), ${failed} failed`);
  return failed ? 1 : 0;
}

process.exit(main());
