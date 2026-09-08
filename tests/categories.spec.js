// @ts-check
// Guided make (P8) — the print-type grid, its guided questions, the plain
// English route note and its single override. Each assertion maps to a line
// in docs/v04-guided-make-contracts.md §P8.
//
// Only this package's own assertions run here. The three .target-btn / chip
// assertions below are NOT duplicates of composer.spec.js and presets.spec.js
// — they exist because P8 demotes those controls visually, and "demoted" must
// never quietly become "hidden".
const { test, expect } = require('@playwright/test');
const { _electron: electron } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { openWorkbench } = require('./helpers');

const APP_PATH = path.join(__dirname, '..');
const TEST_WORKSPACE = path.join(os.tmpdir(), 'clawscad-categories-test-' + Date.now());

// Chromium profile for this spec's own app launches. main.js takes the first
// non-dash argv entry as the workspace (main.js:1799), so a --switch after it
// is passed straight through to Electron and ignored by the app.
//
// Why: every spec in this suite otherwise shares %APPDATA%/Electron, and a
// lingering app from the previous test holds that profile — which is how a
// launch ends up producing a process that never opens a window. Isolating the
// profile also means this spec's composer-state.json writes (P8 persists
// { categoryId, answers } through setGuidedState) can never reach a sibling
// spec at all. The shared profile is still reset in afterAll regardless.
const TEST_PROFILE = path.join(os.tmpdir(), 'clawscad-categories-profile-' + Date.now());

const BOOT_MS = 1400; // categories:load + presets:load + the composer's own async state restore

let electronApp;
let page;

async function launch() {
  const app = await electron.launch({
    args: [path.join(APP_PATH, 'main.js'), TEST_WORKSPACE, `--user-data-dir=${TEST_PROFILE}`],
    cwd: APP_PATH,
  });
  const p = await app.firstWindow();
  await p.waitForLoadState('domcontentloaded');
  await p.waitForTimeout(BOOT_MS);
  await openWorkbench(p);
  // The grid is what every test below reads, and it mounts LAST (after
  // categories:load resolves). Waiting on it here means a slow boot reads as
  // a slow boot rather than as a missing tile in whichever test ran first.
  await p.waitForSelector('#category-grid .category-tile[aria-checked="true"]');
  return { app, p };
}

// P8 writes { categoryId, answers } into composer-state.json (via the
// composer's setGuidedState) in the SHARED Electron userData profile. Left
// behind, a persisted category would set another spec's target at boot — so
// it is cleared after every test, not just at the end of the file. The
// double write straddles the composer's own 250 ms debounce.
async function resetComposerState(p) {
  if (!p) return;
  try {
    await p.evaluate(() => window.api.composerSetState({}));
    await p.waitForTimeout(320);
    await p.evaluate(() => window.api.composerSetState({}));
  } catch {
    /* window already gone — the afterAll cleanup pass still runs */
  }
}

test.beforeAll(async () => {
  const { execSync } = require('child_process');
  execSync('npm run build:renderer', { cwd: APP_PATH, stdio: 'pipe' });
  fs.mkdirSync(TEST_WORKSPACE, { recursive: true });
});

test.beforeEach(async () => {
  const launched = await launch();
  electronApp = launched.app;
  page = launched.p;
});

test.afterEach(async () => {
  await resetComposerState(page);
  if (electronApp) await electronApp.close();
});

test.afterAll(async () => {
  // The same reset composer.spec.js does, on the SHARED profile — this spec's
  // own writes land in TEST_PROFILE and never reach it, but the reset stays
  // so a future change that drops the isolation can't silently poison a
  // sibling spec.
  const cleanupApp = await electron.launch({
    args: [path.join(APP_PATH, 'main.js'), TEST_WORKSPACE],
    cwd: APP_PATH,
  });
  const cleanupPage = await cleanupApp.firstWindow();
  await cleanupPage.evaluate(() => window.api.composerSetState({}));
  await cleanupApp.close();

  for (const dir of [TEST_WORKSPACE, TEST_PROFILE]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
    } catch (err) {
      console.warn(`test cleanup left ${dir}: ${err.code}`);
    }
  }
});

