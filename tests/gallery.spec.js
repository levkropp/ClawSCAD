// @ts-check
// The gallery sheet (P4) — the answer to "make it easy to open previously
// made things to iterate on them". Each assertion here maps to a specific
// "done when" line in the master plan's W4 wave.
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
  const dir = path.join(os.tmpdir(), `clawscad-gallery-${name}-${Date.now()}`);
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

test.describe('gallery sheet', () => {
  test('opens on the header button', async () => {
    const ws = freshWorkspace('opens');
    const { electronApp, page } = await launch(ws);
    try {
      const sheet = page.locator('#gallery-sheet');
      await expect(sheet).toHaveAttribute('hidden', '');

      const openBtn = page.locator('#gallery-open-btn');
      await expect(openBtn).toBeVisible();
      await openBtn.click();

      await expect(sheet).not.toHaveAttribute('hidden', '');
      const modal = page.locator('.gallery-modal');
      await expect(modal).toHaveAttribute('role', 'dialog');
      await expect(modal).toHaveAttribute('aria-modal', 'true');
    } finally {
      await electronApp.close();
      removeWorkspace(ws);
    }
  });

  test('traps focus, and Esc closes and returns focus to the opener', async () => {
    const ws = freshWorkspace('trap-esc');
    fs.writeFileSync(path.join(ws, 'a-plate.scad'), '// A flat plate\ncube([20,20,2]);\n');
    const { electronApp, page } = await launch(ws);
    try {
      const openBtn = page.locator('#gallery-open-btn');
      await openBtn.click();
      await expect(page.locator('#gallery-sheet')).not.toHaveAttribute('hidden', '');
      // Let the async gallery:list / gallery:list-jobs round trip settle so
      // the focusable set (which includes any rendered cards) is stable.
      await page.waitForTimeout(400);

      const firstId = await page.evaluate(() => document.activeElement && document.activeElement.id);
      expect(firstId).toBeTruthy();
      const startedInModal = await page.evaluate(
        () => !!(document.activeElement && document.activeElement.closest('.gallery-modal'))
      );
      expect(startedInModal).toBe(true);

      // Shift+Tab from the first focusable element must wrap to the last
      // one WITHOUT leaving the modal — that's the trap.
      await page.keyboard.press('Shift+Tab');
      const wrapped = await page.evaluate(() => {
        const el = document.activeElement;
        return { inModal: !!(el && el.closest('.gallery-modal')), id: el && el.id };
      });
      expect(wrapped.inModal).toBe(true);

      // Esc closes and returns focus to the opener.
      await page.keyboard.press('Escape');
      await expect(page.locator('#gallery-sheet')).toHaveAttribute('hidden', '');
      await expect(openBtn).toBeFocused();
    } finally {
      await electronApp.close();
      removeWorkspace(ws);
    }
  });

  test("a card's .cp-badge text equals its tree row's", async () => {
    const ws = freshWorkspace('badge-match');
    fs.writeFileSync(
      path.join(ws, 'owl-sculpt.scad'),
      '// Generated sculpt: an owl planter\ncolor("Tan")\n  import("meshes/owl.stl", convexity = 8);\n'
    );
    const { electronApp, page } = await launch(ws);
    try {
      const treeBadge = page.locator('.cp-node[data-kind="generated"] .cp-badge').first();
      await expect(treeBadge).toContainText('GEN');
      const treeBadgeText = (await treeBadge.textContent() || '').trim();

      await page.locator('#gallery-open-btn').click();
      await expect(page.locator('#gallery-sheet')).not.toHaveAttribute('hidden', '');

      const card = page.locator('.gallery-card').first();
      await expect(card).toBeVisible();
      const cardBadge = card.locator('.cp-badge').first();
      await expect(cardBadge).toHaveText(treeBadgeText);
    } finally {
      await electronApp.close();
      removeWorkspace(ws);
    }
  });

  test('a workspace with no renders/gen yields an empty state that names where it looked', async () => {
    const ws = freshWorkspace('empty-names-path');
    const { electronApp, page } = await launch(ws);
    try {
      await page.locator('#gallery-open-btn').click();
      const empty = page.locator('#gallery-empty');
      await expect(empty).toBeVisible();
      await expect(empty).toContainText('Nothing here yet');

      const wsBase = path.basename(ws);
      await expect(empty).toContainText(wsBase);
      await expect(empty).toContainText('renders');
      await expect(empty).toContainText('gen');
    } finally {
      await electronApp.close();
      removeWorkspace(ws);
    }
  });

  test('the checkpoint-header Gallery button lands after .spacer and leaves the label text alone', async () => {
    const ws = freshWorkspace('cp-header-btn');
    const { electronApp, page } = await launch(ws);
    try {
      await expect(page.locator('#checkpoint-header .label')).toHaveText('Checkpoints');
      const cpBtn = page.locator('#checkpoint-gallery-btn');
      await expect(cpBtn).toBeVisible();

      const order = await page.evaluate(() => {
        const header = document.getElementById('checkpoint-header');
        const kids = Array.from(header.children);
        return {
          spacerIdx: kids.findIndex((k) => k.classList.contains('spacer')),
          galleryIdx: kids.findIndex((k) => k.id === 'checkpoint-gallery-btn'),
        };
      });
      expect(order.galleryIdx).toBeGreaterThan(order.spacerIdx);

      await cpBtn.click();
      await expect(page.locator('#gallery-sheet')).not.toHaveAttribute('hidden', '');
    } finally {
      await electronApp.close();
      removeWorkspace(ws);
    }
  });
});
