// renderer/onboarding.js — P5 (onboarding + copy pass). Owned exclusively by
// the onboarding package.
//
// IMPORTANT: renderer.js is bundled by esbuild as ESM (--format=esm), and
// ESM imports hoist — this module's top-level body runs BEFORE renderer.js's
// own body finishes executing. All work happens inside mountOnboarding(ctx),
// called once at the very end of renderer.js's init, after `ctx` (see
// renderer/bus.js) is fully populated.
//
// Stylesheet note: index.html's clawscad:anchor:stylesheets block (added by
// P0) links style-composer.css / style-uploads.css / style-presets.css /
// style-gallery.css but was never extended for a fifth "onboarding" package
// — nobody anticipated P5 needing its own file. Rather than block on an
// index.html edit outside this package's exclusive ownership, this module
// injects its own <link> into <head> imperatively at mount (guarded so a
// re-mount never double-inserts it). Reported to the integrator: for the
// PACKAGED build, `style-onboarding.css` still needs a real <link> in
// index.html plus an entry in package.json's `build.files` (R-12) — the
// imperative injection only covers the dev/test run of this renderer bundle.
function ensureStylesheet() {
  if (document.getElementById('style-onboarding-link')) return;
  const link = document.createElement('link');
  link.id = 'style-onboarding-link';
  link.rel = 'stylesheet';
  link.href = './style-onboarding.css';
  document.head.appendChild(link);
}

const STARTERS = [
  {
    id: 'fits',
    glyph: '▣', // ▣ hollow square — same shape language as the parametric checkpoint glyph
    title: 'A part that fits something',
    target: 'part',
    prompt: 'a 40 mm cable clip that snaps onto a 6 mm cable',
  },
  {
    id: 'looks-good',
    glyph: '❈', // ❋ — same glyph family as the decorative/generated checkpoint kind
    title: 'A sculpt that looks good',
    target: 'sculpt',
    prompt: 'a squat owl planter with big round eyes',
  },
  {
    id: 'open',
    glyph: '⊞', // ⊞ — "open" affordance, distinct from the two make-something glyphs
    title: 'Open something I made',
    action: 'open-gallery',
  },
];

// Copy pass (master plan §3 W5 / ux-spec §3.2): the status bar's boot-time
// message still describes the old terminal-first interface. #status's text
// lives in static index.html markup (out of this package's write scope —
// index.html is P0's), and nothing else in renderer.js rewrites it before a
// render actually happens, so it is safe to patch once, imperatively, at
// mount. Only "in the terminal on the right" changes; the rest of the
// sentence — and #status-bar's own required "ClawSCAD" text/click target —
// are untouched.
function applyCopyPass() {
  const statusEl = document.getElementById('status');
  if (!statusEl) return;
  const OLD = 'in the terminal on the right';
  const NEW = 'on the right';
  if (statusEl.textContent && statusEl.textContent.includes(OLD)) {
    statusEl.textContent = statusEl.textContent.replace(OLD, NEW);
  }
}

