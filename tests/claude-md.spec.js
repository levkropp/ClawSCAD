// @ts-check
const { test, expect } = require('@playwright/test');
const { _electron: electron } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const os = require('os');

const APP_PATH = path.join(__dirname, '..');
const START_MARKER = '<!-- clawscad:rules:start -->';
const END_MARKER = '<!-- clawscad:rules:end -->';

test.beforeAll(async () => {
  const { execSync } = require('child_process');
  execSync('npm run build:renderer', { cwd: APP_PATH, stdio: 'pipe' });
});

function freshWorkspace(name) {
  const dir = path.join(os.tmpdir(), `clawscad-claudemd-${name}-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// On Windows the closed app's children can still hold a handle on the temp
// workspace for a moment, so a bare rmSync throws EBUSY and fails a spec whose
// assertions all passed. Retry, and never let cleanup alone turn the run red.
function removeWorkspace(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  } catch (err) {
    console.warn(`test workspace cleanup left ${dir}: ${err.code}`);
  }
}

async function launchWithWorkspace(wsDir) {
  const electronApp = await electron.launch({
    args: [path.join(APP_PATH, 'main.js'), wsDir],
    cwd: APP_PATH,
  });
  const page = await electronApp.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(1000);
  return electronApp;
}

// ── CLAUDE.md managed block ─────────────────────────────────────────────
// writeClaudeMd() (main.js) must never clobber user-authored content in a
// workspace's CLAUDE.md — it owns only the region between START/END
// markers. Covers: absent file, existing file with markers, and existing
// hand-written file with no markers at all.

test.describe('CLAUDE.md managed block', () => {
  test('creates CLAUDE.md with the managed block when the file is absent', async () => {
    const ws = freshWorkspace('absent');
    const electronApp = await launchWithWorkspace(ws);
    try {
      const content = fs.readFileSync(path.join(ws, 'CLAUDE.md'), 'utf-8');
      expect(content).toContain(START_MARKER);
      expect(content).toContain(END_MARKER);
      expect(content).toContain('MANDATORY RULES');
      expect(content).toContain('NEVER modify or overwrite');
      expect(content).toContain('Mesh-Derived Checkpoints');
      expect(content).toContain('branch');
    } finally {
      await electronApp.close();
      removeWorkspace(ws);
    }
  });

  test('replaces only the managed block, preserving surrounding user content byte-for-byte', async () => {
    const ws = freshWorkspace('markers');
    const before =
      '# My Project Notes\n\n' +
      'Some hand-written intro the app must never touch.\n\n' +
      START_MARKER + '\n' +
      'STALE OLD GENERATED CONTENT FROM A PREVIOUS VERSION\n' +
      END_MARKER + '\n\n' +
      '## My own conventions\n- always use metric\n- ask before deleting parts\n';
    fs.writeFileSync(path.join(ws, 'CLAUDE.md'), before);

    const electronApp = await launchWithWorkspace(ws);
    try {
      const content = fs.readFileSync(path.join(ws, 'CLAUDE.md'), 'utf-8');

      // Everything outside the markers is untouched.
      expect(content).toContain('# My Project Notes');
      expect(content).toContain('Some hand-written intro the app must never touch.');
      expect(content).toContain('## My own conventions');
      expect(content).toContain('- always use metric');
      expect(content).toContain('- ask before deleting parts');

      // Only the block's contents changed.
      expect(content).not.toContain('STALE OLD GENERATED CONTENT');
      expect(content).toContain('MANDATORY RULES');

      // Markers still appear exactly once each — no duplication.
      expect(content.split(START_MARKER).length - 1).toBe(1);
      expect(content.split(END_MARKER).length - 1).toBe(1);
    } finally {
      await electronApp.close();
      removeWorkspace(ws);
    }
  });

  test('prepends the managed block without touching pre-existing unmarked content', async () => {
    const ws = freshWorkspace('unmarked');
    const before =
      '# Hand-written CLAUDE.md\n\n' +
      'This entire file was written by a human and has no clawscad markers.\n' +
      '- rule one\n- rule two\n';
    fs.writeFileSync(path.join(ws, 'CLAUDE.md'), before);

    const electronApp = await launchWithWorkspace(ws);
    try {
      const content = fs.readFileSync(path.join(ws, 'CLAUDE.md'), 'utf-8');
      expect(content).toContain(before);
      expect(content).toContain('MANDATORY RULES');
      // The managed block was prepended, i.e. it comes first in the file.
      expect(content.indexOf(START_MARKER)).toBeLessThan(content.indexOf('Hand-written CLAUDE.md'));
      expect(content.split(START_MARKER).length - 1).toBe(1);
    } finally {
      await electronApp.close();
    }

    // Relaunching now hits the marker path and must not duplicate the block.
    const electronApp2 = await launchWithWorkspace(ws);
    try {
      const content2 = fs.readFileSync(path.join(ws, 'CLAUDE.md'), 'utf-8');
      expect(content2.split(START_MARKER).length - 1).toBe(1);
      expect(content2.split(END_MARKER).length - 1).toBe(1);
      expect(content2).toContain('This entire file was written by a human and has no clawscad markers.');
      expect(content2).toContain('- rule one\n- rule two');
    } finally {
      await electronApp2.close();
      removeWorkspace(ws);
    }
  });
});
