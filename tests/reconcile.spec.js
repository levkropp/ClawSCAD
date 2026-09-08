// @ts-check
const { test, expect } = require('@playwright/test');
const { _electron: electron } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const os = require('os');

const APP_PATH = path.join(__dirname, '..');

test.beforeAll(async () => {
  const { execSync } = require('child_process');
  execSync('npm run build:renderer', { cwd: APP_PATH, stdio: 'pipe' });
});

function freshWorkspace(name) {
  const dir = path.join(os.tmpdir(), `clawscad-reconcile-${name}-${Date.now()}`);
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
  return { electronApp, page };
}

function readState(ws) {
  return JSON.parse(fs.readFileSync(path.join(ws, 'clawscad.json'), 'utf-8'));
}

// ── Workspace reconciliation ────────────────────────────────────────────
// The watcher runs with ignoreInitial:true and loadState only ever read
// clawscad.json, so any .scad written while the app was closed — a plain
// `claude` CLI session, a claw-gen run, a git checkout — was invisible
// forever. For a tool that promises "every file is a permanent checkpoint",
// silently omitting real work is the worst failure available.

test.describe('workspace reconciliation', () => {
  test('adopts .scad files created while the app was closed', async () => {
    const ws = freshWorkspace('adopt');
    fs.writeFileSync(path.join(ws, 'bracket.scad'), '// A simple bracket\ncube([10,10,2]);\n');
    fs.writeFileSync(path.join(ws, 'spacer.scad'), '// A spacer ring\ncylinder(h=4, r=6);\n');

    const { electronApp } = await launch(ws);
    try {
      const state = readState(ws);
      const files = Object.values(state.checkpoints).map((c) => c.file).sort();
      expect(files).toEqual(['bracket.scad', 'spacer.scad']);

      // Adopted nodes are marked, and carry the first-line // comment.
      const adopted = Object.values(state.checkpoints);
      expect(adopted.every((c) => c.discovered === true)).toBe(true);
      const bracket = adopted.find((c) => c.file === 'bracket.scad');
      expect(bracket.description).toBe('A simple bracket');

      // An active pointer is initialised so the tree has a branch point.
      expect(state.active).toBeTruthy();
      expect(state.checkpoints[state.active]).toBeTruthy();
    } finally {
      await electronApp.close();
      removeWorkspace(ws);
    }
  });

  test('never rewrites active.scad or repoints an active checkpoint the user already set', async () => {
    const ws = freshWorkspace('nondestructive');
    fs.writeFileSync(path.join(ws, 'first.scad'), '// First\ncube(1);\n');
    fs.writeFileSync(path.join(ws, 'second.scad'), '// Second\ncube(2);\n');

    // A registry that already knows about first.scad and points at it.
    fs.writeFileSync(
      path.join(ws, 'clawscad.json'),
      JSON.stringify({
        checkpoints: {
          cp_existing: {
            file: 'first.scad',
            parent: null,
            label: 'first',
            description: 'First',
            sessionId: null,
            created: '2026-01-01T00:00:00.000Z',
          },
        },
        active: 'cp_existing',
      })
    );
    const sentinel = '// DO NOT CLOBBER\ncube(99);\n';
    fs.writeFileSync(path.join(ws, 'active.scad'), sentinel);

    const { electronApp } = await launch(ws);
    try {
      const state = readState(ws);

      // second.scad adopted, first.scad not duplicated.
      const files = Object.values(state.checkpoints).map((c) => c.file).sort();
      expect(files).toEqual(['first.scad', 'second.scad']);

      // The user's active checkpoint is untouched.
      expect(state.active).toBe('cp_existing');

      // Reconciliation must not write active.scad.
      expect(fs.readFileSync(path.join(ws, 'active.scad'), 'utf-8')).toBe(sentinel);
    } finally {
      await electronApp.close();
      removeWorkspace(ws);
    }
  });

  test('active.scad is never itself adopted as a checkpoint', async () => {
    const ws = freshWorkspace('activefile');
    fs.writeFileSync(path.join(ws, 'active.scad'), '// pointer copy\ncube(3);\n');
    fs.writeFileSync(path.join(ws, 'real.scad'), '// Real part\ncube(3);\n');

    const { electronApp } = await launch(ws);
    try {
      const files = Object.values(readState(ws).checkpoints).map((c) => c.file);
      expect(files).toEqual(['real.scad']);
    } finally {
      await electronApp.close();
      removeWorkspace(ws);
    }
  });

  test('classifies a mesh-import checkpoint as generated and a primitive one as parametric', async () => {
    const ws = freshWorkspace('kind');
    fs.writeFileSync(
      path.join(ws, 'sculpt.scad'),
      '// Generated sculpt: an owl planter\nimport("meshes/owl.stl", convexity = 8);\n'
    );
    fs.writeFileSync(path.join(ws, 'plate.scad'), '// Flat plate\ncube([20,20,2]);\n');

    const { electronApp } = await launch(ws);
    try {
      const cps = Object.values(readState(ws).checkpoints);
      expect(cps.find((c) => c.file === 'sculpt.scad').kind).toBe('generated');
      expect(cps.find((c) => c.file === 'plate.scad').kind).toBe('parametric');
    } finally {
      await electronApp.close();
      removeWorkspace(ws);
    }
  });

  // A generated sculpt mislabelled as parametric loses the branch-don't-edit
  // signal on exactly the file that rule exists to protect.
  test('kind detection survives divisions on the import line and ignores commented-out imports', async () => {
    const ws = freshWorkspace('kindedge');
    // A division earlier on the same line used to defeat detection.
    fs.writeFileSync(
      path.join(ws, 'divided.scad'),
      '// Sculpt with a centring transform\nh = 40;\ntranslate([0,0,-h/2]) import("meshes/x.stl");\n'
    );
    // A commented-out import must NOT count as generated.
    fs.writeFileSync(
      path.join(ws, 'commented.scad'),
      '// A parametric part\n// import("old.stl");\ncube([4,4,4]);\n'
    );
    // Block-commented too.
    fs.writeFileSync(
      path.join(ws, 'blockcomment.scad'),
      '// Parametric with an old idea parked\n/* import("legacy.stl"); */\nsphere(5);\n'
    );

    const { electronApp } = await launch(ws);
    try {
      const cps = Object.values(readState(ws).checkpoints);
      expect(cps.find((c) => c.file === 'divided.scad').kind).toBe('generated');
      expect(cps.find((c) => c.file === 'commented.scad').kind).toBe('parametric');
      expect(cps.find((c) => c.file === 'blockcomment.scad').kind).toBe('parametric');
    } finally {
      await electronApp.close();
      removeWorkspace(ws);
    }
  });

  test('a second launch adopts nothing new and does not duplicate', async () => {
    const ws = freshWorkspace('idempotent');
    fs.writeFileSync(path.join(ws, 'part.scad'), '// Part\ncube(5);\n');

    let app = await launch(ws);
    let firstIds;
    try {
      firstIds = Object.keys(readState(ws).checkpoints);
      expect(firstIds).toHaveLength(1);
    } finally {
      await app.electronApp.close();
    }

    app = await launch(ws);
    try {
      const state = readState(ws);
      expect(Object.keys(state.checkpoints)).toEqual(firstIds);
    } finally {
      await app.electronApp.close();
      removeWorkspace(ws);
    }
  });
});
