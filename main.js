const { app, BrowserWindow, ipcMain, Menu, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const pty = require('node-pty');
const chokidar = require('chokidar');
const { execFile, spawn, spawnSync } = require('child_process');

// Resolve the OpenSCAD binary: prefer bundled copy, fall back to env / system.
// In packaged builds, extraResources lands at process.resourcesPath.
// In dev, look in the repo's vendors/ directory (populated by download-openscad.js).
function resolveOpenSCAD() {
  const base = app.isPackaged
    ? process.resourcesPath
    : path.join(__dirname, 'vendors');
  const candidates = {
    linux:  path.join(base, 'openscad-linux.AppImage'),
    darwin: path.join(base, 'OpenSCAD.app', 'Contents', 'MacOS', 'OpenSCAD'),
    win32:  path.join(base, 'openscad-win', 'openscad.exe'),
  };
  const bundled = candidates[process.platform];
  if (bundled && fs.existsSync(bundled)) return bundled;
  return process.env.OPENSCAD_BINARY || 'openscad';
}
const OPENSCAD_BIN = resolveOpenSCAD();

// Resolve the Claude Code CLI binary. Checks the standalone installer location
// (~/.claude/local/claude), user/system PATH, and other common install paths.
// Returns null if not found — startTerminal will auto-install via npm in that case.
let _claudeBin = null;
function resolveClaude() {
  if (_claudeBin) return _claudeBin;
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

// Resolve the OpenCode CLI binary. Mirrors resolveClaude() so the two agents are
// interchangeable. Returns null if not found — startTerminal falls back to a
// shell in that case so the user sees a helpful hint instead of a crash.
let _opencodeBin = null;
function resolveOpencode() {
  if (_opencodeBin) return _opencodeBin;
  const candidates = [
    path.join(os.homedir(), '.local', 'bin', 'opencode'),
    '/opt/homebrew/bin/opencode',
    '/usr/local/bin/opencode',
  ];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    candidates.push(path.join(dir, 'opencode'));
  }
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const c of candidates) {
    for (const ext of exts) {
      try { if (fs.existsSync(c + ext)) { _opencodeBin = c + ext; return c + ext; } } catch {}
    }
  }
  return null;
}

// Resolve the OpenAI Codex CLI binary. Codex's native installer typically
// places it in ~/.local/bin; Homebrew and npm installations are found via the
// explicit common paths or PATH scan below.
let _codexBin = null;
function resolveCodex() {
  if (_codexBin) return _codexBin;
  const candidates = [
    path.join(os.homedir(), '.local', 'bin', 'codex'),
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex',
  ];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    candidates.push(path.join(dir, 'codex'));
  }
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const c of candidates) {
    for (const ext of exts) {
      try { if (fs.existsSync(c + ext)) { _codexBin = c + ext; return c + ext; } } catch {}
    }
  }
  return null;
}

// Codex accepts project MCP configuration as CLI overrides. Supplying these
// per launch avoids changing the user's global config and also works before a
// newly-created workspace has been marked trusted.
function codexLaunchArgs() {
  return [
    '-c', 'mcp_servers.openscad.command="npx"',
    '-c', 'mcp_servers.openscad.args=["-y","openscad-mcp-server"]',
    '-c', `mcp_servers.openscad.env.OPENSCAD_PATH=${JSON.stringify(OPENSCAD_BIN)}`,
  ];
}

// Pick the agent backend for a workspace. Preserve Claude as the first choice
// for existing installs, then prefer Codex over OpenCode when both are present.
function defaultAgent() {
  if (resolveClaude()) return 'claude';
  if (resolveCodex()) return 'codex';
  if (resolveOpencode()) return 'opencode';
  return 'claude';
}

// Per-agent CLI specifics: binary resolver, launch configuration, and
// resume/continue mappings are normalized behind one interface.
const AGENT_SPECS = {
  claude: {
    name: 'Claude Code',
    bin: () => resolveClaude(),
    installUrl: 'https://docs.claude.com/en/docs/claude-code/setup',
    continueArgs: () => ['--continue'],
    resumeArgs: (id) => ['--resume', id],
  },
  codex: {
    name: 'Codex',
    bin: () => resolveCodex(),
    installUrl: 'https://developers.openai.com/codex/cli',
    launchArgs: () => codexLaunchArgs(),
    continueArgs: () => ['resume', '--last'],
    resumeArgs: (id) => ['resume', id],
  },
  opencode: {
    name: 'OpenCode',
    bin: () => resolveOpencode(),
    installUrl: 'https://opencode.ai/docs',
    continueArgs: () => ['-c'],
    resumeArgs: (id) => ['-s', id],
  },
};

