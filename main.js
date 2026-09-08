const { app, BrowserWindow, ipcMain, Menu, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const pty = require('node-pty');
const chokidar = require('chokidar');
const { execFile, spawn } = require('child_process');

// Single source of truth for the app version — surfaced over IPC as
// app:get-version and sent in the MCP handshake, so neither can drift.
const APP_VERSION = require('./package.json').version;

// Tests only: give every launch its own Electron/Chromium profile.
//
// Every spec launches a fresh app per test, all against the one profile keyed
// by app name (%APPDATA%\Electron). electronApp.close() returns before the
// process has actually exited, so launch N+1 routinely started while N still
// held that profile — two Chromium instances on one user-data-dir, the second
// unable to publish its DevTools endpoint, and Playwright waiting out
// firstWindow() on a renderer that had in fact been created. That is the
// "Timeout exceeded while waiting for event window" the suite kept hitting,
// and it looks identical to a code failure.
//
// Set only from playwright.config.js — a normal run is untouched and keeps
// using the real profile.
if (process.env.CLAWSCAD_TEST_PROFILE_ROOT) {
  // Keyed on the workspace, NOT the pid. A spec that reuses one workspace
  // across launches (categories.spec.js relaunches to prove the chosen print
  // type persists) must see the same profile both times, while two different
  // spec files still never share one — which is the isolation that matters.
  const wsArg = process.argv.slice(2).find((a) => !a.startsWith('-'));
  const key = wsArg ? path.basename(wsArg).replace(/[^a-zA-Z0-9._-]/g, '_') : 'default';
  app.setPath('userData', path.join(process.env.CLAWSCAD_TEST_PROFILE_ROOT, key));

  // ...and run the suite on software rendering.
  //
  // Launching dozens of Electron apps back-to-back on a workstation whose GPU
  // is already busy makes the GPU process die — "GPU process exited
  // unexpectedly: exit_code=34" — and a launch that inherits that broken state
  // creates its BrowserWindow but never finishes loading the page. Playwright
  // then reports either "firstWindow timed out" or "waitForLoadState timed
  // out" depending on how far it got, both of which read as an app bug and are
  // not one. The specs assert DOM and computed styles, never rendered pixels,
  // so software rendering costs the suite nothing.
  app.disableHardwareAcceleration();
}

// Resolve the OpenSCAD binary: prefer bundled copy, fall back to env / system.
// In packaged builds, extraResources lands at process.resourcesPath.
// In dev, look in the repo's vendors/ directory (populated by download-openscad.js).
//
// This MUST be a function, not a module-load constant: env:locate-openscad
// mutates process.env.OPENSCAD_BINARY at runtime (below), and every call site
// needs to see that change on its very next render, not after an app restart.
function getOpenscadBin() {
  const bundled = openscadBundledPath();
  if (bundled && fs.existsSync(bundled)) return bundled;
  return process.env.OPENSCAD_BINARY || 'openscad';
}

// Is the resolved binary the BUNDLED one, or a fallback? An environment banner
// that only says "install OpenSCAD" is wrong in a dev checkout, where the
// bundled path exists as a code branch but the binary is simply un-downloaded:
// there the fix is `npm run download-openscad`, not an install.
function openscadBundledPath() {
  const base = app.isPackaged ? process.resourcesPath : path.join(__dirname, 'vendors');
  const candidates = {
    linux: path.join(base, 'openscad-linux.AppImage'),
    darwin: path.join(base, 'OpenSCAD.app', 'Contents', 'MacOS', 'OpenSCAD'),
    win32: path.join(base, 'openscad-win', 'openscad.exe'),
  };
  return candidates[process.platform] || null;
}

// --backend=Manifold is ~50x faster than 2021.01's CGAL on boolean-heavy
// exports, but it only exists on recent/Nightly builds — passing it to an old
// binary is a hard argument error, so probe once and cache.
let _manifoldSupported = null;
function probeManifold() {
  if (_manifoldSupported !== null) return Promise.resolve(_manifoldSupported);
  return new Promise((resolve) => {
    execFile(getOpenscadBin(), ['--help'], { timeout: 10000, env: openscadEnv() }, (err, stdout, stderr) => {
      const text = `${stdout || ''}${stderr || ''}`;
      _manifoldSupported = !err && /manifold/i.test(text);
      resolve(_manifoldSupported);
    });
  });
}

function manifoldArgs() {
  return _manifoldSupported ? ['--backend=Manifold'] : [];
}

// What the app can and cannot do right now, as facts rather than as a failure
// discovered mid-render. Consumed by the environment banner strip.
function probeEnvironment() {
  const bundled = openscadBundledPath();
  const openscad = {
    binary: getOpenscadBin(),
    bundledPath: bundled,
    bundledMissing: !!bundled && !fs.existsSync(bundled),
    resolved: !!bundled && fs.existsSync(bundled)
      ? true
      : !!(process.env.OPENSCAD_BINARY && fs.existsSync(process.env.OPENSCAD_BINARY)) || !!findOnPath('openscad'),
  };
  return {
    openscad,
    claude: { binary: resolveClaude() },
    clawGen: { binary: resolvePipelineCli() },
  };
}

// Resolve the Claude Code CLI binary. Checks the standalone installer location
// (~/.claude/local/claude), user/system PATH, and other common install paths.
// Returns null if not found — startTerminal will auto-install via npm in that case.
let _claudeBin = null;
function resolveClaude() {
  if (_claudeBin) return _claudeBin;
  // An explicit path always wins. The probe below covers every install method we
  // know of, but "we know of" is the weak part — an unusual install (a version
  // manager, a wrapper script, a second CLI kept for testing) needs a way in
  // that does not involve editing this list. Mirrors OPENSCAD_BINARY.
  const fromEnv = process.env.CLAWSCAD_CLAUDE_BIN;
  if (fromEnv) {
    try { if (fs.existsSync(fromEnv)) { _claudeBin = fromEnv; return fromEnv; } } catch {}
  }
  const candidates = [
    path.join(os.homedir(), '.claude', 'local', 'claude'), // standalone installer
    path.join(os.homedir(), '.local', 'bin', 'claude'),
    '/usr/local/bin/claude',
  ];
  // Search every directory on this process's PATH (catches npm global and others)
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    candidates.push(path.join(dir, 'claude'));
  }
  // On Windows the executable is claude.exe (standalone / ~/.local/bin) or
  // claude.cmd (npm global), so probe platform extensions before the bare name.
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const c of candidates) {
    for (const ext of exts) {
      try { if (fs.existsSync(c + ext)) { _claudeBin = c + ext; return c + ext; } } catch {}
    }
  }
  return null;
}

// Interactive shell to fall back to when Claude can't be launched. On Windows
// process.env.SHELL is unset, so a bare '/bin/bash' fallback would fail to spawn.
const DEFAULT_SHELL = process.platform === 'win32'
  ? (process.env.COMSPEC || 'cmd.exe')
  : (process.env.SHELL || '/bin/bash');

// Extra env vars needed when running OpenSCAD on specific platforms.
// On Linux, APPIMAGE_EXTRACT_AND_RUN=1 lets a bundled AppImage run inside
// the Electron AppImage without needing nested FUSE mounts.
function openscadEnv() {
  if (process.platform === 'linux' && getOpenscadBin().endsWith('.AppImage')) {
    return { ...process.env, APPIMAGE_EXTRACT_AND_RUN: '1' };
  }
  return process.env;
}

const STATE_FILE = 'clawscad.json';
const ACTIVE_FILE = 'active.scad';
const MAX_WINDOWS = 4;

// ── OpenSCAD MCP Client ─────────────────────────────────────────────────
// Spawns openscad-mcp-server as a subprocess and calls its tools via JSON-RPC.
// This gives ClawSCAD direct rendering/validation without relying on Claude's MCP.

class McpClient {
  constructor() {
    this.proc = null;
    this.nextId = 1;
    this.pending = new Map(); // id -> { resolve, reject }
    this.buffer = '';
    this.ready = false;
  }

