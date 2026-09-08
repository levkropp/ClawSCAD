'use strict';

// Auto-update. ClawSCAD checks its own GitHub releases, downloads new versions
// in the background, and installs them when the app quits — so a long Claude
// session or an in-flight render is never interrupted by an update.
//
// Why this exists: without it the installed binary silently rots. An install
// can sit several versions behind for weeks before anyone notices, and the
// first suspicion is usually a stale shortcut rather than a stale build.
//
// Transport is electron-updater against the `publish` block in package.json
// (GitHub provider, public repo → the CLIENT needs no token; a token is only
// needed by whoever PUBLISHES a release). A fork must repoint that block at
// its own repo before releasing — see docs/releasing.md.
//
// Everything here is defensive: an unreachable network, a rate-limited API, a
// dev run from source, or a corrupt partial download must never take the editor
// down with it.

const { app } = require('electron');

// Mirrors ClawSCAD's other status payloads: a plain object pushed on a single
// channel, with the renderer free to render as much or as little as it wants.
const UPDATE_STATUS = {
  IDLE: 'idle',
  CHECKING: 'checking',
  AVAILABLE: 'available',
  DOWNLOADING: 'downloading',
  READY: 'ready',
  CURRENT: 'current',
  ERROR: 'error',
  UNSUPPORTED: 'unsupported',
};

const EMPTY_UPDATE = {
  status: UPDATE_STATUS.IDLE,
  version: '',
  percent: 0,
  message: '',
  checkedAt: 0,
};

const CHECK_INTERVAL_HOURS = 6;
// The first check is deliberately delayed: startup is the one moment the app is
// busy probing OpenSCAD, spawning the pty and warming the MCP server. An update
// check is never urgent enough to compete with that.
const FIRST_CHECK_DELAY_MS = 25000;

let updater = null; // electron-updater's autoUpdater, loaded lazily
let timer = null;
let broadcast = () => {};
let state = { ...EMPTY_UPDATE };
let downloadedVersion = ''; // set once an install is staged and ready

function push(patch) {
  state = { ...state, ...patch };
  try {
    broadcast('app:update-status', state);
  } catch {
    // A window torn down mid-push must never reject here.
  }
}

// Running `npm start` / `electron .` has no installer to replace, and
// electron-updater throws a hard error in that case. Detect it up front and
// present it as an honest status rather than an error the user can't action.
function isPackaged() {
  return app.isPackaged;
}

function load() {
  if (updater) return updater;
  try {
    // Required lazily so a missing or broken dependency degrades to "updates
    // unavailable" instead of preventing the app from starting at all.
    ({ autoUpdater: updater } = require('electron-updater'));
  } catch (err) {
    console.error('[updater] electron-updater unavailable:', err && err.message);
    return null;
  }

  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;
  updater.allowPrerelease = false;
  updater.logger = {
    info: (m) => console.log('[updater]', m),
    warn: (m) => console.warn('[updater]', m),
    error: (m) => console.error('[updater]', m),
    debug: () => {},
  };

  updater.on('checking-for-update', () => push({ status: UPDATE_STATUS.CHECKING, message: '' }));

  updater.on('update-available', (info) => {
    push({
      status: UPDATE_STATUS.DOWNLOADING,
      version: info.version,
      percent: 0,
      message: `ClawSCAD ${info.version} is available.`,
    });
  });

  updater.on('update-not-available', () => {
    push({ status: UPDATE_STATUS.CURRENT, version: '', percent: 0, checkedAt: Date.now(), message: '' });
  });

  updater.on('download-progress', (p) => {
    push({ status: UPDATE_STATUS.DOWNLOADING, percent: Math.round((p && p.percent) || 0) });
  });

  updater.on('update-downloaded', (info) => {
    downloadedVersion = info.version;
    push({
      status: UPDATE_STATUS.READY,
      version: info.version,
      percent: 100,
      checkedAt: Date.now(),
      message: `ClawSCAD ${info.version} is ready — it installs when you quit.`,
    });
  });

  updater.on('error', (err) => {
    const msg = (err && err.message) || String(err);
    console.error('[updater] error:', msg);
    push({
      status: UPDATE_STATUS.ERROR,
      percent: 0,
      checkedAt: Date.now(),
      // Surface something a human can act on; the raw stack goes to the log.
      message: /net::|ENOTFOUND|EAI_AGAIN|ETIMEDOUT/i.test(msg)
        ? 'Could not reach the update server.'
        : 'Update check failed — see the log for details.',
    });
  });

  return updater;
}

async function check({ manual = false } = {}) {
  if (!isPackaged()) {
    push({
      status: UPDATE_STATUS.UNSUPPORTED,
      message: 'Running from source — updates apply to the installed app only.',
    });
    return state;
  }

  const u = load();
  if (!u) {
    push({ status: UPDATE_STATUS.UNSUPPORTED, message: 'Updater unavailable in this build.' });
    return state;
  }

  // An update already staged doesn't need re-checking; re-announce it instead so
  // a manual check still gives the user feedback.
  if (downloadedVersion) {
    push({ status: UPDATE_STATUS.READY, version: downloadedVersion, percent: 100 });
    return state;
  }

  try {
    await u.checkForUpdates();
  } catch {
    // The 'error' event already reported this; swallow so nothing rejects here.
  }
  return state;
}

// Quit and apply a staged update immediately (the "Restart now" affordance).
function installNow() {
  if (!downloadedVersion || !updater) return false;
  // isSilent=false so the user sees the installer's progress; isForceRunAfter=true
  // so ClawSCAD comes back up on the new version rather than just disappearing.
  setImmediate(() => {
    try {
      updater.quitAndInstall(false, true);
    } catch (err) {
      console.error('[updater] quitAndInstall failed:', err && err.message);
    }
  });
  return true;
}

function getState() {
  return state;
}

function schedule() {
  clearInterval(timer);
  timer = setInterval(() => check(), CHECK_INTERVAL_HOURS * 60 * 60 * 1000);
  // Never hold the process open for an update check.
  if (timer.unref) timer.unref();
}

// deps: { broadcast(channel, payload) } — ClawSCAD is multi-window, so status
// goes to every live window rather than to one ctx.
function init(deps) {
  broadcast = (deps && deps.broadcast) || (() => {});
  const first = setTimeout(() => check(), FIRST_CHECK_DELAY_MS);
  if (first.unref) first.unref();
  schedule();
}

function register(ipcMain) {
  ipcMain.handle('app:get-update-status', () => getState());
  ipcMain.handle('app:check-updates', () => check({ manual: true }));
  ipcMain.handle('app:install-update', () => installNow());
}

module.exports = { init, register, check, installNow, getState, UPDATE_STATUS, EMPTY_UPDATE };