function isKnownAgent(agent) {
  return typeof agent === 'string' && Object.prototype.hasOwnProperty.call(AGENT_SPECS, agent);
}

function agentSpec(ctx) {
  const selected = ctx && ctx.state && ctx.state.agent;
  return isKnownAgent(selected) ? AGENT_SPECS[selected] : AGENT_SPECS.claude;
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
  if (process.platform === 'linux' && OPENSCAD_BIN.endsWith('.AppImage')) {
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
    ptyProcess2: null,
    closing: false,
    renderQueue: [],
    isRendering: false,
    renderFormat: '3mf',
  };

  const wcId = win.webContents.id;
  windows.set(wcId, ctx);

  win.loadFile('index.html');

  // Order matters: loadState first so ctx.state.agent is available to
  // initWorkspace() (it writes opencode.json only when agent==='opencode'),
  // then refresh vision and the rules file before the terminal spawns.
  loadState(ctx);
  initWorkspace(ctx);
  if (ctx.firstRun) {
    // Don't pre-spawn an agent on first run — the picker decides which CLI
    // to launch. Drop into a plain shell so the right pane isn't blank, and
    // let `agent:set` (from the picker) do the real launch + vision refresh.
    ctx.ptyProcess = spawnPty(ctx, DEFAULT_SHELL, []);
    ctx.ptyProcess.onExit(() => {});
  } else {
    refreshAgent(ctx);
    startTerminal(ctx);
  }
  startFileWatcher(ctx);

  win.setTitle(`ClawSCAD — ${ctx.workspaceDir}`);

  win.webContents.once('did-finish-load', () => {
    sendCheckpoints(ctx);
    if (ctx.firstRun) {
      // Ask the renderer to present the harness picker. It calls agent:set,
      // which marks agentChosen=true, restarts the terminal with the chosen
      // CLI, and refreshes vision/CLAUDE.md.
      ctxSend(ctx, 'agent:request-pick', null);
    } else {
      // Push the resolved agent/model info to the renderer now that it can
      // receive events (refreshAgent ran before the window was ready).
      ctxSend(ctx, 'agent:info', {
        agent: ctx.state.agent,
        model: ctx.modelLabel || null,
        visionSupported: !!ctx.visionSupported,
      });
    }
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
    ctx.closing = true;
    if (ctx.fileWatcher) ctx.fileWatcher.close();
    const primary = ctx.ptyProcess;
    const secondary = ctx.ptyProcess2;
    ctx.ptyProcess = null;
    ctx.ptyProcess2 = null;
    if (primary) try { primary.kill(); } catch {}
    if (secondary) try { secondary.kill(); } catch {}
    ctx.window = null; // Mark as destroyed so ctxSend won't touch it
    windows.delete(wcId);
    updateAllAgentRules();
  });

  updateAllAgentRules();
  addRecentPath(wsDir);
  return ctx;
}

// ── Workspace Init ──────────────────────────────────────────────────────

// Workspace rules shared by Claude Code, Codex, and OpenCode. Claude reads
// CLAUDE.md, Codex reads AGENTS.md, and OpenCode uses the compatible rules file.
//
// The "vision" branch controls whether image-returning MCP tools are offered.
// When the active model can't view images (e.g. a text-only opencode model),
// we tell the agent to skip render_single/render_perspectives/render_scad_png
// and rely on validate_scad + analyze_model instead.
const RULES_FILE = `## File Rules (NEVER break these)
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
When the user asks to change colors, create a new file (never modify the old one) with the color changes.`;

const RULES_WORKFLOW_VISION = `## Workflow
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

**Always render and visually verify your output.** Don't just write code and hope — use the MCP tools to see the result and iterate if needed.`;

