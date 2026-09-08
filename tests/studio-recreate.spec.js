// @ts-check
//
// Flow C — "upload a picture and recreate it as a model" — end to end against
// the fake claw-gen, in its own spec file so it can hold the CLI-configured
// setup without disturbing tests/studio.spec.js.
//
// This is the flow the whole `claw-gen mesh --image … --new-job` change exists
// for, and it was the LAST thing to be provable: attaching normally goes
// through a native file dialog Playwright cannot drive, and the mesh→prep→
// checkpoint chain is driven by `genPendingStage`, which is private to
// renderer.js. Before ctx.startMeshChain() existed, a recreate would start the
// mesh and then simply stop — an .stl in a job dir, no checkpoint, and nothing
// on screen to say why. That is exactly the failure a test has to catch,
// because to the user it looks identical to "nothing happened".
const { test, expect } = require('@playwright/test');
const { _electron: electron } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const os = require('os');

const APP_PATH = path.join(__dirname, '..');
const FAKE_CLI = path.join(__dirname, 'fixtures', 'fake-claw-gen.exe');
const TEST_WORKSPACE = path.join(os.tmpdir(), 'clawscad-recreate-' + Date.now());

// A 1x1 PNG — enough for uploadIngest to classify and copy it.
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);

let electronApp;
let page;

test.beforeAll(async () => {
  const { execSync } = require('child_process');
  execSync('npm run build:renderer', { cwd: APP_PATH, stdio: 'pipe' });
  fs.mkdirSync(TEST_WORKSPACE, { recursive: true });
  if (!fs.existsSync(FAKE_CLI)) test.skip(true, 'fake-claw-gen.exe has not been built');
});

test.afterAll(async () => {
  // composer-state.json lives in the shared userData profile; leaving a
  // recreate attachment behind would poison every later spec (standing rule 5).
  try {
    const p = await electronApp?.firstWindow();
    if (p) await p.evaluate(() => window.api.composerSetState({}));
  } catch {}
  try {
    await electronApp?.close();
  } catch {}
  try {
    fs.rmSync(TEST_WORKSPACE, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  } catch (err) {
    console.warn(`test workspace cleanup left ${TEST_WORKSPACE}: ${err.code}`);
  }
});

test('recreating an attached picture runs mesh -> prep -> checkpoint and writes a checkpoint file', async () => {
  electronApp = await electron.launch({
    args: [path.join(APP_PATH, 'main.js'), TEST_WORKSPACE],
    cwd: APP_PATH,
  });
  page = await electronApp.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(1200);

  await page.evaluate((cliPath) => window.api.setPipelineCliPath(cliPath), FAKE_CLI);
  await page.reload();
  await page.waitForTimeout(1500);
  await page.evaluate(() => window.clawscadStudio && window.clawscadStudio.ready);

  // Ingest a real file through the real IPC — the flow copies into
  // <workspace>/uploads/ and hands back a workspace-RELATIVE path, which is
  // what claw-gen receives unchanged (it runs with cwd = the workspace).
  const src = path.join(TEST_WORKSPACE, 'source-picture.png');
  fs.writeFileSync(src, TINY_PNG);
  const ingested = await page.evaluate((p) => window.api.uploadIngest(p), src);
  expect(ingested.ok).toBe(true);
  expect(ingested.relPath.startsWith('uploads/')).toBe(true);
  expect(fs.existsSync(src)).toBe(true); // ingest COPIES, never moves

  await page.evaluate(
    (rel) => window.clawscadStudio.setAttachment({ relPath: rel, name: 'source-picture.png', mode: 'recreate' }),
    ingested.relPath
  );

  // With a recreate attachment the button names that action, and — unlike every
  // other flow — it is enabled with an EMPTY prompt, because the picture is the
  // description.
  const submit = page.locator('#studio-submit');
  await expect(submit).toHaveText(/recreate/i);
  await expect(submit).toBeEnabled();

  await submit.click();

  // The chain's contract-visible output: the fake CLI's checkpoint stage writes
  // a real .scad into the workspace. If startMeshChain did not hand off to
  // renderer.js's exit handler, mesh would finish and this would never appear.
  const scadPath = path.join(TEST_WORKSPACE, 'fake-gen-checkpoint.scad');
  await expect.poll(() => fs.existsSync(scadPath), { timeout: 20000 }).toBe(true);
  expect(fs.readFileSync(scadPath, 'utf-8').startsWith('// Generated sculpt:')).toBe(true);
});
