// @ts-check
// The visual confirm gate (P9) — the sheet that asks "is this the thing?"
// before the app spends ten minutes making the wrong one.
// Contract: docs/v04-guided-make-contracts.md §P9.
//
// The gate is driven from page.evaluate through window.clawscadConfirm, which
// mountConfirmGate publishes alongside ctx.confirm (same object, no second
// implementation): `ctx` lives inside the esbuild bundle and is unreachable
// from the page context, and this spec must not depend on P8's UI to open the
// sheet.
//
// One Electron instance is shared by every test here. Each test opens the
// sheet and closes it again, so there is no state to carry — and a dozen
// separate launches on a machine that may be running other Electron specs at
// the same time is the main source of flake in this suite.
//
// userData: the sheet itself writes nothing (asserted below). The one test
// that answers a "what's missing?" question goes through
// ctx.composer.setPrompt(), which is the composer's own persisted state
// (composer-state.json) — the contract directs P9 to use exactly that call —
// so afterAll resets it, matching composer.spec.js's convention.
const { test, expect } = require('@playwright/test');
const { _electron: electron } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { openWorkbench } = require('./helpers');

const APP_PATH = path.join(__dirname, '..');
const TEST_WORKSPACE = path.join(os.tmpdir(), 'clawscad-confirm-test-' + Date.now());

let electronApp;
let page;

test.beforeAll(async () => {
  const { execSync } = require('child_process');
  execSync('npm run build:renderer', { cwd: APP_PATH, stdio: 'pipe' });
  fs.mkdirSync(TEST_WORKSPACE, { recursive: true });

  const app = await electron.launch({
    args: [path.join(APP_PATH, 'main.js'), TEST_WORKSPACE],
    cwd: APP_PATH,
  });
  try {
    page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(1200);
  } catch (err) {
    // Never leak the instance when the window never arrives — an orphaned
    // Electron poisons every later launch on this machine.
    await app.close().catch(() => {});
    throw err;
  }
  electronApp = app;
});

test.beforeEach(async () => {
  await openWorkbench(page);
});

