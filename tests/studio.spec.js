// @ts-check
// The v0.6 Studio (S4) — the full-window dashboard that is now the front door.
// Every assertion below maps to a line in docs/v06-studio-contracts.md §S4,
// and only to selectors from that document's shared DOM inventory. Nothing
// here asserts markup the contract does not freeze: an over-specified spec
// fails on a legitimate implementation choice and costs more than it catches.
//
// The studio is driven from page.evaluate through window.clawscadStudio, which
// mountStudio publishes alongside ctx.studio (the SAME object, not a second
// implementation — the v0.4 test-seam correction, §S1 "Published interface"):
// `ctx` lives inside the esbuild bundle and is unreachable from the page
// context. The handle is used only where clicking would be brittle — setting a
// tool field, reading `enabled` — and every claim it makes is cross-checked
// against the DOM. A test that only proves the handle agrees with itself
// proves nothing.
//
// LAUNCH MODEL: one Electron app per test, like categories.spec.js. The studio
// persists `view` as well as its own state, so a test that leaves the app in
// Workbench would change what "first run" means for the next one. A fresh
// launch against a state file cleared in afterEach is the only way each test
// starts from the documented first-run state.
//
// userData: the studio persists through ctx.api.composerSetState under a
// `studio` key, into composer-state.json (§S1 "State"; standing rule 5 —
// "any new userData write must be reset in the owning spec's afterAll"). It is
// cleared after EVERY test, not just at the end, and the file itself is
// removed in afterAll. composerSetState({}) is a whole-file clear by design
// (main/composer.js mergeState) — anything non-empty would merge.
//
// The Electron profile is keyed on the workspace basename (see the
// CLAWSCAD_TEST_PROFILE_ROOT block in main.js), so TEST_WORKSPACE being unique
// to this run means this spec's writes can never reach a sibling spec — and
// reusing the SAME workspace across the relaunch in the persistence test is
// what makes that test see the profile it just wrote.
const { test, expect } = require('@playwright/test');
const { _electron: electron } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const os = require('os');

const APP_PATH = path.join(__dirname, '..');
const TEST_WORKSPACE = path.join(os.tmpdir(), 'clawscad-studio-test-' + Date.now());

// categories:load + presets:load + tools:load + the composer's async state
// restore, and mountStudio runs last of all (renderer.js, after mountGuided).
const BOOT_MS = 1600;

let electronApp;
let page;
let userDataDir = '';

/** #studio-tool-fields panel for one tool. */
function panel(toolId) {
  return page.locator(`#studio-tool-fields .studio-tool-panel[data-tool-id="${toolId}"]`);
}

/** The chip for one tool, if it has one. */
function chip(toolId) {
  return page.locator(`#studio-chips .studio-chip[data-tool-id="${toolId}"]`);
}

/** A print-type tile. */
function tile(categoryId) {
  return page.locator(`#studio-types .studio-type[data-category="${categoryId}"]`);
}

async function launch() {
  const app = await electron.launch({
    args: [path.join(APP_PATH, 'main.js'), TEST_WORKSPACE],
    cwd: APP_PATH,
  });
  try {
    const p = await app.firstWindow();
    await p.waitForLoadState('domcontentloaded');
    await p.waitForTimeout(BOOT_MS);
    // The real readiness signal: mountStudio publishes the handle at the end
    // of its own mount, so this waits out a slow tools:load rather than
    // reading a half-built view as a missing element.
    await p.waitForFunction(() => !!window.clawscadStudio, null, { timeout: 20000 });
    // `attached`, not `visible`: the relaunch in the persistence test reopens
    // in Workbench, where the studio is built but not showing.
    await p.waitForSelector('#studio-console', { state: 'attached' });
    await p.waitForSelector('#studio-types .studio-type', { state: 'attached' });
    if (!userDataDir) userDataDir = await app.evaluate(({ app: a }) => a.getPath('userData'));
    return { app, p };
  } catch (err) {
    // Never leak the instance when the window never arrives — an orphaned
    // Electron poisons every later launch on this machine.
    await app.close().catch(() => {});
    throw err;
  }
}

/** Clears composer-state.json, which is where the studio's `studio` key lives.
 *  Written twice around the persist debounce, the way categories.spec.js does:
 *  a single clear can be immediately overwritten by a write already in flight. */