test.describe('Guided make — the print-type grid', () => {
  test('renders 10 tiles with exactly one selected at launch', async () => {
    const tiles = page.locator('.category-tile');
    await expect(tiles).toHaveCount(10);
    const checked = page.locator('.category-tile[aria-checked="true"]');
    await expect(checked).toHaveCount(1);
    await expect(checked).toHaveAttribute('data-category', 'hardware');
  });

  test('is a radiogroup of radios with one tab stop and a hint on every tile', async () => {
    const grid = page.locator('#category-grid');
    await expect(grid).toHaveAttribute('role', 'radiogroup');
    await expect(grid).toHaveAttribute('aria-label', 'What are you making');

    await expect(page.locator('#category-grid [role="radio"]')).toHaveCount(10);
    await expect(page.locator('.category-tile[tabindex="0"]')).toHaveCount(1);

    const withTitle = page.locator('.category-tile[title]');
    await expect(withTitle).toHaveCount(10);
    // Glyph + short label, per tile.
    await expect(page.locator('.category-tile .category-glyph')).toHaveCount(10);
    await expect(page.locator('.category-tile .category-label')).toHaveCount(10);
  });

  test('asks the question in plain words, with no jargon anywhere in the guided chrome', async () => {
    await expect(page.locator('#category-heading')).toHaveText('What are you making?');

    const copy = await page.evaluate(() => {
      const parts = [
        '#category-heading',
        '#category-grid',
        '#category-ask',
        '.route-note-override',
        '.guided-caption',
      ];
      return parts
        .map((sel) => Array.from(document.querySelectorAll(sel)).map((el) => el.textContent || '').join(' '))
        .join(' ');
    });
    for (const word of ['target', 'pipeline', 'preset', 'parametric', 'mesh', 'route']) {
      expect(copy.toLowerCase()).not.toContain(word);
    }
  });

  test('arrow keys move within the grid and Home/End jump', async () => {
    await page.locator('.category-tile[aria-checked="true"]').focus();

    await page.keyboard.press('ArrowRight');
    await expect(page.locator('.category-tile[data-category="bracket"]')).toHaveAttribute('aria-checked', 'true');

    await page.keyboard.press('ArrowDown'); // + one row of three
    await expect(page.locator('.category-tile[data-category="structural"]')).toHaveAttribute('aria-checked', 'true');

    await page.keyboard.press('ArrowUp');
    await expect(page.locator('.category-tile[data-category="bracket"]')).toHaveAttribute('aria-checked', 'true');

    await page.keyboard.press('End');
    await expect(page.locator('.category-tile[data-category="other"]')).toHaveAttribute('aria-checked', 'true');

    await page.keyboard.press('Home');
    await expect(page.locator('.category-tile[data-category="hardware"]')).toHaveAttribute('aria-checked', 'true');

    // Still exactly one selection and exactly one tab stop after all that.
    await expect(page.locator('.category-tile[aria-checked="true"]')).toHaveCount(1);
    await expect(page.locator('.category-tile[tabindex="0"]')).toHaveCount(1);
  });
});

test.describe('Guided make — what a print type sets for you', () => {
  test('picking "Models & figures" switches what gets made to Sculpt', async () => {
    await page.locator('.category-tile[data-category="model"]').click();
    await expect(page.locator('.target-btn[data-target="sculpt"]')).toHaveAttribute('aria-checked', 'true');
    await expect(page.locator('.target-btn[aria-checked="true"]')).toHaveCount(1);
  });

  test('picking "Screws & hardware" turns on the Fits hardware chip', async () => {
    await page.locator('.category-tile[data-category="hardware"]').click();
    await expect(
      page.locator('#preset-chip-row .preset-chip[data-preset-id="fits-hardware"]')
    ).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.target-btn[data-target="part"]')).toHaveAttribute('aria-checked', 'true');
  });

  test('the prompt survives a category change', async () => {
    // The same proof-assertion composer.spec.js makes for the Output row:
    // choosing a print type is a mode WITHIN the composer, never a reset.
    const promptEl = page.locator('#composer-prompt');
    await promptEl.fill('a 40mm cable clip');

    await page.locator('.category-tile[data-category="model"]').click();
    await expect(page.locator('.category-tile[data-category="model"]')).toHaveAttribute('aria-checked', 'true');
    await expect(promptEl).toHaveValue('a 40mm cable clip');

    await page.locator('.category-tile[data-category="decor"]').click();
    await expect(promptEl).toHaveValue('a 40mm cable clip');

    await page.locator('.category-tile[data-category="hardware"]').click();
    await expect(promptEl).toHaveValue('a 40mm cable clip');
  });

  test('the prompt placeholder becomes the category’s own example', async () => {
    await page.locator('.category-tile[data-category="model"]').click();
    const placeholder = await page.locator('#composer-prompt').getAttribute('placeholder');
    expect(placeholder).toBe('A squat dragon curled around an egg');
  });

  test('the chosen print type survives a relaunch', async () => {
    await page.locator('.category-tile[data-category="enclosure"]').click();
    await page.waitForTimeout(500); // the composer debounces its state write

    await electronApp.close();
    const relaunched = await launch();
    electronApp = relaunched.app;
    page = relaunched.p;

    await expect(page.locator('.category-tile[data-category="enclosure"]')).toHaveAttribute('aria-checked', 'true');
    await expect(page.locator('.category-tile[aria-checked="true"]')).toHaveCount(1);
  });
});

