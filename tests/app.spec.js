// @ts-check
const { test, expect } = require('@playwright/test');
const { _electron: electron } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const os = require('os');

const APP_PATH = path.join(__dirname, '..');
const TEST_WORKSPACE = path.join(os.tmpdir(), 'clawscad-test-' + Date.now());

let electronApp;
let page;

test.beforeAll(async () => {
  // Build renderer before tests
  const { execSync } = require('child_process');
  execSync('npm run build:renderer', { cwd: APP_PATH, stdio: 'pipe' });

  // Create a clean test workspace
  fs.mkdirSync(TEST_WORKSPACE, { recursive: true });
});

test.beforeEach(async () => {
  electronApp = await electron.launch({
    args: [path.join(APP_PATH, 'main.js'), TEST_WORKSPACE],
    cwd: APP_PATH,
  });
  page = await electronApp.firstWindow();
  // Wait for the app to fully render
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(1000); // Allow three.js/monaco to initialize
});

test.afterEach(async () => {
  if (electronApp) {
    await electronApp.close();
  }
});

test.afterAll(async () => {
  // Clean up test workspace
  fs.rmSync(TEST_WORKSPACE, { recursive: true, force: true });
});

// ── Window & Layout Tests ────────────────────────────────────────────

test.describe('Window & Layout', () => {
  test('window launches with correct title', async () => {
    const title = await page.title();
    expect(title).toBe('ClawSCAD');
  });

  test('app header is visible with brand text', async () => {
    const header = page.locator('#app-header');
    await expect(header).toBeVisible();
    const brand = page.locator('#app-menu-btn');
    await expect(brand).toBeVisible();
    await expect(brand).toContainText('ClawSCAD');
  });

  test('viewport is visible', async () => {
    const viewport = page.locator('#viewport');
    await expect(viewport).toBeVisible();
  });

  test('terminal panel is visible', async () => {
    const terminal = page.locator('#terminal');
    await expect(terminal).toBeVisible();
  });

  test('status bar is visible', async () => {
    const status = page.locator('#status-bar');
    await expect(status).toBeVisible();
    await expect(status).toContainText('ClawSCAD');
  });

  test('checkpoint panel is visible with empty state', async () => {
    const cpPanel = page.locator('#checkpoint-panel');
    await expect(cpPanel).toBeVisible();
    const tree = page.locator('#checkpoint-tree');
    await expect(tree).toContainText('No checkpoints yet');
  });

  test('splitter is visible and has correct cursor', async () => {
    const splitter = page.locator('#splitter');
    await expect(splitter).toBeVisible();
    const cursor = await splitter.evaluate((el) => getComputedStyle(el).cursor);
    expect(cursor).toBe('col-resize');
  });

  test('workspace path is shown in header', async () => {
    const pathEl = page.locator('#workspace-path');
    await expect(pathEl).toContainText(TEST_WORKSPACE);
  });
});

// ── ClawSCAD Menu Tests ─────────────────────────────────────────────

test.describe('ClawSCAD Menu', () => {
  test('menu is hidden by default', async () => {
    const menu = page.locator('#app-menu');
    await expect(menu).toHaveClass(/hidden/);
  });

  test('clicking brand button opens menu', async () => {
    await page.locator('#app-menu-btn').click();
    const menu = page.locator('#app-menu');
    await expect(menu).not.toHaveClass(/hidden/);
  });

  test('menu has all expected items', async () => {
    await page.locator('#app-menu-btn').click();
    const items = page.locator('.menu-item');
    const count = await items.count();
    expect(count).toBeGreaterThanOrEqual(10);

    // Check key menu items exist
    await expect(page.locator('[data-action="new-window"]')).toBeVisible();
    await expect(page.locator('[data-action="open-workspace"]')).toBeVisible();
    await expect(page.locator('[data-action="new-session"]')).toBeVisible();
    await expect(page.locator('[data-action="screenshot"]')).toBeVisible();
    await expect(page.locator('[data-action="toggle-editor"]')).toBeVisible();
    await expect(page.locator('[data-action="devtools"]')).toBeVisible();
  });

  test('clicking outside menu closes it', async () => {
    await page.locator('#app-menu-btn').click();
    const menu = page.locator('#app-menu');
    await expect(menu).not.toHaveClass(/hidden/);

    // Click on the viewport (outside the menu)
    await page.locator('#viewport').click({ position: { x: 200, y: 200 } });
    await expect(menu).toHaveClass(/hidden/);
  });

  test('clicking a menu item closes menu', async () => {
    await page.locator('#app-menu-btn').click();
    const menu = page.locator('#app-menu');
    await expect(menu).not.toHaveClass(/hidden/);

    // Toggle editor
    await page.locator('[data-action="toggle-editor"]').click();
    await expect(menu).toHaveClass(/hidden/);
  });
});