  async start() {
    if (this.proc) return;

    try {
      this.proc = spawn('npx', ['-y', 'openscad-mcp-server'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: true,
      });
    } catch (err) {
      console.error('Failed to start openscad-mcp-server:', err.message);
      return;
    }

    // Same fatality hazard as the file watcher: ChildProcess is a real
    // EventEmitter, so an unhandled 'error' (e.g. npx missing/ENOENT) would
    // crash the whole Electron main process instead of just this subprocess.
    this.proc.on('error', (err) => {
      console.error('openscad-mcp-server process error:', err.message);
    });

    this.proc.stdout.on('data', (chunk) => {
      this.buffer += chunk.toString();
      this._processBuffer();
    });

    this.proc.stderr.on('data', (chunk) => {
      // MCP server logs go to stderr — ignore unless debugging
    });

    this.proc.on('exit', () => {
      this.proc = null;
      this.ready = false;
      // Reject all pending
      for (const [, p] of this.pending) p.reject(new Error('MCP server exited'));
      this.pending.clear();
    });

    // MCP handshake
    try {
      await this._send('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'ClawSCAD', version: APP_VERSION },
      });
      this._notify('notifications/initialized');
      this.ready = true;
    } catch (err) {
      console.error('MCP handshake failed:', err.message);
    }
  }

  stop() {
    if (this.proc) {
      // Spawned as `npx -y openscad-mcp-server` with shell:true, so this.proc
      // is the shell — killing it orphans the npx and node grandchildren,
      // which then outlive the app, keep the profile directory busy, and are
      // why closing ClawSCAD used to leave a process tree behind. Kill the
      // whole tree; taskkill is the only thing on Windows that does.
      const pid = this.proc.pid;
      try { this.proc.kill(); } catch {}
      if (process.platform === 'win32' && pid) {
        try {
          require('child_process').execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
        } catch {} // already gone, or never started — both fine
      }
      this.proc = null;
      this.ready = false;
    }
  }

  _processBuffer() {
    // MCP uses newline-delimited JSON
    let nl;
    while ((nl = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) {
            p.reject(new Error(msg.error.message || 'MCP error'));
          } else {
            p.resolve(msg.result);
          }
        }
      } catch {}
    }
  }

  _send(method, params) {
    return new Promise((resolve, reject) => {
      if (!this.proc) return reject(new Error('MCP not running'));
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
      this.proc.stdin.write(msg);
      // Timeout after 30s
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('MCP timeout'));
        }
      }, 30000);
    });
  }

  _notify(method, params) {
    if (!this.proc) return;
    const msg = JSON.stringify({ jsonrpc: '2.0', method, ...(params ? { params } : {}) }) + '\n';
    this.proc.stdin.write(msg);
  }

  async callTool(name, args) {
    if (!this.ready) await this.start();
    if (!this.ready) throw new Error('MCP server not available');
    const result = await this._send('tools/call', { name, arguments: args });
    if (result && result.isError) {
      throw new Error(result.content?.[0]?.text || 'Tool error');
    }
    return result;
  }

  async renderPng(scadCode, opts = {}) {
    return this.callTool('render_scad_png', {
      scadCode,
      width: opts.width || 800,
      height: opts.height || 600,
      cameraPreset: opts.cameraPreset || 'isometric',
    });
  }

  async exportStl(scadCode, filename) {
    return this.callTool('export_scad_stl', { scadCode, filename });
  }
}

const mcpClient = new McpClient();

// ── Multi-Window State ──────────────────────────────────────────────────
// Each BrowserWindow gets its own context: workspace, checkpoints, pty, watcher.
// Claude in each window sees all other open workspaces via CLAUDE.md.

const windows = new Map(); // webContents.id -> ctx

function getCtx(event) {
  return windows.get(event.sender.id);
}

// ── Open / Close Windows ────────────────────────────────────────────────

// Where a launch with no path argument puts its project directory, in order:
//
//   1. $CLAWSCAD_WORKSPACE — the explicit override, and the same variable the
//      web port reads (web/server.js), so one setting covers both.
//   2. The workspace last opened, if it is still there. Without this, changing
//      the default below would strand an existing install's work on the old
//      path with no hint about where it went.
//   3. ~/clawscad-workspace — writable on every platform without asking, which
//      a hardcoded drive letter is not.
//
// If you keep projects elsewhere, set CLAWSCAD_WORKSPACE rather than editing
// this; `clawscad <path>` also wins over all three.
function defaultWorkspaceDir() {
  const fromEnv = process.env.CLAWSCAD_WORKSPACE;
  if (fromEnv) return path.resolve(fromEnv);

  const [lastUsed] = loadRecentPaths();
  try {
    if (lastUsed && fs.existsSync(lastUsed) && fs.statSync(lastUsed).isDirectory()) return lastUsed;
  } catch {
    // An unreadable or removed drive is not a reason to fail to launch.
  }

  return path.join(os.homedir(), 'clawscad-workspace');
}

function openWindow(wsDir) {
  if (windows.size >= MAX_WINDOWS) return null;

  wsDir = wsDir || defaultWorkspaceDir();

  const win = new BrowserWindow({
    width: 1600,
    height: 900,
    title: 'ClawSCAD',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    backgroundColor: '#0d0d1a',
    icon: path.join(__dirname, 'icon.png'),
  });

  Menu.setApplicationMenu(null);

  const ctx = {
    window: win,
    workspaceDir: wsDir,
    state: { checkpoints: {}, active: null },
    fileWatcher: null,
    ptyProcess: null,
    renderQueue: [],
    isRendering: false,
    renderFormat: '3mf',
    pipelineChild: null,
    pipelineJobDir: null,
    pipelineJob: null,
  };

  const wcId = win.webContents.id;
  windows.set(wcId, ctx);

  win.loadFile('index.html');

  initWorkspace(ctx);
  loadState(ctx);
  startTerminal(ctx);
  startFileWatcher(ctx);

  win.setTitle(`ClawSCAD — ${ctx.workspaceDir}`);

  win.webContents.once('did-finish-load', () => {
    sendCheckpoints(ctx);
    ctxSend(ctx, 'env:status', probeEnvironment());
    ctxSend(ctx, 'terminal:label', { kind: ctx.terminalKind || 'shell', binary: ctx.terminalBinary || null });
    if (ctx.state.active && ctx.state.checkpoints[ctx.state.active]) {
      const cp = ctx.state.checkpoints[ctx.state.active];
      sendFileContent(ctx, cp.file);
      const scadPath = path.join(ctx.workspaceDir, cp.file);
      const tmfPath = scadPath.replace(/\.scad$/, '.3mf');
      const stlPath = scadToStl(scadPath);
      if (fs.existsSync(tmfPath)) {
        sendModel(ctx, tmfPath, '3mf');
      } else if (fs.existsSync(stlPath)) {
        sendModel(ctx, stlPath, 'stl');
      } else {
        enqueueRender(ctx, scadPath);
      }
    }
  });

  win.on('closed', () => {
    // `closing` must be set BEFORE anything is killed: node-pty's onExit is
    // async, so attachRespawn's handler runs after this whole block, and
    // without the flag it resurrects a fallback shell into a window that no
    // longer exists (see killPty).
    ctx.closing = true;
    if (ctx.fileWatcher) ctx.fileWatcher.close();
    killPty(ctx, 'ptyProcess');
    killPty(ctx, 'ptyProcess2');
    if (ctx.pipelineChild) try { ctx.pipelineChild.kill(); } catch {}
    ctx.window = null; // Mark as destroyed so ctxSend won't touch it
    windows.delete(wcId);
    updateAllClaudeMd();
  });

  updateAllClaudeMd();
  addRecentPath(wsDir);
  return ctx;
}

// ── Workspace Init ──────────────────────────────────────────────────────

const CLAUDE_MD_RULES = `## File Rules (NEVER break these)
- **NEVER modify or overwrite an existing .scad file.** Every .scad file is an immutable checkpoint. Overwriting one destroys the user's version history. Always create a NEW file.
- **Name each .scad file** with a short creative descriptive name in kebab-case (max 30 characters, no sequential numbers). The name should hint at what changed. Good: \`hollow-shaft-gear.scad\`, \`rounded-blue-body.scad\`, \`tapered-legs-v2.scad\`. Bad: \`model_003.scad\`, \`update.scad\`.
- **First line of every .scad file MUST be a comment** describing what this version adds or changes, e.g.: \`// Hollowed center, added 6 bolt holes around the flange\`. This is shown to the user as a tooltip in the checkpoint history.

## Colors — use them extensively
OpenSCAD's \`color()\` function is fully supported. **Color every part** of your models to make them visually clear:
\`\`\`scad
color("SteelBlue") body();
color([0.8, 0.2, 0.1]) accent_ring();
color("#44cc88", 0.8) transparent_cover();
\`\`\`
Supported formats: named colors (CSS/SVG names like "Red", "SteelBlue", "Gold"), \`[r,g,b]\` floats 0-1, \`[r,g,b,a]\` with alpha, hex \`"#rrggbb"\`, \`"#rrggbbaa"\`.
When the user asks to change colors, create a new file (never modify the old one) with the color changes.

## Workflow
1. Read \`active.scad\` to understand the current model
2. Create a new .scad file building on it (never modify the original)
3. **Use the OpenSCAD MCP server to validate your work** — this is critical:
   - After creating a .scad file, use the MCP \`render\` tool to render it and visually inspect the result
   - Use \`validate_scad\` to check for syntax errors before rendering
   - Use \`analyze_model\` to check bounding box and dimensions match what the user asked for
   - If the render shows problems, create a new fixed .scad file (still never modify the broken one)
   - Use \`render_perspectives\` to check the model from multiple angles
4. The app auto-detects new .scad files and adds them to the checkpoint history tree
5. Users can click any checkpoint to go back and branch from it — every file is permanent

## MCP Tools Available
You have access to the \`openscad\` MCP server with these tools — **use them proactively**:
- \`render_single\` / \`render_perspectives\` — render the model to see what it looks like
- \`validate_scad\` — check syntax before rendering (saves time)
- \`analyze_model\` — get bounding box, dimensions, triangle count
- \`export\` — export to STL, 3MF, AMF, etc.
- \`check_openscad\` — verify OpenSCAD is installed and working
- \`get_libraries\` — discover installed OpenSCAD libraries

**Always render and visually verify your output.** Don't just write code and hope — use the MCP tools to see the result and iterate if needed.

## Auto-Iteration
ClawSCAD automatically validates your .scad files when they are created. If a render fails:
- Errors are written to \`RENDER_ERRORS.md\` in this workspace
- You will receive a message asking you to fix the issue
- **Read RENDER_ERRORS.md**, understand the problem, and create a NEW fixed .scad file
- Keep iterating until the render succeeds — don't present broken models to the user
- Only stop when you have a clean render with no errors

## Mesh-Derived Checkpoints
Some checkpoints are generated from a 3D mesh rather than written by hand — the .scad file \`import()\`s a mesh file instead of describing geometry with primitives. Treat these as a **starting point to branch from, not a finished part**:
- Never edit a mesh-derived .scad directly to add features. Branch into a NEW .scad that \`difference()\`s or \`union()\`s additional parametric geometry into the imported mesh (e.g. wrap the \`import()\` in \`difference() { import("meshes/x.stl"); translate([...]) cylinder(...); }\` to cut a hole).
- Mesh-derived sculpts suit organic, decorative, or freeform shapes. For anything tolerance-critical (snap fits, threads, mating parts, load-bearing features), model it fully parametrically instead of relying on the imported mesh.
- Keep the same checkpoint discipline: the imported mesh file is immutable too — never regenerate or overwrite it in place.`;

