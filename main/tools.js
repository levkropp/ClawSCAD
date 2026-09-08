// main/tools.js — v0.6 Studio. FOUNDATION IMPLEMENTATION.
//
// Registers tools:load, mirroring main/categories.js exactly: reads the shipped
// presets/tools.json, overridable wholesale by a same-named file in
// app.getPath('userData')/presets/. Read-only and best-effort — a corrupt
// override falls back to the shipped catalog and reports the parse error in
// `error` rather than failing the call.
//
// A broken tools file must never take the front door with it. The studio is
// required to work with zero tools; this handler's job is only to say why.
//
// Contract: docs/v06-studio-contracts.md.
const fs = require('fs');
const path = require('path');

const SHIPPED_DIR = path.join(__dirname, '..', 'presets');
const FILENAME = 'tools.json';

function readJson(filePath) {
  // "Not there" (fine, expected for the override) is distinguished from "there
  // and broken" (worth telling the user about) — the same split main/categories.js
  // makes, and for the same reason: a broken override silently reverting a
  // whole feature is worse than a stated error.
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return { data: null, error: null };
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.tools)) {
      return { data: null, error: `${filePath} has no "tools" array` };
    }
    return { data: parsed, error: null };
  } catch (err) {
    return { data: null, error: `${filePath}: ${err.message}` };
  }
}

/**
 * The load itself, with no Electron in it. Exported separately so the web
 * server (web/server.js) serves the SAME catalog through the same override
 * rules — one implementation, not a second one that drifts.
 *
 * `userDataDir` is where the optional override lives; Electron passes
 * app.getPath('userData'), the web server passes its own state dir.
 */
function loadTools(userDataDir) {
  const shipped = readJson(path.join(SHIPPED_DIR, FILENAME));
  const overridePath = path.join(userDataDir, 'presets', FILENAME);
  const override = readJson(overridePath);

  const data = override.data || shipped.data;
  const errors = [override.error, shipped.error].filter(Boolean);

  return {
    tools: data,
    source: override.data ? 'userData' : 'shipped',
    overridePath,
    error: errors.length ? errors.join(' | ') : null,
  };
}

exports.loadTools = loadTools;

exports.register = function register(ipcMain, deps) {
  const { app } = deps;
  ipcMain.handle('tools:load', () => loadTools(app.getPath('userData')));
};
