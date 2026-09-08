// web/entry.js — the web port's renderer.
//
// This file plays exactly the role renderer.js plays in the desktop app, and
// nothing more: it populates the shared `ctx` from renderer/bus.js, owns the
// single `window.api.on*` registration for each channel and fans it out through
// the bus, owns the `#gen-*` call sites, and then calls the REAL
// renderer/studio.js's mountStudio(ctx). studio.js is imported unmodified.
//
// The three seams that make that possible:
//
//  1. `ctx.api` is the fetch/EventSource shim, which mirrors preload.js's
//     surface shape for shape.
//  2. The SSE stream is fanned out through `notifyPipelineEvent`, so
//     `ctx.onPipelineEvent` behaves exactly as it does in Electron — one
//     registration, many subscribers (standing rule 3).
//  3. The `#gen-*` elements exist and are FUNCTIONAL. studio.js's flow B writes
//     #gen-prompt, clicks #gen-generate-btn, clicks a `.gen-candidate` and then
//     #gen-make3d-btn, and reads `#gen-generate-btn.disabled` as its only
//     end-of-run signal. A shell with inert placeholders would leave the whole
//     preview flow silently dead, so the generate driver below is real — it is
//     renderer.js's generate panel, minus the log pane and the stepper that the
//     Studio draws for itself.
import { ctx, notifyPipelineEvent, notifyCheckpointsChanged } from '../renderer/bus.js';
import { mountStudio } from '../renderer/studio.js';
import { createApiShim } from './api-shim.js';
import { mountCustomize } from './customize.js';

// ── toasts ────────────────────────────────────────────────────────────────
// Same markup and lifetime as renderer.js:15, so style.css's .toast rules apply
// unchanged.

function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('visible'));
  setTimeout(() => {
    toast.classList.add('hiding');
    toast.addEventListener('animationend', () => toast.remove());
    setTimeout(() => toast.remove(), 1000);
  }, 4000);
}

const api = createApiShim({ onUnsupported: (reason) => showToast(reason, 'info') });

// ── the generate driver (renderer.js's role, kept minimal) ────────────────

const GEN_STAGES = ['images', 'mesh', 'prep', 'checkpoint'];

const genPromptEl = document.getElementById('gen-prompt');
const genCountEl = document.getElementById('gen-count');
const genGenerateBtn = document.getElementById('gen-generate-btn');
const genMake3dBtn = document.getElementById('gen-make3d-btn');
const genGridEl = document.getElementById('gen-image-grid');

let genSelectedKey = null;
let genJob = null;
let genRunning = false;
let genPendingStage = null; // drives the Make 3D chain: mesh -> prep -> checkpoint

function genSetRunning(running) {
  genRunning = running;
  // studio.js's watchRun() MutationObserver keys off exactly this attribute and
  // treats its removal as "the run ended, for any reason". Changing how this is
  // set would silently break the picture step's only completion signal.
  if (genGenerateBtn) genGenerateBtn.disabled = running;
  if (genMake3dBtn) genMake3dBtn.disabled = running || !genSelectedKey;
}

async function startImageGeneration({ continueJob = false } = {}) {
  if (!genPromptEl) return { error: 'no-gen-panel' };
  const text = genPromptEl.value.trim();
  if (!text) {
    showToast('Enter a prompt first', 'error');
    return { error: 'no-prompt' };
  }
  const continuing = continueJob && Boolean(genJob);
  if (!continuing) {
    genJob = null;
    if (genGridEl) genGridEl.innerHTML = '';
  }
  genSelectedKey = null;
  genPendingStage = null;
  genSetRunning(true);

  const args = [text, '-n', (genCountEl && genCountEl.value) || '4'];
  const result = await api.startPipeline(
    continuing ? { action: 'images', args, job: genJob } : { action: 'images', args }
  );
  if (result && result.error) {
    genSetRunning(false);
    // 'not-configured' and 'already-running' are both said better by the
    // Studio's own notices, which name the reason and offer a way forward.
    if (result.error !== 'not-configured' && result.error !== 'already-running') {
      showToast(`Generate failed: ${result.error}`, 'error');
    }
  }
  return result;
}

if (genGenerateBtn) genGenerateBtn.addEventListener('click', () => startImageGeneration());

// The Studio's sculpt path clicks the matching `.gen-candidate[data-key]` and
// then #gen-make3d-btn, so both must exist and both must really work.
async function addGenCandidate(evt) {
  if (!genGridEl) return;
  const key = `${evt.round}:${evt.index}`;
  const url = await api.readPipelineImage(evt.path);
  const card = document.createElement('div');
  card.className = 'gen-candidate';
  card.dataset.key = key;
  if (url) {
    const img = document.createElement('img');
    img.src = url;
    img.alt = `Candidate ${evt.index}`;
    card.appendChild(img);
  }
  card.addEventListener('click', () => {
    genGridEl.querySelectorAll('.gen-candidate.selected').forEach((el) => el.classList.remove('selected'));
    card.classList.add('selected');
    genSelectedKey = key;
    if (genMake3dBtn) genMake3dBtn.disabled = genRunning;
  });
  genGridEl.appendChild(card);
}