test.describe('Guided make — the guided questions', () => {
  test('renders the selected type’s own fields, each with a blank first choice', async () => {
    await page.locator('.category-tile[data-category="hardware"]').click();
    await expect(page.locator('#category-ask .category-ask-field')).toHaveCount(3);
    await expect(page.locator('#category-ask [data-ask-id="thread"]')).toHaveCount(1);

    const firstOption = page.locator('#category-ask select[data-ask-id="thread"] option').first();
    await expect(firstOption).toHaveText('—');
    await expect(firstOption).toHaveAttribute('value', '');

    // A different type asks different questions.
    await page.locator('.category-tile[data-category="model"]').click();
    await expect(page.locator('#category-ask .category-ask-field')).toHaveCount(2);
    await expect(page.locator('#category-ask [data-ask-id="height"]')).toHaveCount(1);
  });

  test('nothing in the guided questions is ever required', async () => {
    await page.locator('.category-tile[data-category="hardware"]').click();
    await page.locator('#composer-prompt').fill('a spacer that lifts a board off a panel');
    await expect(page.locator('#composer-submit')).toBeEnabled();
  });

  test('answered fields reach what Claude will read, unanswered ones do not', async () => {
    await page.locator('.category-tile[data-category="hardware"]').click();
    await page.locator('#composer-prompt').fill('a standoff');
    await page.locator('#category-ask select[data-ask-id="thread"]').selectOption('M4');
    await page.locator('#category-ask input[data-ask-id="length"]').fill('20');

    await page.locator('#composer-preamble summary').click();
    const body = page.locator('#composer-preamble-body');
    await expect(body).toContainText('CATEGORY: SCREWS & HARDWARE.');
    await expect(body).toContainText('Thread: M4');
    await expect(body).toContainText('Length: 20 mm');
    await expect(body).toContainText('a standoff');
    await expect(body).not.toContainText('Head:'); // untouched, so never invented
  });

  test('the category section contributes text only, with nothing of its own on screen', async () => {
    const section = page.locator('#composer-sections [data-section-id="category"]');
    await expect(section).toHaveCount(1);
    await expect(section).toHaveAttribute('hidden', '');
  });
});

