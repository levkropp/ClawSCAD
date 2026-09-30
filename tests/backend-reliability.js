const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

const appRoot = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(appRoot, 'main.js'), 'utf8');

// Evaluate the actual main process code with Electron startup disabled and
// controllable child processes. File writes and the render queue remain real.
function loadBackend(overrides = {}) {
  const renders = [], children = [], timers = [], logs = [];
  const watcher = new EventEmitter();
  const mocks = {
    electron: {
      app: { isPackaged: false, getPath: () => os.tmpdir(), whenReady: () => ({ then() {} }), on() {} },
      ipcMain: { on() {}, handle() {} },
    },
    'node-pty': {},
    chokidar: { watch: () => watcher },
    child_process: {
      execFile: (bin, args, options, callback) => renders.push({ bin, args, callback }),
      spawn: () => {
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.stdin = new EventEmitter();
        child.stdin.write = () => {};
        child.kill = () => {};
        children.push(child);
        return child;
      },
    },
    ...overrides,
  };
  const context = vm.createContext({
    require: (name) => mocks[name] || require(name),
    __dirname: appRoot,
    process: { env: {}, platform: process.platform, argv: [] },
    console: { error: (...args) => logs.push(args), warn: (...args) => logs.push(args) },
    setTimeout: (callback, ms) => { timers.push({ callback, ms }); return timers.length; },
  });
  vm.runInContext(source + '\n;globalThis.backend = { McpClient, writeClaudeMd, startFileWatcher, processRenderQueue };', context);
  return { ...context.backend, renders, children, timers, logs, watcher };
}

function workspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawscad-backend-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function renderContext(dir, files) {
  const messages = [];
  return {
    workspaceDir: dir,
    renderQueue: files.map((file) => path.join(dir, file)),
    state: { active: null },
    window: { isDestroyed: () => false, webContents: { isDestroyed: () => false, send: (channel, data) => messages.push({ channel, data }) } },
    messages,
  };
}

function completeRender(request, err = null, stderr = '') {
  if (!err) fs.writeFileSync(request.args[1], 'rendered mesh');
  request.callback(err, '', stderr);
}

test('watcher errors are contained and later file events remain usable', () => {
  const backend = loadBackend();
  backend.startFileWatcher({ workspaceDir: 'workspace' });
  assert.doesNotThrow(() => backend.watcher.emit('error', new Error('ENOSPC')));
  assert.equal(backend.logs.length, 1);
  assert.doesNotThrow(() => backend.watcher.emit('change', 'notes.txt'));
});

for (const stream of ['child', 'stdin']) {
  test(`MCP ${stream} errors reject pending calls and permit reconnecting`, async () => {
    const backend = loadBackend();
    const client = new backend.McpClient();
    const starting = client.start();
    const first = backend.children[0];
    const pending = client._send('tools/list', {});
    const rejected = assert.rejects(pending, /helper failed/);
    assert.doesNotThrow(() => (stream === 'child' ? first : first.stdin).emit('error', new Error('helper failed')));
    await starting;
    await rejected;
    assert.equal(client.proc, null);
    assert.equal(client.ready, false);
    assert.equal(client.pending.size, 0);

    const restarting = client.start();
    const second = backend.children[1];
    first.stdout.emit('data', Buffer.from('stale incomplete output'));
    assert.equal(client.buffer, '');
    const initializeId = client.nextId - 1;
    second.stdout.emit('data', Buffer.from(JSON.stringify({ id: initializeId, result: {} }) + '\n'));
    await restarting;
    first.emit('exit', 1);
    assert.equal(client.proc, second);
    assert.equal(client.ready, true);
  });
}

test('stopping the MCP helper rejects requests without waiting for the timeout', async () => {
  const backend = loadBackend();
  const client = new backend.McpClient();
  const starting = client.start();
  const pending = client._send('tools/list', {});
  const rejected = assert.rejects(pending, /stopped/);
  client.stop();
  await starting;
  await rejected;
  assert.equal(client.pending.size, 0);
});

