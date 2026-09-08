// @ts-check
const { defineConfig } = require('@playwright/test');

// Every spec launches a fresh Electron app per test, and each launch used to
// start the real Claude Code CLI in the temp workspace: seconds of startup,
// an open handle on the workspace (the EBUSY cleanup warnings), and a slow
// death that pushed electronApp.close() past the 60s worker-teardown budget —
// after which the next launch sat waiting for a `window` event that never
// arrived. _electron.launch() inherits this process's env, so setting it here
// covers every spec without touching a single launch site. See spawnClaude()
// in main.js: this suppresses only the spawn, never the environment probe.
process.env.CLAWSCAD_DISABLE_CLAUDE = '1';

// ...and give every launch its own Electron profile, under one root this run
// owns. See the CLAWSCAD_TEST_PROFILE_ROOT block in main.js for why: sharing
// %APPDATA%\Electron across overlapping launches is what produced the
// "firstWindow timed out" failures that look like code faults and are not.
const os = require('os');
const path = require('path');
process.env.CLAWSCAD_TEST_PROFILE_ROOT = path.join(os.tmpdir(), `clawscad-profiles-${process.pid}`);

module.exports = defineConfig({
  testDir: './tests',
  timeout: 60000, // render pipeline tests invoke OpenSCAD and need more time
  retries: 0,
  workers: 1, // Electron tests must run sequentially
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    trace: 'on-first-retry',
  },
});
