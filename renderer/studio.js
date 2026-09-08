// renderer/studio.js — S1 (v0.6 "Studio"). Owned exclusively by the studio
// package. Contract: docs/v06-studio-contracts.md §S1.
//
// The front door. v0.4 made the QUESTION human ("what are you making?") but
// left the answer being typed into a 280px rail with the submit button below
// the fold. This is the whole window: pick a print type, switch on the tools
// that say what a sentence can't, type one line, press one button.
//
// Three flows, and they are the product:
//
//   A. Direct        — compose a brief and hand it to Claude. Parametric.
//   B. Preview first — generate reference pictures, narrow in over rounds,
//                      THEN either mesh the winner or hand it to Claude as an
//                      approved reference and build it parametrically.
//   C. Recreate      — a picture the user already has, meshed directly.
//
// Four constraints shape everything below, and each one has cost somebody a
// day before:
//
//  1. NEVER re-implement the pipeline. The studio drives the EXISTING Generate
//     panel — writes #gen-prompt, clicks #gen-generate-btn, clicks the matching
//     .gen-candidate and #gen-make3d-btn — and listens through the
//     ctx.onPipelineEvent fan-out. window.api.onPipelineEvent is registered
//     exactly once, by renderer.js (standing rule 3). The single exception the
//     contract grants is flow C's `mesh --image … --new-job`, which has no
//     button to drive.
//  2. It never throws at mount. A throw here is the last mount in the chain,
//     but it still leaves the app with a hidden studio and a header tab that
//     does nothing — so every DOM handle is guarded and every await is wrapped.
//  3. Every id and class name in the DOM inventory is frozen. S2 is writing CSS
//     against these selectors and S4 is asserting them; a rename breaks both
//     silently, at a distance, in someone else's file.
//  4. A disabled control is COLOURED, never faded (standing rule 1). Nothing
//     here ever sets `opacity`.
//
// ESM imports hoist, so nothing at this file's top level reads the DOM or ctx;
// all of that happens inside mountStudio(ctx).
import {
  readCatalog,
  autoToolsFor,
  toolAppliesTo,
  pruneValues,
  compile,
  composeBrief,
  composeImagePrompt,
} from './tools.js';
import { decideRoute, explain } from './route.js';

// auto → on → off → auto. Order is asserted by the spec, so it lives in one
// array rather than in a chain of ternaries nobody can read.
const PREVIEW_ORDER = ['auto', 'on', 'off'];

const GEN_STAGES = ['images', 'mesh', 'prep', 'checkpoint'];

// The one-line orientation under the title. Not marketing: it tells the person
// what the button is going to do to their afternoon.
const SUB_LINE = 'Describe it in a sentence. Switch on whatever the sentence cannot carry.';

