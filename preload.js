const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Terminal (primary)
  onTerminalData: (cb) => ipcRenderer.on('terminal:data', (_, data) => cb(data)),
  sendTerminalInput: (data) => ipcRenderer.send('terminal:input', data),
  resizeTerminal: (cols, rows) => ipcRenderer.send('terminal:resize', { cols, rows }),

  // Terminal 2 (secondary)
  onTerminal2Data: (cb) => ipcRenderer.on('terminal2:data', (_, data) => cb(data)),
  sendTerminal2Input: (data) => ipcRenderer.send('terminal2:input', data),
  resizeTerminal2: (cols, rows) => ipcRenderer.send('terminal2:resize', { cols, rows }),
  spawnTerminal2: () => ipcRenderer.invoke('terminal2:spawn'),
  killTerminal2: () => ipcRenderer.invoke('terminal2:kill'),

  // Model updates
  onModelUpdate: (cb) => ipcRenderer.on('model:update', (_, data) => cb(data)),

  // Render lifecycle
  onRenderStart: (cb) => ipcRenderer.on('render:start', (_, data) => cb(data)),
  onRenderComplete: (cb) => ipcRenderer.on('render:complete', (_, data) => cb(data)),
  onRenderError: (cb) => ipcRenderer.on('render:error', (_, data) => cb(data)),
  forceRender: () => ipcRenderer.invoke('render:force'),
  onRenderWarning: (cb) => ipcRenderer.on('render:warning', (_, data) => cb(data)),
  // Setup fault (missing / unrunnable OpenSCAD). Deliberately a separate channel
  // from render:error so an environment problem never enters the model-fix loop.
  onRenderEnvError: (cb) => ipcRenderer.on('render:env-error', (_, data) => cb(data)),

  // Environment status (banner strip) and the two setup actions it offers
  getEnvStatus: () => ipcRenderer.invoke('env:status'),
  onEnvStatus: (cb) => ipcRenderer.on('env:status', (_, data) => cb(data)),
  locateOpenSCAD: () => ipcRenderer.invoke('env:locate-openscad'),
  openRenderErrors: () => ipcRenderer.invoke('app:open-render-errors'),

  // Claude nudge — offered as a card, delivered only on request
  onClaudeNudge: (cb) => ipcRenderer.on('claude:nudge', (_, data) => cb(data)),
  sendClaudeNudge: (message) => ipcRenderer.invoke('claude:send-nudge', message),
  onTerminalLabel: (cb) => ipcRenderer.on('terminal:label', (_, data) => cb(data)),
  restartTerminal: () => ipcRenderer.invoke('terminal:restart'),

  // Export progress
  onExportStart: (cb) => ipcRenderer.on('export:start', (_, data) => cb(data)),
  onExportDone: (cb) => ipcRenderer.on('export:done', (_, data) => cb(data)),

  // Sessions
  getSessions: () => ipcRenderer.invoke('sessions:list'),
  newSession: () => ipcRenderer.invoke('sessions:new'),
  continueSession: () => ipcRenderer.invoke('sessions:continue'),
  resumeSession: (id) => ipcRenderer.invoke('sessions:resume', id),

  // Checkpoints
  getCheckpoints: () => ipcRenderer.invoke('checkpoint:list'),
  selectCheckpoint: (id) => ipcRenderer.invoke('checkpoint:select', id),
  deleteCheckpoint: (id, opts) => ipcRenderer.invoke('checkpoint:delete', id, opts || {}),
  renameCheckpoint: (id, label) => ipcRenderer.invoke('checkpoint:rename', id, label),
  restoreCheckpointSession: (id) => ipcRenderer.invoke('checkpoint:restore-session', id),
  onCheckpointUpdate: (cb) => ipcRenderer.on('checkpoint:update', (_, data) => cb(data)),

  // Files
  readFile: (filePath) => ipcRenderer.invoke('file:read', filePath),
  readModelFile: (filePath, format) => ipcRenderer.invoke('file:read-model', filePath, format),
  saveFile: (filePath, content) => ipcRenderer.invoke('file:save', filePath, content),
  saveAsCheckpoint: (filePath, content) =>
    ipcRenderer.invoke('file:save-as-checkpoint', filePath, content),
  isTrackedCheckpoint: (filePath) => ipcRenderer.invoke('checkpoint:is-tracked', filePath),
  onFileContent: (cb) => ipcRenderer.on('file:content', (_, data) => cb(data)),

  // Workspace
  getWorkspace: () => ipcRenderer.invoke('workspace:get'),

  // MCP direct access (bypasses Claude, calls openscad-mcp-server directly)
  mcpRenderPng: (scadCode, opts) => ipcRenderer.invoke('mcp:render-png', scadCode, opts),
  mcpExportStl: (scadCode, filename) => ipcRenderer.invoke('mcp:export-stl', scadCode, filename),
  mcpStatus: () => ipcRenderer.invoke('mcp:status'),

  // App menu actions
  newProjectWindow: () => ipcRenderer.invoke('app:new-project-window'),
  openWorkspace: () => ipcRenderer.invoke('app:open-workspace'),
  openInFiles: () => ipcRenderer.invoke('app:open-workspace-in-files'),
  toggleDevTools: () => ipcRenderer.invoke('app:toggle-devtools'),
  getWindowCount: () => ipcRenderer.invoke('app:window-count'),

  // Export
  exportModel: (format) => ipcRenderer.invoke('app:export', format),

  // Path bar / recent / file browser
  listRecentPaths: () => ipcRenderer.invoke('app:list-recent'),
  browseDir: (dirPath) => ipcRenderer.invoke('app:browse-dir', dirPath),
  openPath: (inputPath) => ipcRenderer.invoke('app:open-path', inputPath),

  // App version / README
  getAppVersion: () => ipcRenderer.invoke('app:get-version'),
  openReadme: () => ipcRenderer.invoke('app:open-readme'),

  // Auto-update. checkUpdates/installUpdate take no payload — there is nothing
  // here for a compromised renderer to inject; it can only ask "check now" or
  // "restart into the already-downloaded build".
  getUpdateStatus: () => ipcRenderer.invoke('app:get-update-status'),
  checkUpdates: () => ipcRenderer.invoke('app:check-updates'),
  installUpdate: () => ipcRenderer.invoke('app:install-update'),
  onUpdateStatus: (cb) => ipcRenderer.on('app:update-status', (_, data) => cb(data)),

  // Generation pipeline (claw-gen)
  getPipelineCliPath: () => ipcRenderer.invoke('pipeline:get-cli-path'),
  setPipelineCliPath: (cliPath) => ipcRenderer.invoke('pipeline:set-cli-path', cliPath),
  locatePipelineCli: () => ipcRenderer.invoke('pipeline:locate-cli'),
  getPipelineBackends: () => ipcRenderer.invoke('pipeline:backends'),
  startPipeline: (opts) => ipcRenderer.invoke('pipeline:start', opts),
  cancelPipeline: () => ipcRenderer.invoke('pipeline:cancel'),
  readPipelineImage: (filePath) => ipcRenderer.invoke('pipeline:read-image', filePath),
  onPipelineEvent: (cb) => ipcRenderer.on('pipeline:event', (_, data) => cb(data)),
  onPipelineLog: (cb) => ipcRenderer.on('pipeline:log', (_, data) => cb(data)),
  onPipelineExit: (cb) => ipcRenderer.on('pipeline:exit', (_, data) => cb(data)),

  // clawscad:anchor:preload:composer — P1. Handlers land in main/composer.js;
  // until then these reject with "no handler registered", which is fine
  // because nothing calls them yet.
  composerSendToClaude: (payload) => ipcRenderer.invoke('composer:send-to-claude', payload),
  composerGetState: () => ipcRenderer.invoke('composer:get-state'),
  composerSetState: (state) => ipcRenderer.invoke('composer:set-state', state),

  // clawscad:anchor:preload:uploads — P2. Handlers land in main/uploads.js.
  // Electron 43 removed File.path, and webUtils is reachable only from preload.
  // Returns a real filesystem path for a dropped File, or null for a virtual
  // one (a browser/Outlook drag has no path). Path-based ingest is preferred:
  // it skips file.arrayBuffer(), so a 200 MB mesh is never buffered into
  // renderer memory just to be copied. Callers fall back to bytes on null.
  pathForFile: (file) => { try { return webUtils.getPathForFile(file); } catch { return null; } },
  uploadPick: () => ipcRenderer.invoke('upload:pick'),
  uploadIngest: (filePath) => ipcRenderer.invoke('upload:ingest', filePath),
  uploadIngestBytes: (name, bytes) => ipcRenderer.invoke('upload:ingest-bytes', name, bytes),
  uploadList: () => ipcRenderer.invoke('upload:list'),

  // clawscad:anchor:preload:presets — P3. Handlers land in main/presets.js.
  presetsLoad: () => ipcRenderer.invoke('presets:load'),

  // clawscad:anchor:preload:categories — P7 (v0.4 guided make). Handler lands
  // in main/categories.js. Returns { categories, error }; never rejects for a
  // bad user override — the shipped taxonomy is the fallback.
  categoriesLoad: () => ipcRenderer.invoke('categories:load'),

  // clawscad:anchor:preload:tools — S1 (v0.6 studio). Handler lands in
  // main/tools.js. Returns { tools, error }; never rejects for a bad user
  // override — the shipped catalog is the fallback, and a studio with zero
  // tools is a supported state.
  toolsLoad: () => ipcRenderer.invoke('tools:load'),

  // clawscad:anchor:preload:gallery — P4. Handlers land in main/gallery.js.
  galleryList: () => ipcRenderer.invoke('gallery:list'),
  galleryListJobs: () => ipcRenderer.invoke('gallery:list-jobs'),
  // No galleryOpenCheckpoint bridge: the gallery drives Open / Continue /
  // Export through the EXISTING checkpoint:select, checkpoint:restore-session,
  // app:open-path and app:export channels rather than a parallel one. The
  // anchor stub for it was removed because an exposed method with no registered
  // handler is worse than no method — it rejects at call time instead of
  // failing to exist, so a caller discovers it only in production.
});