// The app only ever owns the content between these markers — anything a
// user writes before/after them in CLAUDE.md is never touched.
const CLAUDE_MD_START = '<!-- clawscad:rules:start -->';
const CLAUDE_MD_END = '<!-- clawscad:rules:end -->';

function updateAllClaudeMd() {
  // Filter out destroyed windows
  const live = Array.from(windows.values()).filter((c) => c.window !== null);
  const allWorkspaces = live.map((c) => c.workspaceDir);
  for (const ctx of live) {
    try { writeClaudeMd(ctx, allWorkspaces); } catch {}
  }
}

function buildClaudeMdBlock(ctx, allWorkspaces) {
  const others = allWorkspaces.filter((w) => w !== ctx.workspaceDir);
  let md = `# ClawSCAD Workspace — MANDATORY RULES\n\n${CLAUDE_MD_RULES}\n`;

  if (others.length > 0) {
    md += `\n## Multi-Project Context\n`;
    md += `ClawSCAD currently has ${allWorkspaces.length} projects open. You can reference designs across projects:\n`;
    for (const w of allWorkspaces) {
      const label = path.basename(w);
      if (w === ctx.workspaceDir) {
        md += `- **This workspace** (${label}): \`${w}\`\n`;
      } else {
        md += `- ${label}: \`${w}\`\n`;
      }
    }
    md += `\nTo import a part from another project:\n\`\`\`scad\nuse <${others[0]}/filename.scad>\n\`\`\`\n`;
    md += `You can read any file from these paths. If the user asks you to combine or reference designs from other projects, read the relevant .scad files directly.\n`;
  }

  return md.replace(/\n+$/, '');
}

// Writes the app's generated rules into a delimited managed block inside
// CLAUDE.md instead of overwriting the whole file, so any hand-written
// content a user has in their workspace's CLAUDE.md survives every
// window open/close. See CLAUDE_MD_START/END.
function writeClaudeMd(ctx, allWorkspaces) {
  const filePath = path.join(ctx.workspaceDir, 'CLAUDE.md');
  const block = buildClaudeMdBlock(ctx, allWorkspaces);
  const managed = `${CLAUDE_MD_START}\n${block}\n${CLAUDE_MD_END}`;

  let existing = '';
  try {
    existing = fs.readFileSync(filePath, 'utf-8');
  } catch {}

  let output;
  if (!existing) {
    // No file yet — create it with just the managed block.
    output = managed + '\n';
  } else {
    const startIdx = existing.indexOf(CLAUDE_MD_START);
    const endIdx = existing.indexOf(CLAUDE_MD_END);
    if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
      // Replace only the block's contents; everything before/after is
      // preserved byte-for-byte.
      output = existing.slice(0, startIdx) + managed + existing.slice(endIdx + CLAUDE_MD_END.length);
    } else {
      // Existing hand-written file with no markers — never clobber it.
      // Prepend the managed block once; future runs will hit the marker
      // path above and leave the user's content alone.
      output = managed + '\n\n' + existing;
    }
  }

  fs.writeFileSync(filePath, output);
}

function initWorkspace(ctx) {
  fs.mkdirSync(ctx.workspaceDir, { recursive: true });

  // MCP server config — merge into existing settings
  const claudeDir = path.join(ctx.workspaceDir, '.claude');
  const settingsFile = path.join(claudeDir, 'settings.json');
  fs.mkdirSync(claudeDir, { recursive: true });
  let settings = {};
  try {
    if (fs.existsSync(settingsFile)) {
      settings = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
    }
  } catch {}
  if (!settings.mcpServers) settings.mcpServers = {};
  settings.mcpServers.openscad = {
    command: 'npx',
    args: ['-y', 'openscad-mcp-server'],
    // Point the MCP server at the same bundled binary ClawSCAD uses
    env: { OPENSCAD_PATH: getOpenscadBin() },
  };
  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
}

// ── State Management ────────────────────────────────────────────────────

function statePath(ctx) {
  return path.join(ctx.workspaceDir, STATE_FILE);
}

function loadState(ctx) {
  try {
    if (fs.existsSync(statePath(ctx))) {
      ctx.state = JSON.parse(fs.readFileSync(statePath(ctx), 'utf-8'));
    }
  } catch {
    ctx.state = { checkpoints: {}, active: null };
  }
  if (!ctx.state || typeof ctx.state !== 'object') ctx.state = { checkpoints: {}, active: null };
  if (!ctx.state.checkpoints) ctx.state.checkpoints = {};
  reconcileWorkspace(ctx);
}

// Adopt .scad files that exist on disk but aren't in the registry.
//
// The watcher starts with ignoreInitial:true, so anything created while the app
// was closed — a plain `claude` CLI session, a claw-gen run, a git checkout or
// pull — was invisible forever. For a tool whose whole promise is "every file is
// a permanent checkpoint you can come back to", silently omitting real work is
// the worst failure available, and it had already happened: this workspace's
// registry stopped at sport-wall-climbers while three later .scad files sat on
// disk unlisted.
//
// Non-destructive by construction: it only ADDS records. It never rewrites
// active.scad and never repoints an active checkpoint the user already has.
function reconcileWorkspace(ctx) {
  let files;
  try {
    files = fs
      .readdirSync(ctx.workspaceDir)
      .filter((f) => f.endsWith('.scad') && f !== ACTIVE_FILE);
  } catch {
    return;
  }

  const known = new Set(Object.values(ctx.state.checkpoints).map((c) => c.file));
  const missing = files
    .filter((f) => !known.has(f))
    .map((f) => {
      const full = path.join(ctx.workspaceDir, f);
      let mtime = 0;
      try { mtime = fs.statSync(full).mtimeMs; } catch {}
      return { file: f, full, mtime };
    })
    // Oldest first, so the adopted chain runs in the order the work was actually done.
    .sort((a, b) => a.mtime - b.mtime);

  // A dangling active pointer (its checkpoint was deleted) would otherwise
  // parent every adopted node to an id that no longer exists.
  if (ctx.state.active && !ctx.state.checkpoints[ctx.state.active]) ctx.state.active = null;

  let parent = ctx.state.active || newestCheckpointId(ctx) || null;

  for (const m of missing) {
    const id = generateId();
    ctx.state.checkpoints[id] = {
      file: m.file,
      parent,
      label: path.basename(m.file, '.scad').replace(/[_-]/g, ' ').substring(0, 30),
      description: extractDescription(m.full),
      kind: detectKind(m.full),
      sessionId: null,
      // mtime, not now — an adopted file's real age is what makes the tree honest.
      created: new Date(m.mtime || Date.now()).toISOString(),
      discovered: true,
    };
    parent = id;
  }

  // Only initialise a missing pointer; never move one the user already set.
  if (!ctx.state.active) ctx.state.active = newestCheckpointId(ctx);

  if (missing.length) saveState(ctx);
}

function newestCheckpointId(ctx) {
  const entries = Object.entries(ctx.state.checkpoints);
  if (!entries.length) return null;
  return entries.sort(
    (a, b) => new Date(a[1].created || 0) - new Date(b[1].created || 0)
  )[entries.length - 1][0];
}

// A mesh-derived checkpoint import()s geometry instead of describing it. The
// workspace rule is branch-don't-edit for these, so the tree needs to say which
// is which — see the generated-sculpt section of the workspace CLAUDE.md.
function detectKind(scadPath) {
  try {
    const src = fs.readFileSync(scadPath, 'utf-8');
    // Strip comments FIRST, then look for the call. Testing a "no slash before
    // import(" pattern instead would also reject a division on the same line,
    // so `translate([0,0,-h/2]) import("x.stl");` silently read as parametric —
    // mislabelling exactly the file the branch-don't-edit rule protects.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    return /\bimport\s*\(/.test(code) ? 'generated' : 'parametric';
  } catch {
    return 'parametric';
  }
}

function saveState(ctx) {
  fs.writeFileSync(statePath(ctx), JSON.stringify(ctx.state, null, 2));
}

function generateId() {
  return 'cp_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
}

function extractDescription(scadPath) {
  try {
    const content = fs.readFileSync(scadPath, 'utf-8');
    const lines = content.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('//')) {
        const comment = trimmed.slice(2).trim();
        if (comment.length > 0) return comment;
      }
      if (trimmed.length > 0 && !trimmed.startsWith('//')) break;
    }
  } catch {}
  return '';
}