test.afterAll(async () => {
  if (electronApp) {
    try {
      await page.evaluate(() => window.api.composerSetState({}));
    } catch {}
    await electronApp.close();
    electronApp = null;
  }
  try {
    fs.rmSync(TEST_WORKSPACE, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  } catch (err) {
    console.warn(`test workspace cleanup left ${TEST_WORKSPACE}: ${err.code}`);
  }
});

const SCULPT = {
  decision: { route: 'confirm', target: 'sculpt', confirmMode: 'images', missing: [], reasons: [] },
  prompt: 'an owl planter with big round eyes',
  category: { id: 'decor', label: 'Home decor' },
  answers: {},
};

const PHOTO = {
  decision: { route: 'confirm', target: 'part', confirmMode: 'photo', missing: [] },
  prompt: 'the broken knob on my dryer',
  category: { id: 'replacement', label: 'Replacement part' },
  answers: {},
};

/** Opens the sheet and parks the pending promise on window for later reading. */
async function openGate(opts) {
  await page.evaluate((o) => {
    // @ts-ignore — test seam published by mountConfirmGate
    window.__confirmPending = window.clawscadConfirm.open(o);
  }, opts);
  await expect(page.locator('#confirm-sheet')).not.toHaveAttribute('hidden', '');
}

/** Awaits whatever the gate resolved with. */
function gateResult() {
  // @ts-ignore
  return page.evaluate(() => window.__confirmPending);
}

test.describe('confirm gate', () => {
  test('is mounted but invisible at launch, and publishes an open()', async () => {
    await expect(page.locator('#confirm-sheet')).toHaveAttribute('hidden', '');
    await expect(page.locator('.confirm-modal')).toBeHidden();

    const published = await page.evaluate(
      // @ts-ignore
      () => !!(window.clawscadConfirm && typeof window.clawscadConfirm.open === 'function')
    );
    expect(published).toBe(true);
  });

  test('open() shows a modal dialog that echoes the sentence back, in plain English', async () => {
    await openGate(SCULPT);

    const modal = page.locator('.confirm-modal');
    await expect(modal).toBeVisible();
    await expect(modal).toHaveAttribute('role', 'dialog');
    await expect(modal).toHaveAttribute('aria-modal', 'true');

    await expect(page.locator('#confirm-title')).toContainText('right thing');
    await expect(page.locator('#confirm-echo')).toContainText('an owl planter with big round eyes');
    await expect(page.locator('#confirm-primary-btn')).toHaveText('Show me a few options');

    // No jargon anywhere in what the person actually reads.
    const words = (await modal.innerText()).toLowerCase();
    for (const banned of ['pipeline', 'candidate', 'mesh', 'backend', 'target']) {
      expect(words).not.toContain(banned);
    }

    await page.keyboard.press('Escape');
    expect(await gateResult()).toEqual({ proceed: false });
  });

  test('traps focus; Esc resolves {proceed:false} and returns focus to the opener', async () => {
    await page.evaluate(() => document.getElementById('gen-toggle').focus());
    await openGate(SCULPT);

    const inModal = await page.evaluate(
      () => !!(document.activeElement && document.activeElement.closest('.confirm-modal'))
    );
    expect(inModal).toBe(true);

    // Shift+Tab off the first focusable wraps inside the sheet — the trap.
    await page.keyboard.press('Shift+Tab');
    const stillInside = await page.evaluate(
      () => !!(document.activeElement && document.activeElement.closest('.confirm-modal'))
    );
    expect(stillInside).toBe(true);

    await page.keyboard.press('Escape');
    await expect(page.locator('#confirm-sheet')).toHaveAttribute('hidden', '');
    expect(await gateResult()).toEqual({ proceed: false });
    await expect(page.locator('#gen-toggle')).toBeFocused();
  });

  test('"Skip the check" resolves {proceed:true, handled:false}', async () => {
    await openGate(SCULPT);
    await page.locator('#confirm-skip-btn').click();
    await expect(page.locator('#confirm-sheet')).toHaveAttribute('hidden', '');
    expect(await gateResult()).toEqual({ proceed: true, handled: false });
  });

  test('Cancel and the backdrop both resolve {proceed:false}', async () => {
    await openGate(SCULPT);
    await page.locator('#confirm-cancel-btn').click();
    expect(await gateResult()).toEqual({ proceed: false });

    await openGate(SCULPT);
    await page.locator('.confirm-scrim').click({ position: { x: 5, y: 5 } });
    await expect(page.locator('#confirm-sheet')).toHaveAttribute('hidden', '');
    expect(await gateResult()).toEqual({ proceed: false });
  });

  test('a replacement part asks for a photo and offers both exits', async () => {
    await openGate(PHOTO);

    await expect(page.locator('#confirm-title')).toContainText('photo of the real thing');
    await expect(page.locator('#confirm-photo')).toBeVisible();
    await expect(page.locator('#confirm-dropzone')).toBeVisible();
    await expect(page.locator('#confirm-photo-btn')).toHaveText('Choose a photo…');

    // "Use this photo" is the primary, and waits for a photo.
    const primary = page.locator('#confirm-primary-btn');
    await expect(primary).toHaveText('Use this photo');
    await expect(primary).toBeDisabled();

    // The other exit: make it anyway.
    await page.locator('#confirm-nophoto-btn').click();
    await expect(page.locator('#confirm-sheet')).toHaveAttribute('hidden', '');
    expect(await gateResult()).toEqual({ proceed: true, handled: false });
  });

  test('every button stays fully opaque when disabled', async () => {
    // Photo mode parks the primary in its disabled state.
    await openGate(PHOTO);

    const styles = await page.evaluate(() => {
      const out = [];
      for (const el of document.querySelectorAll('.confirm-modal button')) {
        const cs = getComputedStyle(el);
        // @ts-ignore
        out.push({ id: el.id, disabled: el.disabled, opacity: cs.opacity, color: cs.color });
      }
      return out;
    });

    expect(styles.filter((s) => s.disabled).length).toBeGreaterThan(0);
    for (const s of styles) {
      expect(s.opacity).toBe('1');
      // A disabled control is coloured, never invisible.
      expect(s.color).not.toBe('rgba(0, 0, 0, 0)');
    }

    await page.keyboard.press('Escape');
    expect(await gateResult()).toEqual({ proceed: false });
  });

  test('opening it disturbs neither the console nor the Generate panel', async () => {
    const before = await page.evaluate(() => ({
      terminal: document.getElementById('terminal').offsetParent !== null,
      genCollapsed: document.getElementById('gen-panel').classList.contains('collapsed'),
    }));
    expect(before.genCollapsed).toBe(true);

    await openGate(SCULPT);

    const during = await page.evaluate(() => ({
      terminal: document.getElementById('terminal').offsetParent !== null,
      genCollapsed: document.getElementById('gen-panel').classList.contains('collapsed'),
      // @ts-ignore
      genPrompt: document.getElementById('gen-prompt').value,
    }));
    expect(during.terminal).toBe(before.terminal);
    expect(during.genCollapsed).toBe(true);
    // Nothing is dispatched until the person asks for it.
    expect(during.genPrompt).toBe('');

    await page.keyboard.press('Escape');
    expect(await gateResult()).toEqual({ proceed: false });
  });

  test('opening and closing the sheet creates nothing in userData', async () => {
    const userData = await electronApp.evaluate(({ app }) => app.getPath('userData'));
    // Every settings file the app owns is top-level JSON here
    // (composer-state.json, pipeline-settings.json, recent-workspaces.json);
    // the rest of the directory is Chromium's own churn.
    const jsonNames = () =>
      fs
        .readdirSync(userData)
        .filter((f) => f.toLowerCase().endsWith('.json'))
        .sort();
    const before = jsonNames();

    await openGate(SCULPT);
    await page.keyboard.press('Escape');
    expect(await gateResult()).toEqual({ proceed: false });

    await openGate(PHOTO);
    await page.locator('#confirm-skip-btn').click();
    expect(await gateResult()).toEqual({ proceed: true, handled: false });
    await page.waitForTimeout(600); // outlast any debounced write it could have triggered

    expect(jsonNames()).toEqual(before);
    expect(fs.readdirSync(userData).some((f) => /confirm/i.test(f))).toBe(false);
  });

  test('open() with no arguments still opens something usable', async () => {
    await page.evaluate(() => {
      // @ts-ignore
      window.__confirmPending = window.clawscadConfirm.open();
    });
    await expect(page.locator('#confirm-sheet')).not.toHaveAttribute('hidden', '');
    await expect(page.locator('.confirm-modal')).toHaveAttribute('role', 'dialog');
    await page.keyboard.press('Escape');
    expect(await gateResult()).toEqual({ proceed: false });
  });

  test('with no picture maker installed it says why and still offers a photo and a skip', async () => {
    // Read-only probe; the shared Electron profile is normally unconfigured,
    // but say so plainly rather than assert a false negative if it isn't.
    const backends = await page.evaluate(() => window.api.getPipelineBackends());
    test.skip(!!(backends && backends.configured), 'a generation CLI is configured in this profile');

    await openGate(SCULPT);
    await page.locator('#confirm-primary-btn').click();

    await expect(page.locator('#confirm-note')).toContainText('set up yet', { timeout: 5000 });
    await expect(page.locator('#confirm-photo')).toBeVisible();
    await expect(page.locator('#confirm-photo-btn')).toBeEnabled();
    await expect(page.locator('#confirm-skip-btn')).toBeEnabled();

    // Still not a dead end.
    await page.locator('#confirm-skip-btn').click();
    expect(await gateResult()).toEqual({ proceed: true, handled: false });
  });

  test('the questions it could not answer are asked, and the answer joins the description', async () => {
    await page.locator('#composer-prompt').fill('an owl planter with big round eyes');
    await openGate({
      decision: { target: 'sculpt', confirmMode: 'images', missing: ['How big should it be?'] },
      prompt: 'an owl planter with big round eyes',
    });

    await expect(page.locator('#confirm-missing')).toContainText('How big should it be?');
    await page.locator('#confirm-missing-0').fill('about 15 cm tall');
    await page.locator('#confirm-skip-btn').click();

    expect(await gateResult()).toEqual({ proceed: true, handled: false });
    await expect(page.locator('#composer-prompt')).toHaveValue(
      'an owl planter with big round eyes about 15 cm tall'
    );

    // Leave the shared composer state as we found it (see afterAll).
    await page.locator('#composer-prompt').fill('');
  });
});
