#!/usr/bin/env node
// @ts-check
//
// Mutation-proof harness for the "unhandled listener 'error' orphans children"
// fix in main.js (startFileWatcher's chokidar watcher, and McpClient's spawned
// child process): an EventEmitter with no 'error' listener throws, and here
// that throw killed the main process while leaving its children orphaned.
//
// main.js can't be `require()`d directly outside the Electron runtime (line 1
// destructures `{ app, ... }` from `require('electron')`, which under plain
// Node resolves to a path string, not the module — `app.isPackaged` then
// throws at module-load time). So this harness proves the fix two ways:
//
//   1. watcher scenario — extracts the LITERAL `startFileWatcher` function
//      body out of the current main.js source at run time (bracket-matched,
//      not copy-pasted) and executes it for real against a real chokidar
//      watcher. This is a genuine mutation test AGAINST main.js: edit the
//      function in main.js, rerun this script, the extracted source changes
//      with it.
//   2. spawn scenario — proves the general "unhandled ChildProcess 'error'
//      is fatal" pattern that justifies McpClient's fix, using the exact
//      console.error(...) string copied from main.js (verified via grep in
//      the report) so the two don't drift silently. This one is pattern-level,
//      not a literal extraction, because McpClient.start() is async and
//      wired to a real npx subprocess — not practical to isolate here.
//
// Each scenario runs in its own child `node` process (spawnSync) so an
// unhandled throw — which is exactly the failure mode under test — kills
// that child, not this harness.

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MAIN_JS = path.join(__dirname, '..', 'main.js');

// ---- worker mode: one scenario, run in its own process ------------------

function extractFunctionSource(src, name) {
  const m = src.match(new RegExp(`function ${name}\\s*\\([^)]*\\)\\s*\\{`));
  if (!m) throw new Error(`could not find function ${name} in main.js`);
  let i = m.index + m[0].length;
  let depth = 1;
  while (depth > 0) {
    if (i >= src.length) throw new Error(`unbalanced braces extracting ${name}`);
    if (src[i] === '{') depth++;
    else if (src[i] === '}') depth--;
    i++;
  }
  return src.slice(m.index, i);
}

function runWatcherScenario() {
  const src = fs.readFileSync(MAIN_JS, 'utf-8');
  const fnSrc = extractFunctionSource(src, 'startFileWatcher');
  // startFileWatcher(ctx) only touches: chokidar, handleFileEvent, console
  // eslint-disable-next-line no-new-func
  const startFileWatcher = new Function('chokidar', 'handleFileEvent', 'console', `return (${fnSrc});`)(
    require('chokidar'),
    () => {},
    console
  );

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawscad-watch-test-'));
  const ctx = { workspaceDir: dir };
  startFileWatcher(ctx);

  ctx.fileWatcher.on('ready', () => {
    // Same failure a deleted/unmounted/EPERM workspace dir produces.
    ctx.fileWatcher.emit('error', new Error('synthetic ENOSPC (test)'));
    setTimeout(() => {
      console.log('SURVIVED');
      process.exit(0);
    }, 200);
  });
}

function runSpawnScenario() {
  const { spawn } = require('child_process');
  // No shell:true here on purpose — spawning a genuinely missing binary
  // without a shell reliably emits a real async ENOENT 'error' event
  // cross-platform, which is the exact hazard McpClient.start() has.
  const proc = spawn('clawscad-definitely-does-not-exist-xyz', [], { stdio: 'ignore' });
  if (process.env.WITH_HANDLER === '1') {
    // Verbatim from main.js's McpClient.start() fix.
    proc.on('error', (err) => {
      console.error('openscad-mcp-server process error:', err.message);
    });
  }
  setTimeout(() => {
    console.log('SURVIVED');
    process.exit(0);
  }, 500);
}

const mode = process.argv[2];
if (mode === 'watcher') {
  runWatcherScenario();
} else if (mode === 'spawn') {
  runSpawnScenario();
} else if (mode) {
  console.error(`unknown scenario: ${mode}`);
  process.exit(2);
} else {
  // ---- driver mode: run both scenarios and report pass/fail -------------
  let failed = false;

  // Scenario 1: watcher — proves the LITERAL current main.js survives.
  {
    const res = spawnSync(process.execPath, [__filename, 'watcher'], { encoding: 'utf-8', timeout: 5000 });
    const survived = res.status === 0 && /SURVIVED/.test(res.stdout);
    console.log(`[watcher] extracted-from-main.js run: ${survived ? 'SURVIVED (pass)' : 'CRASHED (fail — expected survival)'} (exit ${res.status})`);
    if (!survived) {
      failed = true;
      if (res.stderr) console.log('  stderr:', res.stderr.trim().split('\n').slice(0, 5).join('\n  '));
    }
  }

  // Scenario 2: spawn — proves the pattern, both with and without the handler.
  {
    const withHandler = spawnSync(process.execPath, [__filename, 'spawn'], {
      encoding: 'utf-8',
      timeout: 5000,
      env: { ...process.env, WITH_HANDLER: '1' },
    });
    const withoutHandler = spawnSync(process.execPath, [__filename, 'spawn'], {
      encoding: 'utf-8',
      timeout: 5000,
      env: { ...process.env, WITH_HANDLER: '0' },
    });
    const survivedWith = withHandler.status === 0 && /SURVIVED/.test(withHandler.stdout);
    const crashedWithout = !(withoutHandler.status === 0 && /SURVIVED/.test(withoutHandler.stdout));
    console.log(`[spawn] with handler: ${survivedWith ? 'SURVIVED (pass)' : 'CRASHED (fail — expected survival)'} (exit ${withHandler.status})`);
    console.log(`[spawn] without handler: ${crashedWithout ? 'CRASHED as expected (pass — proves the hazard is real)' : 'SURVIVED (fail — mutation not proven)'} (exit ${withoutHandler.status})`);
    if (!survivedWith || !crashedWithout) failed = true;
  }

  process.exit(failed ? 1 : 0);
}
