// main/gallery.js — P4 (gallery). Owned exclusively by the gallery package.
//
// Registers gallery:list and gallery:list-jobs. Both are read-only, best-
// effort disk reads — never a claw-gen spawn (that would collide with the
// app's single long-running pipeline child per window, main.js §PIPELINE_ACTIONS)
// and never a `backends --json` probe (2-10s of live SSH round trips).
//
// gallery:open-checkpoint is intentionally left unregistered — the gallery
// UI drives checkpoint selection through the existing checkpoint:select /
// app:open-path channels instead (see renderer/gallery.js). preload.js
// already exposes a bridge for it; calling it today rejects with "no
// handler registered", which is the same degrade every other unregistered
// anchor channel gets until its owner lands.
const fs = require('fs');
const path = require('path');

const IMAGE_EXT_OK = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // per-file safety cap for embedded thumbs
const MAX_JOBS = 60; // most-recent jobs embedded per response
const MOSAIC_COUNT = 4; // candidates embedded per job, matching the 2x2 mosaic

// True if `target` resolves to a path inside `baseDir` (both already
// path.resolve()d). Used to jail thumbnail reads to <workspace>/renders/gen —
// this is a SEPARATE, explicitly-scoped reader from pipeline:read-image
// (main.js:1475, jailed to ctx.pipelineJobDir and only unlocked after a
// `candidate` event); that jail is never widened here.
function isWithin(baseDir, target) {
  const rel = path.relative(baseDir, target);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function readImageDataUrl(filePath, jobsRoot) {
  try {
    if (typeof filePath !== 'string' || !filePath) return null;
    // clawgen-capabilities §E: candidate `path` values in job.json are
    // stored ABSOLUTE already — resolve, don't re-join to the job dir.
    const resolved = path.resolve(filePath);
    if (!isWithin(jobsRoot, resolved)) return null;
    const ext = path.extname(resolved).toLowerCase();
    if (!IMAGE_EXT_OK.has(ext)) return null;
    const stat = fs.statSync(resolved);
    if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES) return null;
    const data = fs.readFileSync(resolved);
    const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
    return `data:${mime};base64,${data.toString('base64')}`;
  } catch {
    return null;
  }
}

// Reads <workspaceDir>/renders/gen/*/job.json directly off disk. No claw-gen
// spawn, no probe, no collision with the pipeline's single-child slot
// (master plan §1.12).
function listJobs(workspaceDir) {
  const jobsRoot = path.join(workspaceDir, 'renders', 'gen');
  const result = { jobsRoot, jobs: [], error: null };
  let entries;
  try {
    entries = fs.readdirSync(jobsRoot, { withFileTypes: true });
  } catch (err) {
    result.error = err && err.code === 'ENOENT' ? 'no-renders-dir' : String((err && err.message) || err);
    return result;
  }

  const jobs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const jobDir = path.join(jobsRoot, entry.name);
    let job;
    try {
      job = JSON.parse(fs.readFileSync(path.join(jobDir, 'job.json'), 'utf-8'));
    } catch (err) {
      jobs.push({
        name: entry.name,
        dir: jobDir,
        error: 'unreadable job.json: ' + String((err && err.code) || (err && err.message) || err),
      });
      continue;
    }

    const rounds = Array.isArray(job.rounds) ? job.rounds : [];
    // Mosaic candidates come from the most recent round that has any —
    // matches how the checkpoint tree always shows current state, not history.
    let candidates = [];
    for (let i = rounds.length - 1; i >= 0 && candidates.length === 0; i--) {
      const rc = rounds[i] && rounds[i].candidates;
      if (Array.isArray(rc) && rc.length) candidates = rc;
    }
    const candidateCount = rounds.reduce(
      (n, r) => n + (Array.isArray(r.candidates) ? r.candidates.length : 0),
      0
    );

    const thumbs = [];
    for (const c of candidates.slice(0, MOSAIC_COUNT)) {
      const url = c && readImageDataUrl(c.path, jobsRoot);
      if (url) thumbs.push(url);
    }

    jobs.push({
      name: entry.name,
      dir: jobDir,
      slug: job.slug || entry.name,
      created: job.created || null,
      text: job.text || '',
      prompt: job.prompt || '',
      picked: job.picked || null,
      checkpoint: job.checkpoint || null,
      candidateCount,
      roundCount: rounds.length,
      thumbs, // data: URLs, already size- and extension-capped above
      thumbsTruncated: candidates.length > thumbs.length || candidates.length > MOSAIC_COUNT,
    });
  }

  jobs.sort((a, b) => {
    const ta = a.created ? Date.parse(a.created) : 0;
    const tb = b.created ? Date.parse(b.created) : 0;
    return tb - ta;
  });
  result.jobs = jobs.slice(0, MAX_JOBS);
  return result;
}

exports.register = function register(ipcMain, deps) {
  const { getCtx, app } = deps;

  // This workspace's checkpoints (from the live in-memory ctx.state, kept in
  // sync with clawscad.json by saveState) plus each recent workspace's
  // clawscad.json, read straight off disk. Read-only, best-effort: a
  // workspace that can't be read gets an error row, never a failed sheet,
  // and nothing here ever mutates another workspace's state.
  ipcMain.handle('gallery:list', (event) => {
    const ctx = getCtx(event);
    if (!ctx) return { workspaces: [] };

    const workspaces = [];
    workspaces.push({
      dir: ctx.workspaceDir,
      label: path.basename(ctx.workspaceDir) || ctx.workspaceDir,
      isCurrent: true,
      ok: true,
      checkpoints: (ctx.state && ctx.state.checkpoints) || {},
      active: (ctx.state && ctx.state.active) || null,
    });

    let recents = [];
    try {
      const recentFile = path.join(app.getPath('userData'), 'recent-workspaces.json');
      if (fs.existsSync(recentFile)) {
        recents = JSON.parse(fs.readFileSync(recentFile, 'utf-8'));
      }
    } catch {
      // best-effort — an unreadable recents file just means no cross-workspace rows
    }

    for (const dir of Array.isArray(recents) ? recents : []) {
      if (!dir || dir === ctx.workspaceDir) continue;
      const row = { dir, label: path.basename(dir) || dir, isCurrent: false };
      try {
        const raw = fs.readFileSync(path.join(dir, 'clawscad.json'), 'utf-8');
        const state = JSON.parse(raw);
        row.ok = true;
        row.checkpoints = state.checkpoints || {};
        row.active = state.active || null;
      } catch (err) {
        row.ok = false;
        row.checkpoints = {};
        row.active = null;
        row.error =
          err && err.code === 'ENOENT'
            ? 'no clawscad.json here'
            : String((err && err.message) || err);
      }
      workspaces.push(row);
    }

    return { workspaces };
  });

  // Current-workspace-only: preload's galleryListJobs() takes no argument
  // (owned by P0, not editable here), so scope is always the invoking
  // window's own workspace. Cross-workspace image batches are out of scope
  // for v0.2.5 as a result — checkpoints still get cross-workspace scope via
  // gallery:list above.
  ipcMain.handle('gallery:list-jobs', (event) => {
    const ctx = getCtx(event);
    if (!ctx) return { jobsRoot: '', jobs: [], error: 'no-window' };
    return listJobs(ctx.workspaceDir);
  });
};