// Claude Code encodes a project's cwd into a directory name under
// ~/.claude/projects/ by replacing every character outside [A-Za-z0-9] with
// a literal '-', one-for-one — no stripping, no collapsing. Verified against
// real on-disk project directories: "E:\Work" -> "E--Work" (colon and
// backslash each become one dash), "E:\$RECYCLE.BIN" -> "E---RECYCLE-BIN"
// (colon, backslash, '$' and '.' each become one dash), and a workspace at
// "E:\clawscad-workspace" -> "E--clawscad-workspace". The previous
// implementation only replaced '/', so on Windows paths (which use '\' and
// ':') it never matched Claude Code's real directory naming and sessionId was
// always null.
function getEncodedCwd(dir) {
  return dir.replace(/[^a-zA-Z0-9]/g, '-');
}

function detectCurrentSessionId(ctx) {
  const encoded = getEncodedCwd(ctx.workspaceDir);
  const projectDir = path.join(os.homedir(), '.claude', 'projects', encoded);
  try {
    if (!fs.existsSync(projectDir)) return null;
    const files = fs
      .readdirSync(projectDir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => ({
        name: path.basename(f, '.jsonl'),
        mtime: fs.statSync(path.join(projectDir, f)).mtimeMs,
      }))
      .sort((a, b) => b.mtime - a.mtime);
    return files.length > 0 ? files[0].name : null;
  } catch {
    return null;
  }
}

function addCheckpoint(ctx, scadFile) {
  const basename = path.basename(scadFile);

  const existing = Object.values(ctx.state.checkpoints).find((c) => c.file === basename);
  if (existing) return;
  if (basename === ACTIVE_FILE) return;

  const description = extractDescription(scadFile);
  const sessionId = detectCurrentSessionId(ctx);

  const id = generateId();
  ctx.state.checkpoints[id] = {
    file: basename,
    parent: ctx.state.active,
    label: path.basename(basename, '.scad').replace(/[_-]/g, ' ').substring(0, 30),
    description,
    kind: detectKind(scadFile),
    sessionId,
    created: new Date().toISOString(),
  };

  ctx.state.active = id;
  saveState(ctx);
  copyToActive(ctx, basename);
  sendCheckpoints(ctx);
  sendFileContent(ctx, basename);

  return id;
}

function selectCheckpoint(ctx, id) {
  if (!ctx.state.checkpoints[id]) return;
  ctx.state.active = id;
  saveState(ctx);

  const cp = ctx.state.checkpoints[id];
  copyToActive(ctx, cp.file);
  sendCheckpoints(ctx);
  sendFileContent(ctx, cp.file);

  const scadPath = path.join(ctx.workspaceDir, cp.file);
  const tmfPath = scadPath.replace(/\.scad$/, '.3mf');
  const stlPath = scadToStl(scadPath);
  if (fs.existsSync(tmfPath)) {
    sendModel(ctx, tmfPath, '3mf');
  } else if (fs.existsSync(stlPath)) {
    sendModel(ctx, stlPath, 'stl');
  } else {
    enqueueRender(ctx, scadPath);
  }
}

function copyToActive(ctx, scadFilename) {
  const src = path.join(ctx.workspaceDir, scadFilename);
  const dst = path.join(ctx.workspaceDir, ACTIVE_FILE);
  try { fs.copyFileSync(src, dst); } catch {}
}

function sendCheckpoints(ctx) {
  ctxSend(ctx, 'checkpoint:update', ctx.state);
}

// ── Render Queue ────────────────────────────────────────────────────────

function enqueueRender(ctx, scadPath) {
  ctx.renderQueue = ctx.renderQueue.filter((p) => p !== scadPath);
  ctx.renderQueue.push(scadPath);
  processRenderQueue(ctx);
}

function processRenderQueue(ctx) {
  if (ctx.isRendering || ctx.renderQueue.length === 0) return;
  ctx.isRendering = true;
  const scadPath = ctx.renderQueue.shift();
  // .3mf is the deliverable standard, so every render starts by attempting it.
  // The STL fallback is scoped to the one file that needed it and is cleared as
  // soon as that file resolves — it used to flip ctx.renderFormat for the rest
  // of the session, so one bad 3mf silently killed colour until the app restarted.
  const format = ctx.stlFallbackFor === scadPath ? 'stl' : '3mf';
  ctx.renderFormat = format;
  const outputPath = scadPath.replace(/\.scad$/, format === '3mf' ? '.3mf' : '.stl');

  ctxSend(ctx, 'render:start', { file: path.basename(scadPath) });

  // Manifold where the binary has it: ~50x on boolean-heavy models. Omitted
  // silently on older binaries, where the flag is a hard argument error.
  const renderArgs = [...manifoldArgs(), '-o', outputPath, scadPath];

  execFile(getOpenscadBin(), renderArgs, { timeout: 120000, env: openscadEnv() }, (err, stdout, stderr) => {
    ctx.isRendering = false;
    const fault = classifyRenderFailure(err, outputPath);

    if (fault === 'environment') {
      // NOT a model problem. Never write RENDER_ERRORS.md and never nudge Claude
      // to "create a fixed .scad" — the model may be perfect and Claude cannot
      // install a binary. Surface it as a setup fault instead.
      ctx.stlFallbackFor = null;
      ctxSend(ctx, 'render:env-error', {
        file: path.basename(scadPath),
        binary: getOpenscadBin(),
        code: (err && err.code) || 'UNKNOWN',
        error: (err && err.message) || 'OpenSCAD could not be started',
      });
      processRenderQueue(ctx);
      return;
    }

    if (fault) {
      // Retry a failed 3mf once as STL, for this file only. Not for timeouts —
      // a heavy model would just burn another two minutes.
      if (format === '3mf' && fault !== 'timeout') {
        ctx.stlFallbackFor = scadPath;
        ctx.renderQueue.unshift(scadPath);
        processRenderQueue(ctx);
        return;
      }
      ctx.stlFallbackFor = null;
      const errorText = stderr || (err && err.message) || 'Unknown error';
      const errors = parseOpenSCADErrors(errorText);
      ctxSend(ctx, 'render:error', {
        file: path.basename(scadPath),
        error: errorText,
        errors,
        fault,
      });
      // Auto-iteration: only a genuine model rejection is Claude's to fix.
      if (fault === 'model') {
        writeRenderErrors(ctx, path.basename(scadPath), errorText, errors);
      }
    } else {
      ctx.stlFallbackFor = null;
      if (stderr && stderr.includes('WARNING')) {
        ctxSend(ctx, 'render:warning', { file: path.basename(scadPath), warnings: stderr });
      }
      sendModel(ctx, outputPath, ctx.renderFormat);
      ctxSend(ctx, 'render:complete', { file: path.basename(scadPath) });
      clearRenderErrors(ctx);
    }

    processRenderQueue(ctx);
  });
}

// Three very different faults used to collapse into one "Render Failed":
//   environment — no binary, no permission. Nothing about the model is wrong.
//   timeout     — the model may be correct and merely heavy (boolean-heavy
//                 BOSL2/metaball work routinely is).
//   model       — OpenSCAD ran and rejected the geometry. Only this one is
//                 Claude's to fix, and only this one may write RENDER_ERRORS.md.
function classifyRenderFailure(err, outputPath) {
  if (err) {
    if (err.code === 'ENOENT' || err.code === 'EACCES' || err.code === 'EPERM') return 'environment';
    if (err.killed || err.signal === 'SIGTERM' || err.code === 'ETIMEDOUT') return 'timeout';
  }
  if (err || !fs.existsSync(outputPath)) return 'model';
  return null;
}

function parseOpenSCADErrors(stderr) {
  const errors = [];
  if (!stderr) return errors;
  const regex = /(?:ERROR|WARNING):\s*(.*?)(?:\s+in file\s+"([^"]+)",\s*line\s*(\d+))?$/gm;
  let match;
  while ((match = regex.exec(stderr)) !== null) {
    errors.push({ message: match[1], file: match[2] || '', line: match[3] ? parseInt(match[3]) : 0 });
  }
  return errors;
}

function writeRenderErrors(ctx, filename, errorText, errors) {
  // Write a RENDER_ERRORS.md that Claude can read to understand what went wrong
  const errFile = path.join(ctx.workspaceDir, 'RENDER_ERRORS.md');
  const errorLines = errors.map((e) => `- Line ${e.line}: ${e.message}`).join('\n');
  fs.writeFileSync(
    errFile,
    `# Render Failed: ${filename}\n\n` +
      `The last render of \`${filename}\` failed with errors.\n` +
      `**Create a NEW fixed .scad file** (never modify the broken one).\n\n` +
      `## Errors\n${errorLines || errorText}\n\n` +
      `## Raw Output\n\`\`\`\n${errorText.substring(0, 2000)}\n\`\`\`\n`
  );

  // Offer the nudge; don't type it. The old code wrote this sentence straight
  // into the pty 2s after a failure, with a comment claiming it only fired when
  // Claude was idle — there was no idle check, so it could splice into a
  // half-typed line and mangle whatever the user was writing.
  ctxSend(ctx, 'claude:nudge', {
    file: filename,
    message:
      `The render of ${filename} failed. Read RENDER_ERRORS.md for details and create a fixed version.`,
  });
}

function clearRenderErrors(ctx) {
  const errFile = path.join(ctx.workspaceDir, 'RENDER_ERRORS.md');
  try { if (fs.existsSync(errFile)) fs.unlinkSync(errFile); } catch {}
}

