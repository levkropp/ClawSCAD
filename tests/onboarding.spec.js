// @ts-check
const { test, expect } = require('@playwright/test');
const { _electron: electron } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { openWorkbench } = require('./helpers');

const APP_PATH = path.join(__dirname, '..');

test.beforeAll(async () => {
  const { execSync } = require('child_process');
  execSync('npm run build:renderer', { cwd: APP_PATH, stdio: 'pipe' });
});

function freshWorkspace(name) {
  const dir = path.join(os.tmpdir(), `clawscad-onboarding-${name}-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function removeWorkspace(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  } catch (err) {
    console.warn(`test workspace cleanup left ${dir}: ${err.code}`);
  }
}

async function launch(wsDir) {
  const electronApp = await electron.launch({
    args: [path.join(APP_PATH, 'main.js'), wsDir],
    cwd: APP_PATH,
  });
  const page = await electronApp.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(1200);
  await openWorkbench(page);
  return { electronApp, page };
}

test.describe('Onboarding', () => {
  test('is present on a fresh workspace with no checkpoints', async () => {
    const ws = freshWorkspace('fresh');
    const { electronApp, page } = await launch(ws);
    try {
      await expect(page.locator('#onboarding-card')).toBeVisible();
      await expect(page.locator('.onboard-start-card')).toHaveCount(3);
    } finally {
      await electronApp.close();
      removeWorkspace(ws);
    }
  });

  test('is absent once the workspace has a checkpoint', async () => {
    const ws = freshWorkspace('has-cp');
    fs.writeFileSync(path.join(ws, 'bracket.scad'), '// A simple bracket\ncube([10,10,2]);\n');
    const { electronApp, page } = await launch(ws);
    try {
      await expect(page.locator('#onboarding-overlay')).toBeHidden();
    } finally {
      await electronApp.close();
      removeWorkspace(ws);
    }
  });

  test('clicking the "fits something" starter puts real, editable text in the composer prompt', async () => {
    const ws = freshWorkspace('starter-fits');
    const { electronApp, page } = await launch(ws);
    try {
      await page.locator('.onboard-start-card[data-starter="fits"]').click();
      const promptEl = page.locator('#composer-prompt');
      await expect(promptEl).toHaveValue('a 40 mm cable clip that snaps onto a 6 mm cable');
      // Real editable text, not a placeholder that vanishes on typing.
      await expect(promptEl).not.toHaveAttribute('placeholder', 'a 40 mm cable clip that snaps onto a 6 mm cable');
      await expect(page.locator('.target-btn[data-target="part"]')).toHaveAttribute('aria-checked', 'true');
    } finally {
      await electronApp.close();
      removeWorkspace(ws);
    }
  });

  test('clicking the "sculpt" starter selects the Sculpt target with editable text', async () => {
    const ws = freshWorkspace('starter-sculpt');
    const { electronApp, page } = await launch(ws);
    try {
      await page.locator('.onboard-start-card[data-starter="looks-good"]').click();
      const promptEl = page.locator('#composer-prompt');
      await expect(promptEl).toHaveValue('a squat owl planter with big round eyes');
      await expect(page.locator('.target-btn[data-target="sculpt"]')).toHaveAttribute('aria-checked', 'true');
    } finally {
      await electronApp.close();
      removeWorkspace(ws);
    }
  });

  test('the three-item environment checklist renders', async () => {
    const ws = freshWorkspace('env-checklist');
    const { electronApp, page } = await launch(ws);
    try {
      await expect(page.locator('.onboard-env-item')).toHaveCount(3);
      await expect(page.locator('.onboard-env-item[data-env="openscad"]')).toBeVisible();
      await expect(page.locator('.onboard-env-item[data-env="claude"]')).toBeVisible();
      await expect(page.locator('.onboard-env-item[data-env="claw-gen"]')).toBeVisible();
    } finally {
      await electronApp.close();
      removeWorkspace(ws);
    }
  });

  test('#render-overlay still computes opacity 0 at rest with the onboarding card present', async () => {
    const ws = freshWorkspace('overlay-rest');
    const { electronApp, page } = await launch(ws);
    try {
      await expect(page.locator('#onboarding-card')).toBeVisible();
      const opacity = await page.locator('#render-overlay').evaluate((el) => getComputedStyle(el).opacity);
      expect(opacity).toBe('0');
    } finally {
      await electronApp.close();
      removeWorkspace(ws);
    }
  });

  test('#terminal stays visible with the onboarding card present', async () => {
    const ws = freshWorkspace('terminal-visible');
    const { electronApp, page } = await launch(ws);
    try {
      await expect(page.locator('#onboarding-card')).toBeVisible();
      await expect(page.locator('#terminal')).toBeVisible();
    } finally {
      await electronApp.close();
      removeWorkspace(ws);
    }
  });

  test('the status copy no longer points at the terminal', async () => {
    const ws = freshWorkspace('status-copy');
    const { electronApp, page } = await launch(ws);
    try {
      const text = await page.locator('#status').textContent();
      expect(text).not.toContain('in the terminal on the right');
      expect(text).toContain('on the right');
    } finally {
      await electronApp.close();
      removeWorkspace(ws);
    }
  });
});
