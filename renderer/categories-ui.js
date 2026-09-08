// renderer/categories-ui.js — P8 (guided UI). Owned exclusively by the
// guided package.
//
// The headline of v0.4: the composer's first question stops being
// "Part / Sculpt / Images" — a pipeline concept nobody outside CAD can
// answer — and becomes "What are you making?", a grid of ten print types.
// Picking one silently sets the pipeline target AND the intent presets, so
// the technical controls below become confirmations rather than decisions.
//
// Mounts into ctx.composer.guidedSlot and publishes ctx.guided.
// Full contract: docs/v04-guided-make-contracts.md §P8.
//
// ESM imports hoist: nothing here may read the DOM or ctx at import time.
// All work belongs inside mountGuided(ctx), which renderer.js calls last,
// after ctx.categories, ctx.presets and ctx.confirm all exist.
import { decideRoute, explain } from './route.js';

const COLS = 3; // the grid is three across; arrow-key geometry follows from it

// Used only when P7's explain() is unavailable or returns nothing — the note
// must never be blank, because a blank note reads as "nothing will happen".
const FALLBACK_EXPLAIN = {
  direct: 'This is straightforward — making it now.',
  confirm: "Let's check the look first — I'll show you a few options.",
};

// The one override control, per route. Verbatim from the contract.
const OVERRIDE_LABEL = {
  direct: 'Show me options first', // shown while heading straight through
  confirm: 'Skip the check, just make it',
};

