// @ts-check
const { test, expect } = require('@playwright/test');
const { _electron: electron } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { openWorkbench } = require('./helpers');

const APP_PATH = path.join(__dirname, '..');
const TEST_WORKSPACE = path.join(os.tmpdir(), 'clawscad-composer-test-' + Date.now());

let electronApp;
let page;

test.beforeAll(async () => {
  const { execSync } = require('child_process');
  execSync('npm run build:renderer', { cwd: APP_PATH, stdio: 'pipe' });
  fs.mkdirSync(TEST_WORKSPACE, { recursive: true });
});

test.beforeEach(async () => {
  electronApp = await electron.launch({
    args: [path.join(APP_PATH, 'main.js'), TEST_WORKSPACE],
    cwd: APP_PATH,
  });
  page = await electronApp.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(1000);
  await openWorkbench(page);
});

test.afterEach(async () => {
  if (electronApp) await electronApp.close();
});

test.afterAll(async () => {
  // composer-state.json lives in the shared Electron userData profile
  // (main/composer.js) — reset it so this spec never poisons a sibling
  // spec's run, matching generate-panel.spec.js's afterAll convention.
  const cleanupApp = await electron.launch({
    args: [path.join(APP_PATH, 'main.js'), TEST_WORKSPACE],
    cwd: APP_PATH,
  });
  const cleanupPage = await cleanupApp.firstWindow();
  await cleanupPage.evaluate(() => window.api.composerSetState({}));
  await cleanupApp.close();

  try {
    fs.rmSync(TEST_WORKSPACE, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  } catch (err) {
    console.warn(`test workspace cleanup left ${TEST_WORKSPACE}: ${err.code}`);
  }
});

test.describe('Composer shell', () => {
  test('is visible at launch', async () => {
    await expect(page.locator('#composer')).toBeVisible();
  });

  test('has exactly 3 target buttons with exactly one aria-checked=true', async () => {
    const targets = page.locator('.target-btn');
    await expect(targets).toHaveCount(3);
    const checked = page.locator('.target-btn[aria-checked="true"]');
    await expect(checked).toHaveCount(1);
    await expect(checked).toHaveAttribute('data-target', 'part');
  });

  test('changing target preserves the prompt value', async () => {
    // This single assertion is what proves the one-composer decision
    // (master plan §1.1) — target is a mode WITHIN the composer, not a
    // separate surface with its own state.
    const promptEl = page.locator('#composer-prompt');
    await promptEl.fill('a 40mm cable clip');

    await page.locator('.target-btn[data-target="sculpt"]').click();
    await expect(page.locator('.target-btn[data-target="sculpt"]')).toHaveAttribute('aria-checked', 'true');
    await expect(promptEl).toHaveValue('a 40mm cable clip');

    await page.locator('.target-btn[data-target="image"]').click();
    await expect(promptEl).toHaveValue('a 40mm cable clip');

    await page.locator('.target-btn[data-target="part"]').click();
    await expect(promptEl).toHaveValue('a 40mm cable clip');
  });

  test('submit is disabled on empty prompt and stays fully opaque', async () => {
    const promptEl = page.locator('#composer-prompt');
    await promptEl.fill('');
    const submitBtn = page.locator('#composer-submit');
    await expect(submitBtn).toBeDisabled();
    const opacity = await submitBtn.evaluate((el) => getComputedStyle(el).opacity);
    expect(opacity).toBe('1');

    await promptEl.fill('something to make');
    await expect(submitBtn).toBeEnabled();
  });

  test('#terminal stays visible with the composer present', async () => {
    await expect(page.locator('#terminal')).toBeVisible();
  });

  test('#gen-panel stays collapsed at boot', async () => {
    await expect(page.locator('#gen-panel')).toHaveClass(/collapsed/);
  });

  test('the "What Claude will read" preamble renders even with nothing attached', async () => {
    const promptEl = page.locator('#composer-prompt');
    await promptEl.fill('a decorative owl planter');
    await page.locator('#composer-preamble summary').click();
    await expect(page.locator('#composer-preamble-body')).toContainText('a decorative owl planter');
  });

  test('part-mode submit writes a multi-line message to the pty', async () => {
    const promptEl = page.locator('#composer-prompt');
    await promptEl.fill('line one\nline two');
    await expect(page.locator('.target-btn[data-target="part"]')).toHaveAttribute('aria-checked', 'true');

    const ok = await page.evaluate(() => window.api.composerSendToClaude('line one\nline two'));
    expect(ok).toBe(true);
  });
});