const RULES_WORKFLOW_NO_VISION = `## Workflow
1. Read \`active.scad\` to understand the current model
2. Create a new .scad file building on it (never modify the original)
3. **Validate programmatically with the OpenSCAD MCP server**:
   - Use \`validate_scad\` to check syntax before rendering (saves time)
   - Use \`analyze_model\` to check bounding box, dimensions, and triangle count match what the user asked for
   - If validation reports a problem, create a NEW fixed .scad file (still never modify the broken one)
4. The app auto-detects new .scad files and adds them to the checkpoint history tree
5. Users can click any checkpoint to go back and branch from it — every file is permanent

## MCP Tools Available
You have access to the \`openscad\` MCP server. **Your current model cannot view images**, so do NOT call \`render_single\`, \`render_perspectives\`, \`render_scad_png\`, or any other image-returning tool — you won't be able to see its output. Rely only on:
- \`validate_scad\` — check syntax before rendering (saves time)
- \`analyze_model\` — get bounding box, dimensions, triangle count
- \`export\` — export to STL, 3MF, AMF, etc.
- \`check_openscad\` — verify OpenSCAD is installed and working
- \`get_libraries\` — discover installed OpenSCAD libraries

ClawSCAD renders every new .scad file automatically in the user's 3D viewport; the user inspects the result, not you. **Verify correctness programmatically** with \`validate_scad\` + \`analyze_model\` instead of visual inspection.`;

const RULES_AUTOITERATION = `## Auto-Iteration
ClawSCAD automatically validates your .scad files when they are created. If a render fails:
- Errors are written to \`RENDER_ERRORS.md\` in this workspace
- You will receive a message asking you to fix the issue
- **Read RENDER_ERRORS.md**, understand the problem, and create a NEW fixed .scad file
- Keep iterating until the render succeeds — don't present broken models to the user
- Only stop when you have a clean render with no errors`;

// Compose the full rules body for a workspace. Vision-aware: when the active
// model can't view images we strip the visual-inspection workflow and the
// image-returning MCP tools so the agent doesn't waste calls it can't consume.
function buildRules(ctx) {
  const vision = ctx.visionSupported;
  return (
    RULES_FILE + '\n\n' +
    (vision ? RULES_WORKFLOW_VISION : RULES_WORKFLOW_NO_VISION) + '\n\n' +
    RULES_AUTOITERATION
  );
}

function updateAllAgentRules() {
  // Filter out destroyed windows
  const live = Array.from(windows.values()).filter((c) => c.window !== null);
  const allWorkspaces = live.map((c) => c.workspaceDir);
  for (const ctx of live) {
    try { writeClaudeMd(ctx, allWorkspaces); } catch {}
  }
}

function writeClaudeMd(ctx, allWorkspaces) {
  const others = allWorkspaces.filter((w) => w !== ctx.workspaceDir);
  let md = `# ClawSCAD Workspace — MANDATORY RULES\n\n${buildRules(ctx)}\n`;

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
  writeAgentsMd(ctx, md);
}

const AGENTS_RULES_START = '<!-- CLAWSCAD MANAGED RULES START -->';
const AGENTS_RULES_END = '<!-- CLAWSCAD MANAGED RULES END -->';

// Codex reads AGENTS.md. Keep ClawSCAD's generated instructions in a managed
// block so an existing project AGENTS.md can coexist without being overwritten.
function writeAgentsMd(ctx, md) {
  const agentsPath = path.join(ctx.workspaceDir, 'AGENTS.md');
  const block = `${AGENTS_RULES_START}\n${md.trimEnd()}\n${AGENTS_RULES_END}`;
  let current = '';
  try {
    if (fs.existsSync(agentsPath)) current = fs.readFileSync(agentsPath, 'utf-8');
  } catch {}

  const start = current.indexOf(AGENTS_RULES_START);
  const end = current.indexOf(AGENTS_RULES_END, start + AGENTS_RULES_START.length);
  let next;
  if (start >= 0 && end >= start) {
    next = current.slice(0, start) + block + current.slice(end + AGENTS_RULES_END.length);
  } else if (current.trim()) {
    next = `${current.trimEnd()}\n\n${block}\n`;
  } else {
    next = `${block}\n`;
  }
  fs.writeFileSync(agentsPath, next);
}

function initWorkspace(ctx) {
  fs.mkdirSync(ctx.workspaceDir, { recursive: true });

  // Claude Code MCP server config — merge into existing settings
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
    env: { OPENSCAD_PATH: OPENSCAD_BIN },
  };
  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));

  // OpenCode MCP config — only written when opencode is the active agent.
  // Same openscad-mcp-server, but in opencode.json's `mcp` schema. Merged
  // into any existing opencode.json so user customizations are preserved.
  if (ctx.state && ctx.state.agent === 'opencode') writeOpencodeMcp(ctx);
}