export function mountStudio(ctx) {
  const root = ctx && ctx.els && ctx.els.studio;
  if (!root) return;

  const api = (ctx && ctx.api) || null;
  const mainEl = document.getElementById('main-content');
  const tabStudio = document.getElementById('view-studio');
  const tabWorkbench = document.getElementById('view-workbench');

  // ── state (contract §S1 "State") ───────────────────────────────────────
  let view = 'studio';
  let viewTouched = false; // a real click beats a late-arriving persisted view
  let categoryId = null;
  let promptText = '';
  let enabled = []; // tool ids, in click order
  let values = {}; // { [toolId]: { [fieldId]: string } }
  let preview = 'auto'; // 'auto' | 'on' | 'off'
  let attachment = null; // { relPath, name, kind, mode: 'recreate' | 'reference' }
  let stage = null; // { phase, job, round, candidates[], selectedKey, prompt }

  // Tools the user pinned on / off by hand. A category switch re-derives the
  // automatic set but must never quietly undo a deliberate click.
  const pinned = new Set();
  let dismissed = new Set();

  // Declared up here, not next to renderNotices(): buildTypes() can raise the
  // "print types couldn't load" notice during the synchronous mount body, and
  // a `const` further down would still be in its temporal dead zone. A ReferenceError
  // there would take the whole front door with it.
  const notices = new Map();

  let tools = [];
  let groups = [];
  let toolsError = null;
  let toolsLoaded = false;

  let env = null; // { openscad, claude:{binary}, clawGen:{binary} } — probed once
  let lastJob = null; // the newest job slug seen on the event stream
  let panelSignature = ''; // rebuild the field panels only when the set changes
  let restored = false;

  const taxonomy = readTaxonomy(ctx);
  categoryId = pickInitialCategory(taxonomy);

  // ── DOM ────────────────────────────────────────────────────────────────
  root.innerHTML = '';

  const glow = document.createElement('div');
  glow.className = 'studio-glow';
  glow.setAttribute('aria-hidden', 'true');
  root.appendChild(glow);

  const scroll = el('div', 'studio-scroll');
  scroll.id = 'studio-scroll';
  root.appendChild(scroll);

  // hero
  const hero = el('header', 'studio-hero');
  hero.id = 'studio-hero';
  const titleEl = el('h1', 'studio-title');
  titleEl.id = 'studio-title';
  titleEl.textContent = 'What are we making?';
  const subEl = el('p', 'studio-sub');
  subEl.id = 'studio-sub';
  subEl.textContent = SUB_LINE;
  hero.append(titleEl, subEl);
  scroll.appendChild(hero);

  // print types
  const typesEl = el('div', 'studio-types');
  typesEl.id = 'studio-types';
  typesEl.setAttribute('role', 'radiogroup');
  typesEl.setAttribute('aria-label', 'What are you making');
  scroll.appendChild(typesEl);

  // console card — the visual centre of the view
  const consoleEl = el('section', 'studio-console');
  consoleEl.id = 'studio-console';
  scroll.appendChild(consoleEl);

  const chipsEl = el('div', 'studio-chips');
  chipsEl.id = 'studio-chips';
  consoleEl.appendChild(chipsEl);

  const promptEl = document.createElement('textarea');
  promptEl.id = 'studio-prompt';
  promptEl.className = 'studio-prompt';
  promptEl.rows = 2;
  promptEl.setAttribute('aria-label', 'Describe what you are making');
  consoleEl.appendChild(promptEl);

  const toolbar = el('div', 'studio-toolbar');
  toolbar.id = 'studio-toolbar';
  consoleEl.appendChild(toolbar);

  const toolsBtn = button('studio-tools-btn', 'studio-toolbar-btn', 'Tools');
  toolsBtn.setAttribute('aria-haspopup', 'menu');
  toolsBtn.setAttribute('aria-expanded', 'false');
  toolsBtn.setAttribute('aria-controls', 'studio-tools-menu');

  // The one genuinely new control. role=switch with three data-modes: the
  // switch's aria-checked answers "will I see pictures first?", and data-mode
  // says whether that answer is the app's or the person's.
  const previewBtn = button('studio-preview-toggle', 'studio-toolbar-btn', 'Preview');
  previewBtn.setAttribute('role', 'switch');
  previewBtn.dataset.mode = preview;
  previewBtn.setAttribute('aria-checked', 'false');

  const attachBtn = button('studio-attach-btn', 'studio-toolbar-btn', 'Add a picture…');

  const spacer = el('span', 'studio-toolbar-spacer');

  const hintEl = el('span', 'studio-hint');
  hintEl.id = 'studio-hint';

  const submitBtn = button('studio-submit', 'studio-submit-btn', 'Make it');

  toolbar.append(toolsBtn, previewBtn, attachBtn, spacer, hintEl, submitBtn);

  // tools menu
  const menuEl = el('div', 'studio-tools-menu');
  menuEl.id = 'studio-tools-menu';
  menuEl.setAttribute('role', 'menu');
  menuEl.setAttribute('aria-label', 'Tools');
  menuEl.hidden = true;
  scroll.appendChild(menuEl);

  // expanded field groups
  const fieldsEl = el('div', 'studio-tool-fields');
  fieldsEl.id = 'studio-tool-fields';
  scroll.appendChild(fieldsEl);

  // Environment / degradation notices. NOT in the frozen inventory (S2 has no
  // rule for it): every row in the degradation table has to be reachable and
  // has to say WHY, and none of the inventory's regions is the honest place for
  // "claw-gen isn't installed". Reported to the integrator as an S2 addition.
  const noticeEl = el('div', 'studio-notice');
  noticeEl.id = 'studio-notice';
  noticeEl.setAttribute('role', 'status');
  noticeEl.setAttribute('aria-live', 'polite');
  noticeEl.hidden = true;
  scroll.appendChild(noticeEl);

  // route note
  const routeEl = el('div', 'studio-route');
  routeEl.id = 'studio-route';
  routeEl.setAttribute('role', 'status');
  routeEl.setAttribute('aria-live', 'polite');
  const routeTextEl = el('span', 'studio-route-text');
  routeTextEl.id = 'studio-route-text';
  const routeOverrideEl = button('studio-route-override', 'studio-route-override-btn', '');
  routeEl.append(routeTextEl, routeOverrideEl);
  scroll.appendChild(routeEl);

  // the pre-image narrowing process
  const stageEl = el('section', 'studio-stage');
  stageEl.id = 'studio-stage';
  stageEl.hidden = true;
  scroll.appendChild(stageEl);

  const stageTitle = el('h2', 'studio-stage-title');
  stageTitle.id = 'studio-stage-title';
  stageTitle.textContent = 'Finding the right look';
  const stageNote = el('p', 'studio-stage-note');
  stageNote.id = 'studio-stage-note';
  stageNote.setAttribute('role', 'status');
  stageNote.setAttribute('aria-live', 'polite');

  const stepperEl = el('div', 'studio-stepper');
  stepperEl.id = 'studio-stepper';
  for (const name of GEN_STAGES) {
    const step = el('span', 'studio-step');
    step.dataset.stage = name;
    step.textContent = name;
    stepperEl.appendChild(step);
  }
  const elapsedEl = el('span', 'studio-stage-elapsed');
  elapsedEl.id = 'studio-stage-elapsed';
  elapsedEl.textContent = '0:00';

  const candidatesEl = el('div', 'studio-candidates');
  candidatesEl.id = 'studio-candidates';
  candidatesEl.setAttribute('role', 'group');
  candidatesEl.setAttribute('aria-label', 'Reference pictures');

  const stageActions = el('div', 'studio-stage-actions');
  stageActions.id = 'studio-stage-actions';

  const refineInput = document.createElement('input');
  refineInput.id = 'studio-refine-input';
  refineInput.className = 'studio-refine-input';
  refineInput.type = 'text';
  refineInput.placeholder = 'bigger eyes, flatter base…';
  refineInput.setAttribute('aria-label', 'Refine the pictures');

  const refineBtn = button('studio-refine-btn', 'studio-stage-btn', 'Refine…');
  const moreBtn = button('studio-more-btn', 'studio-stage-btn', 'More like this');
  const useBtn = button('studio-use-btn', 'studio-stage-btn studio-stage-primary', 'Use this');
  // Not in the inventory, and required by the degradation table: "no candidates
  // → offer Try again AND Skip the pictures". Every state of this panel must
  // have a way forward that does not need claw-gen at all.
  const skipBtn = button('studio-stage-skip', 'studio-stage-btn studio-stage-quiet', 'Skip the pictures');
  const cancelBtn = button('studio-stage-cancel', 'studio-stage-btn studio-stage-quiet', 'Cancel');

  // Nothing is picked until a picture arrives, so the primary action starts
  // refusing rather than promising. Coloured, never faded (standing rule 1).
  useBtn.disabled = true;
  stageActions.append(refineInput, refineBtn, moreBtn, skipBtn, cancelBtn, useBtn);
  stageEl.append(stageTitle, stageNote, stepperEl, elapsedEl, candidatesEl, stageActions);

  // recent work
  const recentEl = el('section', 'studio-recent');
  recentEl.id = 'studio-recent';
  recentEl.hidden = true;
  scroll.appendChild(recentEl);

  // ── view switching ─────────────────────────────────────────────────────
  //
  // #main-content is `display:flex` from an ID selector in style.css, and the
  // UA's `[hidden]{display:none}` is a type-less rule that loses to it. Setting
  // the attribute alone would leave the workbench fully visible underneath a
  // "hidden" studio. Inline display beats every stylesheet, and clearing it
  // (rather than setting `display:flex`) hands the box back to whichever sheet
  // owns it — including S2's, which may switch on body[data-view] instead.

  function applyView() {
    const studioOn = view === 'studio';
    document.body.dataset.view = view;

    root.hidden = !studioOn;
    root.style.display = studioOn ? '' : 'none';
    if (mainEl) {
      mainEl.hidden = studioOn;
      mainEl.style.display = studioOn ? 'none' : '';
    }
    if (tabStudio) tabStudio.setAttribute('aria-selected', studioOn ? 'true' : 'false');
    if (tabWorkbench) tabWorkbench.setAttribute('aria-selected', studioOn ? 'false' : 'true');
  }

  // LIFECYCLE, not rendering: while #main-content is display:none its subtree
  // measures 0×0, and xterm's fit addon and the three.js renderer both size
  // from getBoundingClientRect(). Coming back to a one-column terminal or a
  // stretched viewport looks like a rendering bug and is really a missed
  // re-measure. renderer.js owns both handlers and neither is reachable through
  // ctx, so the honest fallback is a window resize event plus one frame of
  // delay so the measurement happens AFTER the display change has applied.
  // (renderer.js also has ResizeObservers on #viewport and #terminal, which
  // fire on their own when a zero-size box regains size; this is belt to that
  // braces, and it is what a future window-resize handler would need anyway.)
  function remeasureWorkbench() {
    const fire = () => {
      try {
        window.dispatchEvent(new Event('resize'));
      } catch (err) {
        console.error('[studio] could not ask the workbench to re-measure', err);
      }
    };
    requestAnimationFrame(fire);
    setTimeout(fire, 0);
  }

  function showView(next, opts) {
    const wanted = next === 'workbench' ? 'workbench' : 'studio';
    if (opts && opts.user) viewTouched = true;
    if (wanted === view) {
      applyView();
      if (wanted === 'workbench') remeasureWorkbench();
      return;
    }
    view = wanted;
    applyView();
    if (view === 'workbench') remeasureWorkbench();
    persist();
  }

  if (tabStudio) tabStudio.addEventListener('click', () => showView('studio', { user: true }));
  if (tabWorkbench) tabWorkbench.addEventListener('click', () => showView('workbench', { user: true }));
  applyView();

  // ── print-type grid ────────────────────────────────────────────────────

  function buildTypes() {
    typesEl.innerHTML = '';
    if (!taxonomy.list.length) {
      // "keep the console usable with no type grid and a stated reason"
      typesEl.hidden = true;
      notice(
        'categories',
        taxonomy.error
          ? "Print types couldn't load, so I'm not showing the grid — describe what you're making and I'll still make it."
          : "No print types are set up — describe what you're making and I'll still make it."
      );
      return;
    }
    typesEl.hidden = false;
    for (const cat of taxonomy.list) {
      const tile = document.createElement('button');
      tile.type = 'button';
      tile.className = 'studio-type';
      tile.dataset.category = cat.id;
      tile.setAttribute('role', 'radio');
      tile.setAttribute('aria-checked', 'false');
      tile.tabIndex = -1;

      const glyph = el('span', 'studio-type-glyph');
      glyph.setAttribute('aria-hidden', 'true');
      glyph.textContent = cat.glyph || '·';
      const label = el('span', 'studio-type-label');
      label.textContent = cat.label || cat.id;
      const hint = el('span', 'studio-type-hint');
      hint.textContent = cat.hint || '';
      tile.append(glyph, label, hint);
      tile.addEventListener('click', () => setCategory(cat.id, { user: true }));
      typesEl.appendChild(tile);
    }
  }

  // One tab stop for the whole grid, arrows inside it — the pattern the guided
  // grid already established, so the two views feel like one app.
  typesEl.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const ids = taxonomy.list.map((c) => c.id);
    if (!ids.length) return;
    const cols = columnsOf(typesEl) || 1;
    const idx = Math.max(0, ids.indexOf(categoryId));
    let next = null;
    if (e.key === 'ArrowRight') next = (idx + 1) % ids.length;
    else if (e.key === 'ArrowLeft') next = (idx - 1 + ids.length) % ids.length;
    else if (e.key === 'ArrowDown') next = Math.min(ids.length - 1, idx + cols);
    else if (e.key === 'ArrowUp') next = Math.max(0, idx - cols);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = ids.length - 1;
    if (next === null) return;
    e.preventDefault();
    setCategory(ids[next], { user: true });
    const tile = typesEl.querySelector(`.studio-type[data-category="${cssEscape(ids[next])}"]`);
    if (tile) tile.focus();
  });

  function refreshTypes() {
    for (const tile of typesEl.querySelectorAll('.studio-type')) {
      const on = tile.dataset.category === categoryId;
      tile.setAttribute('aria-checked', on ? 'true' : 'false');
      tile.classList.toggle('is-selected', on);
      tile.tabIndex = on ? 0 : -1;
    }
    if (!typesEl.querySelector('.studio-type[tabindex="0"]')) {
      const first = typesEl.querySelector('.studio-type');
      if (first) first.tabIndex = 0;
    }
  }

  function setCategory(id, opts) {
    const cat = categoryById(id);
    if (!cat || id === categoryId) {
      if (cat) refreshTypes();
      return;
    }
    categoryId = id;
    // A different kind of object entirely — a tool the last type auto-enabled
    // and the user dismissed is a fresh question now.
    dismissed = new Set();
    applyAutoTools();
    if (opts && opts.user) {
      applyCategoryWiring(cat);
      if (cat.examples && cat.examples[0]) promptEl.placeholder = String(cat.examples[0]);
    }
    persist();
    refresh({ structure: true });
  }

  // Picking a print type is meant to set the fine-tune chips and the pipeline
  // target too, so the person never has to learn what those controls mean. Only
  // ever on a real click: doing it during boot restore would change the app's
  // launch state for every other package's spec.
  function applyCategoryWiring(cat) {
    if (ctx.guided && typeof ctx.guided.setCategory === 'function') {
      safe(() => ctx.guided.setCategory(cat.id));
      return;
    }
    if (ctx.presets && typeof ctx.presets.setActive === 'function') {
      safe(() => ctx.presets.setActive(Array.isArray(cat.presets) ? cat.presets.slice() : []));
    }
  }

  // ── tools ──────────────────────────────────────────────────────────────

  function toolById(id) {
    return tools.find((t) => t && t.id === id) || null;
  }

  function applyAutoTools() {
    const auto = autoToolsFor(tools, categoryId);
    // Catalog order for the automatic ones, click order for the pinned ones.
    const next = [];
    for (const id of enabled) if (pinned.has(id)) next.push(id);
    for (const id of auto) if (!next.includes(id) && !dismissed.has(id)) next.push(id);
    enabled = next;
    for (const id of enabled) seedDefaults(id);
  }

  // A field with a `default` is filled the moment its tool comes on — that is
  // what makes "measured outside" or "0.4 nozzle" a stated assumption instead
  // of a silent one. It is also why an auto-enabled tool can show a chip.
  function seedDefaults(toolId) {
    const tool = toolById(toolId);
    if (!tool) return;
    const bag = values[toolId] || (values[toolId] = {});
    for (const field of Array.isArray(tool.fields) ? tool.fields : []) {
      if (!field || !field.id) continue;
      if (bag[field.id] !== undefined && bag[field.id] !== '') continue;
      if (field.default === undefined || field.default === null) continue;
      bag[field.id] = field.default === true ? 'yes' : field.default === false ? '' : String(field.default);
    }
  }

  function enableTool(id, opts) {
    const tool = toolById(id);
    if (!tool || enabled.includes(id)) return;
    enabled = enabled.concat([id]);
    if (!opts || opts.user !== false) {
      pinned.add(id);
      dismissed.delete(id);
    }
    seedDefaults(id);
    persist();
    refresh({ structure: true });
  }

  function disableTool(id, opts) {
    if (!enabled.includes(id)) return;
    enabled = enabled.filter((x) => x !== id);
    if (!opts || opts.user !== false) {
      pinned.delete(id);
      dismissed.add(id);
    }
    persist();
    refresh({ structure: true });
  }

  function setToolValue(toolId, fieldId, value) {
    if (!toolById(toolId)) return;
    if (!enabled.includes(toolId)) enableTool(toolId);
    const bag = values[toolId] || (values[toolId] = {});
    bag[fieldId] = typeof value === 'string' ? value : value === true ? 'yes' : value == null || value === false ? '' : String(value);
    persist();
    refresh();
  }

  function buildToolsMenu() {
    menuEl.innerHTML = '';
    if (!tools.length) {
      const empty = el('div', 'studio-tools-empty');
      empty.textContent = toolsError
        ? "The tools couldn't be read, so none are offered right now."
        : 'No tools are set up.';
      menuEl.appendChild(empty);
      return;
    }
    const order = groups.length ? groups : [{ id: null, label: 'Tools' }];
    const seen = new Set();
    for (const group of order.concat([{ id: '__rest', label: 'Other' }])) {
      const members = tools.filter((t) => {
        if (seen.has(t.id)) return false;
        return group.id === '__rest' ? true : t.group === group.id || (!t.group && group.id === null);
      });
      if (!members.length) continue;
      const groupEl = el('div', 'studio-tools-group');
      const labelEl = el('div', 'studio-tools-group-label');
      labelEl.textContent = group.label || group.id || 'Tools';
      groupEl.appendChild(labelEl);
      for (const tool of members) {
        seen.add(tool.id);
        const opt = document.createElement('button');
        opt.type = 'button';
        opt.className = 'studio-tool-option';
        opt.dataset.toolId = tool.id;
        opt.setAttribute('role', 'menuitemcheckbox');
        opt.setAttribute('aria-checked', 'false');
        const name = el('span', 'studio-tool-option-label');
        name.textContent = tool.label || tool.id;
        const hint = el('span', 'studio-tool-option-hint');
        hint.textContent = tool.hint || '';
        opt.append(name, hint);
        opt.addEventListener('click', () => {
          if (enabled.includes(tool.id)) disableTool(tool.id);
          else enableTool(tool.id);
        });
        groupEl.appendChild(opt);
      }
      menuEl.appendChild(groupEl);
    }
  }

  function refreshToolsMenu(target) {
    for (const opt of menuEl.querySelectorAll('.studio-tool-option')) {
      const tool = toolById(opt.dataset.toolId);
      const on = enabled.includes(opt.dataset.toolId);
      opt.setAttribute('aria-checked', on ? 'true' : 'false');
      opt.classList.toggle('is-on', on);
      // Hardware has no meaning in a picture — but the option is NOT disabled
      // for it. This repo enforces by refusing out loud, never by greying out:
      // the menu line stays clickable and says "not used when making sculpts",
      // switching it on still shows its panel, and compile() reports it in
      // `skipped` with the same reason under the panel head. A grey control is
      // a mystery; a stated reason is a teacher.
      const applies = toolAppliesTo(tool, target);
      opt.classList.toggle('is-unavailable', !applies);
      const hint = opt.querySelector('.studio-tool-option-hint');
      if (hint) {
        hint.textContent = applies
          ? (tool && tool.hint) || ''
          : `not used when making ${target === 'image' ? 'images' : target + 's'}`;
      }
    }
    toolsBtn.textContent = enabled.length ? `Tools · ${enabled.length}` : 'Tools';
  }

  function openMenu(open) {
    menuEl.hidden = !open;
    toolsBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  toolsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openMenu(menuEl.hidden);
  });
  document.addEventListener('click', (e) => {
    if (menuEl.hidden) return;
    if (menuEl.contains(e.target) || e.target === toolsBtn) return;
    openMenu(false);
  });
  menuEl.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      openMenu(false);
      toolsBtn.focus();
    }
  });

  // ── field panels ───────────────────────────────────────────────────────

  function buildPanels() {
    // Rebuilding takes focus out of whatever input is being typed in, so the
    // panels are rebuilt ONLY when the set of enabled tools changes. The target
    // is deliberately not part of this signature: typing a number can flip the
    // route, which flips the target (decor/toy/other are sculpt-on-confirm and
    // part-on-direct), and rebuilding for that would blur the box mid-digit.
    // Everything target-dependent in a panel is text, and refreshPanels()
    // updates it in place.
    const signature = enabled.join('|');
    if (signature === panelSignature) return;
    panelSignature = signature;
    fieldsEl.innerHTML = '';

    for (const id of enabled) {
      const tool = toolById(id);
      if (!tool) continue;
      const panel = el('div', 'studio-tool-panel');
      panel.dataset.toolId = id;

      const head = el('div', 'studio-tool-panel-head');
      const headLabel = el('span', 'studio-tool-panel-label');
      headLabel.textContent = tool.label || id;
      const headNote = el('span', 'studio-tool-panel-note');
      const remove = button('', 'studio-tool-panel-remove', 'Remove');
      remove.setAttribute('aria-label', `Remove ${tool.label || id}`);
      remove.addEventListener('click', () => disableTool(id));
      head.append(headLabel, headNote, remove);
      panel.appendChild(head);

      for (const field of Array.isArray(tool.fields) ? tool.fields : []) {
        if (!field || !field.id) continue;
        panel.appendChild(buildField(tool, field));
      }
      fieldsEl.appendChild(panel);
    }
  }

  function buildField(tool, field) {
    const row = el('label', 'studio-field');
    row.dataset.fieldId = field.id;
    const label = el('span', 'studio-field-label');
    label.textContent = field.label || field.id;
    row.appendChild(label);

    const current = (values[tool.id] || {})[field.id] || '';
    let input;
    if (field.kind === 'choice') {
      input = document.createElement('select');
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
      input.value = current;
    } else if (field.kind === 'toggle') {
      input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = current === 'yes';
    } else {
      input = document.createElement('input');
      input.type = field.kind === 'number' ? 'number' : 'text';
      if (field.kind === 'number') input.inputMode = 'decimal';
      if (field.placeholder) input.placeholder = String(field.placeholder);
      input.value = current;
    }
    input.className = 'studio-field-input';
    input.dataset.toolId = tool.id;
    input.dataset.fieldId = field.id;

    const commit = () => {
      const bag = values[tool.id] || (values[tool.id] = {});
      bag[field.id] = field.kind === 'toggle' ? (input.checked ? 'yes' : '') : input.value;
      persist();
      refresh();
    };
    input.addEventListener('input', commit);
    input.addEventListener('change', commit);
    // The composer's root handler turns a bare 1/2/3 into an Output change.
    // Typing "20" in a Height box must not change what gets made.
    input.addEventListener('keydown', (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key && e.key.length === 1) e.stopPropagation();
    });
    row.appendChild(input);

    if (field.unit) {
      const unit = el('span', 'studio-field-unit');
      unit.textContent = String(field.unit);
      row.appendChild(unit);
    }
    return row;
  }

  function refreshPanels(result) {
    const skippedBy = new Map();
    for (const s of result.skipped) skippedBy.set(s.toolId, s.reason);
    for (const panel of fieldsEl.querySelectorAll('.studio-tool-panel')) {
      const id = panel.dataset.toolId;
      const note = panel.querySelector('.studio-tool-panel-note');
      if (note) {
        // The chip above already carries the summary; repeating it here is
        // noise. "nothing filled in yet" is likewise already said by the empty
        // fields directly below. A reason worth stating ("not used when making
        // sculpts") is different — nothing else on screen explains that.
        const reason = skippedBy.get(id);
        const worthSaying = reason && !/nothing filled in/i.test(reason);
        note.textContent = worthSaying ? reason : '';
        note.classList.toggle('is-skipped', Boolean(worthSaying));
      }

      // The panels are only REBUILT when the set of enabled tools changes (so a
      // keystroke never yanks focus out of the box being typed in), which means
      // a value set from anywhere else — restore, window.clawscadStudio
      // .setToolValue(), a category switch — would otherwise never reach the
      // input. Sync every field except the one that currently has focus.
      const bag = values[id] || {};
      for (const input of panel.querySelectorAll('.studio-field-input')) {
        if (input === document.activeElement) continue;
        const wanted = bag[input.dataset.fieldId] || '';
        if (input.type === 'checkbox') {
          const on = wanted === 'yes';
          if (input.checked !== on) input.checked = on;
        } else if (input.value !== wanted) {
          input.value = wanted;
        }
      }
    }
  }

  // ── chips ──────────────────────────────────────────────────────────────
  //
  // CONTRACT CONFLICT, resolved here and flagged to the integrator. §S4 asks
  // for three things that cannot all be true at once:
  //
  //   (1) "selecting a type auto-enables that type's tools as chips"
  //   (2) "adding a tool from #studio-tools-menu adds a .studio-tool-panel and
  //        a chip, removing it removes both"
  //   (3) "a tool with no values adds no chip"
  //
  // Only three of the thirteen shipped tools declare field defaults, so under
  // (3) selecting `model` (auto: Style, no defaults) would produce ZERO chips
  // and (1) and (2) would both be false for most categories. So the row shows
  // one chip per ENABLED tool — it is the "active tool + attachment chips" the
  // DOM inventory calls for, and the only always-visible handle on what is
  // switched on once the menu closes. The chip's TEXT still comes from
  // compile()'s own `chips`, so a tool that contributes nothing says so rather
  // than pretending. Flip CHIP_PER_ENABLED_TOOL to honour (3) instead; nothing
  // else has to change.
  const CHIP_PER_ENABLED_TOOL = true;

  function refreshChips(result) {
    chipsEl.innerHTML = '';
    const byTool = new Map(result.chips.map((c) => [c.toolId, c]));
    const skippedBy = new Map(result.skipped.map((s) => [s.toolId, s.reason]));
    const ids = CHIP_PER_ENABLED_TOOL ? enabled : result.chips.map((c) => c.toolId);

    for (const toolId of ids) {
      const tool = toolById(toolId);
      if (!tool) continue;
      const chip = byTool.get(toolId);
      const node = el('span', 'studio-chip');
      node.dataset.toolId = toolId;
      if (!chip) node.classList.add('is-empty');
      const label = el('span', 'studio-chip-label');
      label.textContent = (chip && chip.label) || tool.label || toolId;
      const text = el('span', 'studio-chip-text');
      text.textContent = chip ? chip.text : skippedBy.get(toolId) || 'nothing filled in yet';
      const remove = button('', 'studio-chip-remove', '×');
      remove.setAttribute('aria-label', `Remove ${label.textContent}`);
      remove.addEventListener('click', () => disableTool(toolId));
      node.append(label, text, remove);
      chipsEl.appendChild(node);
    }

    if (attachment) {
      const node = el('span', 'studio-chip');
      node.dataset.attachment = attachment.relPath;
      node.dataset.mode = attachment.mode;
      const label = el('span', 'studio-chip-label');
      label.textContent = attachment.name || 'Picture';
      const text = el('span', 'studio-chip-text');
      text.textContent = attachment.mode === 'recreate' ? 'recreate this' : 'use as reference';
      // Two modes, one chip. Which one is right depends on whether the picture
      // IS the thing (recreate) or only shows what the thing should look like.
      const mode = button('', 'studio-chip-mode', attachment.mode === 'recreate' ? 'Use as reference' : 'Recreate it');
      mode.addEventListener('click', () => {
        attachment.mode = attachment.mode === 'recreate' ? 'reference' : 'recreate';
        persist();
        refresh();
      });
      const remove = button('', 'studio-chip-remove', '×');
      remove.setAttribute('aria-label', 'Remove the picture');
      remove.addEventListener('click', () => {
        attachment = null;
        persist();
        refresh();
      });
      node.append(label, text, mode, remove);
      chipsEl.appendChild(node);
    }
  }

  // ── the decision ───────────────────────────────────────────────────────

  function categoryById(id) {
    return taxonomy.list.find((c) => c && c.id === id) || null;
  }
  function category() {
    return categoryById(categoryId);
  }

  // "the flattened union of every enabled tool's values plus the category's own
  // ask answers". Tool values go in first so a guided answer the person typed
  // in the workbench wins the tie.
  function flatAnswers() {
    const out = {};
    for (const id of enabled) {
      const tool = toolById(id);
      if (!tool) continue;
      const bag = pruneValues(tool, values[id]);
      for (const [k, v] of Object.entries(bag)) out[k] = v;
    }
    if (ctx.guided && typeof ctx.guided.getAnswers === 'function') {
      const answers = safe(() => ctx.guided.getAnswers()) || {};
      for (const [k, v] of Object.entries(answers)) if (typeof v === 'string' && v.trim()) out[k] = v;
    }
    return out;
  }

  function routerAttachments() {
    const out = [];
    if (attachment) out.push({ name: attachment.name || attachment.relPath, kind: attachment.kind || 'image' });
    if (stage && stage.selectedKey) {
      const picked = pickedCandidate();
      if (picked) out.push({ name: picked.path, kind: 'image' });
    }
    return out;
  }

  function currentDecision() {
    let decision = null;
    try {
      decision = decideRoute({
        category: category(),
        prompt: promptText,
        answers: flatAnswers(),
        attachments: routerAttachments(),
      });
    } catch (err) {
      console.error('[studio] decideRoute threw', err);
    }
    if (!decision || typeof decision !== 'object') {
      decision = { route: 'direct', target: 'part', presets: [], confirmMode: 'none', score: 50, reasons: [], missing: [], forced: false };
    }
    return decision;
  }

  // Verbatim from the contract. `auto` mirrors the router, and a photo-confirm
  // category is deliberately NOT a preview case: for a broken dryer knob the
  // useful reference is the user's own photo, not four invented ones.
  function previewFirstFor(decision) {
    if (preview === 'on') return true;
    if (preview === 'off') return false;
    return decision.route === 'confirm' && decision.confirmMode !== 'photo';
  }

  function setPreviewMode(mode) {
    const next = PREVIEW_ORDER.includes(mode) ? mode : 'auto';
    if (next === preview) return;
    preview = next;
    persist();
    refresh();
  }

  previewBtn.addEventListener('click', () => {
    setPreviewMode(PREVIEW_ORDER[(PREVIEW_ORDER.indexOf(preview) + 1) % PREVIEW_ORDER.length]);
  });

  // The override control the guided grid established, expressed through the
  // one switch: in `auto` it flips you to the other route and says whose choice
  // that now is; in `on`/`off` it is the way back to automatic. Always shown,
  // always reversible — never a black box.
  routeOverrideEl.addEventListener('click', () => {
    if (preview !== 'auto') {
      setPreviewMode('auto');
      return;
    }
    setPreviewMode(previewFirstFor(currentDecision()) ? 'off' : 'on');
  });

  function refreshRoute(decision, wantsPreview) {
    const parts = [];
    const natural = decision.route === 'confirm' && decision.confirmMode !== 'photo';

    if (preview === 'auto') {
      parts.push(explain(decision) || (wantsPreview ? "Let's check the look first." : 'This is straightforward — making it now.'));
    } else if (preview === 'on') {
      // Say whose choice this is AND whether it differs from mine. Pasting
      // explain() on the end unchanged reads as a contradiction ("I'll show you
      // options. This is straightforward — making it now.").
      parts.push(
        natural
          ? "You've asked to see pictures first, so I'll show you a few options before anything is made."
          : "You've asked to see pictures first, so I'll show you a few options — I'd have gone straight to making it."
      );
    } else {
      parts.push(
        decision.route === 'confirm'
          ? "You've asked me to skip the pictures and go straight to geometry."
          : "You've asked me to skip the pictures — which is what I'd have done here anyway."
      );
      // An explicit `off` overrides a forced-confirm category — say so in one
      // plain sentence rather than silently ignoring the taxonomy.
      if (decision.route === 'confirm') {
        parts.push(
          decision.confirmMode === 'photo'
            ? "A photo of the real thing would normally make this much more accurate — I'm going ahead without one."
            : "This kind of thing is usually judged by eye first — I'm going ahead without the check."
        );
      }
    }

    if (preview === 'auto' && decision.route === 'confirm' && decision.confirmMode === 'photo' && !attachment) {
      parts.push('Add a photo with the button above and I can match its real shape and size.');
    }

    routeTextEl.textContent = parts.join(' ');
    routeOverrideEl.textContent =
      preview !== 'auto'
        ? 'Back to automatic'
        : wantsPreview
          ? 'Skip the check, just make it'
          : 'Show me options first';
    routeEl.dataset.route = decision.route;
    routeEl.dataset.preview = preview;
    routeEl.dataset.previewFirst = String(wantsPreview);

    previewBtn.dataset.mode = preview;
    previewBtn.setAttribute('aria-checked', wantsPreview ? 'true' : 'false');
    previewBtn.textContent =
      preview === 'auto' ? 'Pictures first: automatic' : preview === 'on' ? 'Pictures first: always' : 'Pictures first: never';
    previewBtn.title =
      preview === 'auto'
        ? 'I decide whether to show you reference pictures before making anything. Click to always show them.'
        : preview === 'on'
          ? 'Always show reference pictures first. Click to never show them.'
          : 'Never show reference pictures. Click to hand the decision back to me.';
  }

  // ── submit ─────────────────────────────────────────────────────────────

  function refreshSubmit(decision, wantsPreview) {
    const ready = promptText.trim().length > 0 || (attachment && attachment.mode === 'recreate');
    submitBtn.disabled = !ready;
    submitBtn.textContent = !ready
      ? 'Describe it first'
      : attachment && attachment.mode === 'recreate'
        ? 'Recreate this picture'
        : wantsPreview
          ? 'Show me options first'
          : 'Make it';
    submitBtn.dataset.ready = ready ? 'true' : 'false';
    hintEl.textContent = !ready
      ? 'One sentence is plenty'
      : attachment && attachment.mode === 'recreate'
        ? '~10 min'
        : wantsPreview
          ? '~2 min for pictures'
          : decision.target === 'sculpt'
            ? '~10 min'
            : 'about a minute';
  }

  promptEl.addEventListener('input', () => {
    promptText = promptEl.value;
    autoGrow();
    persist();
    refresh();
  });
  promptEl.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      if (!submitBtn.disabled) submit();
    }
  });

  submitBtn.addEventListener('click', () => {
    submit();
  });

  async function submit() {
    const decision = currentDecision();
    const result = compileNow(decision.target);

    if (attachment && attachment.mode === 'recreate') return recreate(decision, result);
    if (previewFirstFor(decision)) return startPreview(decision, result);
    return dispatchDirect(decision, result, []);
  }

  // ── flow A: straight to Claude ─────────────────────────────────────────

  async function dispatchDirect(decision, result, extraAttachments) {
    const cat = category();
    const files = [];
    if (attachment && attachment.mode === 'reference') files.push(attachment.relPath);
    for (const extra of extraAttachments || []) if (extra) files.push(extra);

    const message = composeBrief({
      preamble: taxonomy.preamble,
      categoryPrompt: cat && cat.prompt,
      lines: result.lines,
      prompt: promptText,
      attachments: files,
    });
    if (!message.trim()) {
      notice('submit', 'Tell me what it is first — a few words is plenty.');
      return false;
    }

    if (!api || typeof api.composerSendToClaude !== 'function') {
      toast("I can't reach the Claude Code terminal from here.", 'error');
      return false;
    }

    let ok = false;
    try {
      ok = await api.composerSendToClaude(message);
    } catch (err) {
      console.error('[studio] send to Claude failed', err);
    }
    if (!ok) {
      // The terminal may simply not be running — say which of the two it is.
      const missing = env && env.claude && !env.claude.binary;
      notice(
        'claude',
        missing
          ? "The Claude Code CLI isn't installed, so there's nothing to send this to. The setup guide walks through it."
          : "I couldn't reach the Claude Code terminal — open the Workbench and check it's running.",
        missing
          ? [{ label: 'Setup guide', onClick: () => safe(() => api && api.openReadme && api.openReadme()) }]
          : [{ label: 'Open the Workbench', onClick: () => showView('workbench', { user: true }) }]
      );
      toast("Couldn't reach the Claude Code terminal — is it running?", 'error');
      return false;
    }

    clearNotice('claude');
    clearNotice('submit');
    toast('Sent to Claude — watch it work in the Workbench.', 'success');
    showView('workbench');
    return true;
  }

  // ── flow B: pictures first ─────────────────────────────────────────────

  function genEls() {
    return {
      prompt: document.getElementById('gen-prompt'),
      generate: document.getElementById('gen-generate-btn'),
      make3d: document.getElementById('gen-make3d-btn'),
      grid: document.getElementById('gen-image-grid'),
    };
  }

  async function startPreview(decision, result, opts) {
    const gen = genEls();
    if (!gen.prompt || !gen.generate) {
      // "#gen-* elements absent → fall back to Direct with a toast; never a
      // dead button."
      toast("The picture step isn't available — making it directly instead.", 'info');
      return dispatchDirect(decision, result, []);
    }

    if (!(await pipelineReady('preview', opts))) return false;

    stage = {
      phase: 'images',
      job: null,
      round: 0,
      candidates: [],
      selectedKey: null,
      prompt: composeImagePrompt({ prompt: promptText, imageWords: result.imageWords }),
    };
    candidatesEl.innerHTML = '';
    stageEl.hidden = false;
    resetStepper();
    refresh();
    return runRound(stage.prompt);
  }

  // Every round goes through machinery the Generate panel already owns — no
  // second pipeline:start call site. Previous rounds stay on screen, which is
  // the whole point of narrowing: you compare.
  //
  // The FIRST round clicks #gen-generate-btn, exactly as before. Every round
  // after it goes through ctx.startImageRound(), which renderer.js added for
  // this: the button handler alone always starts a NEW job, and candidate keys
  // are `round:index` scoped to a job, so a second job's "1:0" collides with
  // the first's and Make-3D reaches for whichever the grid last held. Continuing
  // the job makes claw-gen append round N+1 to the same one, which is what the
  // user means by "more like this".
  async function runRound(text, opts) {
    const gen = genEls();
    if (!gen.prompt || !gen.generate || !stage) return false;
    if (gen.generate.disabled) {
      sayStage('Something else is being made right now. Give it a minute, or watch it in the Workbench.');
      offerWatch();
      return false;
    }
    const continuing = Boolean(opts && opts.continueJob) && stage.round > 0;
    stage.phase = 'images';
    stage.round += 1;
    stage.prompt = text;
    setStep('images', 'running');
    startClock();
    watchRun(gen.generate);
    sayStage('Making a few pictures — this takes a moment.');
    try {
      gen.prompt.value = text;
      gen.prompt.dispatchEvent(new Event('input', { bubbles: true }));
      if (continuing && ctx && typeof ctx.startImageRound === 'function') {
        await ctx.startImageRound();
      } else {
        gen.generate.click();
      }
    } catch (err) {
      console.error('[studio] could not start the picture run', err);
      endImages("I couldn't start making pictures.");
      return false;
    }
    refresh();
    return true;
  }

  moreBtn.addEventListener('click', () => {
    if (!stage) return;
    runRound(stage.prompt, { continueJob: true });
  });

  refineBtn.addEventListener('click', () => {
    if (!stage) return;
    const extra = refineInput.value.trim();
    if (!extra) {
      refineInput.focus();
      sayStage('Say what to change — "bigger eyes", "flatter base".');
      return;
    }
    refineInput.value = '';
    // Same job, new text. claw-gen drops the job's cached expanded prompt when
    // the text changes (contract v1.4), so the refinement genuinely re-expands
    // instead of quietly regenerating the previous round.
    runRound(`${stage.prompt}, ${extra}`, { continueJob: true });
  });

  skipBtn.addEventListener('click', () => {
    const decision = currentDecision();
    closeStage();
    // Skipping is not "give up" — it is the direct route, explicitly chosen.
    preview = 'off';
    persist();
    refresh();
    dispatchDirect(decision, compileNow(decision.target), []);
  });

  cancelBtn.addEventListener('click', () => {
    if (isRunning()) {
      safe(() => api && api.cancelPipeline && api.cancelPipeline());
      sayStage('Stopping…');
      return;
    }
    closeStage();
    refresh();
  });

  useBtn.addEventListener('click', () => {
    useSelected();
  });

  async function useSelected(opts) {
    const picked = pickedCandidate();
    if (!stage || !picked) return;
    const decision = currentDecision();
    const result = compileNow(decision.target);

    if (decision.target !== 'sculpt') {
      // The most valuable flow in the app: approve the LOOK, then build it
      // parametrically with the approved picture as the reference.
      closeStage();
      return dispatchDirect(decision, result, [picked.path]);
    }

    // Sculpt needs the mesher. If it is down, refuse out loud and offer the
    // route that still works: the approved picture handed to Claude on the part
    // track needs no mesher at all. The button stays full-contrast either way.
    const mesh = kindState('mesh3d');
    if (!mesh.ok && !(opts && opts.force)) {
      sayStage(`I can't make that in 3D right now — ${mesh.reason || 'the mesh backend is not ready'}.`);
      notice(
        'backend-mesh3d',
        `3D meshing is unavailable right now — ${mesh.reason || 'no backend is ready'}. That is this machine's setup, not your picture. I can still build this as a parametric part from the picture you approved.`,
        [
          {
            label: 'Build this from the picture',
            onClick: () => {
              const alt = pickedCandidate();
              closeStage();
              clearNotice('backend-mesh3d');
              dispatchDirect(decision, compileNow('part'), alt ? [alt.path] : []);
            },
          },
          {
            label: 'Try anyway',
            onClick: () => {
              clearNotice('backend-mesh3d');
              useSelected({ force: true });
            },
          },
        ]
      );
      return false;
    }

    // Sculpt: hand it to the existing Make-3D chain, which carries mesh → prep
    // → checkpoint on its own. We only mirror the stages here.
    const gen = genEls();
    const card =
      gen.grid && picked.job === lastJob
        ? gen.grid.querySelector(`.gen-candidate[data-key="${cssEscape(picked.key)}"]`)
        : null;
    if (!card || !gen.make3d) {
      sayStage(
        picked.job && picked.job !== lastJob
          ? "That one is from an earlier set — pick from the newest set to make it in 3D, or press Skip and I'll build it from your description."
          : "I couldn't hand that picture to the 3D step. Press Skip and I'll make it from your description instead."
      );
      return false;
    }
    if (gen.make3d.disabled && isRunning()) {
      sayStage('One moment — the last pictures are still arriving.');
      return false;
    }
    card.click();
    if (gen.make3d.disabled) {
      sayStage('The 3D step is busy right now. Give it a minute, or watch it in the Workbench.');
      offerWatch();
      return false;
    }
    stage.phase = 'mesh';
    setStep('images', 'done');
    setStep('mesh', 'running');
    startClock();
    sayStage('Making the 3D model. This is the ten-minute part — you can leave it running.');
    gen.make3d.click();
    refresh();
    return true;
  }

  // ── flow C: recreate an uploaded picture ───────────────────────────────

  async function recreate(decision, result, opts) {
    if (!attachment) return false;
    if (!(await pipelineReady('recreate', opts))) return false;

    stage = { phase: 'mesh', job: null, round: 0, candidates: [], selectedKey: null, prompt: promptText };
    candidatesEl.innerHTML = '';
    stageEl.hidden = false;
    resetStepper();
    setStep('mesh', 'running');
    startClock();
    stageTitle.textContent = 'Recreating your picture';
    sayStage('Turning your picture into a 3D model. This is the ten-minute part.');
    refresh();

    // `relPath` is workspace-relative and claw-gen runs with cwd set to the
    // workspace, so it goes through UNCHANGED. Building an absolute path in the
    // renderer is how an upload ends up outside the job directory.
    //
    // --new-job is why claw-gen went to 0.3.0: without it `mesh --image` reuses
    // the most recent job, so the upload lands in the last text prompt's job,
    // is checkpointed under that job's slug, and interleaves two subjects'
    // artifacts in one directory.
    const args = ['--image', attachment.relPath, '--new-job', ...(result.flags.mesh || [])];

    // renderer.js chains mesh → prep → checkpoint off its own genPendingStage,
    // which only its #gen-make3d-btn handler sets — an outside caller can't
    // reach it. If the foundation ever exposes a chain starter we use it;
    // until then the mesh runs and the chain does not, which is stated below
    // rather than left to look like a hang. (Reported to the integrator.)
    const chain = ctx && typeof ctx.startMeshChain === 'function' ? ctx.startMeshChain : null;
    let res = null;
    try {
      res = chain
        ? await chain(args)
        : await api.startPipeline({ action: 'mesh', args });
    } catch (err) {
      console.error('[studio] recreate failed to start', err);
    }
    if (res && res.error) {
      if (res.error === 'already-running') {
        sayStage('Something else is being made right now. Give it a minute, or watch it in the Workbench.');
        offerWatch();
      } else if (res.error === 'not-configured') {
        pipelineMissing('recreate');
        closeStage();
      } else {
        sayStage(`That didn't start — ${res.error}.`);
      }
      stopClock();
      return false;
    }
    if (!chain) {
      sayStage(
        'Making the mesh from your picture. When it finishes, open the Workbench and press Make 3D to turn it into a checkpoint.'
      );
      offerWatch();
    }
    return true;
  }

  // ── stage plumbing ─────────────────────────────────────────────────────

  let runObserver = null;
  let clockTimer = null;
  let clockStart = 0;

  function isRunning() {
    const gen = genEls();
    return Boolean(gen.generate && gen.generate.disabled);
  }

  function startClock() {
    clockStart = Date.now();
    tickClock();
    if (clockTimer) clearInterval(clockTimer);
    clockTimer = setInterval(tickClock, 1000);
  }
  function stopClock() {
    if (clockTimer) clearInterval(clockTimer);
    clockTimer = null;
  }
  function tickClock() {
    const s = Math.max(0, Math.floor((Date.now() - clockStart) / 1000));
    elapsedEl.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  function resetStepper() {
    for (const step of stepperEl.querySelectorAll('.studio-step')) {
      step.classList.remove('is-running', 'is-done', 'is-failed');
    }
  }
  function setStep(name, state) {
    const step = stepperEl.querySelector(`.studio-step[data-stage="${cssEscape(name)}"]`);
    if (!step) return;
    step.classList.remove('is-running', 'is-done', 'is-failed');
    if (state) step.classList.add('is-' + state);
  }

  function sayStage(message) {
    stageNote.textContent = message || '';
  }

  function closeStage() {
    stage = null;
    stopClock();
    stopWatchingRun();
    stageEl.hidden = true;
    stageTitle.textContent = 'Finding the right look';
  }

  // The Generate panel re-enables #gen-generate-btn when a run ends for ANY
  // reason — finished, failed, or cancelled from the panel. That is the only
  // end-of-run signal available without touching its exit handler.
  function watchRun(generateBtn) {
    stopWatchingRun();
    if (typeof MutationObserver !== 'function') return;
    runObserver = new MutationObserver(() => {
      if (!stage || stage.phase !== 'images') return;
      if (!generateBtn.disabled) endImages();
    });
    runObserver.observe(generateBtn, { attributes: true, attributeFilter: ['disabled'] });
  }
  function stopWatchingRun() {
    if (runObserver) {
      runObserver.disconnect();
      runObserver = null;
    }
  }

  function endImages(errorMessage) {
    if (!stage || stage.phase !== 'images') return;
    stage.phase = 'picking';
    stopWatchingRun();
    stopClock();
    if (stage.candidates.length) {
      setStep('images', 'done');
      sayStage('Pick the one closest to what you mean. Not there yet? Ask for more, or refine it.');
    } else {
      setStep('images', 'failed');
      sayStage(
        errorMessage
          ? `No pictures came back — ${errorMessage}. Try again, or skip the pictures and I'll make it from your description.`
          : "No pictures came back this time. Try again, or skip the pictures and I'll make it from your description."
      );
      moreBtn.textContent = 'Try again';
    }
    refresh();
  }

  function pickedCandidate() {
    if (!stage || !stage.selectedKey) return null;
    return stage.candidates.find((c) => c.uid === stage.selectedKey) || null;
  }

  async function addCandidate(evt) {
    if (!stage) return;
    const key = `${evt.round}:${evt.index}`;
    const uid = `${evt.job || ''}|${key}`;
    if (stage.candidates.some((c) => c.uid === uid)) return;

    let url = null;
    try {
      if (api && typeof api.readPipelineImage === 'function') url = await api.readPipelineImage(evt.path);
    } catch (err) {
      console.error('[studio] could not read a picture', err);
    }
    if (!stage || stage.candidates.some((c) => c.uid === uid)) return;

    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'studio-candidate';
    card.dataset.key = key;
    card.dataset.uid = uid;
    card.setAttribute('aria-pressed', 'false');
    card.setAttribute('aria-label', `Option ${stage.candidates.length + 1}`);

    if (url) {
      const img = document.createElement('img');
      img.className = 'studio-candidate-img';
      img.src = url;
      img.alt = `Option ${stage.candidates.length + 1}`;
      card.appendChild(img);
    } else {
      const missing = el('div', 'studio-candidate-img studio-candidate-missing');
      missing.textContent = 'Picture unavailable';
      card.appendChild(missing);
    }

    const meta = el('span', 'studio-candidate-meta');
    meta.dataset.backend = evt.backend ? String(evt.backend) : '';
    meta.textContent = meta.dataset.backend;
    card.appendChild(meta);

    card.addEventListener('click', () => {
      if (!stage) return;
      stage.selectedKey = uid;
      for (const other of candidatesEl.querySelectorAll('.studio-candidate')) {
        const on = other === card;
        other.setAttribute('aria-pressed', on ? 'true' : 'false');
        other.classList.toggle('is-picked', on);
      }
      refresh();
    });

    stage.candidates.push({ uid, key, path: evt.path, job: evt.job || lastJob, meta });
    // A round separator keeps "previous rounds stay visible" legible instead of
    // being one long undifferentiated wall of pictures.
    if (!candidatesEl.querySelector(`.studio-round[data-round="${cssEscape(uid.split('|')[0] + evt.round)}"]`)) {
      const label = el('div', 'studio-round');
      label.dataset.round = uid.split('|')[0] + evt.round;
      label.textContent = `set ${candidatesEl.querySelectorAll('.studio-round').length + 1}`;
      candidatesEl.appendChild(label);
    }
    candidatesEl.appendChild(card);
    refresh();
  }

  function setCandidateScore(evt) {
    if (!stage || typeof evt.score !== 'number') return;
    const key = `${evt.round}:${evt.index}`;
    // A score event carries the same job as its candidate — but not every
    // claw-gen build fills `job` on every event, and a score that silently
    // failed to land is invisible. Fall back to the newest card with that key.
    const uid = `${evt.job || ''}|${key}`;
    const found =
      stage.candidates.find((c) => c.uid === uid) ||
      [...stage.candidates].reverse().find((c) => c.key === key);
    if (!found) return;
    // A bare number means nothing; say what scale it is on.
    found.meta.textContent = `${found.meta.dataset.backend || evt.backend || ''} ${evt.score}/10`.trim();
    found.meta.title = 'how closely this matches your words, out of 10';
  }

  // One subscription, registered once at mount. ctx.onPipelineEvent has no
  // unsubscribe (exactly like the registrar it wraps), so this filters on
  // `stage` rather than subscribing and unsubscribing.
  if (typeof ctx.onPipelineEvent === 'function') {
    ctx.onPipelineEvent((evt) => {
      if (!evt || typeof evt !== 'object') return;
      if (evt.job) lastJob = evt.job;
      if (!stage) return;
      if (evt.job && !stage.job) stage.job = evt.job;

      switch (evt.event) {
        case 'start':
          if (GEN_STAGES.includes(evt.stage)) setStep(evt.stage, 'running');
          break;
        case 'candidate':
          addCandidate(evt);
          break;
        case 'score':
          setCandidateScore(evt);
          break;
        case 'done':
          if (GEN_STAGES.includes(evt.stage)) setStep(evt.stage, 'done');
          if (evt.stage === 'images') endImages();
          if (evt.stage === 'checkpoint') {
            stopClock();
            sayStage('Done — it is a checkpoint now. Open the Workbench to see it.');
            offerWatch();
          }
          break;
        case 'error':
          if (GEN_STAGES.includes(evt.stage)) setStep(evt.stage, 'failed');
          if (evt.stage === 'images') endImages(String(evt.message || '').trim());
          else {
            stopClock();
            // claw-gen exits 3 when it does not understand a flag — for flow C
            // that is almost always a build older than 0.3.0.
            const message = String(evt.message || '').trim();
            sayStage(
              /new-job|unknown option|unrecognized/i.test(message)
                ? 'This needs claw-gen 0.3.0 or newer — update claw-gen and try again.'
                : `That didn't finish — ${message || 'the step failed'}.`
            );
          }
          break;
        default:
          break;
      }
    });
  }

  function refreshStage(decision) {
    if (!stage) return;
    const picked = pickedCandidate();
    const busy = stage.phase === 'images' || stage.phase === 'mesh';
    useBtn.disabled = !picked || stage.phase === 'mesh';
    useBtn.textContent = decision.target === 'sculpt' ? 'Make this in 3D' : 'Build this';
    moreBtn.disabled = busy;
    refineBtn.disabled = busy;
    refineInput.disabled = busy;
    if (stage.candidates.length) moreBtn.textContent = 'More like this';
    cancelBtn.textContent = isRunning() ? 'Stop' : 'Close';
    stageEl.dataset.phase = stage.phase;
  }

  // ── claw-gen availability ──────────────────────────────────────────────
  //
  // "Configured" is not the same question as "can this flow actually run".
  // claw-gen reports each backend's own readiness, and on this project the mesh
  // host runs out of disk regularly: `mesher: disk 23GB < 30GB min` while every
  // image backend is fine. Without this check the app would happily spend the
  // user's ten minutes choosing a picture and then fail at the mesh stage — the
  // most expensive failure it can produce, and one that was knowable for free
  // before anything started.
  //
  // This is an ENVIRONMENT fault, not a model fault and not an app fault. v0.2's
  // worst bug was handing environment faults to Claude as if they were model
  // bugs; classify before escalating.

  let backends = null; // the last pipeline:backends probe

  async function probeBackends() {
    try {
      if (api && typeof api.getPipelineBackends === 'function') backends = await api.getPipelineBackends();
    } catch (err) {
      console.error('[studio] could not check the picture maker', err);
    }
    return backends;
  }

  // renderGenBackends() in renderer.js treats a missing `kind` as an image
  // backend, so the same reading is used here rather than a second convention.
  function backendKind(entry) {
    return String(entry && entry.kind ? entry.kind : 'image');
  }

  // A kind nobody declares is NOT reported as unavailable: an older claw-gen
  // that lists no mesh3d backend must not have a block invented for it.
  function kindState(kind) {
    const list = Array.isArray(backends && backends.backends) ? backends.backends : [];
    const members = list.filter((b) => backendKind(b) === kind);
    if (!members.length) return { ok: true, known: false, reason: '' };
    return {
      ok: members.some((b) => b.ok),
      known: true,
      reason: members
        .filter((b) => !b.ok)
        .map((b) => `${b.name}: ${b.reason || 'unavailable'}`)
        .join(' · '),
    };
  }

  const KIND_WORD = { image: 'Picture generation', mesh3d: '3D meshing' };

  async function pipelineReady(which, opts) {
    await probeBackends();
    if (backends && !backends.configured) {
      pipelineMissing(which);
      return false;
    }
    clearNotice('clawgen');
    const kind = which === 'recreate' ? 'mesh3d' : 'image';
    const state = kindState(kind);
    if (state.ok || (opts && opts.force)) {
      clearNotice('backend-' + kind);
      return true;
    }
    backendDown(kind, state.reason, which);
    return false;
  }

  // Refuse out loud, never grey out: the control stays full-contrast and
  // clickable, and pressing it teaches you why it cannot run and what still
  // can. A greyed button is a mystery; a refusal is a sentence.
  function backendDown(kind, reason, which) {
    const what = KIND_WORD[kind] || kind;
    const actions = [];
    if (kind === 'mesh3d' && which === 'recreate') {
      actions.push({
        label: 'Use the picture as a reference instead',
        onClick: () => {
          if (attachment) attachment.mode = 'reference';
          persist();
          refresh();
          const decision = currentDecision();
          dispatchDirect(decision, compileNow(decision.target), []);
        },
      });
    } else {
      actions.push({
        label: 'Make it from my description',
        onClick: () => {
          preview = 'off';
          if (attachment && attachment.mode === 'recreate') attachment.mode = 'reference';
          persist();
          refresh();
          const decision = currentDecision();
          dispatchDirect(decision, compileNow(decision.target), []);
        },
      });
    }
    // The reason can be stale by the time it is read (disk gets freed), so the
    // refusal is never a locked door.
    actions.push({
      label: 'Try anyway',
      onClick: () => {
        clearNotice('backend-' + kind);
        const decision = currentDecision();
        const result = compileNow(decision.target);
        if (which === 'recreate') recreate(decision, result, { force: true });
        else startPreview(decision, result, { force: true });
      },
    });
    notice(
      'backend-' + kind,
      `${what} is unavailable right now — ${reason || 'no backend is ready'}. That is this machine's setup, not your description. ` +
        (kind === 'mesh3d'
          ? 'Reference pictures and parametric parts still work.'
          : 'I can still build it from your description.'),
      actions
    );
  }

  // Never a dead end: Direct still works with no claw-gen at all, and the
  // locate flow is one click away rather than buried in a collapsed panel.
  function pipelineMissing(which) {
    notice(
      'clawgen',
      which === 'recreate'
        ? "Recreating a picture needs the claw-gen tool, and it isn't set up on this computer. I can still build it from your description."
        : "Preview pictures need the claw-gen tool, and it isn't set up on this computer. I can still build it from your description.",
      [
        {
          label: 'Locate claw-gen…',
          onClick: () => {
            const locate = document.getElementById('gen-locate-btn');
            if (locate) locate.click();
            else safe(() => api && api.locatePipelineCli && api.locatePipelineCli());
          },
        },
        {
          label: 'Make it from my description',
          onClick: () => {
            preview = 'off';
            if (attachment && attachment.mode === 'recreate') attachment.mode = 'reference';
            persist();
            refresh();
            const decision = currentDecision();
            dispatchDirect(decision, compileNow(decision.target), []);
          },
        },
      ]
    );
  }

  function offerWatch() {
    notice('watch', 'It is running in the Workbench — you can watch it there.', [
      { label: 'Open the Workbench', onClick: () => showView('workbench', { user: true }) },
    ]);
  }

  // ── attachments ────────────────────────────────────────────────────────

  attachBtn.addEventListener('click', () => pickAttachment());

  async function pickAttachment() {
    if (!api || typeof api.uploadPick !== 'function') {
      notice('upload', "I can't open the file picker right now — drop a picture onto this card instead.");
      return;
    }
    attachBtn.disabled = true;
    try {
      const paths = await api.uploadPick();
      if (!Array.isArray(paths) || !paths.length) return; // cancelled — say nothing
      await ingestPath(paths[0]);
    } catch (err) {
      console.error('[studio] choosing a picture failed', err);
      notice('upload', "That picture couldn't be opened. Try a different one.");
    } finally {
      attachBtn.disabled = false;
    }
  }

  async function ingestPath(filePath) {
    let res = null;
    try {
      res = await api.uploadIngest(filePath);
    } catch (err) {
      console.error('[studio] ingest failed', err);
    }
    acceptIngest(res);
  }

  async function ingestBytes(file) {
    let res = null;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      res = await api.uploadIngestBytes(file.name, bytes);
    } catch (err) {
      console.error('[studio] ingest failed', err);
    }
    acceptIngest(res);
  }

  function acceptIngest(res) {
    if (!res || !res.ok) {
      notice('upload', (res && (res.message || res.error)) || "That file didn't work. Try a png, jpg or webp picture.");
      return;
    }
    if (res.class !== 'image') {
      notice('upload', 'That looks like a model file rather than a picture. Choose a png, jpg or webp.');
      return;
    }
    clearNotice('upload');
    // `relPath` is workspace-relative by contract and stays that way.
    attachment = {
      relPath: res.relPath,
      name: res.name || res.relPath,
      kind: 'image',
      mode: 'reference',
    };
    persist();
    refresh();
    toast('Picture added. Use it as a reference, or recreate it directly.', 'success');
  }

  consoleEl.addEventListener('dragover', (e) => {
    e.preventDefault();
    consoleEl.classList.add('is-drop-target');
  });
  consoleEl.addEventListener('dragleave', () => consoleEl.classList.remove('is-drop-target'));
  consoleEl.addEventListener('drop', (e) => {
    e.preventDefault();
    consoleEl.classList.remove('is-drop-target');
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (!file || !api) return;
    let p = null;
    try {
      p = typeof api.pathForFile === 'function' ? api.pathForFile(file) : null;
    } catch {
      p = null;
    }
    if (p && typeof api.uploadIngest === 'function') ingestPath(p);
    else if (typeof api.uploadIngestBytes === 'function') ingestBytes(file);
  });

  // ── recent work ────────────────────────────────────────────────────────

  function renderRecent(state) {
    const map = (state && state.checkpoints) || {};
    const items = Object.entries(map)
      .map(([id, cp]) => ({
        id,
        file: (cp && cp.file) || '',
        label: (cp && (cp.label || cp.file)) || id,
        created: cp && cp.created ? Date.parse(cp.created) || 0 : 0,
      }))
      .filter((it) => it.file)
      .sort((a, b) => b.created - a.created)
      .slice(0, 6);

    recentEl.innerHTML = '';
    if (!items.length) {
      recentEl.hidden = true;
      return;
    }
    const head = el('h2', 'studio-recent-title');
    head.textContent = 'Pick up where you left off';
    recentEl.appendChild(head);
    for (const item of items) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'studio-recent-item';
      btn.dataset.file = item.file;
      const label = el('span', 'studio-recent-label');
      label.textContent = item.label;
      btn.appendChild(label);
      btn.addEventListener('click', async () => {
        try {
          if (api && typeof api.selectCheckpoint === 'function') await api.selectCheckpoint(item.id);
        } catch (err) {
          console.error('[studio] could not open that checkpoint', err);
        }
        showView('workbench', { user: true });
      });
      recentEl.appendChild(btn);
    }
    recentEl.hidden = false;
  }

  if (typeof ctx.onCheckpointsChanged === 'function') ctx.onCheckpointsChanged(renderRecent);
  if (api && typeof api.getCheckpoints === 'function') {
    api.getCheckpoints().then(renderRecent).catch(() => {});
  }

  // ── notices ────────────────────────────────────────────────────────────

  function notice(id, text, actions) {
    notices.set(id, { text, actions: actions || [] });
    renderNotices();
  }
  function clearNotice(id) {
    if (!notices.delete(id)) return;
    renderNotices();
  }
  function renderNotices() {
    noticeEl.innerHTML = '';
    if (!notices.size) {
      noticeEl.hidden = true;
      return;
    }
    for (const [id, item] of notices) {
      const row = el('div', 'studio-note');
      row.dataset.note = id;
      const text = el('span', 'studio-note-text');
      text.textContent = item.text;
      row.appendChild(text);
      for (const action of item.actions) {
        const btn = button('', 'studio-note-btn', action.label);
        btn.addEventListener('click', () => safe(action.onClick));
        row.appendChild(btn);
      }
      const close = button('', 'studio-note-dismiss', '×');
      close.setAttribute('aria-label', 'Dismiss');
      close.addEventListener('click', () => clearNotice(id));
      row.appendChild(close);
      noticeEl.appendChild(row);
    }
    noticeEl.hidden = false;
  }

  // ── refresh ────────────────────────────────────────────────────────────

  function compileNow(target) {
    try {
      return compile({ tools, enabled, values, target });
    } catch (err) {
      console.error('[studio] compile threw', err);
      return { lines: [], imageWords: [], flags: { images: [], mesh: [], prep: [], checkpoint: [] }, chips: [], skipped: [] };
    }
  }

  function refresh(opts) {
    try {
      const decision = currentDecision();
      const wantsPreview = previewFirstFor(decision);
      const result = compileNow(decision.target);

      refreshTypes();
      buildPanels();
      refreshPanels(result);
      refreshChips(result);
      refreshToolsMenu(decision.target);
      refreshRoute(decision, wantsPreview);
      refreshSubmit(decision, wantsPreview);
      refreshStage(decision);
    } catch (err) {
      console.error('[studio] refresh failed', err);
    }
  }

  function autoGrow() {
    promptEl.style.height = 'auto';
    promptEl.style.height = Math.min(320, Math.max(64, promptEl.scrollHeight)) + 'px';
  }

  // ── persistence ────────────────────────────────────────────────────────
  //
  // composer-state.json, under a `studio` key — never clawscad.json, never a
  // second userData file (contract §S1).
  //
  // `composer:set-state` merges at the TOP LEVEL (main/composer.js mergeState),
  // so this sends only `{ studio }` and the composer's own keys survive. Three
  // consequences worth stating, because each one has a wrong-looking
  // alternative:
  //
  //  · Never read-modify-write the file here. Re-reading and re-sending the
  //    composer's keys would let a stale read clobber a keystroke it hadn't
  //    seen yet.
  //  · Always send the WHOLE studio object. Top-level keys are replaced, not
  //    deep-merged, which is what makes removing a tool actually remove it —
  //    a deep merge would resurrect it from the previous `enabled` array.
  //  · Never send `{}` to mean "nothing changed". An empty object is the
  //    whole-file reset five specs use in afterAll; sending it here would wipe
  //    the composer's state too.

  const PERSIST_DELAY = 250;
  let persistTimer = null;

  function studioState() {
    return {
      view,
      categoryId,
      prompt: promptText,
      enabled: enabled.slice(),
      values: JSON.parse(JSON.stringify(values || {})),
      preview,
      attachment: attachment ? { ...attachment } : null,
    };
  }

  function persist() {
    if (!api || typeof api.composerSetState !== 'function') return;
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      persistTimer = null;
      try {
        const result = api.composerSetState({ studio: studioState() });
        if (result && typeof result.catch === 'function') {
          result.catch((err) => console.error('[studio] could not save the studio state', err));
        }
      } catch (err) {
        console.error('[studio] could not save the studio state', err);
      }
    }, PERSIST_DELAY);
  }

  async function restore() {
    let saved = null;
    try {
      if (api && typeof api.composerGetState === 'function') {
        const state = await api.composerGetState();
        if (state && typeof state === 'object' && state.studio && typeof state.studio === 'object') saved = state.studio;
      }
    } catch (err) {
      console.error('[studio] could not read the saved studio state', err);
    }
    if (saved) {
      if (typeof saved.categoryId === 'string' && categoryById(saved.categoryId)) categoryId = saved.categoryId;
      if (typeof saved.prompt === 'string') promptText = saved.prompt;
      if (PREVIEW_ORDER.includes(saved.preview)) preview = saved.preview;
      if (Array.isArray(saved.enabled)) {
        enabled = saved.enabled.filter((id) => typeof id === 'string' && toolById(id));
        for (const id of enabled) pinned.add(id);
      }
      if (saved.values && typeof saved.values === 'object') {
        values = {};
        for (const [toolId, bag] of Object.entries(saved.values)) {
          if (!bag || typeof bag !== 'object') continue;
          const clean = {};
          for (const [k, v] of Object.entries(bag)) if (typeof v === 'string') clean[k] = v;
          values[toolId] = clean;
        }
      }
      if (saved.attachment && typeof saved.attachment === 'object' && typeof saved.attachment.relPath === 'string') {
        attachment = {
          relPath: saved.attachment.relPath,
          name: saved.attachment.name || saved.attachment.relPath,
          kind: saved.attachment.kind || 'image',
          mode: saved.attachment.mode === 'recreate' ? 'recreate' : 'reference',
        };
      }
      // A click on the header beats a persisted view that arrives a beat later.
      if (!viewTouched && (saved.view === 'workbench' || saved.view === 'studio')) {
        view = saved.view;
        applyView();
      }
    }
    if (!enabled.length) applyAutoTools();
    restored = true;

    const cat = category();
    if (cat && cat.examples && cat.examples[0]) promptEl.placeholder = String(cat.examples[0]);
    promptEl.value = promptText;
    autoGrow();
  }

  // ── boot ───────────────────────────────────────────────────────────────

  buildTypes();
  refreshTypes();

  const ready = (async () => {
    // The catalog first: a studio with zero tools is a supported state, and the
    // restore below has to be able to tell a real tool id from a stale one.
    try {
      const payload = api && typeof api.toolsLoad === 'function' ? await api.toolsLoad() : null;
      const catalog = readCatalog(payload);
      tools = catalog.tools;
      groups = catalog.groups;
      toolsError = catalog.error;
    } catch (err) {
      console.error('[studio] the tools could not be loaded', err);
      toolsError = String((err && err.message) || err);
    }
    if (toolsError || !tools.length) {
      // Said once, quietly. The front door still works with no tools at all.
      notice('tools', "The extra tools couldn't be loaded, so it's just your description this time.");
    }
    buildToolsMenu();

    try {
      if (api && typeof api.getEnvStatus === 'function') env = await api.getEnvStatus();
    } catch (err) {
      console.error('[studio] could not read the environment', err);
    }
    if (env && env.claude && !env.claude.binary) {
      notice('claude', "The Claude Code CLI isn't installed yet, so nothing can be built from a description until it is.", [
        { label: 'Setup guide', onClick: () => safe(() => api && api.openReadme && api.openReadme()) },
      ]);
    }

    await restore();
    refresh({ structure: true });

    // Last, and deliberately not awaited by anything the person can see: this
    // spawns claw-gen once to ask which backends are ready. Said up front,
    // quietly, so nobody discovers the mesh host is out of disk ten minutes
    // into a job — but never in the way of the front door being usable.
    await probeBackends();
    if (backends && backends.configured) {
      const mesh = kindState('mesh3d');
      if (!mesh.ok) {
        notice(
          'backend-mesh3d',
          `3D meshing is unavailable right now — ${mesh.reason || 'no backend is ready'}. Reference pictures and parametric parts still work.`
        );
      }
      const image = kindState('image');
      if (!image.ok) {
        notice(
          'backend-image',
          `Picture generation is unavailable right now — ${image.reason || 'no backend is ready'}. I can still build from your description.`
        );
      }
    }
  })();
  ready.catch((err) => console.error('[studio] mount failed', err));

  // ── published interface (LAST, so nothing sees a half-built one) ───────

  ctx.studio = {
    show: () => showView('studio'),
    hide: () => showView('workbench'),
    isVisible: () => view === 'studio',
    getState: () => ({ ...studioState(), stage: stage ? { ...stage, candidates: stage.candidates.map((c) => c.key) } : null }),
    setCategory: (id) => setCategory(id, { user: true }),
    setPrompt: (text) => {
      promptText = typeof text === 'string' ? text : '';
      promptEl.value = promptText;
      autoGrow();
      persist();
      refresh();
    },
    enableTool: (id) => enableTool(id),
    disableTool: (id) => disableTool(id),
    setToolValue,
    setPreviewMode,
    getDecision: () => currentDecision(),
    submit: () => submit(),
    // Additive, not in the contract: the spec needs a way to wait for the async
    // catalog + restore, and to read the derived answer without re-deriving it.
    ready,
    getPreviewFirst: () => previewFirstFor(currentDecision()),
    isRestored: () => restored,
    // Flow C's only seam. Attaching a picture normally goes through a native
    // file dialog, which Playwright cannot drive, so without this the one flow
    // that the whole `mesh --image --new-job` change exists for would be the
    // only untested one. Sets exactly what ingest sets — no shortcut around
    // uploadIngest's copy, because the spec passes an already-ingested relPath.
    setAttachment: (att) => {
      attachment = att && att.relPath
        ? {
            relPath: String(att.relPath),
            name: String(att.name || att.relPath),
            kind: att.kind || 'image',
            mode: att.mode === 'recreate' ? 'recreate' : 'reference',
          }
        : null;
      persist();
      refresh();
    },
  };

  // `ctx` lives inside the esbuild bundle's module scope and page.evaluate
  // cannot reach it (the v0.4 test-seam correction). Same object, not a second
  // implementation — no product code path goes through the window alias.
  try {
    window.clawscadStudio = ctx.studio;
  } catch (err) {
    console.error('[studio] could not publish the test handle', err);
  }

  // ── small helpers ──────────────────────────────────────────────────────

  function toast(message, kind) {
    if (typeof ctx.showToast === 'function') safe(() => ctx.showToast(message, kind || 'info'));
  }

  function safe(fn) {
    try {
      return typeof fn === 'function' ? fn() : undefined;
    } catch (err) {
      console.error('[studio]', err);
      return undefined;
    }
  }
}

