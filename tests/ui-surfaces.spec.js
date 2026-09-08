// @ts-check
// The surfaces added by the UI/UX master plan (waves W1–W4). Each assertion
// here maps to a defect that shipped: a checkpoint whose kind was invisible, a
// branching rule that only ever appeared in a 4-second toast, an environment
// fault that raised an overlay nobody could dismiss, and a ten-minute job that
// reported no progress at all.
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
  const dir = path.join(os.tmpdir(), `clawscad-ui-${name}-${Date.now()}`);
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

// ── Checkpoint tree: kind, badges, branch point ─────────────────────────

test.describe('checkpoint tree surfaces', () => {
  test('a generated sculpt badges GEN and FOUND, and carries data-kind', async () => {
    const ws = freshWorkspace('kindbadge');
    fs.writeFileSync(
      path.join(ws, 'owl-sculpt.scad'),
      '// Generated sculpt: an owl planter\ncolor("Tan")\n  import("meshes/owl.stl", convexity = 8);\n'
    );
    const { electronApp, page } = await launch(ws);
    try {
      const node = page.locator('.cp-node[data-kind="generated"]');
      await expect(node).toHaveCount(1);
      // Shape AND colour: the badge is the half that survives a colourblind read.
      await expect(node.locator('.cp-badge').first()).toContainText('GEN');
      await expect(node.locator('.cp-badge.cp-badge-found')).toContainText('FOUND');
      // The description second line replaces a hover-only string.
      await expect(node.locator('.cp-desc')).toContainText('Generated sculpt: an owl planter');
    } finally {
      await electronApp.close();
      removeWorkspace(ws);
    }
  });

  test('a hand-written parametric checkpoint does not badge as generated', async () => {
    const ws = freshWorkspace('parametric');
    fs.writeFileSync(path.join(ws, 'plate.scad'), '// A flat plate\ncube([20,20,2]);\n');
    const { electronApp, page } = await launch(ws);
    try {
      await expect(page.locator('.cp-node[data-kind="parametric"]')).toHaveCount(1);
      await expect(page.locator('.cp-node .cp-badge:not(.cp-badge-found)')).toHaveCount(0);
    } finally {
      await electronApp.close();
      removeWorkspace(ws);
    }
  });

  test('the branch-point strip names the checkpoint the next change branches from', async () => {
    const ws = freshWorkspace('branchpoint');
    fs.writeFileSync(path.join(ws, 'base-plate.scad'), '// Base plate\ncube([10,10,1]);\n');
    const { electronApp, page } = await launch(ws);
    try {
      const strip = page.locator('#cp-branchpoint');
      await expect(strip).toBeVisible();
      await expect(strip).toContainText('Next change branches from');
      await expect(strip).toContainText('base plate');
      await expect(strip).toContainText('active.scad');
    } finally {
      await electronApp.close();
      removeWorkspace(ws);
    }
  });

  test('checkpoint rows are keyboard reachable and operable', async () => {
    const ws = freshWorkspace('keyboard');
    fs.writeFileSync(path.join(ws, 'first-part.scad'), '// First part\ncube(4);\n');
    const { electronApp, page } = await launch(ws);
    try {
      const row = page.locator('.cp-node').first();
      await expect(row).toHaveAttribute('role', 'treeitem');
      await row.focus();
      // Focus surfaces the same tooltip a hover does.
      await expect(page.locator('#cp-tooltip')).not.toHaveClass(/hidden/);
      await page.keyboard.press('Enter');
      await expect(row).toHaveClass(/active/);
    } finally {
      await electronApp.close();
      removeWorkspace(ws);
    }
  });

  test('the panel is named Checkpoints, not History', async () => {
    const ws = freshWorkspace('naming');
    const { electronApp, page } = await launch(ws);
    try {
      await expect(page.locator('#checkpoint-header .label')).toHaveText('Checkpoints');
    } finally {
      await electronApp.close();
      removeWorkspace(ws);
    }
  });
});

// ── Environment faults ──────────────────────────────────────────────────