// Write/merge the openscad MCP server into opencode.json. We never blow away
// existing keys (model/permissions/etc.) — only ensure `mcp.openscad` points
// at our bundled OpenSCAD binary.
function writeOpencodeMcp(ctx) {
  const cfgPath = path.join(ctx.workspaceDir, 'opencode.json');
  let cfg = {};
  try {
    if (fs.existsSync(cfgPath)) cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
  } catch {}
  if (!cfg.$schema) cfg.$schema = 'https://opencode.ai/config.json';
  if (!cfg.mcp || typeof cfg.mcp !== 'object') cfg.mcp = {};
  cfg.mcp.openscad = {
    type: 'local',
    command: ['npx', '-y', 'openscad-mcp-server'],
    environment: { OPENSCAD_PATH: OPENSCAD_BIN },
    enabled: true,
  };
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
}

// ── OpenCode model + vision detection ─────────────────────────────────────
// Resolve the configured opencode model ("provider/model") and whether it
// can view images. Uses `opencode debug config` (merged project config) and
// `opencode models <provider> --verbose` (NDJSON-ish model metadata with a
// `capabilities.input.image` boolean). Falls back to {vision: false} on any
// error so a non-vision model never gets handed image tools.
function opencodeResolvedModel(ctx) {
  const r = spawnSync('opencode', ['debug', 'config'], {
    cwd: ctx.workspaceDir, encoding: 'utf-8', timeout: 10000,
  });
  if (r.error || r.status !== 0 || !r.stdout) return null;
  try {
    const cfg = JSON.parse(r.stdout);
    return cfg.model || null;
  } catch { return null; }
}

// Parse `opencode models <provider> --verbose` output. Each model appears
// as a header line `provider/model` immediately followed by a pretty-printed
// JSON object on its own line block. We scan for the header that matches and
// accumulate the JSON until it parses.
function parseOpencodeModelsVerbose(stdout, providerID, modelID) {
  const lines = stdout.split('\n');
  let header = null;
  let buf = [];
  const flush = () => {
    if (!header) return null;
    const [p, m] = header.split('/');
    if (p === providerID && m === modelID) {
      try { return JSON.parse(buf.join('\n')); } catch { return null; }
    }
    return null;
  };
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    const isHeader =
      /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(trimmed) &&
      lines[i + 1] && lines[i + 1].trim().startsWith('{');
    if (isHeader) {
      const found = flush();
      if (found) return found;
      header = trimmed;
      buf = [];
    } else if (header) {
      buf.push(lines[i]);
    }
  }
  return flush();
}

function resolveOpencodeVision(ctx) {
  const model = opencodeResolvedModel(ctx);
  if (!model) return { model: null, visionSupported: false };
  const slash = model.indexOf('/');
  if (slash <= 0) return { model, visionSupported: false };
  const providerID = model.slice(0, slash);
  const modelID = model.slice(slash + 1);
  const r = spawnSync('opencode', ['models', providerID, '--verbose'], {
    encoding: 'utf-8', timeout: 15000,
  });
  if (r.error || r.status !== 0 || !r.stdout) return { model, visionSupported: false };
  const entry = parseOpencodeModelsVerbose(r.stdout, providerID, modelID);
  const img = entry && entry.capabilities && entry.capabilities.input && entry.capabilities.input.image;
  return { model, visionSupported: !!img };
}

// Refresh vision flag for the active agent, persist it, and notify renderer.
// Claude Code and Codex support image input; OpenCode depends on its model.
async function refreshAgent(ctx) {
  if (!ctx) return;
  if (ctx.state.agent === 'opencode') {
    try {
      const info = resolveOpencodeVision(ctx);
      ctx.visionSupported = info.visionSupported;
      ctx.modelLabel = info.model;
      ctx.state.visionSupported = info.visionSupported;
      ctx.state.model = info.model || '';
      saveState(ctx);
    } catch {
      ctx.visionSupported = false;
    }
  } else {
    ctx.visionSupported = true;
    ctx.modelLabel = null;
    ctx.state.visionSupported = true;
    ctx.state.model = '';
    saveState(ctx);
  }
  updateAllAgentRules();
  ctxSend(ctx, 'agent:info', {
    agent: ctx.state.agent,
    model: ctx.modelLabel || null,
    visionSupported: !!ctx.visionSupported,
  });
}

// ── State Management ────────────────────────────────────────────────────

