// scripts/probe-launch.js — isolates the two failures that look identical in a
// Playwright report and have different causes: Electron never producing a
// first window, vs. electronApp.close() hanging.
//
//   node scripts/probe-launch.js 5
//
// Prints per-run timings, the app's own stdout/stderr, and how many app-owned
// processes survive each close — because a launch that fails is almost always
// explained by what the PREVIOUS one left running.
const { _electron: electron } = require('@playwright/test');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const APP_PATH = path.join(__dirname, '..');
const runs = parseInt(process.argv[2], 10) || 3;

function survivors() {
  try {
    const out = execSync(
      'powershell -NoProfile -Command "(Get-Process electron,ClawSCAD,node -ErrorAction SilentlyContinue | Measure-Object).Count"',
      { encoding: 'utf-8' }
    );
    return out.trim();
  } catch {
    return '?';
  }
}

(async () => {
  for (let i = 1; i <= runs; i++) {
    const ws = path.join(os.tmpdir(), `clawscad-probe-${Date.now()}-${i}`);
    fs.mkdirSync(ws, { recursive: true });
    const t0 = Date.now();
    let app;
    try {
      app = await electron.launch({ args: [path.join(APP_PATH, 'main.js'), ws], cwd: APP_PATH, timeout: 30000 });
    } catch (err) {
      console.log(`run ${i}: LAUNCH FAILED after ${Date.now() - t0}ms — ${err.message.split('\n')[0]}`);
      continue;
    }
    // The app's own output is the one thing the Playwright timeout never shows.
    app.process().stdout.on('data', (d) => process.stdout.write(`  [out] ${d}`));
    app.process().stderr.on('data', (d) => process.stdout.write(`  [err] ${d}`));

    const tLaunched = Date.now();
    let windowMs = -1;
    try {
      const page = await app.firstWindow({ timeout: 30000 });
      await page.waitForLoadState('domcontentloaded');
      windowMs = Date.now() - tLaunched;
    } catch (err) {
      console.log(`run ${i}: launch ${tLaunched - t0}ms, NO WINDOW — ${err.message.split('\n')[0]}`);
      console.log(`  windows seen by playwright: ${app.windows().length}`);
    }
    const t2 = Date.now();
    try {
      await app.close();
    } catch (err) {
      console.log(`  close threw — ${err.message.split('\n')[0]}`);
    }
    const closeMs = Date.now() - t2;
    console.log(`run ${i}: launch ${tLaunched - t0}ms | window ${windowMs}ms | close ${closeMs}ms | survivors after close: ${survivors()}`);
    try {
      fs.rmSync(ws, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 });
    } catch (err) {
      console.log(`  workspace not removable: ${err.code}`);
    }
  }
  process.exit(0);
})();