// ── module-level helpers (no DOM, no ctx) ────────────────────────────────

function el(tag, className) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function button(id, className, text) {
  const node = document.createElement('button');
  node.type = 'button';
  if (id) node.id = id;
  if (className) node.className = className;
  node.textContent = text;
  return node;
}

// CSS.escape is not in every Electron build's global scope in the same shape,
// and a category id or stage name is always [a-z0-9:-] anyway — but a userData
// override could ship anything, and an unescaped quote in a selector throws.
function cssEscape(value) {
  const text = String(value == null ? '' : value);
  try {
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(text);
  } catch {}
  return text.replace(/["\\]/g, '\\$&');
}

// How many tiles are on a row, read from the rendered grid rather than assumed,
// so arrow-key geometry stays correct at 900px and at 2560px (S2's grid is
// auto-fit and the count changes with the window).
function columnsOf(gridEl) {
  try {
    const template = getComputedStyle(gridEl).gridTemplateColumns;
    if (template && template !== 'none') return template.split(' ').filter(Boolean).length;
  } catch {}
  const first = gridEl.firstElementChild;
  if (!first) return 1;
  const width = gridEl.clientWidth || 1;
  const tile = first.getBoundingClientRect().width || width;
  return Math.max(1, Math.round(width / tile));
}

// Accepts { data } (the contract's word), { categories } (what
// main/categories.js actually returns), a bare parsed file, or a bare array.
// Anything else degrades to "no grid, stated reason" — never a throw.
function readTaxonomy(ctx) {
  const empty = { list: [], preamble: '', defaultId: null, error: null };
  const payload = ctx && ctx.categories;
  if (!payload || typeof payload !== 'object') return { ...empty, error: 'The print types were not loaded.' };
  const error = payload.error || null;
  let file = payload.data || payload.categories || null;
  if (Array.isArray(file)) file = { categories: file };
  if (!file || typeof file !== 'object' || !Array.isArray(file.categories)) return { ...empty, error };
  return {
    list: file.categories.filter((c) => c && typeof c === 'object' && typeof c.id === 'string'),
    preamble: typeof file.preamble === 'string' ? file.preamble : '',
    defaultId: typeof file.default === 'string' ? file.default : null,
    error,
  };
}

function pickInitialCategory(taxonomy) {
  if (!taxonomy.list.length) return null;
  if (taxonomy.defaultId && taxonomy.list.some((c) => c.id === taxonomy.defaultId)) return taxonomy.defaultId;
  return taxonomy.list[0].id;
}