function statePath(ctx) {
  return path.join(ctx.workspaceDir, STATE_FILE);
}

function loadState(ctx) {
  const stateExisted = fs.existsSync(statePath(ctx));
  try {
    if (stateExisted) {
      ctx.state = JSON.parse(fs.readFileSync(statePath(ctx), 'utf-8'));
    }
  } catch {
    ctx.state = { checkpoints: {}, active: null };
  }
  // Ensure agent is set. Persisted state from older versions won't have it,
  // and we don't want to overwrite a user's choice by defaulting in memory
  // without saving — so only default/sanitize, and let saveState persist.
  if (!isKnownAgent(ctx.state.agent)) ctx.state.agent = defaultAgent();
  // Vision: Claude and Codex support it; OpenCode defaults to unknown (false)
  // until refreshAgent() resolves the actual capability.
  ctx.visionSupported = ctx.state.agent !== 'opencode' ? true : !!ctx.state.visionSupported;
  ctx.modelLabel = ctx.state.model || null;
  // First-run detection: a brand-new workspace has no state file, or an older
  // state file that predates the agent picker. In either case the renderer
  // shows a one-time picker so the user chooses an installed agent
  // instead of silently landing on the default. The test suite opts out via
  // CLAWSCAD_DISABLE_AGENT_PICKER so the modal overlay can't block clicks.
  ctx.firstRun = !stateExisted || ctx.state.agentChosen !== true;
  if (process.env.CLAWSCAD_DISABLE_AGENT_PICKER === '1') {
    ctx.firstRun = false;
    ctx.state.agentChosen = true;
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
  if (ctx.state.agent === 'opencode') return opencodeDiscoverSessions(ctx)[0]?.sessionId || null;
  if (ctx.state.agent === 'codex') return codexDiscoverSessions(ctx)[0]?.sessionId || null;
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

  execFile(OPENSCAD_BIN, ['-o', outputPath, scadPath], { timeout: 120000, env: openscadEnv() }, (err, stdout, stderr) => {
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
  if (ctx.state.agent === 'opencode') return opencodeDiscoverSessions(ctx);
  if (ctx.state.agent === 'codex') return codexDiscoverSessions(ctx);
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

function codexSessionsRoot() {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  return path.join(codexHome, 'sessions');
}

function codexSessionFiles(root) {
  const files = [];
  const pending = [root];
  while (pending.length > 0) {
    const dir = pending.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const fp = path.join(dir, entry.name);
      if (entry.isDirectory()) pending.push(fp);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(fp);
    }
  }
  return files;
}

function codexMessageText(entry) {
  const payload = entry && entry.payload;
  if (!payload) return '';
  if (entry.type === 'event_msg' && payload.type === 'user_message') {
    return typeof payload.message === 'string' ? payload.message : '';
  }
  if (entry.type !== 'response_item' || payload.type !== 'message' || payload.role !== 'user') return '';
  if (typeof payload.content === 'string') return payload.content;
  if (!Array.isArray(payload.content)) return '';
  return payload.content
    .filter((item) => item && (item.type === 'input_text' || item.type === 'text'))
    .map((item) => item.text || '')
    .join(' ');
}

function isCodexContextMessage(message) {
  const text = message.trimStart();
  return text.startsWith('<environment_context>') ||
    text.startsWith('<permissions instructions>') ||
    text.startsWith('<collaboration_mode>') ||
    text.startsWith('<skills_instructions>');
}

// Read enough of a rollout to capture session_meta and the first real user
// prompt without loading every (potentially very large) transcript into memory.
function readCodexSessionHeader(fp) {
  const maxBytes = 512 * 1024;
  let fd;
  try {
    fd = fs.openSync(fp, 'r');
    const size = Math.min(fs.fstatSync(fd).size, maxBytes);
    const buffer = Buffer.alloc(size);
    fs.readSync(fd, buffer, 0, size, 0);
    const lines = buffer.toString('utf-8').split('\n');
    let meta = null;
    let firstMessage = '';
    for (const line of lines) {
      if (!line) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      if (!meta && entry.type === 'session_meta') meta = entry.payload || null;
      if (!firstMessage) {
        const message = codexMessageText(entry).trim();
        if (message && !isCodexContextMessage(message)) firstMessage = message.substring(0, 80);
      }
      if (meta && firstMessage) break;
    }
    return { meta, firstMessage };
  } catch {
    return { meta: null, firstMessage: '' };
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
  }
}

// Codex stores rollouts below $CODEX_HOME/sessions/YYYY/MM/DD. The first
// session_meta record includes the stable session id and cwd, allowing us to
// expose only sessions belonging to this ClawSCAD workspace.
function codexDiscoverSessions(ctx) {
  const sessions = [];
  const want = path.resolve(ctx.workspaceDir);
  for (const fp of codexSessionFiles(codexSessionsRoot())) {
    try {
      const stat = fs.statSync(fp);
      const { meta, firstMessage } = readCodexSessionHeader(fp);
      if (!meta || !meta.id || !meta.cwd || path.resolve(meta.cwd) !== want) continue;
      const lastModified = stat.mtimeMs;
      sessions.push({
        sessionId: meta.id,
        firstMessage,
        lastModified,
        date: stat.mtime.toISOString(),
      });
    } catch {}
  }
  sessions.sort((a, b) => b.lastModified - a.lastModified);
  return sessions;
}

// List opencode sessions for this workspace via `opencode session list --json`.
// Sessions are global, but each carries a `directory` field (the project root
// at creation) which we filter on so multi-project workspaces stay separate.
// Output shape mirrors the claude discovery above so the renderer is agnostic.
function opencodeDiscoverSessions(ctx) {
  const sessions = [];
  try {
    const r = spawnSync('opencode', ['session', 'list', '--format', 'json'], {
      cwd: ctx.workspaceDir, encoding: 'utf-8', timeout: 10000,
    });
    if (r.error || r.status !== 0 || !r.stdout) return sessions;
    const arr = JSON.parse(r.stdout);
    const want = path.resolve(ctx.workspaceDir);
    for (const s of (Array.isArray(arr) ? arr : [])) {
      if (s.directory && path.resolve(s.directory) !== want) continue;
      const title = (s.title || '').toString();
      const mtime = s.updated || s.created || Date.now();
      sessions.push({
        sessionId: s.id,
        firstMessage: title.substring(0, 80),
        lastModified: mtime,
        date: new Date(mtime).toISOString(),
      });
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

// Spawn a pty running the configured agent CLI. If
// the binary can't be found (or fails to launch), drop the user into a normal
// shell with a hint on how to install it — we don't silently install global
// npm packages on their behalf.
function spawnAgent(ctx, args = []) {
  const spec = agentSpec(ctx);
  // Test/probe hook: when CLAWSCAD_DISABLE_AGENT_SPAWN=1 is set, skip
  // launching the agent TUI entirely and fall back to a plain shell. Used by
  // the Playwright suite to verify IPC/config side effects without risking a
  // long-lived TUI process that can stall worker teardown.
  if (process.env.CLAWSCAD_DISABLE_AGENT_SPAWN === '1') {
    return spawnPty(ctx, DEFAULT_SHELL, []);
  }
  const bin = spec.bin();
  if (bin) {
    const launchArgs = typeof spec.launchArgs === 'function' ? spec.launchArgs(ctx) : [];
    try { return spawnPty(ctx, bin, [...launchArgs, ...args]); } catch {}
  }
  const proc = spawnPty(ctx, DEFAULT_SHELL, []);
  ctxSend(ctx, 'terminal:data',
    `\r\n\x1b[33m${spec.name} CLI not found.\x1b[0m Install it from ` +
    `${spec.installUrl} then restart the terminal.\r\n\r\n`);
  return proc;
}

function startTerminal(ctx) {
  const proc = spawnAgent(ctx, []);
  ctx.ptyProcess = proc;
  proc.onExit(() => {
    if (ctx.closing || ctx.ptyProcess !== proc) return;
    const shellProc = spawnPty(ctx, DEFAULT_SHELL, []);
    ctx.ptyProcess = shellProc;
    shellProc.onExit(() => {
      if (ctx.ptyProcess === shellProc) ctx.ptyProcess = null;
    });
  });
}

function restartTerminal(ctx, args = []) {
  const previous = ctx.ptyProcess;
  ctx.ptyProcess = null;
  if (previous) try { previous.kill(); } catch {}
  const proc = spawnAgent(ctx, args);
  ctx.ptyProcess = proc;
  proc.onExit(() => {
    if (ctx.closing || ctx.ptyProcess !== proc) return;
    const shellProc = spawnPty(ctx, DEFAULT_SHELL, []);
    ctx.ptyProcess = shellProc;
    shellProc.onExit(() => {
      if (ctx.ptyProcess === shellProc) ctx.ptyProcess = null;
    });
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
  const spec = agentSpec(ctx);
  if (process.env.CLAWSCAD_DISABLE_AGENT_SPAWN === '1') {
    ctx.ptyProcess2 = spawnPty2(ctx, DEFAULT_SHELL, []);
    ctx.ptyProcess2.onExit(() => { ctx.ptyProcess2 = null; });
    return;
  }
  const bin = spec.bin();
  const launchArgs = typeof spec.launchArgs === 'function' ? spec.launchArgs(ctx) : [];
  try {
    ctx.ptyProcess2 = bin
      ? spawnPty2(ctx, bin, launchArgs)
      : spawnPty2(ctx, DEFAULT_SHELL, []);
  } catch {
    ctx.ptyProcess2 = spawnPty2(ctx, DEFAULT_SHELL, []);
  }
  if (!bin) {
    ctxSend(ctx, 'terminal2:data',
      `\r\n\x1b[33m${spec.name} CLI not found.\x1b[0m Install it from ` +
      `${spec.installUrl} then restart the terminal.\r\n\r\n`);
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
  if (ctx) restartTerminal(ctx, agentSpec(ctx).continueArgs());
});

ipcMain.handle('sessions:resume', (event, sessionId) => {
  const ctx = getCtx(event);
  if (ctx) restartTerminal(ctx, agentSpec(ctx).resumeArgs(sessionId));
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
    restartTerminal(ctx, agentSpec(ctx).resumeArgs(cp.sessionId));
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

// ── Agent Backend Selection ─────────────────────────────────────────────
// Per-workspace switch between Claude Code, Codex, and OpenCode. Persisted in the
// state file, applied by re-initializing workspace configs (writes/refreshes
// opencode.json), rewriting agent rules, and restarting the
// terminal with the correct binary + resume flag conventions.

ipcMain.handle('agent:get', (event) => {
  const ctx = getCtx(event);
  if (!ctx) return { agent: 'claude', model: null, visionSupported: true };
  return {
    agent: ctx.state.agent,
    model: ctx.modelLabel || null,
    visionSupported: !!ctx.visionSupported,
  };
});

ipcMain.handle('agent:set', (event, agent) => {
  const ctx = getCtx(event);
  if (!ctx) return false;
  if (!isKnownAgent(agent)) return false;
  // The user has now explicitly chosen a backend — record it so the
  // first-run picker doesn't reappear on subsequent launches of this
  // workspace, and so this window's firstRun flag is cleared.
  ctx.state.agentChosen = true;
  ctx.firstRun = false;
  if (ctx.state.agent === agent) {
    // Nothing to switch, but still refresh vision in case the model changed.
    saveState(ctx);
    refreshAgent(ctx);
    return true;
  }
  ctx.state.agent = agent;
  ctx.state.visionSupported = agent !== 'opencode';
  ctx.state.model = '';
  ctx.visionSupported = ctx.state.visionSupported;
  ctx.modelLabel = null;
  saveState(ctx);
  // Re-init (re)writes opencode.json based on the new agent, then refresh
  // vision/model and rules files before relaunching the terminal.
  initWorkspace(ctx);
  refreshAgent(ctx);
  restartTerminal(ctx);
  ctxSend(ctx, 'agent:info', {
    agent: ctx.state.agent,
    model: ctx.modelLabel || null,
    visionSupported: !!ctx.visionSupported,
  });
  return true;
});

ipcMain.handle('agent:available', () => ({
  claude: !!resolveClaude(),
  codex: !!resolveCodex(),
  opencode: !!resolveOpencode(),
}));

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
    loadState(ctx);
    initWorkspace(ctx);
    refreshAgent(ctx);
    startTerminal(ctx);
    startFileWatcher(ctx);
    ctx.window.setTitle(`ClawSCAD — ${ctx.workspaceDir}`);
    sendCheckpoints(ctx);
    updateAllAgentRules();
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
    execFile(OPENSCAD_BIN, args, { timeout: 120000, env: openscadEnv() }, (err, stdout, stderr) => {
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
      loadState(ctx);
      initWorkspace(ctx);
      refreshAgent(ctx);
      startTerminal(ctx);
      startFileWatcher(ctx);
      ctx.window.setTitle(`ClawSCAD — ${ctx.workspaceDir}`);
      sendCheckpoints(ctx);
      updateAllAgentRules();
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
