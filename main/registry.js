// main/registry.js — the main-side interface for every feature package
// (P1 composer, P2 uploads, P3 presets, P4 gallery).
//
// Each package module (main/composer.js, main/uploads.js, main/presets.js,
// main/gallery.js) exports `register(ipcMain, deps)`. main.js requires each
// module exactly once, inside the clawscad:anchor:modules block, and calls
// register() with the deps object this file assembles.
//
// buildDeps() only ever runs from inside main.js's IPC handler region, after
// every value it references already exists — nothing here runs at require
// time, and this file has no other side effects.
function buildDeps(parts) {
  // deps = { getCtx, ctxSend, windows, addCheckpoint, sendCheckpoints,
  //          copyToActive, saveState, APP_VERSION, dialog, app }
  // A package needing a dep not in that list asks P0 (foundations) to add
  // one line here — no merge conflict, because P0 owns this file.
  return { ...parts };
}

module.exports = { buildDeps };
