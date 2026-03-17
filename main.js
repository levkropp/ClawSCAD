const { app, BrowserWindow, ipcMain, Menu, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const pty = require('node-pty');
const chokidar = require('chokidar');
const { execFile, spawn } = require('child_process');

const OPENSCAD_BIN = process.env.OPENSCAD_BINARY || 'openscad';
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
        clientInfo: { name: 'ClawSCAD', version: '0.1.0' },
      });
      this._notify('notifications/initialized');
      this.ready = true;
    } catch (err) {
      console.error('MCP handshake failed:', err.message);
    }
  }

  stop() {
    if (this.proc) {
      try { this.proc.kill(); } catch {}
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

function openWindow(wsDir) {
  if (windows.size >= MAX_WINDOWS) return null;

  wsDir = wsDir || path.join(os.homedir(), 'clawscad-workspace');

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
    if (ctx.fileWatcher) ctx.fileWatcher.close();
    if (ctx.ptyProcess) try { ctx.ptyProcess.kill(); } catch {}
    if (ctx.ptyProcess2) try { ctx.ptyProcess2.kill(); } catch {}
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
- Only stop when you have a clean render with no errors`;

function updateAllClaudeMd() {
  // Filter out destroyed windows
  const live = Array.from(windows.values()).filter((c) => c.window !== null);
  const allWorkspaces = live.map((c) => c.workspaceDir);
  for (const ctx of live) {
    try { writeClaudeMd(ctx, allWorkspaces); } catch {}
  }
}

function writeClaudeMd(ctx, allWorkspaces) {
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

  fs.writeFileSync(path.join(ctx.workspaceDir, 'CLAUDE.md'), md);
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

function getEncodedCwd(dir) {
  return dir.replace(/\//g, '-').replace(/^-/, '');
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
  const outputExt = ctx.renderFormat === '3mf' ? '.3mf' : '.stl';
  const outputPath = scadPath.replace(/\.scad$/, outputExt);

  ctxSend(ctx, 'render:start', { file: path.basename(scadPath) });

  execFile(OPENSCAD_BIN, ['-o', outputPath, scadPath], { timeout: 120000 }, (err, stdout, stderr) => {
    ctx.isRendering = false;

    if (err || !fs.existsSync(outputPath)) {
      if (ctx.renderFormat === '3mf') {
        ctx.renderFormat = 'stl';
        ctx.renderQueue.unshift(scadPath);
        processRenderQueue(ctx);
        return;
      }
      const errorText = stderr || (err && err.message) || 'Unknown error';
      const errors = parseOpenSCADErrors(errorText);
      ctxSend(ctx, 'render:error', {
        file: path.basename(scadPath),
        error: errorText,
        errors,
      });
      // Auto-iteration: write errors so Claude can see them and nudge the terminal
      writeRenderErrors(ctx, path.basename(scadPath), errorText, errors);
    } else {
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

  // Send a nudge to Claude's terminal — a visible prompt that there are errors to fix
  if (ctx.ptyProcess) {
    // Only nudge if Claude seems idle (don't interrupt mid-generation)
    // Write to pty so it appears in the conversation as user input
    const nudge =
      `The render of ${filename} failed. Read RENDER_ERRORS.md for details and create a fixed version.\n`;
    // Small delay to avoid interrupting Claude mid-output
    setTimeout(() => {
      if (ctx.ptyProcess) ctx.ptyProcess.write(nudge);
    }, 2000);
  }
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

function startTerminal(ctx) {
  const shell = process.env.SHELL || '/bin/bash';
  try {
    ctx.ptyProcess = spawnPty(ctx, 'claude', []);
  } catch {
    ctx.ptyProcess = spawnPty(ctx, shell, []);
  }
  ctx.ptyProcess.onExit(() => {
    ctx.ptyProcess = spawnPty(ctx, shell, []);
    ctx.ptyProcess.onExit(() => {});
  });
}

function restartTerminal(ctx, args = []) {
  if (ctx.ptyProcess) try { ctx.ptyProcess.kill(); } catch {}
  try {
    ctx.ptyProcess = spawnPty(ctx, 'claude', args);
  } catch {
    ctx.ptyProcess = spawnPty(ctx, process.env.SHELL || '/bin/bash', []);
  }
  ctx.ptyProcess.onExit(() => {
    ctx.ptyProcess = spawnPty(ctx, process.env.SHELL || '/bin/bash', []);
    ctx.ptyProcess.onExit(() => {});
  });
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

// ── IPC Handlers ────────────────────────────────────────────────────────

ipcMain.on('terminal:input', (event, data) => {
  const ctx = getCtx(event);
  if (ctx && ctx.ptyProcess) ctx.ptyProcess.write(data);
});

ipcMain.handle('terminal2:spawn', (event) => {
  const ctx = getCtx(event);
  if (!ctx || ctx.ptyProcess2) return;
  try {
    ctx.ptyProcess2 = spawnPty2(ctx, 'claude', []);
  } catch {
    ctx.ptyProcess2 = spawnPty2(ctx, process.env.SHELL || '/bin/bash', []);
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

ipcMain.handle('checkpoint:delete', (event, id) => {
  const ctx = getCtx(event);
  if (!ctx || !ctx.state.checkpoints[id]) return;
  const parentId = ctx.state.checkpoints[id].parent;
  for (const [, cp] of Object.entries(ctx.state.checkpoints)) {
    if (cp.parent === id) cp.parent = parentId;
  }
  delete ctx.state.checkpoints[id];
  if (ctx.state.active === id) ctx.state.active = parentId;
  saveState(ctx);
  sendCheckpoints(ctx);
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
    if (ctx.ptyProcess) try { ctx.ptyProcess.kill(); } catch {}
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
  if (!ctx) return null;
  const cp = ctx.state.active && ctx.state.checkpoints[ctx.state.active];
  if (!cp) return null;
  const scadPath = path.join(ctx.workspaceDir, cp.file);
  if (!fs.existsSync(scadPath)) return null;

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
  if (result.canceled) return null;

  const args = format === 'png'
    ? ['--imgsize=1920,1080', '-o', result.filePath, scadPath]
    : ['-o', result.filePath, scadPath];

  return new Promise((resolve) => {
    execFile(OPENSCAD_BIN, args, { timeout: 120000 }, (err, stdout, stderr) => {
      if (err) {
        resolve({ error: stderr || err.message });
      } else {
        resolve({ path: result.filePath });
      }
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
      if (ctx.ptyProcess) try { ctx.ptyProcess.kill(); } catch {}
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

  const cliArg = process.argv.slice(2).find((a) => !a.startsWith('-'));
  const wsDir = cliArg ? path.resolve(cliArg) : path.join(os.homedir(), 'clawscad-workspace');
  openWindow(wsDir);
});

app.on('window-all-closed', () => {
  mcpClient.stop();
  app.quit();
});