function scadToStl(scadPath) {
  return scadPath.replace(/\.scad$/, '.stl');
}

function sendModel(ctx, filePath, format) {
  try {
    const data = fs.readFileSync(filePath);
    ctxSend(ctx, 'model:update', {
      data,
      path: filePath,
      format: format || 'stl',
      checkpointId: ctx.state.active,
    });
  } catch {}
}

function ctxSend(ctx, channel, data) {
  try {
    if (ctx.window && !ctx.window.isDestroyed() && ctx.window.webContents && !ctx.window.webContents.isDestroyed()) {
      ctx.window.webContents.send(channel, data);
    }
  } catch {
    // Window was destroyed during send — safe to ignore
  }
}

// Same guarantees as ctxSend, fanned out to every live window. For state that
// belongs to the app rather than to one workspace — currently the auto-update
// status, which is identical in every window.
function broadcastAll(channel, data) {
  for (const ctx of windows.values()) ctxSend(ctx, channel, data);
}

function sendFileContent(ctx, scadFilename) {
  const filePath = path.join(ctx.workspaceDir, scadFilename);
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    ctxSend(ctx, 'file:content', { path: filePath, name: scadFilename, content });
  } catch {}
}

// ── Session Discovery ───────────────────────────────────────────────────

function discoverSessions(ctx) {
  const encoded = getEncodedCwd(ctx.workspaceDir);
  const projectDir = path.join(os.homedir(), '.claude', 'projects', encoded);
  const sessions = [];
  try {
    if (!fs.existsSync(projectDir)) return sessions;
    const files = fs.readdirSync(projectDir).filter((f) => f.endsWith('.jsonl'));
    for (const file of files) {
      const sessionId = path.basename(file, '.jsonl');
      const fp = path.join(projectDir, file);
      const stat = fs.statSync(fp);
      let firstMessage = '';
      try {
        const content = fs.readFileSync(fp, 'utf-8');
        for (const line of content.split('\n').filter(Boolean)) {
          try {
            const entry = JSON.parse(line);
            if (entry.type === 'user' && entry.message) {
              const msg = typeof entry.message === 'string'
                ? entry.message
                : entry.message.content || JSON.stringify(entry.message);
              firstMessage = msg.substring(0, 80);
              break;
            }
          } catch {}
        }
      } catch {}
      sessions.push({ sessionId, firstMessage, lastModified: stat.mtimeMs, date: stat.mtime.toISOString() });
    }
    sessions.sort((a, b) => b.lastModified - a.lastModified);
  } catch {}
  return sessions;
}

// ── Terminal ────────────────────────────────────────────────────────────

function spawnPty(ctx, cmd, args = []) {
  const proc = pty.spawn(cmd, args, {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: ctx.workspaceDir,
    env: { ...process.env, COLORTERM: 'truecolor' },
  });
  proc.onData((data) => ctxSend(ctx, 'terminal:data', data));
  return proc;
}

function spawnPty2(ctx, cmd, args = []) {
  const proc = pty.spawn(cmd, args, {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: ctx.workspaceDir,
    env: { ...process.env, COLORTERM: 'truecolor' },
  });
  proc.onData((data) => ctxSend(ctx, 'terminal2:data', data));
  return proc;
}

// Fall back to a plain interactive shell. Returns null rather than throwing:
// startTerminal() is called from openWindow(), and an uncaught spawn failure
// here used to take the rest of that function down with it, silently skipping
// startFileWatcher() and updateAllClaudeMd() for the whole window.
function spawnFallbackShell(ctx) {
  try { return spawnPty(ctx, DEFAULT_SHELL, []); } catch { return null; }
}

// Re-spawn a shell whenever the current pty exits, so closing Claude leaves a
// usable terminal instead of a dead panel.
// Kill a pty we are killing ON PURPOSE, without waking the respawn handler.
//
// attachRespawn exists so a crashed Claude CLI still leaves a usable terminal
// behind — but node-pty's onExit cannot tell a crash from a deliberate kill,
// so EVERY intentional kill (window close, workspace switch, Restart Claude)
// also spawned a fallback shell that nothing then owned. On window close that
// orphan kept the main process alive, so app.quit() never completed and the
// dead-but-running app went on holding the Chromium user-data profile — which
// is why the next launch's `window` event never arrived and Playwright's
// firstWindow() timed out. One leak, three call sites, two symptoms.
function killPty(ctx, key) {
  const proc = ctx[key];
  if (!proc) return;
  proc.killedIntentionally = true;
  try { proc.kill(); } catch {}
  ctx[key] = null;
}

function attachRespawn(ctx) {
  const proc = ctx.ptyProcess;
  if (!proc) return;
  proc.onExit(() => {
    // onExit is async, so by the time this runs the window may already be
    // gone and ctx.ptyProcess may already point at its replacement. Respawn
    // only for an unexpected death of the pty we actually registered on.
    if (proc.killedIntentionally || ctx.closing || !ctx.window) return;
    if (ctx.ptyProcess && ctx.ptyProcess !== proc) return;
    ctx.ptyProcess = spawnFallbackShell(ctx);
    setTerminalKind(ctx, ctx.ptyProcess ? 'shell' : 'dead', ctx.ptyProcess ? DEFAULT_SHELL : null);
    if (ctx.ptyProcess) ctx.ptyProcess.onExit(() => {});
  });
}

// Spawn a pty running the Claude Code CLI. If the binary can't be found (or
// fails to launch), drop the user into a normal shell with a hint on how to
// install it — we don't silently install global npm packages on their behalf.
// resolveClaude() is what makes this work on Windows, where the CLI is
// claude.exe / claude.cmd rather than a bare `claude` on PATH.
function spawnClaude(ctx, args = []) {
  // Test runs launch a fresh Electron app per test — dozens of times per
  // suite. Starting the real Claude Code CLI each time costs seconds, holds a
  // handle on the temp workspace (the EBUSY cleanup warnings), and is slow to
  // die, which is what pushed electronApp.close() past Playwright's worker
  // teardown budget and left the NEXT launch waiting for a window that never
  // came. The specs never drive the CLI — ui-surfaces.spec.js injects
  // terminal:label over IPC rather than reading a real spawn — so the suite
  // runs against the fallback shell instead.
  //
  // Deliberately guards only the SPAWN, not resolveClaude(): probeEnvironment()
  // must keep reporting the CLI as present, or the composer shows its
  // "Claude Code CLI needed" degradation card and disables submit, breaking
  // composer.spec.js's enabled-after-typing assertion.
  if (process.env.CLAWSCAD_DISABLE_CLAUDE === '1') {
    const proc = spawnFallbackShell(ctx);
    setTerminalKind(ctx, proc ? 'shell' : 'dead', proc ? DEFAULT_SHELL : null);
    return proc;
  }
  const bin = resolveClaude();
  if (bin) {
    try {
      const proc = spawnPty(ctx, bin, args);
      setTerminalKind(ctx, 'claude', bin);
      return proc;
    } catch {}
  }
  const proc = spawnFallbackShell(ctx);
  // The pane used to be labelled "Claude Code" over a cmd.exe. Say what actually
  // spawned — and offer the way back rather than only an install URL.
  setTerminalKind(ctx, proc ? 'shell' : 'dead', proc ? DEFAULT_SHELL : null);
  if (proc) {
    ctxSend(ctx, 'terminal:data',
      '\r\n\x1b[33mClaude Code CLI not found.\x1b[0m Install it from ' +
      'https://docs.claude.com/en/docs/claude-code/setup then use Restart Claude.\r\n\r\n');
  }
  return proc;
}

function setTerminalKind(ctx, kind, binary) {
  ctx.terminalKind = kind;
  ctx.terminalBinary = binary;
  ctxSend(ctx, 'terminal:label', { kind, binary });
}

function startTerminal(ctx) {
  ctx.ptyProcess = spawnClaude(ctx, []);
  attachRespawn(ctx);
}

function restartTerminal(ctx, args = []) {
  killPty(ctx, 'ptyProcess'); // without this, Restart Claude left a shell behind every time
  ctx.ptyProcess = spawnClaude(ctx, args);
  attachRespawn(ctx);
}

// ── File Watcher ────────────────────────────────────────────────────────

function startFileWatcher(ctx) {
  ctx.fileWatcher = chokidar.watch(ctx.workspaceDir, {
    ignored: /(^|[/\\])(\.|node_modules|clawscad\.json)/,
    ignoreInitial: true,
    depth: 1,
    awaitWriteFinish: { stabilityThreshold: 200 },
  });
  ctx.fileWatcher.on('add', (fp) => handleFileEvent(ctx, fp));
  ctx.fileWatcher.on('change', (fp) => handleFileEvent(ctx, fp));
  // An unhandled 'error' event is FATAL in Node — it would kill the whole
  // Electron main process (every window, the MCP server child, both terminal
  // ptys), not just this watcher. A deleted/unmounted/permission-denied
  // workspace dir should only stop live checkpoint detection, not the app.
  ctx.fileWatcher.on('error', (err) => {
    console.warn(`File watcher error for ${ctx.workspaceDir}:`, err.message);
  });
}

