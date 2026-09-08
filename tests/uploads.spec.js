// @ts-check
const { test, expect } = require('@playwright/test');
const { _electron: electron } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { openWorkbench } = require('./helpers');

const APP_PATH = path.join(__dirname, '..');
const TEST_WORKSPACE = path.join(os.tmpdir(), 'clawscad-uploads-test-' + Date.now());
const FIXTURE_DIR = path.join(os.tmpdir(), 'clawscad-uploads-fixtures-' + Date.now());

let electronApp;
let page;

// ── binary STL fixture builder — a ground-truth mesh with a known bbox, so
// the ingest handler's computed bbox can be compared against a value we
// authored ourselves rather than re-deriving it with the same code path. ──
function buildBinaryStl(triangles) {
  const header = Buffer.alloc(80);
  const countBuf = Buffer.alloc(4);
  countBuf.writeUInt32LE(triangles.length, 0);
  const triBufs = triangles.map((tri) => {
    const buf = Buffer.alloc(50);
    // normal (unused by our bbox parser) stays zero
    let off = 12;
    for (const [x, y, z] of tri) {
      buf.writeFloatLE(x, off);
      buf.writeFloatLE(y, off + 4);
      buf.writeFloatLE(z, off + 8);
      off += 12;
    }
    return buf;
  });
  return Buffer.concat([header, countBuf, ...triBufs]);
}

// Two triangles spanning exactly x:[0,10] y:[0,20] z:[0,5].
const KNOWN_BBOX_STL = buildBinaryStl([
  [
    [0, 0, 0],
    [10, 0, 0],
    [10, 20, 5],
  ],
  [
    [0, 0, 0],
    [10, 20, 5],
    [0, 20, 0],
  ],
]);

test.beforeAll(async () => {
  const { execSync } = require('child_process');
  execSync('npm run build:renderer', { cwd: APP_PATH, stdio: 'pipe' });
  fs.mkdirSync(TEST_WORKSPACE, { recursive: true });
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
});