export function mountOnboarding(ctx) {
  if (!ctx || !ctx.els || !ctx.els.viewportsContainer) return;

  ensureStylesheet();
  applyCopyPass();

  const container = ctx.els.viewportsContainer;

  // The card is a SIBLING of #viewport inside #viewports-container, never a
  // new layer inside #render-overlay — #render-overlay must keep computing
  // opacity:0 at rest regardless of onboarding state (app.spec.js,
  // ui-surfaces.spec.js). #viewports-container needs position:relative for
  // the overlay math; that rule lives in style-onboarding.css, scoped to
  // this package's own file per arch-map §4.1 (nobody else styles this id).
  const wrap = document.createElement('div');
  wrap.id = 'onboarding-overlay';
  wrap.setAttribute('aria-hidden', 'false');

  const card = document.createElement('section');
  card.id = 'onboarding-card';
  card.setAttribute('aria-labelledby', 'onboarding-title');
  wrap.appendChild(card);
  container.appendChild(wrap);

  const title = document.createElement('h2');
  title.id = 'onboarding-title';
  title.textContent = 'Make something.';
  card.appendChild(title);

  const body = document.createElement('p');
  body.id = 'onboarding-body';
  body.textContent =
    'Describe a part on the right and press Make it. Everything you make is kept — nothing is ever overwritten.';
  card.appendChild(body);

  const startersEl = document.createElement('div');
  startersEl.className = 'onboard-start';
  startersEl.setAttribute('role', 'group');
  startersEl.setAttribute('aria-label', 'Get started');
  card.appendChild(startersEl);

  for (const s of STARTERS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'onboard-start-card';
    btn.dataset.starter = s.id;

    const glyph = document.createElement('span');
    glyph.className = 'onboard-start-glyph';
    glyph.setAttribute('aria-hidden', 'true');
    glyph.textContent = s.glyph;
    btn.appendChild(glyph);

    const label = document.createElement('span');
    label.className = 'onboard-start-title';
    label.textContent = s.title;
    btn.appendChild(label);

    btn.addEventListener('click', () => runStarter(s));
    startersEl.appendChild(btn);
  }

  const envEl = document.createElement('ul');
  envEl.className = 'onboard-env';
  envEl.setAttribute('aria-label', 'Setup status');
  card.appendChild(envEl);

  function runStarter(s) {
    if (s.action === 'open-gallery') {
      // No public ctx.gallery API is exposed (master plan §4.3 lists no such
      // interface) — the gallery's only entry points are its own header
      // button and Ctrl/Cmd+G. Drive the button directly, same pattern
      // composer.js uses to invoke #gen-generate-btn without bypassing it.
      const galleryBtn = document.getElementById('gallery-open-btn');
      if (galleryBtn) {
        galleryBtn.click();
      } else if (ctx.showToast) {
        ctx.showToast('Gallery is not available yet', 'error');
      }
      return;
    }
    if (!ctx.composer) {
      if (ctx.showToast) ctx.showToast('The composer is not available yet', 'error');
      return;
    }
    // Real, editable text — never a placeholder that vanishes on the first
    // keystroke (master plan directive; ux-spec §3.1 item 1/2).
    ctx.composer.setTarget(s.target);
    ctx.composer.setPrompt(s.prompt, { select: true });
  }

  // ── live three-item environment checklist ──────────────────────────────
  // Reuses env:status (openscad/claude) and pipeline:backends (claw-gen) —
  // the same probes that already feed #env-banners and the composer's own
  // degradation card. This is a checklist, not a banner: it complements
  // #env-banners (which shows at most one at a time) rather than fighting
  // it, and it never renders more than this one <ul>.
  function envRow(id, label, ready, fixText, fixLabel, fixRun) {
    const li = document.createElement('li');
    li.className = 'onboard-env-item';
    li.dataset.env = id;
    li.classList.toggle('is-ready', !!ready);

    const status = document.createElement('span');
    status.className = 'onboard-env-status';
    status.textContent = ready ? 'Ready' : fixText || 'Not set up';
    li.appendChild(status);

    const nameEl = document.createElement('span');
    nameEl.className = 'onboard-env-name';
    nameEl.textContent = label;
    li.appendChild(nameEl);

    if (!ready && fixLabel && fixRun) {
      const fixBtn = document.createElement('button');
      fixBtn.type = 'button';
      fixBtn.className = 'onboard-env-fix';
      fixBtn.textContent = fixLabel;
      fixBtn.addEventListener('click', fixRun);
      li.appendChild(fixBtn);
    }
    return li;
  }

  async function refreshChecklist() {
    if (!ctx.api) return;
    let env = null;
    let pipeline = null;
    try {
      env = ctx.api.getEnvStatus ? await ctx.api.getEnvStatus() : null;
    } catch (err) {
      console.error('[onboarding] getEnvStatus failed', err);
    }
    try {
      pipeline = ctx.api.getPipelineBackends ? await ctx.api.getPipelineBackends() : null;
    } catch (err) {
      console.error('[onboarding] getPipelineBackends failed', err);
    }

    envEl.innerHTML = '';

    const openscadReady = !!(env && env.openscad && env.openscad.resolved);
    envEl.appendChild(
      envRow('openscad', 'OpenSCAD', openscadReady, 'Not found', 'Locate OpenSCAD…', async () => {
        if (ctx.api.locateOpenSCAD) await ctx.api.locateOpenSCAD();
        refreshChecklist();
      })
    );

    const claudeReady = !!(env && env.claude && env.claude.binary);
    envEl.appendChild(
      envRow('claude', 'Claude', claudeReady, 'Not installed', 'Setup guide', () => {
        if (ctx.api.openReadme) ctx.api.openReadme();
      })
    );

    let clawGenReady = false;
    let clawGenFixText = 'Not set up';
    let clawGenFixLabel = 'Locate claw-gen…';
    let clawGenFixRun = async () => {
      if (ctx.api.locatePipelineCli) await ctx.api.locatePipelineCli();
      refreshChecklist();
    };
    if (pipeline) {
      clawGenReady = pipeline.state === 'ready';
      if (pipeline.state === 'cli-error') {
        clawGenFixText = 'Failed to start';
      } else if (pipeline.state === 'no-backend') {
        clawGenFixText = 'No backends available';
        clawGenFixLabel = '';
        clawGenFixRun = null;
      }
    }
    envEl.appendChild(
      envRow('claw-gen', 'Sculpting', clawGenReady, clawGenFixText, clawGenFixLabel, clawGenFixRun)
    );
  }

  refreshChecklist();

  // ── visibility: shown on a fresh workspace, hidden once ≥1 checkpoint
  // exists — never by a close button (ux-spec §3.1: "it should never need
  // one"). Subscribed via ctx.onCheckpointsChanged, never a direct
  // window.api.onCheckpointUpdate call (standing rule 4 — no unsubscribe,
  // renderer.js already owns the one registration).
  function applyVisibility(state) {
    const hasCheckpoints = !!(state && state.checkpoints && Object.keys(state.checkpoints).length > 0);
    wrap.hidden = hasCheckpoints;
  }

  if (ctx.api && ctx.api.getCheckpoints) {
    ctx.api.getCheckpoints().then(applyVisibility).catch((err) => {
      console.error('[onboarding] getCheckpoints failed', err);
    });
  }
  if (typeof ctx.onCheckpointsChanged === 'function') {
    ctx.onCheckpointsChanged(applyVisibility);
  }
}