function handleFileEvent(ctx, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const basename = path.basename(filePath);
  if (basename === ACTIVE_FILE) return;

  if (ext === '.scad') {
    const id = addCheckpoint(ctx, filePath);
    if (id) {
      enqueueRender(ctx, filePath);
    } else {
      const activeCp = ctx.state.active && ctx.state.checkpoints[ctx.state.active];
      if (activeCp && activeCp.file === basename) {
        enqueueRender(ctx, filePath);
      }
    }
  } else if (ext === '.stl') {
    const scadName = basename.replace(/\.stl$/, '.scad');
    const activeCp = ctx.state.active && ctx.state.checkpoints[ctx.state.active];
    if (activeCp && activeCp.file === scadName) {
      sendModel(ctx, filePath, 'stl');
    }
  }
}

// ── Generation Pipeline (claw-gen) ──────────────────────────────────────
// Spawns the `claw-gen` CLI (contract: docs/generation-pipeline.md) as a one-shot
// child process per action — no daemon, no persistent port. The app knows
// nothing about providers/backends; that all comes from `claw-gen backends
// --json`. Resolution order: user setting -> PATH.

const PIPELINE_ACTIONS = new Set(['images', 'mesh', 'prep', 'checkpoint']);
const PIPELINE_IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const PIPELINE_MAX_IMAGE_BYTES = 25 * 1024 * 1024;

function pipelineSettingsPath() {
  return path.join(app.getPath('userData'), 'pipeline-settings.json');
}

function loadPipelineSettings() {
  try {
    return JSON.parse(fs.readFileSync(pipelineSettingsPath(), 'utf-8'));
  } catch {
    return {};
  }
}

function savePipelineSettings(settings) {
  fs.writeFileSync(pipelineSettingsPath(), JSON.stringify(settings, null, 2));
}

function findOnPath(exeName) {
  const dirs = (process.env.PATH || process.env.Path || '').split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32'
    ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';')
    : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, exeName + ext);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {}
    }
  }
  return null;
}

function resolvePipelineCli() {
  const settings = loadPipelineSettings();
  if (settings.cliPath) {
    try {
      if (fs.statSync(settings.cliPath).isFile()) return settings.cliPath;
    } catch {}
  }
  return findOnPath('claw-gen');
}

function pipelineCliStatus() {
  const settings = loadPipelineSettings();
  return { userSet: settings.cliPath || null, resolved: resolvePipelineCli() };
}

function pipelineErrorEvent(stage, code, message) {
  return { v: 1, ts: new Date().toISOString(), stage, event: 'error', code, message, job: '' };
}