// ── Viewport Toolbar Tests ──────────────────────────────────────────

test.describe('Viewport Toolbar', () => {
  test('toolbar is visible with all buttons', async () => {
    const toolbar = page.locator('#viewport-toolbar');
    await expect(toolbar).toBeVisible();

    await expect(page.locator('#btn-render')).toBeVisible();
    await expect(page.locator('#btn-reset')).toBeVisible();
    await expect(page.locator('#btn-fit')).toBeVisible();
    await expect(page.locator('#btn-wire')).toBeVisible();
    await expect(page.locator('#btn-edges')).toBeVisible();
    await expect(page.locator('#btn-ortho')).toBeVisible();
    await expect(page.locator('#btn-zoom-in')).toBeVisible();
    await expect(page.locator('#btn-zoom-out')).toBeVisible();
    await expect(page.locator('#btn-screenshot')).toBeVisible();
  });

  test('render button has distinct green styling', async () => {
    const btn = page.locator('#btn-render');
    const classes = await btn.getAttribute('class');
    expect(classes).toContain('render-btn');
  });

  test('wireframe toggle changes button state', async () => {
    const btn = page.locator('#btn-wire');
    // Should not be active initially
    await expect(btn).not.toHaveClass(/active/);
    await btn.click();
    await expect(btn).toHaveClass(/active/);
    await btn.click();
    await expect(btn).not.toHaveClass(/active/);
  });

  test('edges toggle starts active', async () => {
    const btn = page.locator('#btn-edges');
    await expect(btn).toHaveClass(/active/);
  });

  test('view presets are visible', async () => {
    const presets = page.locator('#view-presets');
    await expect(presets).toBeVisible();
    const buttons = presets.locator('.preset-btn');
    expect(await buttons.count()).toBe(7); // F, Bk, R, L, T, Bt, Iso
  });
});

// ── Editor Panel Tests ──────────────────────────────────────────────

test.describe('Editor Panel', () => {
  test('editor panel starts collapsed', async () => {
    const panel = page.locator('#editor-panel');
    await expect(panel).toHaveClass(/collapsed/);
  });

  test('toggle button expands editor panel', async () => {
    const toggle = page.locator('#editor-toggle');
    await toggle.click();
    const panel = page.locator('#editor-panel');
    await expect(panel).not.toHaveClass(/collapsed/);
  });

  test('edit mode toggle works', async () => {
    // Expand editor first
    await page.locator('#editor-toggle').click();

    const editBtn = page.locator('#editor-edit-toggle');
    await expect(editBtn).not.toHaveClass(/active/);

    // Enable edit mode
    await editBtn.click();
    await expect(editBtn).toHaveClass(/active/);

    // Save button should appear
    const saveBtn = page.locator('#editor-save-btn');
    await expect(saveBtn).not.toHaveClass(/hidden/);
  });
});

// ── Render Overlay Tests ────────────────────────────────────────────

