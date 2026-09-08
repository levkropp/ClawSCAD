// scripts/shot.js — launch the app against a scratch workspace and write a
// screenshot. A design pass needs to see the thing; a Playwright timeout and a
// DOM dump both hide what the window actually looks like.
//
//   node scripts/shot.js out.png [--wait 2500] [--workspace DIR]
//
// Never spawns the real Claude CLI (CLAWSCAD_DISABLE_CLAUDE), and uses its own
// Electron profile so it can run alongside a real app instance.
const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.CLAWSCAD_DISABLE_CLAUDE = '1';
process.env.CLAWSCAD_TEST_PROFILE_ROOT = path.join(os.tmpdir(), `clawscad-shot-${process.pid}`);

const { _electron: electron } = require('@playwright/test');

(async () => {
  const args = process.argv.slice(2);
  const out = path.resolve(args[0] || 'shot.png');
  const wait = Number((args.includes('--wait') && args[args.indexOf('--wait') + 1]) || 2500);
  const ws = (args.includes('--workspace') && args[args.indexOf('--workspace') + 1])
    || path.join(os.tmpdir(), 'clawscad-shot-ws');
  fs.mkdirSync(ws, { recursive: true });

  const app = await electron.launch({
    args: [path.join(__dirname, '..', 'main.js'), ws],
    cwd: path.join(__dirname, '..'),
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(wait);
  await page.setViewportSize({ width: 1600, height: 1000 }).catch(() => {});
  const errors = await page.evaluate(() => (window.__shotErrors || []).slice(0, 10)).catch(() => []);
  await page.screenshot({ path: out });
  if (errors.length) console.log('page errors:', errors);
  console.log('wrote', out);
  await app.close();
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
