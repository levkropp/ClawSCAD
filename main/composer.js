// main/composer.js — P1 (composer shell). Owns composer:send-to-claude,
// composer:get-state and composer:set-state (master plan §4.3 "New IPC
// channels, by owner"). Nothing in this file runs at require time beyond the
// exports assignment.
const fs = require('fs');
const path = require('path');

const STATE_FILENAME = 'composer-state.json';

function statePath(app) {
  return path.join(app.getPath('userData'), STATE_FILENAME);
}

function readState(app) {
  try {
    const raw = fs.readFileSync(statePath(app), 'utf-8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    // No file yet, or a corrupt one — either way, an empty state is the
    // correct fallback and never a reason to throw during mount.
    return {};
  }
}

function writeState(app, state) {
  try {
    fs.writeFileSync(statePath(app), JSON.stringify(state, null, 2));
  } catch (err) {
    console.error('[composer] failed to write composer-state.json', err);
  }
}

/**
 * composer-state.json has more than one owner as of v0.6, so a set-state that
 * overwrote the file wholesale was a silent data-loss bug: the composer's
 * persistState() writes { target, prompt, height, guided } on every keystroke,
 * which would have deleted the studio's `studio` key a fraction of a second
 * after it was written. Each owner writes only its own top-level keys, so a
 * shallow top-level merge is exactly the right semantics.
 *
 * The one exception is deliberate and load-bearing: **an empty object clears
 * the file.** Five specs call `composerSetState({})` as a whole-file reset in
 * afterAll, and under a pure merge that reset would become a no-op and leak
 * state into every later spec — a far worse bug than the one being fixed. So
 * `{}` means "clear", anything else means "partial update". Kept as a pure
 * function so tests/composer-state.js can prove both branches without Electron.
 */
function mergeState(prev, next) {
  if (!next || typeof next !== 'object' || Array.isArray(next)) return prev;
  if (Object.keys(next).length === 0) return {};
  const base = prev && typeof prev === 'object' && !Array.isArray(prev) ? prev : {};
  return { ...base, ...next };
}

exports.mergeState = mergeState;

exports.register = function register(ipcMain, deps) {
  const { getCtx, app } = deps;

  // Part-target submit. claude:send-nudge (main.js:1542) deliberately
  // flattens newlines to spaces — it's a one-line nudge. A composed prompt is
  // preamble + file manifest + the user's sentence, inherently multi-line, so
  // it gets its own channel with its own formatting rather than reusing that
  // one (master plan §1.11). Wrapping the write in an xterm bracketed-paste
  // sequence tells the pty's line editor (Claude Code's own input box, or a
  // bare shell) "this is pasted content" so embedded \n characters land as
  // literal newlines instead of each one submitting a line early.
  ipcMain.handle('composer:send-to-claude', (event, message) => {
    const ctx = getCtx(event);
    if (!ctx || !ctx.ptyProcess || typeof message !== 'string') return false;
    const text = message.replace(/\r\n/g, '\n');
    ctx.ptyProcess.write('\x1b[200~' + text + '\x1b[201~\r');
    return true;
  });

  // Composer state (target, prompt, rail height) — userData, NEVER
  // clawscad.json (that file is the checkpoint registry and a v2 UI must not
  // risk it — master plan §1.15 / R5).
  ipcMain.handle('composer:get-state', () => readState(app));

  ipcMain.handle('composer:set-state', (event, state) => {
    if (!state || typeof state !== 'object') return false;
    // Merge, don't overwrite — see mergeState. The composer and the studio are
    // both owners of this file now, and each writes only its own keys.
    writeState(app, mergeState(readState(app), state));
    return true;
  });
};
