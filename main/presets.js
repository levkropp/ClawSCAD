// main/presets.js — P3 (intent presets). Owned exclusively by the presets
// package.
//
// Registers presets:load, which reads presets/presets.json + presets/
// machine.json shipped with the app, with each optionally overridden by a
// same-named file in app.getPath('userData')/presets/ (master plan §1.8 —
// "product defaults, not workspace state", so this deliberately does NOT
// live in clawscad.json, the checkpoint registry). Read-only, best-effort:
// a missing or corrupt override just falls back to the shipped default
// rather than failing presets:load.
const fs = require('fs');
const path = require('path');

// __dirname is <app>/main; the shipped data sits one level up in presets/,
// alongside it in every packaged build (package.json build.files already lists
// "presets/**/*" — P0 landed that in W0).
const SHIPPED_DIR = path.join(__dirname, '..', 'presets');

function readJsonIfPresent(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    // Either the file doesn't exist (the common case for the userData
    // override) or it's corrupt — both are a silent fall-through to the
    // shipped default, never a reason to fail presets:load.
    return null;
  }
}

// Shallow merge is intentional, not a deep merge: an override file replaces
// a shipped file wholesale (e.g. the whole presets.json), because a partial
// override that silently drops half of §9.2's data shape (tables,
// conflict_notes, merge_policy) would be a much worse failure mode than
// "you have to copy the whole file to tweak one number".
function loadOne(filename, app) {
  const shipped = readJsonIfPresent(path.join(SHIPPED_DIR, filename));
  const overridePath = path.join(app.getPath('userData'), 'presets', filename);
  const override = readJsonIfPresent(overridePath);
  return {
    data: override || shipped,
    source: override ? 'userData' : 'shipped',
    overridePath,
  };
}

exports.register = function register(ipcMain, deps) {
  const { app } = deps;

  ipcMain.handle('presets:load', () => {
    const presets = loadOne('presets.json', app);
    const machine = loadOne('machine.json', app);
    return {
      presets: presets.data,
      presetsSource: presets.source,
      machine: machine.data,
      machineSource: machine.source,
    };
  });
};