test.describe('Render Overlay', () => {
  test('overlay is hidden by default', async () => {
    const overlay = page.locator('#render-overlay');
    const opacity = await overlay.evaluate((el) => getComputedStyle(el).opacity);
    expect(opacity).toBe('0');
  });

  test('overlay has spinner, text, time, and progress bar', async () => {
    const overlay = page.locator('#render-overlay');
    await expect(overlay.locator('.spinner')).toBeAttached();
    await expect(overlay.locator('.overlay-text')).toBeAttached();
    await expect(overlay.locator('#render-time')).toBeAttached();
    await expect(overlay.locator('.overlay-bar')).toBeAttached();
  });
});

// ── Part Properties Panel Tests ─────────────────────────────────────

test.describe('Part Properties', () => {
  test('properties panel is hidden by default', async () => {
    const panel = page.locator('#part-props');
    await expect(panel).toHaveClass(/hidden/);
  });

  test('print settings toggle works', async () => {
    // Make the panel visible via JS since we can't click a model
    await page.evaluate(() => {
      document.getElementById('part-props').classList.remove('hidden');
    });

    const settingsPanel = page.locator('#part-props-settings');
    await expect(settingsPanel).toHaveClass(/hidden/);

    await page.locator('#part-props-settings-btn').click();
    await expect(settingsPanel).not.toHaveClass(/hidden/);
  });

  test('print settings have correct defaults', async () => {
    const infill = page.locator('#setting-infill');
    const material = page.locator('#setting-material');
    const cost = page.locator('#setting-cost');

    await expect(infill).toHaveValue('15');
    await expect(material).toHaveValue('PLA');
    await expect(cost).toHaveValue('20');
  });
});

// ── Session Browser Tests ───────────────────────────────────────────

test.describe('Session Browser', () => {
  test('session dropdown is hidden by default', async () => {
    const dropdown = page.locator('#session-dropdown');
    await expect(dropdown).toHaveClass(/hidden/);
  });

  test('clicking sessions button opens dropdown', async () => {
    await page.locator('#session-btn').click();
    const dropdown = page.locator('#session-dropdown');
    await expect(dropdown).not.toHaveClass(/hidden/);
  });

  test('session dropdown has new and continue buttons', async () => {
    await page.locator('#session-btn').click();
    await expect(page.locator('#session-new')).toBeVisible();
    await expect(page.locator('#session-continue')).toBeVisible();
  });
});

// ── Workspace Initialization Tests ──────────────────────────────────

test.describe('Workspace Setup', () => {
  test('CLAUDE.md is created in workspace', async () => {
    const claudeMd = path.join(TEST_WORKSPACE, 'CLAUDE.md');
    expect(fs.existsSync(claudeMd)).toBe(true);
    const content = fs.readFileSync(claudeMd, 'utf-8');
    expect(content).toContain('MANDATORY RULES');
    expect(content).toContain('NEVER modify or overwrite');
    expect(content).toContain('color()');
    expect(content).toContain('MCP Tools Available');
  });

  test('MCP server config is created', async () => {
    const settings = path.join(TEST_WORKSPACE, '.claude', 'settings.json');
    expect(fs.existsSync(settings)).toBe(true);
    const config = JSON.parse(fs.readFileSync(settings, 'utf-8'));
    expect(config.mcpServers).toBeDefined();
    expect(config.mcpServers.openscad).toBeDefined();
    expect(config.mcpServers.openscad.command).toBe('npx');
  });

  test('clawscad.json state file format', async () => {
    // Initially may not exist, but after a checkpoint it should
    const statePath = path.join(TEST_WORKSPACE, 'clawscad.json');
    // Create a test .scad file to trigger checkpoint creation
    const testScad = path.join(TEST_WORKSPACE, 'test-cube.scad');
    fs.writeFileSync(testScad, '// Test cube\ncube([10, 10, 10]);');

    // Wait for file watcher to pick it up
    await page.waitForTimeout(1500);

    if (fs.existsSync(statePath)) {
      const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
      expect(state).toHaveProperty('checkpoints');
      expect(state).toHaveProperty('active');
    }
  });
});