export function mountGuided(ctx) {
  if (!ctx || !ctx.composer || !ctx.composer.guidedSlot) return;
  const slot = ctx.composer.guidedSlot;
  if (!slot) return;

  // ── taxonomy ─────────────────────────────────────────────────────────
  // renderer.js hands us { categories: <parsed file>, error } from
  // main/categories.js; the contract calls the payload field `data`. Accept
  // either, and accept a bare array too — a shape mismatch must degrade to
  // "no grid, app still works", never to a throw that kills the mount.
  const { list: categories, preamble: taxonomyPreamble, defaultId, loadError } = readTaxonomy(ctx);

  // ── state ────────────────────────────────────────────────────────────
  let selectedId = pickInitialId(categories, defaultId);
  let answers = {}; // { [askFieldId]: string } for the CURRENT category only
  const answerMemo = new Map(); // categoryId -> answers, so switching back restores
  let override = null; // 'direct' | 'confirm' — the user's explicit choice
  let overrideBasis = null; // the natural route when the override was taken
  let clearedNotice = false; // announce, once, that the override lapsed
  let clearedNoticeShown = false; // it has been on screen for a beat; retire it
  let attachment = null; // { path, kind } handed back by the confirm gate
  let targetTouched = false; // the user clicked an Output button themselves
  let lastSignature = null;
  let syncQueued = false;
  const changeHandlers = [];

  // ── DOM ──────────────────────────────────────────────────────────────
  slot.innerHTML = '';

  const heading = document.createElement('div');
  heading.id = 'category-heading';
  heading.textContent = 'What are you making?';
  slot.appendChild(heading);

  const grid = document.createElement('div');
  grid.id = 'category-grid';
  grid.setAttribute('role', 'radiogroup');
  grid.setAttribute('aria-label', 'What are you making');
  slot.appendChild(grid);

  const askEl = document.createElement('div');
  askEl.id = 'category-ask';
  slot.appendChild(askEl);

  const noteEl = document.createElement('div');
  noteEl.id = 'route-note';
  noteEl.setAttribute('role', 'status');
  noteEl.setAttribute('aria-live', 'polite');
  slot.appendChild(noteEl);

  const noteText = document.createElement('span');
  noteText.className = 'route-note-text';
  noteEl.appendChild(noteText);

  const noteOverride = document.createElement('button');
  noteOverride.type = 'button';
  noteOverride.className = 'route-note-override';
  noteOverride.addEventListener('click', onOverrideClick);
  noteEl.appendChild(noteOverride);

  const noteFlag = document.createElement('span');
  noteFlag.className = 'route-note-flag';
  noteFlag.hidden = true;
  noteEl.appendChild(noteFlag);

  // Caption for the (demoted, never hidden) Output row that the composer
  // renders immediately after this slot. It lives here rather than being
  // injected into #composer-targets, because P8 must not reparent or edit
  // that element — three specs click its buttons.
  const outputCaption = document.createElement('div');
  outputCaption.className = 'guided-caption';
  outputCaption.id = 'guided-output-caption';
  outputCaption.textContent = 'Output';
  slot.appendChild(outputCaption);

  const errorEl = document.createElement('div');
  errorEl.id = 'category-load-error';
  errorEl.hidden = true;
  slot.insertBefore(errorEl, grid);

  const tiles = new Map(); // id -> button

  // ── grid ─────────────────────────────────────────────────────────────
  function buildGrid() {
    grid.innerHTML = '';
    tiles.clear();

    if (!categories.length) {
      // Stated, never blank: the person can still type and press the button.
      errorEl.hidden = false;
      errorEl.textContent = loadError
        ? `Print types couldn't load — just describe what you're making below.`
        : `No print types are set up — just describe what you're making below.`;
      if (loadError) errorEl.title = String(loadError);
      grid.hidden = true;
      outputCaption.hidden = false;
      return;
    }

    errorEl.hidden = !loadError;
    if (loadError) {
      errorEl.textContent = "Some print types couldn't be read — using the ones that loaded.";
      errorEl.title = String(loadError);
    }
    grid.hidden = false;

    for (const cat of categories) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'category-tile';
      btn.dataset.category = cat.id;
      btn.setAttribute('role', 'radio');
      btn.setAttribute('aria-checked', 'false');
      if (cat.hint) btn.title = cat.hint;
      btn.tabIndex = -1;

      const glyph = document.createElement('span');
      glyph.className = 'category-glyph';
      glyph.setAttribute('aria-hidden', 'true');
      glyph.textContent = cat.glyph || '·';
      btn.appendChild(glyph);

      const label = document.createElement('span');
      label.className = 'category-label';
      label.textContent = cat.label || cat.id;
      btn.appendChild(label);

      btn.addEventListener('click', () => {
        selectCategory(cat.id, { user: true, focus: false });
      });

      grid.appendChild(btn);
      tiles.set(cat.id, btn);
    }
  }

  grid.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const ids = categories.map((c) => c.id);
    if (!ids.length) return;
    const idx = Math.max(0, ids.indexOf(selectedId));
    let next = null;
    if (e.key === 'ArrowRight') next = (idx + 1) % ids.length;
    else if (e.key === 'ArrowLeft') next = (idx - 1 + ids.length) % ids.length;
    else if (e.key === 'ArrowDown') next = Math.min(ids.length - 1, idx + COLS);
    else if (e.key === 'ArrowUp') next = Math.max(0, idx - COLS);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = ids.length - 1;
    if (next === null) return;
    e.preventDefault();
    selectCategory(ids[next], { user: true, focus: true });
  });

  function refreshGridUI() {
    for (const [id, btn] of tiles) {
      const on = id === selectedId;
      btn.setAttribute('aria-checked', on ? 'true' : 'false');
      btn.classList.toggle('is-selected', on);
      // One tab stop for the whole grid (roving tabindex).
      btn.tabIndex = on ? 0 : -1;
    }
    // Nothing is selected (empty taxonomy) — keep one reachable tab stop.
    if (!tiles.has(selectedId)) {
      const first = tiles.values().next();
      if (!first.done) first.value.tabIndex = 0;
    }
  }

  // ── ask fields ───────────────────────────────────────────────────────
  function buildAsk() {
    askEl.innerHTML = '';
    const cat = getCategory();
    const fields = (cat && Array.isArray(cat.ask) && cat.ask) || [];
    askEl.hidden = fields.length === 0;
    if (!fields.length) return;

    for (const field of fields.slice(0, 3)) {
      if (!field || !field.id) continue;
      const wrap = document.createElement('label');
      wrap.className = 'category-ask-field';
      // Deliberately NOT data-ask-id — that belongs to the control alone, so
      // [data-ask-id="x"] always resolves to exactly one element.
      wrap.dataset.askField = field.id;

      const label = document.createElement('span');
      label.className = 'category-ask-label';
      label.textContent = field.label || field.id;
      wrap.appendChild(label);

      let input;
      if (field.kind === 'choice') {
        input = document.createElement('select');
        // Leading blank option — nothing in `ask` is ever required.
        const blank = document.createElement('option');
        blank.value = '';
        blank.textContent = '—';
        input.appendChild(blank);
        for (const opt of Array.isArray(field.options) ? field.options : []) {
          const o = document.createElement('option');
          o.value = String(opt);
          o.textContent = String(opt);
          input.appendChild(o);
        }
      } else {
        input = document.createElement('input');
        input.type = field.kind === 'number' ? 'number' : 'text';
        if (field.kind === 'number') input.inputMode = 'decimal';
        if (field.placeholder) input.placeholder = String(field.placeholder);
      }
      input.className = 'category-ask-input';
      input.dataset.askId = field.id;
      input.value = answers[field.id] || '';
      input.addEventListener('input', () => onAnswerChange(field.id, input.value));
      input.addEventListener('change', () => onAnswerChange(field.id, input.value));
      // The composer's own root keydown handler turns a bare 1/2/3 into an
      // Output change unless focus is in #composer-prompt (composer.js:190).
      // Typing "20" in a Length box must not silently switch what gets made.
      input.addEventListener('keydown', (e) => {
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        if (e.key && e.key.length === 1) e.stopPropagation();
      });
      wrap.appendChild(input);

      if (field.unit) {
        const unit = document.createElement('span');
        unit.className = 'category-ask-unit';
        unit.textContent = String(field.unit);
        wrap.appendChild(unit);
      }

      askEl.appendChild(wrap);
    }
  }

  function onAnswerChange(id, value) {
    answers[id] = typeof value === 'string' ? value : '';
    answerMemo.set(selectedId, { ...answers });
    persist();
    sync({ force: true });
    if (ctx.composer.refresh) ctx.composer.refresh();
    emitChange();
  }

  // ── selection ────────────────────────────────────────────────────────
  function selectCategory(id, opts) {
    const options = opts || {};
    const cat = byId(id);
    if (!cat) return;
    const changed = id !== selectedId;

    if (changed) {
      answerMemo.set(selectedId, { ...answers });
      selectedId = id;
      answers = { ...(answerMemo.get(id) || {}) };
      attachment = null; // a different thing entirely — the old reference is stale
    }

    // An override belongs to the description it was taken for.
    override = null;
    overrideBasis = null;
    clearedNotice = false;
    clearedNoticeShown = false;
    if (options.user) targetTouched = false;

    refreshGridUI();
    buildAsk();

    if (options.focus) {
      const btn = tiles.get(id);
      if (btn) btn.focus();
    }

    if (options.user) {
      // The whole point of the grid: picking a print type sets the
      // fine-tune chips and what gets made, so the person never has to
      // learn what those controls mean.
      applyCategoryWiring(cat);
    } else if (ctx.composer.setPlaceholder) {
      // Boot-time restore is REFLECTION ONLY — no chip or Output changes.
      // Applying them here would alter the app's launch state for every
      // other package's spec, and the composer has already restored its own.
      safe(() => ctx.composer.setPlaceholder(exampleFor(cat)));
    }

    persist();
    sync({ force: true });
    if (ctx.composer.refresh) ctx.composer.refresh();
    emitChange();
  }

  function applyCategoryWiring(cat) {
    if (ctx.presets && typeof ctx.presets.setActive === 'function') {
      safe(() => ctx.presets.setActive(Array.isArray(cat.presets) ? cat.presets.slice() : []));
    }
    const decision = currentDecision();
    if (decision) syncTarget(decision);
    if (ctx.composer.setPlaceholder) safe(() => ctx.composer.setPlaceholder(exampleFor(cat)));
  }

  function syncTarget(decision) {
    if (!decision || !decision.target) return;
    if (!getCategory()) return; // no taxonomy = no opinion about what gets made
    if (typeof ctx.composer.setTarget !== 'function') return;
    safe(() => ctx.composer.setTarget(decision.target, { silent: true }));
  }

  // ── decision ─────────────────────────────────────────────────────────
  function naturalDecision() {
    const input = {
      category: getCategory(),
      prompt: promptText(),
      answers: { ...answers },
      attachments: readAttachments(),
    };
    let d = null;
    try {
      d = decideRoute(input);
    } catch (err) {
      console.error('[guided] decideRoute threw', err);
    }
    if (!d || typeof d !== 'object') {
      d = { route: 'direct', target: 'part', presets: [], confirmMode: 'none', score: 50, reasons: [], missing: [], forced: false };
    }
    if (d.route !== 'confirm') d.route = 'direct';
    return d;
  }

  // The user's override wins until the description changes it out from
  // under them; when that happens it lapses and the lapse is announced in
  // the same role="status" line.
  function currentDecision() {
    const natural = naturalDecision();
    if (override && overrideBasis && natural.route !== overrideBasis) {
      override = null;
      overrideBasis = null;
      clearedNotice = true;
    }
    if (!override || override === natural.route) return natural;

    const cat = getCategory();
    const route = override;
    return {
      ...natural,
      route,
      target: cat ? (route === 'direct' ? cat.target_direct || cat.target : cat.target) || natural.target : natural.target,
      // "Show me options first" on a type that normally never checks
      // (hardware) still has to have something to show, so an absent or
      // 'none' mode becomes generated previews rather than an empty sheet.
      confirmMode:
        route === 'confirm' ? (cat && cat.confirm && cat.confirm !== 'none' ? cat.confirm : 'images') : 'none',
      forced: false,
      overridden: true,
    };
  }

  function onOverrideClick() {
    const natural = naturalDecision();
    override = natural.route === 'direct' ? 'confirm' : 'direct';
    overrideBasis = natural.route;
    clearedNotice = false;
    clearedNoticeShown = false;
    if (!targetTouched) {
      const d = currentDecision();
      if (d) syncTarget(d);
    }
    sync({ force: true });
    if (ctx.composer.refresh) ctx.composer.refresh();
    emitChange();
  }

  // ── route note ───────────────────────────────────────────────────────
  function sync(opts) {
    const decision = currentDecision();
    const text = explainText(decision);
    const overrideLabel = OVERRIDE_LABEL[decision.route === 'direct' ? 'direct' : 'confirm'];
    const flag = clearedNotice
      ? "That changed things — I'm back to my own suggestion."
      : decision.overridden
        ? 'Your choice.'
        : '';
    const signature = [selectedId, decision.route, decision.target, text, overrideLabel, flag].join('');
    if (!(opts && opts.force) && signature === lastSignature) return;
    lastSignature = signature;

    noteText.textContent = text;
    noteOverride.textContent = overrideLabel;
    noteOverride.hidden = !categories.length;
    noteFlag.hidden = !flag;
    noteFlag.textContent = flag;
    noteEl.dataset.route = decision.route;
    if (clearedNotice) clearedNoticeShown = true;

    if (typeof ctx.composer.setSubmitLabel === 'function') {
      safe(() =>
        ctx.composer.setSubmitLabel(
          !getCategory() ? null : decision.route === 'confirm' ? 'Check it first' : 'Make it'
        )
      );
    }
  }

  // blocks() runs on every composer state recompute, which is the only hook
  // that catches a prompt set programmatically (a starter card, the confirm
  // gate). Deferred to a microtask so the note never re-enters the composer
  // mid-update; the signature check makes the extra pass a no-op.
  function scheduleSync() {
    if (syncQueued) return;
    syncQueued = true;
    Promise.resolve().then(() => {
      syncQueued = false;
      try {
        sync();
      } catch (err) {
        console.error('[guided] sync failed', err);
      }
    });
  }

  function explainText(decision) {
    let text = '';
    try {
      text = explain(decision) || '';
    } catch (err) {
      console.error('[guided] explain threw', err);
    }
    return String(text) || FALLBACK_EXPLAIN[decision.route] || FALLBACK_EXPLAIN.direct;
  }

  // ── composer section (preamble only — the guided flow never blocks) ──
  ctx.composer.registerSection({
    id: 'category',
    order: -10,
    preamble() {
      const lines = [];
      // Nothing is contributed until the person has actually described
      // something. Otherwise the composer would consider a freshly-launched
      // app "non-empty" and enable its button with no request in it.
      if (!promptText()) return lines;
      if (ctx.composer.getTarget && ctx.composer.getTarget() !== 'part') return lines;

      const cat = getCategory();
      if (taxonomyPreamble) lines.push(taxonomyPreamble);
      if (cat && cat.prompt) lines.push(cat.prompt);

      const fields = (cat && Array.isArray(cat.ask) && cat.ask) || [];
      for (const field of fields) {
        if (!field || !field.id) continue;
        const raw = (answers[field.id] || '').trim();
        if (!raw) continue;
        const unit = field.unit ? String(field.unit) : '';
        const value = unit && !raw.toLowerCase().endsWith(unit.toLowerCase()) ? `${raw} ${unit}` : raw;
        lines.push(`${field.label || field.id}: ${value}`);
      }

      if (attachment && attachment.path) {
        lines.push(
          `Approved reference image: ${attachment.path}\nThe person confirmed this is the right look. Read it before writing geometry, and say in a comment what it does and does not tell you.`
        );
      }
      return lines;
    },
    blocks() {
      scheduleSync();
      return null; // the guided flow never blocks submit
    },
  });

  // ── submit ───────────────────────────────────────────────────────────
  ctx.composer.onSubmit(async () => {
    let decision;
    try {
      decision = currentDecision();
    } catch (err) {
      console.error('[guided] could not work out what to do — sending as-is', err);
      return undefined;
    }

    if (!decision || decision.route !== 'confirm') {
      if (!targetTouched) syncTarget(decision);
      return undefined;
    }

    if (!ctx.confirm || typeof ctx.confirm.open !== 'function') {
      // Degrade to today's behaviour, never to a dead button.
      console.warn('[guided] the check step is unavailable — sending straight through');
      if (!targetTouched) syncTarget(decision);
      return undefined;
    }

    let result;
    try {
      result = await ctx.confirm.open({
        decision,
        prompt: promptText(),
        category: getCategory(),
        answers: { ...answers },
      });
    } catch (err) {
      console.error('[guided] the check step failed — sending straight through', err);
      if (!targetTouched) syncTarget(decision);
      return undefined;
    }

    if (result && result.proceed === false) return { handled: true }; // backed out, quietly
    if (result && result.handled) return { handled: true }; // the gate ran it itself

    if (result && result.attachment && result.attachment.path) {
      attachment = { path: result.attachment.path, kind: result.attachment.kind || 'image' };
      if (ctx.composer.refresh) ctx.composer.refresh();
    }
    if (!targetTouched) syncTarget(decision);
    return undefined;
  });

  // ── the person's own choice of Output always wins ────────────────────
  const targetsEl = document.getElementById('composer-targets');
  if (targetsEl) {
    targetsEl.addEventListener(
      'click',
      (e) => {
        if (e.target && e.target.closest && e.target.closest('.target-btn')) targetTouched = true;
      },
      true
    );
  }

  // Typing is the other thing that changes the answer, and the composer's
  // own input handler already recomputes state (which reaches blocks()).
  // This listener is the belt to that braces: firstBlockingSection() stops
  // at the first section that blocks, which can be another package's.
  const promptEl = document.getElementById('composer-prompt');
  if (promptEl) {
    promptEl.addEventListener('input', () => {
      // The lapse notice earns exactly one keystroke on screen, then goes.
      if (clearedNoticeShown) {
        clearedNotice = false;
        clearedNoticeShown = false;
      }
      sync();
      emitChange();
    });
  }

  // ── persistence — the composer owns composer-state.json ──────────────
  function persist() {
    if (typeof ctx.composer.setGuidedState !== 'function') return;
    safe(() => ctx.composer.setGuidedState({ categoryId: selectedId, answers: { ...answers } }));
  }

  function restore() {
    let state = null;
    try {
      state = typeof ctx.composer.getGuidedState === 'function' ? ctx.composer.getGuidedState() : null;
    } catch (err) {
      console.error('[guided] could not read the saved selection', err);
    }
    if (state && typeof state === 'object') {
      if (typeof state.categoryId === 'string' && byId(state.categoryId)) selectedId = state.categoryId;
      if (state.answers && typeof state.answers === 'object') {
        answers = {};
        for (const [k, v] of Object.entries(state.answers)) if (typeof v === 'string') answers[k] = v;
      }
    }
    answerMemo.set(selectedId, { ...answers });
    selectCategory(selectedId, { user: false, focus: false });
  }

  // ── helpers ──────────────────────────────────────────────────────────
  function byId(id) {
    return categories.find((c) => c && c.id === id) || null;
  }
  function getCategory() {
    return byId(selectedId);
  }
  function exampleFor(cat) {
    const ex = cat && Array.isArray(cat.examples) ? cat.examples[0] : null;
    return typeof ex === 'string' && ex ? ex : null;
  }
  function promptText() {
    try {
      return (ctx.composer.getPrompt() || '').trim();
    } catch {
      return '';
    }
  }
  function readAttachments() {
    const out = [];
    try {
      const chips = document.querySelectorAll('.file-chip[data-class]');
      for (const chip of chips) {
        const nameEl = chip.querySelector('.file-chip-name');
        out.push({ name: nameEl ? nameEl.textContent || '' : '', kind: chip.dataset.class });
      }
    } catch (err) {
      console.error('[guided] could not read the attached files', err);
    }
    if (attachment && attachment.path) out.push({ name: attachment.path, kind: attachment.kind || 'image' });
    return out;
  }
  function emitChange() {
    for (const cb of changeHandlers) {
      try {
        cb();
      } catch (err) {
        console.error('[guided] onChange subscriber threw', err);
      }
    }
  }
  function safe(fn) {
    try {
      return fn();
    } catch (err) {
      console.error('[guided]', err);
      return undefined;
    }
  }

  // ── initial render ──────────────────────────────────────────────────
  buildGrid();
  refreshGridUI();
  buildAsk();
  sync({ force: true });

  // composerGetState() is async, so the persisted guided block has NOT
  // landed yet at mount time — getGuidedState() is empty right now. Awaiting
  // ctx.composer.ready is the only way to see it (contract §P8 persistence).
  if (ctx.composer.ready && typeof ctx.composer.ready.then === 'function') {
    ctx.composer.ready.then(restore).catch((err) => console.error('[guided] restore failed', err));
  } else {
    restore();
  }

  // ── ctx.guided — published last, so nothing ever sees a half-built one
  // eslint-disable-next-line no-multi-assign
  ctx.guided = {
    getCategory,
    setCategory: (id) => selectCategory(id, { user: true, focus: false }),
    getAnswers: () => ({ ...answers }),
    getDecision: () => currentDecision(),
    onChange: (cb) => {
      if (typeof cb === 'function') changeHandlers.push(cb);
    },
  };

  // `ctx` is module-scoped inside the esbuild bundle and unreachable from
  // page.evaluate, so the spec has no other way to read the published
  // interface. Mirrors renderer/confirm-gate.js's window.clawscadConfirm.
  try {
    window.clawscadGuided = ctx.guided;
  } catch (err) {
    console.error('[guided] could not publish the test handle', err);
  }
}

// Accepts { data } (contract), { categories } (what main/categories.js
// actually returns), a bare parsed file, or a bare array. Anything else
// degrades to an empty grid with a stated reason.
function readTaxonomy(ctx) {
  const empty = { list: [], preamble: '', defaultId: null, loadError: null };
  const payload = ctx.categories;
  if (!payload || typeof payload !== 'object') return { ...empty, loadError: 'The print types were not loaded.' };

  const loadError = payload.error || null;
  let file = payload.data || payload.categories || null;
  if (Array.isArray(file)) file = { categories: file };
  if (!file || typeof file !== 'object' || !Array.isArray(file.categories)) return { ...empty, loadError };

  const list = file.categories.filter((c) => c && typeof c === 'object' && typeof c.id === 'string');
  return {
    list,
    preamble: typeof file.preamble === 'string' ? file.preamble : '',
    defaultId: typeof file.default === 'string' ? file.default : null,
    loadError,
  };
}

function pickInitialId(list, defaultId) {
  if (!list.length) return null;
  if (defaultId && list.some((c) => c.id === defaultId)) return defaultId;
  return list[0].id;
}