if (genMake3dBtn) {
  genMake3dBtn.addEventListener('click', async () => {
    if (!genSelectedKey || genRunning) return;
    const [, index] = genSelectedKey.split(':');
    genPendingStage = 'mesh';
    genSetRunning(true);
    const result = await api.startPipeline({ action: 'mesh', args: ['--pick', index], job: genJob });
    if (result && result.error) {
      genPendingStage = null;
      genSetRunning(false);
      showToast(`Mesh failed: ${result.error}`, 'error');
    }
  });
}

// ── the single event registrations (standing rule 3) ──────────────────────

api.onPipelineEvent((evt) => {
  if (!evt || typeof evt !== 'object') return;
  if (evt.job) genJob = evt.job;
  if (evt.event === 'candidate') addGenCandidate(evt);
  if (evt.event === 'error') genPendingStage = null;
  // Fan out LAST, so a throwing subscriber can never break the driver above.
  notifyPipelineEvent(evt);
});

api.onPipelineLog((text) => {
  // No log pane in this port; stderr goes to the console so a failing claw-gen
  // is still diagnosable from the browser rather than invisible.
  String(text)
    .split('\n')
    .filter(Boolean)
    .forEach((line) => console.log('[claw-gen]', line));
});

api.onPipelineExit(async ({ action, code }) => {
  genSetRunning(false);

  if (action === 'mesh' && genPendingStage === 'mesh' && code === 0) {
    genPendingStage = 'prep';
    genSetRunning(true);
    api.startPipeline({ action: 'prep', args: [], job: genJob });
  } else if (action === 'prep' && genPendingStage === 'prep' && code === 0) {
    genPendingStage = 'checkpoint';
    genSetRunning(true);
    api.startPipeline({ action: 'checkpoint', args: [], job: genJob });
  } else if (action === 'checkpoint' && genPendingStage === 'checkpoint') {
    genPendingStage = null;
    if (code === 0) {
      showToast('3D model checkpointed', 'success');
      // clawscad.json is only ever READ here, and there is no filesystem
      // watcher in this port — so the registry is re-read at the one moment it
      // is known to have changed, and the Studio's "recent" list updates.
      refreshCheckpoints();
    }
  } else {
    genPendingStage = null;
  }
  if (!GEN_STAGES.includes(action)) genPendingStage = null;
});

async function refreshCheckpoints() {
  try {
    notifyCheckpointsChanged(await api.getCheckpoints());
  } catch (err) {
    console.error('[web] could not read the checkpoint registry', err);
  }
}

// ── ctx (renderer/bus.js) ─────────────────────────────────────────────────

ctx.api = api;
ctx.showToast = showToast;
ctx.setExpanded = () => {};
ctx.updateStatus = (message) => {
  const el = document.getElementById('status-text');
  if (el) el.textContent = message || '';
};
ctx.prettyPath = (p) => String(p || '');
ctx.workspaceDir = '';

// The two hooks renderer.js exposes for the Studio, so it never opens a second
// `pipeline:start` call site for a stage this file owns (contract §S1).
ctx.startImageRound = () => startImageGeneration({ continueJob: true });

ctx.startMeshChain = async (args) => {
  if (genRunning) return { error: 'already-running' };
  genSelectedKey = null;
  genJob = null;
  genPendingStage = 'mesh';
  genSetRunning(true);
  const result = await api.startPipeline({ action: 'mesh', args: Array.isArray(args) ? args.map(String) : [] });
  if (result && result.error) {
    genPendingStage = null;
    genSetRunning(false);
    if (result.error !== 'not-configured' && result.error !== 'already-running') {
      showToast(`Mesh failed: ${result.error}`, 'error');
    }
  }
  return result;
};

ctx.els = {
  studio: document.getElementById('studio'),
  mainContent: document.getElementById('main-content'),
  viewSwitch: document.getElementById('view-switch'),
};

// ── Flow A progress + the Customize view ─────────────────────────────────
//
// studio.js dispatches Flow A through ctx.api.composerSendToClaude and then
// switches to the Workbench, which in this port is a stated-reason panel. So
// the make's PROGRESS has to surface somewhere the user is actually looking:
// a toast on start, and on completion a jump straight into Customize with the
// file Claude just wrote already selected. That is the whole loop — sentence,
// model, knobs, 3MF — without the user having to find anything.