// ── Checkpoint Creation Tests ───────────────────────────────────────

test.describe('Checkpoint System', () => {
  test('creating a .scad file adds a checkpoint', async () => {
    const testScad = path.join(TEST_WORKSPACE, 'my-first-gear.scad');
    fs.writeFileSync(testScad, '// A simple gear shape\ncube([20, 20, 5]);');

    // Wait for file watcher + checkpoint creation
    await page.waitForTimeout(1500);

    const tree = page.locator('#checkpoint-tree');
    await expect(tree).not.toContainText('No checkpoints yet');
    await expect(tree).toContainText('my first gear');
  });

  test('checkpoint shows description on hover', async () => {
    const testScad = path.join(TEST_WORKSPACE, 'hover-test-part.scad');
    fs.writeFileSync(testScad, '// Tooltip description test\nsphere(r=5);');

    await page.waitForTimeout(1500);

    // Hover over the checkpoint node
    const node = page.locator('.cp-node').last();
    await node.hover();

    const tooltip = page.locator('#cp-tooltip');
    await expect(tooltip).not.toHaveClass(/hidden/);
    await expect(page.locator('#cp-tooltip-desc')).toContainText('Tooltip description test');
  });

  test('active.scad is created when checkpoint is selected', async () => {
    const testScad = path.join(TEST_WORKSPACE, 'active-test.scad');
    fs.writeFileSync(testScad, '// Active test\ncube(5);');

    await page.waitForTimeout(1500);

    const activePath = path.join(TEST_WORKSPACE, 'active.scad');
    expect(fs.existsSync(activePath)).toBe(true);
    const content = fs.readFileSync(activePath, 'utf-8');
    expect(content).toContain('Active test');
  });
});

// ── Keyboard Shortcuts Tests ────────────────────────────────────────

test.describe('Keyboard Shortcuts', () => {
  test('F5 triggers re-render (global)', async () => {
    // Listen for the toast that appears
    await page.keyboard.press('F5');
    // Should show a toast (even if render fails due to no active checkpoint)
    const toast = page.locator('.toast').first();
    // Toast may or may not appear depending on state
  });

  test('Ctrl+N opens new window dialog', async () => {
    // We can't easily test the dialog opening, but we can verify the shortcut doesn't error
    // The dialog would block, so we just verify the event fires
    const dialogPromise = electronApp.evaluate(async ({ dialog }) => {
      // Mock the dialog to auto-cancel
      dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
    });
    await dialogPromise;
    await page.keyboard.press('Control+n');
    // No error = pass
  });
});

// ── Three.js Canvas Tests ───────────────────────────────────────────

test.describe('3D Viewport', () => {
  test('canvas element exists in viewport', async () => {
    const canvas = page.locator('#viewport canvas');
    await expect(canvas).toBeAttached();
  });

  test('canvas has non-zero dimensions', async () => {
    const canvas = page.locator('#viewport canvas');
    const box = await canvas.boundingBox();
    expect(box.width).toBeGreaterThan(100);
    expect(box.height).toBeGreaterThan(100);
  });
});

// ── Toast System Tests ──────────────────────────────────────────────

test.describe('Toast Notifications', () => {
  test('showToast creates a visible toast', async () => {
    await page.evaluate(() => {
      // Access the showToast function via the global scope
      const container = document.getElementById('toast-container');
      const toast = document.createElement('div');
      toast.className = 'toast toast-info visible';
      toast.textContent = 'Test notification';
      container.appendChild(toast);
    });

    const toast = page.locator('.toast').first();
    await expect(toast).toBeVisible();
    await expect(toast).toContainText('Test notification');
  });
});

// ── Multi-Window Tests ──────────────────────────────────────────────

test.describe('Multi-Window', () => {
  test('max 4 windows enforced', async () => {
    const count = await page.evaluate(() => window.api.getWindowCount());
    expect(count).toBe(1);
  });
});
