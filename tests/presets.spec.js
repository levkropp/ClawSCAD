// @ts-check
// Intent presets (P3) — the chip row, refusal card and preamble composed
// text. Each assertion maps to a "done when" line in the master plan's W3
// wave. Only this spec's own assertions run here — other packages'
// concurrent specs are out of scope.
const { test, expect } = require('@playwright/test');
const { _electron: electron } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { openWorkbench } = require('./helpers');

const APP_PATH = path.join(__dirname, '..');
const TEST_WORKSPACE = path.join(os.tmpdir(), 'clawscad-presets-test-' + Date.now());

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
  await page.waitForTimeout(1200); // presets:load + composer mount are both async
  await openWorkbench(page);
});

test.afterEach(async () => {
  if (electronApp) await electronApp.close();
});

test.afterAll(async () => {
  // main/presets.js only ever READS app.getPath('userData')/presets/*.json
  // (an override, if present) — it never writes there, so there's nothing
  // of THIS package's own state to reset. But every test here interacts
  // with P1's composer (target selection), whose state lives in the SAME
  // shared userData profile (composer-state.json) — reset it too, matching
  // composer.spec.js's own afterAll convention, so a leftover "sculpt"
  // target never poisons a sibling spec's run.
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

test.describe('Intent presets', () => {
  test('chips render and toggle aria-pressed', async () => {
    const chips = page.locator('.preset-chip');
    await expect(chips).toHaveCount(5);

    const miniature = page.locator('.preset-chip[data-preset-id="miniature"]');
    await expect(miniature).toHaveAttribute('aria-pressed', 'false');
    await miniature.click();
    await expect(miniature).toHaveAttribute('aria-pressed', 'true');
    await miniature.click();
    await expect(miniature).toHaveAttribute('aria-pressed', 'false');
  });

  test('no chip is ever disabled', async () => {
    const chips = page.locator('.preset-chip');
    const count = await chips.count();
    for (let i = 0; i < count; i++) {
      await expect(chips.nth(i)).toBeEnabled();
    }
  });

  test('clicking Prototype while Miniature is active auto-deselects Miniature with a status note', async () => {
    const miniature = page.locator('.preset-chip[data-preset-id="miniature"]');
    const prototype = page.locator('.preset-chip[data-preset-id="prototype"]');
    await miniature.click();
    await expect(miniature).toHaveAttribute('aria-pressed', 'true');

    await prototype.click();
    await expect(prototype).toHaveAttribute('aria-pressed', 'true');
    await expect(miniature).toHaveAttribute('aria-pressed', 'false');
    // Never disabled, even mid-swap.
    await expect(miniature).toBeEnabled();

    const status = page.locator('#preset-status');
    await expect(status).toHaveAttribute('role', 'status');
    await expect(status).toContainText('Prototype replaces Miniature.');
  });

  test('the refusal card appears for Structural + Sculpt target, and submit is disabled but fully opaque', async () => {
    await page.locator('.target-btn[data-target="sculpt"]').click();
    await page.locator('.preset-chip[data-preset-id="strong"]').click();

    const card = page.locator('#preset-refusal-card');
    await expect(card).not.toHaveAttribute('hidden', '');
    await expect(card).toContainText('not dimensionally controlled');
    await expect(page.locator('button:has-text("Turn off Structural")')).toBeVisible();
    await expect(page.locator('button:has-text("Sculpt anyway (decorative only)")')).toBeVisible();

    // Give the composer a prompt so the ONLY blocking reason left is the
    // refusal card, not an empty-prompt state.
    await page.locator('#composer-prompt').fill('a decorative bracket, but only decorative');

    const submitBtn = page.locator('#composer-submit');
    await expect(submitBtn).toBeDisabled();
    const opacity = await submitBtn.evaluate((el) => getComputedStyle(el).opacity);
    expect(opacity).toBe('1');
  });

  test('"Sculpt anyway" clears the refusal block without deactivating the chip', async () => {
    await page.locator('.target-btn[data-target="sculpt"]').click();
    await page.locator('.preset-chip[data-preset-id="strong"]').click();
    await page.locator('#composer-prompt').fill('a decorative bracket');

    const submitBtn = page.locator('#composer-submit');
    await expect(submitBtn).toHaveAttribute('title', /Turn off Structural/);

    await page.locator('button:has-text("Sculpt anyway (decorative only)")').click();

    await expect(page.locator('#preset-refusal-card')).toHaveAttribute('hidden', '');
    await expect(page.locator('.preset-chip[data-preset-id="strong"]')).toHaveAttribute('aria-pressed', 'true');
    // The refusal-specific block is gone — whatever's left disabling submit
    // (e.g. claw-gen not being configured on this machine) is a separate,
    // pre-existing degradation this package doesn't own, so this only
    // asserts the preset-owned reason is no longer the blocker.
    await expect(submitBtn).not.toHaveAttribute('title', /Turn off Structural/);
  });

  test('"Turn off Structural" deactivates the chip and clears the card', async () => {
    await page.locator('.target-btn[data-target="sculpt"]').click();
    await page.locator('.preset-chip[data-preset-id="strong"]').click();
    await page.locator('#composer-prompt').fill('a decorative bracket');

    await page.locator('button:has-text("Turn off Structural")').click();

    await expect(page.locator('#preset-refusal-card')).toHaveAttribute('hidden', '');
    await expect(page.locator('.preset-chip[data-preset-id="strong"]')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('#composer-submit')).not.toHaveAttribute('title', /Turn off Structural/);
  });

  test('the refusal card does not block the Part target', async () => {
    await page.locator('.target-btn[data-target="part"]').click();
    await expect(page.locator('.target-btn[data-target="part"]')).toHaveAttribute('aria-checked', 'true');
    await page.locator('.preset-chip[data-preset-id="fits-hardware"]').click();
    await expect(page.locator('#preset-refusal-card')).toHaveAttribute('hidden', '');
  });

  test('the preamble shows the composed preset prompt text on the Part target', async () => {
    await page.locator('.target-btn[data-target="part"]').click();
    await page.locator('.preset-chip[data-preset-id="fits-hardware"]').click();
    await page.locator('#composer-prompt').fill('a bracket for an M4 bolt');
    await page.locator('#composer-preamble summary').click();
    const body = page.locator('#composer-preamble-body');
    await expect(body).toContainText('INTENT PRESET: FITS SCREWS AND PARTS.');
    await expect(body).toContainText('a bracket for an M4 bolt');
  });

  test('the recipe strip appears once a preset is active and names it', async () => {
    await expect(page.locator('#preset-recipe-strip')).toHaveAttribute('hidden', '');
    await page.locator('.preset-chip[data-preset-id="miniature"]').click();
    await expect(page.locator('#preset-recipe-strip')).not.toHaveAttribute('hidden', '');
    await expect(page.locator('.preset-recipe-title')).toContainText('Miniature');
  });

  test('the printer modifier row renders from machine.json', async () => {
    const printerChips = page.locator('.preset-modifier-chip');
    await expect(printerChips.first()).toBeVisible();
    const pressed = page.locator('.preset-modifier-chip[aria-pressed="true"]');
    await expect(pressed).toHaveCount(1);
  });
});