async function resetStudioState(p) {
  if (!p) return;
  try {
    await p.evaluate(() => window.api.composerSetState({}));
    await p.waitForTimeout(400);
    await p.evaluate(() => window.api.composerSetState({}));
  } catch {
    /* window already gone — the afterAll file removal still runs */
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
  await resetStudioState(page);
  if (electronApp) await electronApp.close();
  electronApp = null;
});

test.afterAll(async () => {
  // Standing rule 5. The in-app clear above is the primary reset; this removes
  // the file outright in case the last app died before its clear landed.
  // Guarded to the temp profile this run created: without
  // CLAWSCAD_TEST_PROFILE_ROOT the app uses the real %APPDATA% profile, and a
  // spec has no business deleting a user's state file.
  try {
    const tmp = fs.realpathSync(os.tmpdir()).toLowerCase();
    if (userDataDir && fs.realpathSync(userDataDir).toLowerCase().startsWith(tmp)) {
      fs.rmSync(path.join(userDataDir, 'composer-state.json'), { force: true });
    }
  } catch (err) {
    console.warn(`studio spec left composer-state.json in ${userDataDir}: ${err.code}`);
  }
  try {
    fs.rmSync(TEST_WORKSPACE, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  } catch (err) {
    console.warn(`test workspace cleanup left ${TEST_WORKSPACE}: ${err.code}`);
  }
});

test.describe('Studio — the front door', () => {
  test('is the view on first run, and the workbench is not showing', async () => {
    await expect(page.locator('#studio')).toBeVisible();
    await expect(page.locator('#main-content')).toBeHidden();

    await expect(page.locator('#view-studio')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#view-workbench')).toHaveAttribute('aria-selected', 'false');

    // The scroll container and the console card are the two structural
    // guarantees the whole inventory hangs off.
    await expect(page.locator('#studio-scroll')).toBeVisible();
    await expect(page.locator('#studio-console')).toBeVisible();
    await expect(page.locator('#studio-title')).not.toBeEmpty();
  });

  test('publishes the documented test seam, and it agrees with the DOM', async () => {
    const methods = await page.evaluate(() => {
      const s = window.clawscadStudio;
      if (!s) return null;
      const names = [];
      for (const key in s) if (typeof s[key] === 'function') names.push(key);
      return names.sort();
    });
    expect(methods).not.toBe(null);
    for (const name of [
      'show',
      'hide',
      'isVisible',
      'getState',
      'setCategory',
      'setPrompt',
      'enableTool',
      'disableTool',
      'setToolValue',
      'setPreviewMode',
      'getDecision',
      'submit',
    ]) {
      expect(methods).toContain(name);
    }

    // The handle is only worth driving if it reports the same world the DOM
    // shows. Check both directions rather than taking its word for it.
    expect(await page.evaluate(() => window.clawscadStudio.isVisible())).toBe(true);
    await page.locator('#view-workbench').click();
    await expect(page.locator('#studio')).toBeHidden();
    expect(await page.evaluate(() => window.clawscadStudio.isVisible())).toBe(false);
  });

  test('offers ten print types as a radiogroup with exactly one chosen', async () => {
    await expect(page.locator('#studio-types')).toHaveAttribute('role', 'radiogroup');

    const tiles = page.locator('#studio-types .studio-type');
    await expect(tiles).toHaveCount(10);
    await expect(page.locator('#studio-types [role="radio"]')).toHaveCount(10);
    await expect(page.locator('#studio-types .studio-type[aria-checked="true"]')).toHaveCount(1);

    // Ten distinct types, each naming its own category.
    const ids = await tiles.evaluateAll((els) => els.map((el) => el.getAttribute('data-category')));
    expect(ids.filter(Boolean).length).toBe(10);
    expect(new Set(ids).size).toBe(10);
  });

  test('the view switch moves both ways, and the composer is reachable in Workbench', async () => {
    await page.locator('#view-workbench').click();
    await expect(page.locator('#main-content')).toBeVisible();
    await expect(page.locator('#studio')).toBeHidden();
    await expect(page.locator('#view-workbench')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#view-studio')).toHaveAttribute('aria-selected', 'false');

    // The switch is never modal: the workbench is the whole v0.5 app, intact.
    await expect(page.locator('#composer-prompt')).toBeVisible();
    await expect(page.locator('#composer-prompt')).toBeEditable();
    await expect(page.locator('#terminal')).toBeVisible();

    await page.locator('#view-studio').click();
    await expect(page.locator('#studio')).toBeVisible();
    await expect(page.locator('#main-content')).toBeHidden();
    await expect(page.locator('#view-studio')).toHaveAttribute('aria-selected', 'true');
  });
});

test.describe('Studio — the prompt and the one button', () => {
  test('submit is disabled and says something else until there is a sentence', async () => {
    const prompt = page.locator('#studio-prompt');
    const submit = page.locator('#studio-submit');

    await prompt.fill('');
    await expect(submit).toBeDisabled();
    const waiting = (await submit.innerText()).trim();
    expect(waiting.length).toBeGreaterThan(0);

    await prompt.fill('a 40 mm cable clip that screws to a wall');
    await expect(submit).toBeEnabled();
    const ready = (await submit.innerText()).trim();
    expect(ready.length).toBeGreaterThan(0);
    // A button that reads "Make it" while it cannot be pressed is a lie about
    // why nothing happened.
    expect(ready).not.toBe(waiting);

    // ...and it goes back when the sentence does.
    await prompt.fill('');
    await expect(submit).toBeDisabled();
  });
});

test.describe('Studio — tools', () => {
  test('picking a print type switches that type’s own tools on', async () => {
    // Models & figures auto-switches Style (presets/tools.json: style.auto).
    await tile('model').click();
    await expect(tile('model')).toHaveAttribute('aria-checked', 'true');
    await expect(panel('style')).toHaveCount(1);

    // Screws & hardware auto-switches Dimensions and Hardware.
    await tile('hardware').click();
    await expect(tile('hardware')).toHaveAttribute('aria-checked', 'true');
    await expect(panel('dimensions')).toHaveCount(1);
    await expect(panel('hardware')).toHaveCount(1);

    const enabled = await page.evaluate(() => window.clawscadStudio.getState().enabled);
    expect(Array.isArray(enabled)).toBe(true);
    for (const id of ['dimensions', 'hardware']) expect(enabled).toContain(id);

    // Material is offered on every type and switched on automatically by none
    // of them (its `auto` is empty) — so this is "that type's tools", not
    // "every tool".
    await expect(panel('material')).toHaveCount(0);
    expect(enabled).not.toContain('material');
  });

  test('the tools menu is a checkable menu, and switching one on adds its panel', async () => {
    await tile('hardware').click();

    const btn = page.locator('#studio-tools-btn');
    const menu = page.locator('#studio-tools-menu');
    await expect(btn).toHaveAttribute('aria-haspopup', 'menu');
    await expect(btn).toHaveAttribute('aria-expanded', 'false');
    await expect(menu).toHaveAttribute('hidden', '');

    await btn.click();
    await expect(btn).toHaveAttribute('aria-expanded', 'true');
    await expect(menu).not.toHaveAttribute('hidden', '');
    await expect(menu).toHaveAttribute('role', 'menu');

    // Grouped, and every entry is a checkable menu item.
    expect(await menu.locator('.studio-tools-group-label').count()).toBeGreaterThan(0);
    const options = menu.locator('.studio-tool-option');
    expect(await options.count()).toBeGreaterThan(1);
    expect(await menu.locator('.studio-tool-option[role="menuitemcheckbox"]').count()).toBe(
      await options.count()
    );

    const material = menu.locator('.studio-tool-option[data-tool-id="material"]');
    await expect(material).toHaveAttribute('aria-checked', 'false');
    await material.click();
    await expect(material).toHaveAttribute('aria-checked', 'true');
    await expect(panel('material')).toHaveCount(1);
  });

  // Contract correction, made at integration. §S4 asked for BOTH "selecting a
  // type auto-enables that type's tools as chips" AND "a tool with no values
  // adds no chip". Only 3 of the 13 tools declare field defaults, so those two
  // clauses cannot both hold — under the second one, picking "Models & figures"
  // would show zero chips despite having switched a tool on, and the chip row
  // would silently disagree with the panels below it.
  //
  // Resolved in favour of one chip per ENABLED tool, carrying compile()'s skip
  // reason while it is still empty. The chip row is the "what am I about to
  // send" summary, and a tool you switched on and haven't filled in is exactly
  // what that summary should be nagging you about. So the empty chip is
  // asserted here rather than its absence.
  test('an enabled tool always has a chip; filling it in gives the chip its value, and removing it removes both', async () => {
    await tile('hardware').click();

    // "Text & engraving": part-track, declares no field defaults, and is never
    // switched on automatically — so it is provably empty the moment it is on.
    await page.evaluate(() => window.clawscadStudio.enableTool('text'));
    await expect(panel('text')).toHaveCount(1);
    await expect(chip('text')).toHaveCount(1);
    // Empty, and saying so rather than showing a blank chip.
    expect((await chip('text').innerText()).trim().length).toBeGreaterThan(0);
    await expect(chip('text').locator('.studio-chip-text')).not.toContainText('WORKSHOP');

    await page.evaluate(() => window.clawscadStudio.setToolValue('text', 'text', 'WORKSHOP'));
    await expect(chip('text')).toHaveCount(1);
    await expect(chip('text').locator('.studio-chip-text')).toContainText('WORKSHOP');
    expect((await chip('text').locator('.studio-chip-label').innerText()).trim().length).toBeGreaterThan(0);

    await chip('text').locator('.studio-chip-remove').click();
    await expect(chip('text')).toHaveCount(0);
    await expect(panel('text')).toHaveCount(0);
    expect(await page.evaluate(() => window.clawscadStudio.getState().enabled)).not.toContain('text');
  });
});

test.describe('Studio — the preview switch and the route note', () => {
  test('cycles auto → on → off → auto, with data-mode and aria-checked together', async () => {
    const toggle = page.locator('#studio-preview-toggle');
    await expect(toggle).toHaveAttribute('role', 'switch');
    await expect(toggle).toHaveAttribute('data-mode', 'auto');

    await toggle.click();
    await expect(toggle).toHaveAttribute('data-mode', 'on');
    await expect(toggle).toHaveAttribute('aria-checked', 'true');

    await toggle.click();
    await expect(toggle).toHaveAttribute('data-mode', 'off');
    await expect(toggle).toHaveAttribute('aria-checked', 'false');

    await toggle.click();
    await expect(toggle).toHaveAttribute('data-mode', 'auto');
  });

  test('in auto it mirrors the router, and leaving auto changes what the route note says', async () => {
    const toggle = page.locator('#studio-preview-toggle');

    // Screws & hardware is route:"direct" in categories.json — forced, so this
    // does not depend on what is in the prompt box.
    await tile('hardware').click();
    await expect(toggle).toHaveAttribute('data-mode', 'auto');
    await expect(toggle).toHaveAttribute('aria-checked', 'false');

    // Models & figures is route:"confirm", confirm:"images" — previewFirst.
    await tile('model').click();
    await expect(toggle).toHaveAttribute('data-mode', 'auto');
    await expect(toggle).toHaveAttribute('aria-checked', 'true');

    // The note tracks the switch: a deliberate choice is explained, and offers
    // its way back to automatic.
    await tile('hardware').click();
    const onAuto = (await page.locator('#studio-route').innerText()).trim();
    expect(onAuto.length).toBeGreaterThan(0);

    await toggle.click(); // on
    await expect(toggle).toHaveAttribute('data-mode', 'on');
    const onOn = (await page.locator('#studio-route').innerText()).trim();
    expect(onOn).not.toBe(onAuto);

    await toggle.click(); // off
    await expect(toggle).toHaveAttribute('data-mode', 'off');
    const onOff = (await page.locator('#studio-route').innerText()).trim();
    expect(onOff).not.toBe(onAuto);
    expect(onOff).not.toBe(onOn);
  });

  test('the route note is a live status whose words differ for a direct and a check-first type', async () => {
    const note = page.locator('#studio-route');
    await expect(note).toHaveAttribute('role', 'status');
    await expect(note).toHaveAttribute('aria-live', 'polite');

    await tile('hardware').click();
    const direct = (await page.locator('#studio-route-text').innerText()).trim();
    expect(direct.length).toBeGreaterThan(0);

    await tile('model').click();
    const confirm = (await page.locator('#studio-route-text').innerText()).trim();
    expect(confirm.length).toBeGreaterThan(0);
    expect(confirm).not.toBe(direct);

    // Never a black box: the decision is shown, and it is overridable.
    await expect(page.locator('#studio-route-override')).toHaveCount(1);
  });
});

test.describe('Studio — what it remembers', () => {
  test('type, sentence, tools, preview mode and view all survive a relaunch', async () => {
    await tile('enclosure').click();
    await expect(tile('enclosure')).toHaveAttribute('aria-checked', 'true');

    await page.locator('#studio-prompt').fill('a vented box for a raspberry pi');

    await page.evaluate(() => {
      window.clawscadStudio.enableTool('text');
      window.clawscadStudio.setToolValue('text', 'text', 'WORKSHOP');
    });
    await expect(chip('text')).toHaveCount(1);

    const toggle = page.locator('#studio-preview-toggle');
    await toggle.click();
    await toggle.click();
    await expect(toggle).toHaveAttribute('data-mode', 'off');

    // The app reopens where you left it, so leave it somewhere.
    await page.locator('#view-workbench').click();
    await expect(page.locator('#main-content')).toBeVisible();
    await page.waitForTimeout(1000); // outlast the persist debounce

    await electronApp.close();
    const relaunched = await launch();
    electronApp = relaunched.app;
    page = relaunched.p;

    // view
    await expect(page.locator('#view-workbench')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#main-content')).toBeVisible();
    await expect(page.locator('#studio')).toBeHidden();

    await page.locator('#view-studio').click();
    await expect(page.locator('#studio')).toBeVisible();

    // category
    await expect(tile('enclosure')).toHaveAttribute('aria-checked', 'true');
    await expect(page.locator('#studio-types .studio-type[aria-checked="true"]')).toHaveCount(1);
    // prompt
    await expect(page.locator('#studio-prompt')).toHaveValue('a vented box for a raspberry pi');
    // enabled tools, and the values that make them worth anything
    await expect(panel('text')).toHaveCount(1);
    await expect(chip('text')).toHaveCount(1);
    await expect(chip('text').locator('.studio-chip-text')).toContainText('WORKSHOP');
    // preview mode
    await expect(page.locator('#studio-preview-toggle')).toHaveAttribute('data-mode', 'off');
  });
});

test.describe('Studio — standing rules', () => {
  test('every studio control is fully opaque when disabled', async () => {
    // An empty prompt parks #studio-submit in its disabled state.
    await page.locator('#studio-prompt').fill('');
    await expect(page.locator('#studio-submit')).toBeDisabled();

    const controls = await page.evaluate(() => {
      const out = [];
      const nodes = document.querySelectorAll(
        '#studio button, #studio input, #studio select, #studio textarea'
      );
      for (const el of nodes) {
        // Only what is actually on screen: a collapsed menu or the hidden
        // stage may legitimately be mid-transition, and the rule is about what
        // a person can see.
        if (!el.getClientRects().length) continue;
        const cs = getComputedStyle(el);
        out.push({
          id: el.id || el.className || el.tagName,
          // @ts-ignore — every tag in the list carries `disabled`
          disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true',
          opacity: cs.opacity,
          color: cs.color,
        });
      }
      return out;
    });

    expect(controls.length).toBeGreaterThan(10);
    expect(controls.filter((c) => c.disabled).length).toBeGreaterThan(0);
    for (const c of controls) {
      // opacity:.4 on an already-3.5:1 label lands at about 1.6:1. A disabled
      // control is coloured differently, never faded.
      expect(c.opacity, `${c.id} is faded`).toBe('1');
      expect(c.color, `${c.id} is invisible`).not.toBe('rgba(0, 0, 0, 0)');
    }
  });

  test('the studio registers no window.api.on* handler of its own, and mounts once', async () => {
    // Standing rule 3. window.api's on* registrars are bare ipcRenderer.on
    // calls with no unsubscribe (preload.js), so a second registration stacks
    // handlers silently and forever; feature modules subscribe through the
    // ctx.onPipelineEvent / ctx.onCheckpointsChanged fan-outs in renderer/bus.js
    // instead. This is checked at the source, because the registrations all
    // happen during boot and nothing observable survives to count afterwards.
    const source = fs.readFileSync(path.join(APP_PATH, 'renderer', 'studio.js'), 'utf8');
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    const calls = code.match(/\bapi\s*\.\s*on[A-Z]\w*\s*\(/g) || [];
    expect(calls.join(', '), 'renderer/studio.js calls a window.api on* registrar directly').toBe('');

    // The DOM symptom of a double mount, which is the other way a registrar
    // gets called twice.
    for (const sel of [
      '#studio-scroll',
      '#studio-console',
      '#studio-prompt',
      '#studio-toolbar',
      '#studio-submit',
      '#studio-tools-menu',
      '#studio-route',
    ]) {
      await expect(page.locator(sel)).toHaveCount(1);
    }
  });
});