test.describe('Guided make — the note that says what will happen', () => {
  test('is a polite status line whose words change with the print type', async () => {
    const note = page.locator('#route-note');
    await expect(note).toHaveAttribute('role', 'status');
    await expect(note).toHaveAttribute('aria-live', 'polite');

    await page.locator('.category-tile[data-category="hardware"]').click();
    const straightThrough = (await note.innerText()).trim();
    expect(straightThrough.length).toBeGreaterThan(0);

    await page.locator('.category-tile[data-category="model"]').click();
    const checkFirst = (await note.innerText()).trim();
    expect(checkFirst.length).toBeGreaterThan(0);
    expect(checkFirst).not.toBe(straightThrough);
  });

  test('offers exactly one override, and it flips the decision', async () => {
    await page.locator('.category-tile[data-category="hardware"]').click();
    const override = page.locator('#route-note .route-note-override');
    await expect(override).toHaveCount(1);
    await expect(override).toBeVisible();
    await expect(override).toHaveText('Show me options first');

    const before = (await page.locator('.route-note-text').innerText()).trim();
    await override.click();

    await expect(override).toHaveText('Skip the check, just make it');
    await expect(page.locator('.route-note-flag')).toBeVisible();
    const after = (await page.locator('.route-note-text').innerText()).trim();
    expect(after).not.toBe(before);
  });

  test('the override is forgotten when the print type changes', async () => {
    await page.locator('.category-tile[data-category="hardware"]').click();
    const override = page.locator('#route-note .route-note-override');
    await override.click();
    await expect(override).toHaveText('Skip the check, just make it');

    await page.locator('.category-tile[data-category="structural"]').click();
    await expect(override).toHaveText('Show me options first');
    await expect(page.locator('.route-note-flag')).toBeHidden();
  });

  test('publishes a live decision that never goes stale', async () => {
    await page.locator('.category-tile[data-category="model"]').click();
    const decision = await page.evaluate(() => window.clawscadGuided.getDecision());
    expect(decision.route).toBe('confirm');
    expect(decision.target).toBe('sculpt');

    const category = await page.evaluate(() => window.clawscadGuided.getCategory().id);
    expect(category).toBe('model');

    await page.evaluate(() => window.clawscadGuided.setCategory('hardware'));
    const after = await page.evaluate(() => window.clawscadGuided.getDecision());
    expect(after.route).toBe('direct');
    expect(after.target).toBe('part');
    const answers = await page.evaluate(() => window.clawscadGuided.getAnswers());
    expect(typeof answers).toBe('object');
  });
});

test.describe('Guided make — nothing it demotes is hidden', () => {
  test('all three Output buttons stay visible and clickable with the grid present', async () => {
    await expect(page.locator('#category-grid')).toBeVisible();

    const targets = page.locator('.target-btn');
    await expect(targets).toHaveCount(3);
    for (const id of ['part', 'sculpt', 'image']) {
      const btn = page.locator(`.target-btn[data-target="${id}"]`);
      await expect(btn).toBeVisible();
      await expect(btn).toBeEnabled();
      const box = await btn.boundingBox();
      expect(box && box.height).toBeGreaterThan(12);
      expect(box && box.width).toBeGreaterThan(24);
    }

    await page.locator('.target-btn[data-target="image"]').click();
    await expect(page.locator('.target-btn[data-target="image"]')).toHaveAttribute('aria-checked', 'true');
  });

  test('the fine-tune chips and the printer row stay visible and clickable', async () => {
    await expect(page.locator('#preset-chip-row')).toBeVisible();
    await expect(page.locator('#preset-chip-row .preset-chip')).toHaveCount(5);
    await expect(page.locator('#preset-modifier-row')).toBeVisible();

    const chip = page.locator('#preset-chip-row .preset-chip[data-preset-id="miniature"]');
    await chip.click();
    await expect(chip).toHaveAttribute('aria-pressed', 'true');
  });

  test('#terminal is still visible and #gen-panel is still collapsed at boot', async () => {
    await expect(page.locator('#terminal')).toBeVisible();
    await expect(page.locator('#gen-panel')).toHaveClass(/collapsed/);
  });

  test('every guided control is fully opaque, and no tile is ever disabled', async () => {
    const opacities = await page.evaluate(() =>
      Array.from(document.querySelectorAll('#composer-guided button, #composer-guided input, #composer-guided select')).map(
        (el) => ({ tag: el.tagName, disabled: !!el.disabled, opacity: getComputedStyle(el).opacity })
      )
    );
    expect(opacities.length).toBeGreaterThan(10);
    for (const rec of opacities) expect(rec.opacity).toBe('1');
    for (const rec of await page.evaluate(() =>
      Array.from(document.querySelectorAll('.category-tile')).map((el) => !!el.disabled)
    )) {
      expect(rec).toBe(false);
    }

    // The submit button is the one guided-adjacent control that IS disabled
    // at boot; it must be coloured, not faded.
    await page.locator('#composer-prompt').fill('');
    const submitBtn = page.locator('#composer-submit');
    await expect(submitBtn).toBeDisabled();
    expect(await submitBtn.evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
  });
});