test.describe('environment surfaces', () => {
  test('env status is reportable and the banner strip shows at most one banner', async () => {
    const ws = freshWorkspace('env');
    const { electronApp, page } = await launch(ws);
    try {
      const env = await page.evaluate(() => window.api.getEnvStatus());
      expect(env).toHaveProperty('openscad');
      expect(env).toHaveProperty('claude');
      expect(env).toHaveProperty('clawGen');
      await expect(page.locator('#env-banners')).toBeAttached();
      const banners = page.locator('.env-banner');
      expect(await banners.count()).toBeLessThanOrEqual(1);
      if (await banners.count()) {
        const cls = await banners.getAttribute('class');
        expect(/blocking|degraded/.test(cls)).toBe(true);
      }
    } finally {
      await electronApp.close();
      removeWorkspace(ws);
    }
  });

  // This is the regression check for the bug that hung the app: main emitted
  // render:env-error, preload exposed it, and NO renderer handler consumed it,
  // so the overlay raised at render:start never came down.
  test('render:env-error is consumed and produces a dismissible setup card', async () => {
    const ws = freshWorkspace('enverror');
    const { electronApp, page } = await launch(ws);
    try {
      await electronApp.evaluate(({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows()[0];
        win.webContents.send('render:env-error', {
          file: 'thing.scad',
          binary: 'openscad',
          code: 'ENOENT',
          error: 'spawn openscad ENOENT',
        });
      });

      const overlay = page.locator('#render-overlay');
      await expect(overlay).toHaveClass(/is-error/);
      // Environment, never the red model variant.
      await expect(overlay).toHaveClass(/fault-environment/);
      await expect(page.locator('#render-fault-detail')).toContainText(
        'Your model was never compiled'
      );
      // Setup actions only: nothing here is Claude's to fix.
      await expect(page.locator('#render-fault-locate')).toBeVisible();
      await expect(page.locator('#render-fault-ask')).toHaveClass(/hidden/);

      await page.locator('#render-fault-dismiss').click();
      await expect(overlay).not.toHaveClass(/is-error/);
    } finally {
      await electronApp.close();
      removeWorkspace(ws);
    }
  });

  test('a model fault offers the two actions that can act on it', async () => {
    const ws = freshWorkspace('modelerror');
    const { electronApp, page } = await launch(ws);
    try {
      await electronApp.evaluate(({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows()[0];
        win.webContents.send('render:error', {
          file: 'broken.scad',
          error: 'ERROR: Parser error in file "broken.scad", line 2',
          errors: [],
          fault: 'model',
        });
      });
      await expect(page.locator('#render-overlay')).toHaveClass(/fault-model/);
      await expect(page.locator('#render-fault-open-errors')).toBeVisible();
      await expect(page.locator('#render-fault-ask')).toBeVisible();
      await expect(page.locator('#render-fault-locate')).toHaveClass(/hidden/);
    } finally {
      await electronApp.close();
      removeWorkspace(ws);
    }
  });

  // The nudge used to be typed straight into the pty two seconds after a
  // failure, with no idle check, so it could splice into a half-typed line.
  test('a render failure offers the Claude nudge as a card rather than typing it', async () => {
    const ws = freshWorkspace('nudge');
    const { electronApp, page } = await launch(ws);
    try {
      await electronApp.evaluate(({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows()[0];
        win.webContents.send('claude:nudge', {
          file: 'broken.scad',
          message: 'The render of broken.scad failed. Read RENDER_ERRORS.md for details.',
        });
      });
      const card = page.locator('#nudge-card');
      await expect(card).not.toHaveClass(/hidden/);
      await expect(card).toContainText('broken.scad');
      await expect(page.locator('#nudge-send')).toBeVisible();
      await page.locator('#nudge-dismiss').click();
      await expect(card).toHaveClass(/hidden/);
    } finally {
      await electronApp.close();
      removeWorkspace(ws);
    }
  });

  test('the terminal pane is labelled from the binary that actually spawned', async () => {
    const ws = freshWorkspace('termlabel');
    const { electronApp, page } = await launch(ws);
    try {
      await electronApp.evaluate(({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows()[0];
        win.webContents.send('terminal:label', { kind: 'shell', binary: 'cmd.exe' });
      });
      await expect(page.locator('#terminal-label')).toHaveText('Shell');
      await expect(page.locator('#restart-claude-btn')).toBeVisible();

      await electronApp.evaluate(({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows()[0];
        win.webContents.send('terminal:label', { kind: 'claude', binary: 'claude.exe' });
      });
      await expect(page.locator('#terminal-label')).toHaveText('Claude Code');
      await expect(page.locator('#restart-claude-btn')).toHaveClass(/hidden/);
    } finally {
      await electronApp.close();
      removeWorkspace(ws);
    }
  });
});

// ── Generate stepper ────────────────────────────────────────────────────

test.describe('generate stepper', () => {
  test('four stages exist, above the log, and stay hidden until a job runs', async () => {
    const ws = freshWorkspace('stepper');
    const { electronApp, page } = await launch(ws);
    try {
      const steps = page.locator('.gen-step');
      await expect(steps).toHaveCount(4);
      for (const stage of ['images', 'mesh', 'prep', 'checkpoint']) {
        await expect(page.locator(`.gen-step[data-stage="${stage}"]`)).toBeAttached();
      }
      // Additive above #gen-log, which generate-panel.spec.js still asserts on.
      await expect(page.locator('#gen-log')).toBeAttached();
      await expect(page.locator('#gen-stepper')).toBeHidden();
      await expect(page.locator('#gen-elapsed')).toBeAttached();
    } finally {
      await electronApp.close();
      removeWorkspace(ws);
    }
  });
});

// ── Toolbar semantics ───────────────────────────────────────────────────

test.describe('toolbar semantics', () => {
  test('toggles carry aria-pressed alongside the active class', async () => {
    const ws = freshWorkspace('aria');
    const { electronApp, page } = await launch(ws);
    try {
      const wire = page.locator('#btn-wire');
      await expect(wire).toHaveAttribute('aria-pressed', 'false');
      await wire.click();
      await expect(wire).toHaveAttribute('aria-pressed', 'true');
      await expect(wire).toHaveClass(/active/);
      await expect(page.locator('#btn-edges')).toHaveAttribute('aria-pressed', 'true');
    } finally {
      await electronApp.close();
      removeWorkspace(ws);
    }
  });

  test('a disabled control is coloured, not faded to invisibility', async () => {
    const ws = freshWorkspace('disabled');
    const { electronApp, page } = await launch(ws);
    try {
      const opacity = await page.locator('#gen-make3d-btn').evaluate(
        (el) => getComputedStyle(el).opacity
      );
      expect(opacity).toBe('1');
    } finally {
      await electronApp.close();
      removeWorkspace(ws);
    }
  });
});