test('CLAUDE.md preserves custom text while updating only its managed rules', (t) => {
  const dir = workspace(t);
  const file = path.join(dir, 'CLAUDE.md');
  const backend = loadBackend();
  const custom = '# My instructions\r\nUse our existing parts library.\r\n';
  fs.writeFileSync(file, custom);
  backend.writeClaudeMd({ workspaceDir: dir }, [dir]);
  const first = fs.readFileSync(file, 'utf8');
  assert.ok(first.endsWith(custom));
  const prefix = 'User notes before the block.\r\n';
  const suffix = '\r\nUser notes after the block.\r\n';
  fs.writeFileSync(file, prefix + first + suffix);
  const other = path.join(dir, 'other-project');
  backend.writeClaudeMd({ workspaceDir: dir }, [dir, other]);
  const updated = fs.readFileSync(file, 'utf8');
  assert.ok(updated.startsWith(prefix));
  assert.ok(updated.endsWith(custom + suffix));
  assert.ok(updated.includes(other));
  assert.equal(updated.split('<!-- clawscad:rules:start -->').length - 1, 1);
  backend.writeClaudeMd({ workspaceDir: dir }, [dir, other]);
  assert.equal(fs.readFileSync(file, 'utf8'), updated);
});

test('CLAUDE.md read failures do not overwrite an unreadable custom file', (t) => {
  const dir = workspace(t);
  const file = path.join(dir, 'CLAUDE.md');
  fs.writeFileSync(file, 'Custom rules');
  const backend = loadBackend({ fs: {
    ...fs,
    readFileSync: (target, ...args) => {
      if (target === file) throw Object.assign(new Error('denied'), { code: 'EACCES' });
      return fs.readFileSync(target, ...args);
    },
  } });
  assert.throws(() => backend.writeClaudeMd({ workspaceDir: dir }, [dir]), /denied/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'Custom rules');
});

test('a fresh workspace receives exactly one managed CLAUDE.md block', (t) => {
  const dir = workspace(t);
  const backend = loadBackend();
  backend.writeClaudeMd({ workspaceDir: dir }, [dir]);
  backend.writeClaudeMd({ workspaceDir: dir }, [dir]);
  const text = fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8');
  assert.equal(text.split('<!-- clawscad:rules:start -->').length - 1, 1);
  assert.ok(text.includes('MCP Tools Available'));
});

test('an STL fallback is limited to its model and the next model uses 3MF', (t) => {
  const backend = loadBackend();
  const dir = workspace(t);
  const ctx = renderContext(dir, ['first.scad', 'second.scad']);
  backend.processRenderQueue(ctx);
  completeRender(backend.renders[0], Object.assign(new Error('3MF failed'), { code: 1 }));
  completeRender(backend.renders[1]);
  completeRender(backend.renders[2]);
  assert.deepEqual(backend.renders.map((r) => path.extname(r.args[1])), ['.3mf', '.stl', '.3mf']);
  assert.deepEqual(ctx.messages.filter((m) => m.channel === 'model:update').map((m) => m.data.format), ['stl', '3mf']);
  assert.equal(ctx.stlFallbackFor, null);
  assert.equal(ctx.isRendering, false);
});

for (const [code, properties, fault] of [
  ['ENOENT', {}, 'environment'], ['EACCES', {}, 'environment'], ['EPERM', {}, 'environment'],
  ['ETIMEDOUT', {}, 'timeout'], [null, { killed: true, signal: 'SIGTERM' }, 'timeout'],
]) {
  test(`${code || 'terminated render'} does not retry or ask Claude to rewrite the model`, (t) => {
    const backend = loadBackend();
    const dir = workspace(t);
    const ctx = renderContext(dir, ['model.scad']);
    ctx.ptyProcess = { write: () => assert.fail('unexpected Claude input') };
    backend.processRenderQueue(ctx);
    completeRender(backend.renders[0], Object.assign(new Error('render failed'), { code, ...properties }));
    assert.equal(backend.renders.length, 1);
    assert.equal(fs.existsSync(path.join(dir, 'RENDER_ERRORS.md')), false);
    assert.equal(backend.timers.length, 0);
    assert.equal(ctx.messages.find((m) => m.channel === 'render:error').data.fault, fault);
    assert.equal(ctx.isRendering, false);
  });
}

test('a genuine model error retains the existing error report and Claude repair behavior', (t) => {
  const backend = loadBackend();
  const dir = workspace(t);
  const ctx = renderContext(dir, ['broken.scad']);
  ctx.ptyProcess = { write() {} };
  backend.processRenderQueue(ctx);
  const err = Object.assign(new Error('parser error'), { code: 1 });
  completeRender(backend.renders[0], err, 'ERROR: syntax error');
  completeRender(backend.renders[1], err, 'ERROR: syntax error');
  assert.match(fs.readFileSync(path.join(dir, 'RENDER_ERRORS.md'), 'utf8'), /syntax error/);
  assert.equal(backend.timers.length, 1);
  assert.equal(ctx.messages.find((m) => m.channel === 'render:error').data.fault, 'model');
  assert.equal(ctx.stlFallbackFor, null);
});