function startPipelineAction(ctx, { action, args = [], job } = {}) {
  if (!ctx) return { error: 'no window' };
  if (ctx.pipelineChild) return { error: 'already-running' };
  if (!PIPELINE_ACTIONS.has(action)) return { error: 'bad-action' };

  const cli = resolvePipelineCli();
  if (!cli) {
    ctxSend(ctx, 'pipeline:event', pipelineErrorEvent(action, 'not-configured', 'No generation pipeline configured'));
    return { error: 'not-configured' };
  }

  const argv = [action, ...args.map(String), '--json-events'];
  if (job) argv.push('--job', String(job));

  let child;
  try {
    child = spawn(cli, argv, { cwd: ctx.workspaceDir, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    ctxSend(ctx, 'pipeline:event', pipelineErrorEvent(action, 'spawn-failed', err.message));
    return { error: err.message };
  }

  ctx.pipelineChild = child;
  let stdoutBuf = '';

  child.stdout.on('data', (chunk) => {
    stdoutBuf += chunk.toString();
    let nl;
    while ((nl = stdoutBuf.indexOf('\n')) !== -1) {
      const line = stdoutBuf.slice(0, nl).trim();
      stdoutBuf = stdoutBuf.slice(nl + 1);
      if (!line) continue;
      let evt;
      try {
        evt = JSON.parse(line);
      } catch {
        continue;
      }
      if (evt.job) ctx.pipelineJob = evt.job;
      if (evt.event === 'candidate' && typeof evt.path === 'string') {
        // job dir is two levels up from img/<file>
        ctx.pipelineJobDir = path.dirname(path.dirname(evt.path));
      }
      ctxSend(ctx, 'pipeline:event', evt);
    }
  });

  child.stderr.on('data', (chunk) => {
    ctxSend(ctx, 'pipeline:log', chunk.toString());
  });

  child.on('error', (err) => {
    ctx.pipelineChild = null;
    ctxSend(ctx, 'pipeline:event', pipelineErrorEvent(action, 'spawn-failed', err.message));
    ctxSend(ctx, 'pipeline:exit', { action, code: null });
  });

  child.on('exit', (code) => {
    ctx.pipelineChild = null;
    ctxSend(ctx, 'pipeline:exit', { action, code });
  });

  return { started: true };
}

// ── IPC Handlers ────────────────────────────────────────────────────────

ipcMain.on('terminal:input', (event, data) => {
  const ctx = getCtx(event);
  if (ctx && ctx.ptyProcess) ctx.ptyProcess.write(data);
});

ipcMain.handle('terminal2:spawn', (event) => {
  const ctx = getCtx(event);
  if (!ctx || ctx.ptyProcess2) return;
  try {
    ctx.ptyProcess2 = spawnPty2(ctx, resolveClaude() || 'claude', []);
  } catch {
    ctx.ptyProcess2 = spawnPty2(ctx, DEFAULT_SHELL, []);
  }
  ctx.ptyProcess2.onExit(() => { ctx.ptyProcess2 = null; });
});

ipcMain.handle('terminal2:kill', (event) => {
  const ctx = getCtx(event);
  if (ctx && ctx.ptyProcess2) {
    try { ctx.ptyProcess2.kill(); } catch {}
    ctx.ptyProcess2 = null;
  }
});

ipcMain.on('terminal2:input', (event, data) => {
  const ctx = getCtx(event);
  if (ctx && ctx.ptyProcess2) ctx.ptyProcess2.write(data);
});

ipcMain.on('terminal2:resize', (event, { cols, rows }) => {
  const ctx = getCtx(event);
  if (ctx && ctx.ptyProcess2) try { ctx.ptyProcess2.resize(cols, rows); } catch {}
});

ipcMain.on('terminal:resize', (event, { cols, rows }) => {
  const ctx = getCtx(event);
  if (ctx && ctx.ptyProcess) try { ctx.ptyProcess.resize(cols, rows); } catch {}
});

ipcMain.handle('workspace:get', (event) => {
  const ctx = getCtx(event);
  return ctx ? ctx.workspaceDir : '';
});

ipcMain.handle('file:read', (_, filePath) => {
  try { return fs.readFileSync(filePath, 'utf-8'); } catch { return null; }
});

ipcMain.handle('file:read-model', (_, filePath, format) => {
  try {
    if (!fs.existsSync(filePath)) return null;
    const data = fs.readFileSync(filePath);
    return { data, format };
  } catch {
    return null;
  }
});

ipcMain.handle('file:save', (_, filePath, content) => {
  try { fs.writeFileSync(filePath, content, 'utf-8'); return true; } catch { return false; }
});

// Save the editor buffer as a NEW .scad instead of overwriting the open one.
//
// Every .scad is an immutable checkpoint, but the app's own Edit + Save wrote
// straight over the file with no warning — making the UI the easiest way in the
// product to violate the product's central rule, with no undo. The watcher picks
// the new file up and it becomes a child checkpoint on its own.
ipcMain.handle('file:save-as-checkpoint', async (event, currentPath, content) => {
  const ctx = getCtx(event);
  if (!ctx) return { ok: false };

  const base = path.basename(currentPath || 'model.scad', '.scad');
  let suggested = path.join(ctx.workspaceDir, `${base}-v2.scad`);
  for (let n = 2; fs.existsSync(suggested) && n < 100; n++) {
    suggested = path.join(ctx.workspaceDir, `${base}-v${n}.scad`);
  }

  const win = BrowserWindow.fromWebContents(event.sender);
  const res = await dialog.showSaveDialog(win, {
    title: 'Save as new checkpoint',
    defaultPath: suggested,
    filters: [{ name: 'OpenSCAD', extensions: ['scad'] }],
  });
  if (res.canceled || !res.filePath) return { ok: false, canceled: true };

  try {
    fs.writeFileSync(res.filePath, content, 'utf-8');
    return { ok: true, file: path.basename(res.filePath) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Is this file a checkpoint the registry is tracking? The renderer uses this to
// decide whether Save needs the branch-don't-overwrite treatment.
ipcMain.handle('checkpoint:is-tracked', (event, filePath) => {
  const ctx = getCtx(event);
  if (!ctx || !filePath) return false;
  const base = path.basename(filePath);
  return Object.values(ctx.state.checkpoints).some((c) => c.file === base);
});

ipcMain.handle('checkpoint:list', (event) => {
  const ctx = getCtx(event);
  return ctx ? ctx.state : { checkpoints: {}, active: null };
});

ipcMain.handle('sessions:list', (event) => {
  const ctx = getCtx(event);
  return ctx ? discoverSessions(ctx) : [];
});

ipcMain.handle('sessions:new', (event) => {
  const ctx = getCtx(event);
  if (ctx) restartTerminal(ctx, []);
});

ipcMain.handle('sessions:continue', (event) => {
  const ctx = getCtx(event);
  if (ctx) restartTerminal(ctx, ['--continue']);
});

ipcMain.handle('sessions:resume', (event, sessionId) => {
  const ctx = getCtx(event);
  if (ctx) restartTerminal(ctx, ['--resume', sessionId]);
});

ipcMain.handle('checkpoint:select', (event, id) => {
  const ctx = getCtx(event);
  if (ctx) selectCheckpoint(ctx, id);
});

ipcMain.handle('checkpoint:restore-session', (event, id) => {
  const ctx = getCtx(event);
  if (!ctx) return false;
  const cp = ctx.state.checkpoints[id];
  if (cp && cp.sessionId) {
    restartTerminal(ctx, ['--resume', cp.sessionId]);
    return true;
  }
  return false;
});

ipcMain.handle('checkpoint:rename', (event, id, label) => {
  const ctx = getCtx(event);
  if (ctx && ctx.state.checkpoints[id]) {
    ctx.state.checkpoints[id].label = label;
    saveState(ctx);
    sendCheckpoints(ctx);
  }
});

// "Delete" only ever removed the registry record — the .scad stayed on disk,
// and since reconcileWorkspace() landed it now comes BACK on the next open.
// deleteFile is the opt-in that makes the word true.
ipcMain.handle('checkpoint:delete', (event, id, opts = {}) => {
  const ctx = getCtx(event);
  if (!ctx || !ctx.state.checkpoints[id]) return { ok: false };
  const record = ctx.state.checkpoints[id];
  const parentId = record.parent;
  for (const [, cp] of Object.entries(ctx.state.checkpoints)) {
    if (cp.parent === id) cp.parent = parentId;
  }
  delete ctx.state.checkpoints[id];
  if (ctx.state.active === id) ctx.state.active = parentId;
  saveState(ctx);

  let fileDeleted = false;
  if (opts && opts.deleteFile && record.file && record.file !== ACTIVE_FILE) {
    try {
      fs.unlinkSync(path.join(ctx.workspaceDir, record.file));
      fileDeleted = true;
    } catch {}
  }

  sendCheckpoints(ctx);
  return { ok: true, fileDeleted };
});

// ── Generation Pipeline IPC ──────────────────────────────────────────────

ipcMain.handle('pipeline:get-cli-path', () => pipelineCliStatus());

ipcMain.handle('pipeline:set-cli-path', (event, cliPath) => {
  const settings = loadPipelineSettings();
  settings.cliPath = cliPath || null;
  savePipelineSettings(settings);
  return pipelineCliStatus();
});

// Three very different situations used to collapse into {configured:false}:
// no install, a CLI that crashed, and a CLI that ran fine but has no usable
// backend right now (the pipeline deliberately reports `busy` under memory
// pressure — "busy, try the API backend" is USEFUL, and it was unreachable).
ipcMain.handle('pipeline:backends', (event) => {
  const ctx = getCtx(event);
  const cli = resolvePipelineCli();
  if (!cli) return Promise.resolve({ configured: false, state: 'not-found' });
  return new Promise((resolve) => {
    execFile(
      cli,
      ['backends', '--json'],
      { cwd: ctx ? ctx.workspaceDir : undefined, timeout: 15000 },
      (err, stdout, stderr) => {
        let parsed = null;
        try {
          const lines = (stdout || '').trim().split('\n').filter(Boolean);
          parsed = JSON.parse(lines[lines.length - 1]);
        } catch {}
        if (!parsed) {
          resolve({
            configured: false,
            state: 'cli-error',
            cli,
            detail: (stderr || (err && err.message) || 'claw-gen produced no parsable output').trim(),
          });
          return;
        }
        parsed.cli = cli;
        if (parsed.configured) {
          const images = (parsed.backends || []).filter((b) => !b.kind || b.kind === 'image');
          parsed.state = images.some((b) => b.ok) ? 'ready' : 'no-backend';
        } else {
          parsed.state = parsed.state || 'not-configured';
        }
        resolve(parsed);
      }
    );
  });
});

// The locate flow existed over IPC but no element ever called it — the feature
// was unreachable from the UI, and its README link pointed at a README with no
// pipeline section at all.
ipcMain.handle('pipeline:locate-cli', async (event) => {
  const ctx = getCtx(event);
  const res = await dialog.showOpenDialog(ctx ? ctx.window : null, {
    title: 'Locate the claw-gen CLI',
    properties: ['openFile'],
    filters: process.platform === 'win32'
      ? [{ name: 'Executables', extensions: ['exe', 'cmd', 'bat'] }, { name: 'All files', extensions: ['*'] }]
      : [{ name: 'All files', extensions: ['*'] }],
  });
  if (res.canceled || !res.filePaths[0]) return { canceled: true, ...pipelineCliStatus() };
  const settings = loadPipelineSettings();
  settings.cliPath = res.filePaths[0];
  savePipelineSettings(settings);
  return pipelineCliStatus();
});

ipcMain.handle('pipeline:start', (event, opts) => {
  const ctx = getCtx(event);
  return startPipelineAction(ctx, opts || {});
});

ipcMain.handle('pipeline:cancel', (event) => {
  const ctx = getCtx(event);
  if (ctx && ctx.pipelineChild) {
    try {
      ctx.pipelineChild.kill('SIGTERM');
      return true;
    } catch {
      return false;
    }
  }
  return false;
});

ipcMain.handle('pipeline:read-image', (event, filePath) => {
  const ctx = getCtx(event);
  if (!ctx || !ctx.pipelineJobDir || typeof filePath !== 'string') return null;
  try {
    const resolved = path.resolve(filePath);
    const jobDir = path.resolve(ctx.pipelineJobDir);
    if (resolved !== jobDir && !resolved.startsWith(jobDir + path.sep)) return null;
    const ext = path.extname(resolved).toLowerCase();
    if (!PIPELINE_IMAGE_EXTS.has(ext)) return null;
    const stat = fs.statSync(resolved);
    if (!stat.isFile() || stat.size > PIPELINE_MAX_IMAGE_BYTES) return null;
    const data = fs.readFileSync(resolved);
    const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
    return `data:${mime};base64,${data.toString('base64')}`;
  } catch {
    return null;
  }
});

// ── Feature package registration ─────────────────────────────────────────
// clawscad:anchor:modules — each later package (composer, uploads, gallery,
// presets) registers its own IPC handlers here. Every module exports
// register(ipcMain, deps); see main/registry.js for the deps shape. Nothing
// above this block may be renamed or moved to satisfy a feature package —
// ask P0 (foundations) to add a dep instead.
{
  const deps = require('./main/registry.js').buildDeps({
    getCtx, ctxSend, windows, addCheckpoint, sendCheckpoints, copyToActive,
    saveState, APP_VERSION, dialog, app,
  });
  require('./main/composer.js').register(ipcMain, deps);
  require('./main/uploads.js').register(ipcMain, deps);
  require('./main/gallery.js').register(ipcMain, deps);
  require('./main/presets.js').register(ipcMain, deps);
  require('./main/categories.js').register(ipcMain, deps);
  require('./main/tools.js').register(ipcMain, deps);
}

ipcMain.handle('app:get-version', () => APP_VERSION);

// ── Auto-update ──────────────────────────────────────────────────────────
// Handlers are registered here (module load) so a renderer that asks for the
// status before whenReady still gets an answer; the polling loop only starts
// in whenReady below.
const updater = require('./main/updater.js');
updater.register(ipcMain);

// ── Environment / terminal / nudge IPC ───────────────────────────────────

ipcMain.handle('env:status', (event) => probeEnvironment());

ipcMain.handle('env:locate-openscad', async (event) => {
  const ctx = getCtx(event);
  const res = await dialog.showOpenDialog(ctx ? ctx.window : null, {
    title: 'Locate the OpenSCAD binary',
    properties: ['openFile'],
  });
  if (res.canceled || !res.filePaths[0]) return { canceled: true };
  // getOpenscadBin() re-reads process.env.OPENSCAD_BINARY on every call (it is
  // a function, not a module-load constant), so this takes effect for every
  // child spawned from here on in this session without needing a restart.
  process.env.OPENSCAD_BINARY = res.filePaths[0];
  _manifoldSupported = null;
  await probeManifold();
  return { binary: res.filePaths[0], note: 'set for this session — export OPENSCAD_BINARY to make it permanent' };
});

// The nudge is delivered only when the user presses the button.
ipcMain.handle('claude:send-nudge', (event, message) => {
  const ctx = getCtx(event);
  if (!ctx || !ctx.ptyProcess || typeof message !== 'string') return false;
  ctx.ptyProcess.write(message.replace(/\r?\n/g, ' ') + '\r');
  return true;
});

ipcMain.handle('terminal:restart', (event) => {
  const ctx = getCtx(event);
  if (!ctx) return { kind: 'dead' };
  restartTerminal(ctx, []);
  return { kind: ctx.terminalKind, binary: ctx.terminalBinary };
});

ipcMain.handle('app:open-render-errors', (event) => {
  const ctx = getCtx(event);
  if (!ctx) return false;
  const errFile = path.join(ctx.workspaceDir, 'RENDER_ERRORS.md');
  if (!fs.existsSync(errFile)) return false;
  shell.openPath(errFile);
  return true;
});

ipcMain.handle('app:open-readme', () => {
  const readmePath = path.join(__dirname, 'README.md');
  if (fs.existsSync(readmePath)) shell.openPath(readmePath);
});

// ── MCP Direct Access ───────────────────────────────────────────────────

ipcMain.handle('mcp:render-png', async (event, scadCode, opts) => {
  try {
    return await mcpClient.renderPng(scadCode, opts);
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('mcp:export-stl', async (event, scadCode, filename) => {
  try {
    return await mcpClient.exportStl(scadCode, filename);
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('mcp:status', async () => {
  return { ready: mcpClient.ready };
});

ipcMain.handle('render:force', (event) => {
  const ctx = getCtx(event);
  if (!ctx) return;
  const cp = ctx.state.active && ctx.state.checkpoints[ctx.state.active];
  if (cp) {
    const scadPath = path.join(ctx.workspaceDir, cp.file);
    if (fs.existsSync(scadPath)) {
      // Delete stale output so it re-renders fresh
      const stlPath = scadToStl(scadPath);
      const tmfPath = scadPath.replace(/\.scad$/, '.3mf');
      try { if (fs.existsSync(stlPath)) fs.unlinkSync(stlPath); } catch {}
      try { if (fs.existsSync(tmfPath)) fs.unlinkSync(tmfPath); } catch {}
      enqueueRender(ctx, scadPath);
    }
  }
});

ipcMain.handle('app:new-project-window', async (event) => {
  if (windows.size >= MAX_WINDOWS) return null;
  const ctx = getCtx(event);
  // Default to current workspace name + "-2"
  const currentBase = ctx ? path.basename(ctx.workspaceDir) : 'clawscad-workspace';
  const defaultDir = path.join(
    ctx ? path.dirname(ctx.workspaceDir) : os.homedir(),
    currentBase + '-2'
  );
  const result = await dialog.showOpenDialog(ctx ? ctx.window : null, {
    properties: ['openDirectory', 'createDirectory'],
    title: 'New Project Workspace',
    defaultPath: defaultDir,
  });
  if (!result.canceled && result.filePaths[0]) {
    openWindow(result.filePaths[0]);
    return result.filePaths[0];
  }
  return null;
});

ipcMain.handle('app:open-workspace', async (event) => {
  const ctx = getCtx(event);
  if (!ctx) return null;
  const result = await dialog.showOpenDialog(ctx.window, {
    properties: ['openDirectory'],
    title: 'Open Workspace',
  });
  if (!result.canceled && result.filePaths[0]) {
    // Replace this window's workspace
    if (ctx.fileWatcher) ctx.fileWatcher.close();
    killPty(ctx, 'ptyProcess');
    ctx.workspaceDir = result.filePaths[0];
    initWorkspace(ctx);
    loadState(ctx);
    startTerminal(ctx);
    startFileWatcher(ctx);
    ctx.window.setTitle(`ClawSCAD — ${ctx.workspaceDir}`);
    sendCheckpoints(ctx);
    updateAllClaudeMd();
    return ctx.workspaceDir;
  }
  return null;
});

ipcMain.handle('app:open-workspace-in-files', (event) => {
  const ctx = getCtx(event);
  if (ctx) shell.openPath(ctx.workspaceDir);
});

ipcMain.handle('app:get-print-settings-path', (event) => {
  const ctx = getCtx(event);
  return ctx ? path.join(ctx.workspaceDir, 'clawscad.json') : '';
});

ipcMain.handle('app:export', async (event, format) => {
  const ctx = getCtx(event);
  if (!ctx) return { error: 'No window' };
  // Returning bare null here made the button silently do nothing, forever, with
  // no way to find out why. Say which of the three reasons it was.
  const cp = ctx.state.active && ctx.state.checkpoints[ctx.state.active];
  if (!cp) return { error: 'Nothing to export — select a checkpoint first.' };
  const scadPath = path.join(ctx.workspaceDir, cp.file);
  if (!fs.existsSync(scadPath)) {
    return { error: `${cp.file} is no longer on disk.` };
  }

  const filters = {
    stl: [{ name: 'STL', extensions: ['stl'] }],
    '3mf': [{ name: '3MF', extensions: ['3mf'] }],
    png: [{ name: 'PNG Image', extensions: ['png'] }],
  };
  const ext = format === 'png' ? '.png' : format === '3mf' ? '.3mf' : '.stl';
  const defaultName = cp.file.replace(/\.scad$/, ext);

  const result = await dialog.showSaveDialog(ctx.window, {
    title: `Export as ${format.toUpperCase()}`,
    defaultPath: path.join(ctx.workspaceDir, defaultName),
    filters: filters[format] || filters.stl,
  });
  if (result.canceled) return { canceled: true };

  const args = format === 'png'
    ? [...manifoldArgs(), '--imgsize=1920,1080', '-o', result.filePath, scadPath]
    : [...manifoldArgs(), '-o', result.filePath, scadPath];

  // OpenSCAD can run for minutes here. The only feedback used to be a toast
  // that expired after 4s, so a long export looked like nothing happening.
  ctxSend(ctx, 'export:start', { format, file: cp.file, target: result.filePath });

  return new Promise((resolve) => {
    execFile(getOpenscadBin(), args, { timeout: 300000, env: openscadEnv() }, (err, stdout, stderr) => {
      const payload = err
        ? { error: stderr || err.message, fault: classifyRenderFailure(err, result.filePath) }
        : { path: result.filePath };
      ctxSend(ctx, 'export:done', { format, ...payload });
      resolve(payload);
    });
  });
});

// Recent paths management
const recentPathsFile = path.join(app.getPath('userData'), 'recent-workspaces.json');

function loadRecentPaths() {
  try {
    if (fs.existsSync(recentPathsFile)) {
      return JSON.parse(fs.readFileSync(recentPathsFile, 'utf-8')).slice(0, 20);
    }
  } catch {}
  return [];
}

function addRecentPath(wsPath) {
  let recent = loadRecentPaths();
  recent = recent.filter((p) => p !== wsPath);
  recent.unshift(wsPath);
  recent = recent.slice(0, 20);
  fs.writeFileSync(recentPathsFile, JSON.stringify(recent, null, 2));
}

ipcMain.handle('app:list-recent', () => loadRecentPaths());

ipcMain.handle('app:browse-dir', (_, dirPath) => {
  try {
    if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) return null;
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    const result = [];
    // Parent directory
    const parent = path.dirname(dirPath);
    if (parent !== dirPath) result.push({ name: '..', path: parent, isDir: true });
    // Directories first, then .scad files
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      if (e.isDirectory()) result.push({ name: e.name + '/', path: path.join(dirPath, e.name), isDir: true });
    }
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith('.scad')) {
        result.push({ name: e.name, path: path.join(dirPath, e.name), isDir: false });
      }
    }
    return { dir: dirPath, entries: result };
  } catch {
    return null;
  }
});

ipcMain.handle('app:open-path', async (event, inputPath) => {
  const ctx = getCtx(event);
  if (!ctx) return null;
  try {
    const stat = fs.statSync(inputPath);
    if (stat.isDirectory()) {
      // Switch workspace to this directory
      if (ctx.fileWatcher) ctx.fileWatcher.close();
      killPty(ctx, 'ptyProcess');
      ctx.workspaceDir = inputPath;
      initWorkspace(ctx);
      loadState(ctx);
      startTerminal(ctx);
      startFileWatcher(ctx);
      ctx.window.setTitle(`ClawSCAD — ${ctx.workspaceDir}`);
      sendCheckpoints(ctx);
      updateAllClaudeMd();
      addRecentPath(inputPath);
      return { type: 'workspace', path: inputPath };
    } else if (stat.isFile() && inputPath.endsWith('.scad')) {
      // Copy the .scad file into the workspace and add as checkpoint
      const basename = path.basename(inputPath);
      const dest = path.join(ctx.workspaceDir, basename);
      if (!fs.existsSync(dest)) fs.copyFileSync(inputPath, dest);
      return { type: 'file', path: dest };
    }
  } catch {}
  return null;
});

ipcMain.handle('app:toggle-devtools', (event) => {
  const ctx = getCtx(event);
  if (ctx) ctx.window.webContents.toggleDevTools();
});

ipcMain.handle('app:window-count', () => windows.size);

// ── App Lifecycle ───────────────────────────────────────────────────────

app.whenReady().then(async () => {
  // Start the MCP server early so it's warm by the time we need it
  mcpClient.start().catch(() => {});
  // Probe once, before any render can need the answer.
  probeManifold().catch(() => {});
  // Auto-update: first check is delayed inside init() so it never competes with
  // the work above.
  updater.init({ broadcast: broadcastAll });

  const cliArg = process.argv.slice(2).find((a) => !a.startsWith('-'));
  const wsDir = cliArg ? path.resolve(cliArg) : defaultWorkspaceDir();
  openWindow(wsDir);
});

app.on('window-all-closed', () => {
  mcpClient.stop();
  app.quit();
});

// Belt and braces for the leak killPty closes: quit must be able to complete
// even if a window was destroyed by a path that skipped its 'closed' handler
// (a crash, a forced quit, or a spec's electronApp.close()). A single
// surviving pty or pipeline child is enough to keep the main process — and
// its lock on the user-data profile — alive indefinitely.
app.on('before-quit', () => {
  for (const ctx of windows.values()) {
    ctx.closing = true;
    if (ctx.fileWatcher) try { ctx.fileWatcher.close(); } catch {}
    killPty(ctx, 'ptyProcess');
    killPty(ctx, 'ptyProcess2');
    if (ctx.pipelineChild) try { ctx.pipelineChild.kill(); } catch {}
  }
  try { mcpClient.stop(); } catch {}
});
