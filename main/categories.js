// main/categories.js — P7 (v0.4 guided make). FOUNDATION IMPLEMENTATION.
//
// Registers categories:load, mirroring main/presets.js: reads the shipped
// presets/categories.json, overridable wholesale by a same-named file in
// app.getPath('userData')/presets/. Read-only and best-effort — a corrupt
// override falls back to the shipped taxonomy and reports the parse error in
// `error` rather than failing the call. The grid is the app's front door; it
// may never be empty because someone hand-edited a JSON file.
//
// P7 owns this file. Full contract: docs/v04-guided-make-contracts.md §P7.
const fs = require('fs');
const path = require('path');

const SHIPPED_DIR = path.join(__dirname, '..', 'presets');
const FILENAME = 'categories.json';

function readJson(filePath) {
  // Distinguishes "not there" (fine, expected for the override) from
  // "there and broken" (worth telling the user about) — presets.js collapses
  // both into null, but a broken taxonomy override would silently revert the
  // whole front door, so this one reports.
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return { data: null, error: null };
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.categories)) {
      return { data: null, error: `${filePath} has no "categories" array` };
    }
    return { data: parsed, error: null };
  } catch (err) {
    return { data: null, error: `${filePath}: ${err.message}` };
  }
}

/**
 * The load itself, with no Electron in it — see main/tools.js's loadTools for
 * why. The web server serves the SAME taxonomy through the same override
 * rules rather than reimplementing them.
 */
function loadCategories(userDataDir) {
  const shipped = readJson(path.join(SHIPPED_DIR, FILENAME));
  const overridePath = path.join(userDataDir, 'presets', FILENAME);
  const override = readJson(overridePath);

  const data = override.data || shipped.data;
  const errors = [override.error, shipped.error].filter(Boolean);

  return {
    categories: data,
    source: override.data ? 'userData' : 'shipped',
    overridePath,
    error: errors.length ? errors.join(' | ') : null,
  };
}

exports.loadCategories = loadCategories;

exports.register = function register(ipcMain, deps) {
  const { app } = deps;
  ipcMain.handle('categories:load', () => loadCategories(app.getPath('userData')));
};