let customize = null;

api.onMakeEvent((evt) => {
  if (!evt || typeof evt !== 'object') return;
  if (evt.event === 'start') {
    showToast('Claude is building your model — this usually takes a minute.', 'info');
    document.body.classList.add('is-making');
  }
  if (evt.event === 'timeout') {
    showToast('That build ran past 10 minutes and was stopped.', 'error');
  }
  if (evt.event === 'error') {
    document.body.classList.remove('is-making');
    showToast(`The build failed: ${evt.reason || 'unknown error'}`, 'error');
  }
  if (evt.event === 'done') {
    document.body.classList.remove('is-making');
    if (evt.file) {
      showToast(`Made ${evt.file} — opening Customize.`, 'success');
      showView('customize');
      if (customize) customize.refresh(evt.file);
    } else {
      // Exit code 0 with no .scad written is a real outcome and must not read
      // as success: the user would go looking for a model that is not there.
      showToast(
        evt.code === 0
          ? 'Claude finished but did not write a .scad. Try describing the part more concretely.'
          : `The build exited ${evt.code} without writing a model.`,
        'error',
      );
    }
  }
});

api.onMakeLog((text) => {
  String(text).split('\n').filter(Boolean).forEach((line) => console.log('[claude]', line));
});

/** The one place the three views are switched, so their [hidden] and the
 *  tabs' aria-selected can never disagree. studio.js owns Make/Workbench for
 *  its own two tabs; this handles Customize and keeps all three in sync. */
function showView(name) {
  const views = { studio: 'studio', customize: 'customize', workbench: 'main-content' };
  for (const [key, id] of Object.entries(views)) {
    const node = document.getElementById(id);
    if (node) node.hidden = key !== name;
  }
  document.body.dataset.view = name;
  for (const [key, tabId] of Object.entries({
    studio: 'view-studio',
    customize: 'view-customize',
    workbench: 'view-workbench',
  })) {
    const tab = document.getElementById(tabId);
    if (tab) tab.setAttribute('aria-selected', String(key === name));
  }
}

document.getElementById('view-customize')?.addEventListener('click', () => {
  showView('customize');
  if (customize) customize.refresh(customize.getModel());
});
// studio.js drives its own two tabs; mirroring them here keeps Customize's
// [hidden] correct when the user goes back.
document.getElementById('view-studio')?.addEventListener('click', () => showView('studio'));
document.getElementById('view-workbench')?.addEventListener('click', () => showView('workbench'));

// The Workbench panel's only control. studio.js owns the view switch, and
// ctx.studio is published at the END of mountStudio, so this reads it lazily
// and falls back to clicking the tab if the mount has not finished yet.
const backToMake = document.getElementById('web-back-to-make');
if (backToMake) {
  backToMake.addEventListener('click', () => {
    if (ctx.studio && typeof ctx.studio.show === 'function') ctx.studio.show();
    else document.getElementById('view-studio')?.click();
  });
}

// ctx.composer / ctx.presets / ctx.guided / ctx.confirm stay null. studio.js
// guards every one of them, and the modules behind them are workbench-only.

// ── boot ──────────────────────────────────────────────────────────────────

api.connect();

api
  .categoriesLoad()
  .then((result) => {
    ctx.categories =
      result && typeof result === 'object' ? result : { categories: null, error: 'categories:load returned nothing' };
  })
  .catch((err) => {
    ctx.categories = { categories: null, error: String((err && err.message) || err) };
  })
  .then(async () => {
    ctx.workspaceDir = await api.getWorkspace().catch(() => '');
    try {
      mountStudio(ctx);
    } catch (err) {
      console.error('[web] mountStudio threw', err);
    }
    // Its own try: a Customize failure must not take the Studio down with it,
    // and vice versa. Same rule renderer.js learned when one module's throw
    // silently killed gallery and onboarding on every launch.
    try {
      customize = mountCustomize(ctx, api, showToast);
    } catch (err) {
      console.error('[web] mountCustomize threw', err);
    }
    if (!ctx.studio) {
      // Same guard renderer.js uses: a Make tab that visibly does nothing is
      // worse than an absent feature. Here there is no workbench to fall back
      // to, so the shell says what happened instead of showing an empty page.
      const fallback = document.getElementById('web-mount-failed');
      if (fallback) fallback.hidden = false;
      if (ctx.els.viewSwitch) ctx.els.viewSwitch.hidden = true;
    }
    refreshCheckpoints();
  });

// A test seam only — the same reasoning as studio.js's window.clawscadStudio:
// `ctx` lives inside the esbuild bundle's module scope and page.evaluate cannot
// reach it. No product code path goes through this alias.
try {
  window.clawscadWeb = { ctx, api, startImageGeneration };
} catch {}