test.afterAll(async () => {
  // The bytes-fallback test below clicks #composer-submit, which is P1's
  // code and persists to the shared userData composer-state.json — not a
  // file uploads.js writes itself, but this spec is what triggers the
  // write, so it resets it, mirroring composer.spec.js's own afterAll.
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
  try {
    fs.rmSync(FIXTURE_DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  } catch {}
});

async function launch(wsDir) {
  const app = await electron.launch({ args: [path.join(APP_PATH, 'main.js'), wsDir], cwd: APP_PATH });
  const p = await app.firstWindow();
  await p.waitForLoadState('domcontentloaded');
  await p.waitForTimeout(1000);
  return { app, page: p };
}

// Dispatches a synthetic HTML5 drop with real File bytes onto the uploads
// composer section — no OS-level drag emulation needed; DataTransfer built
// entirely in-page, which is how Chromium file-drop tests are normally done.
async function dropFile(p, name, bytes) {
  await p.evaluate(
    ({ name, bytes }) => {
      const file = new File([new Uint8Array(bytes)], name, { type: 'application/octet-stream' });
      const dt = new DataTransfer();
      dt.items.add(file);
      const el = document.querySelector('.composer-section[data-section-id="uploads"]');
      if (!el) throw new Error('uploads composer section not mounted');
      el.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    },
    { name, bytes: Array.from(bytes) }
  );
  // stageFile() awaits file.arrayBuffer() before the chip renders.
  await p.waitForTimeout(300);
}

test.describe('Upload & ingest', () => {
  test.beforeEach(async () => {
    const launched = await launch(TEST_WORKSPACE);
    electronApp = launched.app;
    page = launched.page;
    await openWorkbench(page);
  });

  test.afterEach(async () => {
    if (electronApp) await electronApp.close();
  });

  test('a simulated drop adds a .file-chip with the right data-class and writes nothing to disk', async () => {
    await dropFile(page, 'bracket.stl', [1, 2, 3, 4, 5]); // content irrelevant — staging is extension-only

    const chip = page.locator('.file-chip[data-class="mesh"]');
    await expect(chip).toHaveCount(1);
    await expect(chip.locator('.file-chip-name')).toHaveText('bracket.stl');

    // Staging must be pure in-memory state — no IPC call happens until submit.
    expect(fs.existsSync(path.join(TEST_WORKSPACE, 'meshes'))).toBe(false);
    expect(fs.existsSync(path.join(TEST_WORKSPACE, 'uploads'))).toBe(false);
  });

  test('.step produces a blocked chip with the named-fix copy', async () => {
    await dropFile(page, 'part.step', [1, 2, 3]);

    const chip = page.locator('.file-chip[data-class="blocked"]');
    await expect(chip).toHaveCount(1);
    const note = chip.locator('.file-chip-note');
    await expect(note).toContainText("can't be imported");
    await expect(note).toContainText('Export STL or 3MF');

    // Blocked files are never written anywhere.
    expect(fs.existsSync(path.join(TEST_WORKSPACE, 'meshes'))).toBe(false);
    expect(fs.existsSync(path.join(TEST_WORKSPACE, 'uploads'))).toBe(false);
  });

  test('ingesting an .stl produces a checkpoint whose stated bbox matches the mesh\'s actual bbox', async () => {
    const fixturePath = path.join(FIXTURE_DIR, 'known-bbox.stl');
    fs.writeFileSync(fixturePath, KNOWN_BBOX_STL);

    const result = await page.evaluate((p) => window.api.uploadIngest(p), fixturePath);

    expect(result.ok).toBe(true);
    expect(result.class).toBe('mesh');
    // Ground truth authored above: x:[0,10] y:[0,20] z:[0,5].
    expect(result.bbox.min).toEqual([0, 0, 0]);
    expect(result.bbox.max).toEqual([10, 20, 5]);
    expect(result.bbox.dims).toEqual([10, 20, 5]);

    // The checkpoint landed in the workspace and re-centres on X/Y with base
    // at Z=0, derived from the SAME computed bbox — never eyeballed.
    const scadPath = path.join(TEST_WORKSPACE, result.checkpoint.file);
    expect(fs.existsSync(scadPath)).toBe(true);
    const scadSrc = fs.readFileSync(scadPath, 'utf-8');
    expect(scadSrc).toContain('bbox min [0, 0, 0] max [10, 20, 5]');
    expect(scadSrc).toContain('translate([-5, -10, 0])');

    // The source fixture itself was only ever read, never touched.
    expect(fs.existsSync(fixturePath)).toBe(true);
    expect(fs.readFileSync(fixturePath).equals(KNOWN_BBOX_STL)).toBe(true);
  });

  test('re-ingesting a same-named file with different bytes does not overwrite', async () => {
    const dirA = path.join(FIXTURE_DIR, 'a');
    const dirB = path.join(FIXTURE_DIR, 'b');
    fs.mkdirSync(dirA, { recursive: true });
    fs.mkdirSync(dirB, { recursive: true });

    const stlA = buildBinaryStl([
      [
        [0, 0, 0],
        [1, 0, 0],
        [1, 1, 0],
      ],
    ]);
    const stlB = buildBinaryStl([
      [
        [0, 0, 0],
        [9, 0, 0],
        [9, 9, 9],
      ],
    ]);
    const pathA = path.join(dirA, 'same-name.stl');
    const pathB = path.join(dirB, 'same-name.stl');
    fs.writeFileSync(pathA, stlA);
    fs.writeFileSync(pathB, stlB);

    const resultA = await page.evaluate((p) => window.api.uploadIngest(p), pathA);
    expect(resultA.ok).toBe(true);
    const storedAPath = path.join(TEST_WORKSPACE, resultA.relPath);
    const bytesAAfterFirst = fs.readFileSync(storedAPath);

    const resultB = await page.evaluate((p) => window.api.uploadIngest(p), pathB);
    expect(resultB.ok).toBe(true);

    // Different content under the same basename must land at a different
    // path — never overwrite the first copy.
    expect(resultB.relPath).not.toBe(resultA.relPath);
    expect(fs.readFileSync(storedAPath).equals(bytesAAfterFirst)).toBe(true);
    expect(fs.readFileSync(storedAPath).equals(stlA)).toBe(true);
  });

  // The path route (webUtils.getPathForFile via preload) is what a normal OS
  // drag takes; a virtual file (dragged from a browser tab, or an older
  // preload without the bridge) returns null from pathForFile and must still
  // ingest correctly, via upload:ingest-bytes. This is the branch most
  // likely to rot silently since everyday manual testing never exercises it.
  test('falls back to bytes ingest when pathForFile returns null (virtual file)', async () => {
    await page.evaluate(() => {
      window.api.pathForFile = () => null;
    });

    await dropFile(page, 'virtual-drop.stl', KNOWN_BBOX_STL);
    const chip = page.locator('.file-chip[data-class="mesh"]');
    await expect(chip).toHaveCount(1);
    await expect(chip.locator('.file-chip-name')).toHaveText('virtual-drop.stl');

    // Attaching a file alone (with no prompt text) is enough to enable
    // submit, since the section's preamble already has content.
    await expect(page.locator('#composer-submit')).toBeEnabled();
    await page.locator('#composer-submit').click();
    await expect(chip.locator('.file-chip-note')).toContainText('bbox 10 x 20 x 5 mm', { timeout: 10000 });

    // The mesh reached disk via the bytes route — no path was ever supplied,
    // by construction (pathForFile stubbed to null above).
    const meshFiles = fs.readdirSync(path.join(TEST_WORKSPACE, 'meshes'));
    expect(meshFiles.some((f) => f.startsWith('virtual-drop'))).toBe(true);
  });
});
