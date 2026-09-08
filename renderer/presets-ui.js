// renderer/presets-ui.js — P3 (intent presets). Owned exclusively by the
// presets package.
//
// IMPORTANT: renderer.js is bundled by esbuild as ESM (--format=esm), and
// ESM imports hoist — this module's top-level body runs BEFORE renderer.js's
// own body finishes executing. Do NOT read the DOM, touch `ctx`, or do any
// work at import time. All work belongs inside mountPresets(), which
// renderer.js calls once, at the very end of its init, after `ctx` is fully
// populated (see renderer/bus.js). Merge logic itself lives in the sibling
// renderer/preset-merge.js (pure, no DOM) — this file is the DOM/IPC glue
// around it.
import { mergePresets, toggleChip, canonicalOrder, cliFlagsFor } from './preset-merge.js';

// ux-spec's short chip labels win over intent-presets' full labels (master
// plan §1.2); each preset's `summary` field becomes the tooltip instead.
const CHIP_LABEL = {
  miniature: 'Miniature',
  prototype: 'Prototype',
  strong: 'Structural',
  'fits-hardware': 'Fits hardware',
  'decor-organic': 'Decorative',
};

export function mountPresets(ctx) {
  if (!ctx.composer) return; // guard — P1's interface must already be frozen

  // ── state ────────────────────────────────────────────────────────────
  let presetsData = null;
  let machineData = null;
  let activeIds = [];
  let lastNote = null; // the most recent exclusivity note (role="status")
  let refusalOverridden = false; // "Sculpt anyway" was pressed for the current refusal
  let materialId = null; // second-row modifier — informational only, no CLI flag exists for it
  let printerId = null;
  let loadError = null;
  let pendingActive = null; // a ctx.presets.setActive() that arrived before presets.json did

  // ── DOM ──────────────────────────────────────────────────────────────
  const wrap = document.createElement('div');
  wrap.className = 'presets-section';

  const chipRow = document.createElement('div');
  chipRow.id = 'preset-chip-row';
  chipRow.setAttribute('role', 'group');
  chipRow.setAttribute('aria-label', 'Intent presets');
  wrap.appendChild(chipRow);

  // role="status" one-liner for the exclusive-pair auto-deselect note
  // (master plan §1.3 — never a disabled chip, always a stated swap).
  const statusEl = document.createElement('div');
  statusEl.id = 'preset-status';
  statusEl.setAttribute('role', 'status');
  statusEl.setAttribute('aria-live', 'polite');
  statusEl.hidden = true;
  wrap.appendChild(statusEl);

  // Recipe strip (ux-spec §2.5) — a quiet summary of what's currently in
  // force, so the chips don't have to be re-read to know what's active.
  const recipeStrip = document.createElement('div');
  recipeStrip.id = 'preset-recipe-strip';
  recipeStrip.hidden = true;
  wrap.appendChild(recipeStrip);

  // Refusal card (master plan §1.4) — replaces the prompt body's framing
  // with a stated block, never a silent grey-out. Only shown for the
  // sculpt/image targets, and only while Structural/Fits-hardware is on.
  const refusalCard = document.createElement('div');
  refusalCard.id = 'preset-refusal-card';
  refusalCard.hidden = true;
  wrap.appendChild(refusalCard);

  // Second, visually quieter modifier row — material / printer, reading
  // machine.json (§5.3). Informational: neither maps to a real claw-gen
  // flag, but the printer choice (P1S's 18x28mm exclusion zone vs the A1's
  // none) is the single fact most likely to prevent a real bed-fit failure,
  // so it's surfaced directly in the preamble Claude reads.
  const modifierRow = document.createElement('div');
  modifierRow.id = 'preset-modifier-row';
  wrap.appendChild(modifierRow);

  const errorEl = document.createElement('div');
  errorEl.id = 'preset-load-error';
  errorEl.hidden = true;
  wrap.appendChild(errorEl);

  // ── data load ────────────────────────────────────────────────────────
  async function load() {
    if (!ctx.api || !ctx.api.presetsLoad) {
      loadError = 'Presets are unavailable in this build.';
      renderAll();
      return;
    }
    try {
      const result = await ctx.api.presetsLoad();
      if (!result || !result.presets || !result.machine) {
        loadError = 'presets:load returned nothing usable.';
      } else {
        presetsData = result.presets;
        machineData = result.machine;
        printerId = machineData.active || null;
        materialId = (machineData.machines && machineData.machines[printerId] && machineData.machines[printerId].material) || 'PLA';
      }
    } catch (err) {
      loadError = String((err && err.message) || err);
    }
    if (pendingActive && presetsData) {
      const known = canonicalOrder(presetsData).map((p) => p.id);
      activeIds = known.filter((id) => pendingActive.includes(id));
      pendingActive = null;
    }
    renderAll();
    ctx.composer.refresh();
  }

  // ── merge ────────────────────────────────────────────────────────────
  function merged() {
    if (!presetsData) return { activeIds: [], params: {}, notes: [], promptBlocks: [], refuseGenerated: false, refusalText: null, generated: null };
    return mergePresets(activeIds, presetsData);
  }

  function activePresetObjects() {
    if (!presetsData) return [];
    return canonicalOrder(presetsData).filter((p) => activeIds.includes(p.id));
  }

  function humanList() {
    const objs = activePresetObjects();
    if (!objs.length) return '';
    return objs.map((p) => CHIP_LABEL[p.id] || p.id).join(' + ');
  }

  // ── chip row ─────────────────────────────────────────────────────────
  function renderChips() {
    chipRow.innerHTML = '';
    if (!presetsData) return;
    const ordered = canonicalOrder(presetsData);
    let lastGroup = null;
    for (const preset of ordered) {
      if (lastGroup !== null && preset.group !== lastGroup) {
        const sep = document.createElement('div');
        sep.className = 'preset-chip-sep';
        sep.setAttribute('aria-hidden', 'true');
        chipRow.appendChild(sep);
      }
      lastGroup = preset.group;

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'preset-chip';
      btn.dataset.presetId = preset.id;
      const on = activeIds.includes(preset.id);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      btn.title = preset.summary || '';
      btn.textContent = CHIP_LABEL[preset.id] || preset.label;
      // No chip is ever `disabled` — exclusivity and refusal are both
      // handled by auto-deselect / a stated card, never by removing a chip
      // from the tab order (master plan §1.3/§1.4).
      btn.addEventListener('click', () => onChipClick(preset.id));
      chipRow.appendChild(btn);
    }
  }

  function onChipClick(id) {
    const result = toggleChip(activeIds, id, presetsData);
    activeIds = result.activeIds;
    lastNote = result.note;
    refusalOverridden = false; // any chip change re-arms the refusal card
    renderAll();
    ctx.composer.refresh();
  }

  function renderStatus() {
    if (lastNote) {
      statusEl.hidden = false;
      statusEl.textContent = lastNote;
    } else {
      statusEl.hidden = true;
      statusEl.textContent = '';
    }
  }

  // ── recipe strip ─────────────────────────────────────────────────────
  function renderRecipeStrip() {
    const m = merged();
    recipeStrip.innerHTML = '';
    if (!activeIds.length) {
      recipeStrip.hidden = true;
      return;
    }
    recipeStrip.hidden = false;
    const title = document.createElement('div');
    title.className = 'preset-recipe-title';
    title.textContent = humanList();
    recipeStrip.appendChild(title);

    const p = m.params;
    const bits = [];
    if (p.fa !== undefined || p.fs !== undefined) bits.push(`$fa=${p.fa ?? '—'} $fs=${p.fs ?? '—'}`);
    if (p.min_wall_mm !== undefined) bits.push(`wall ≥ ${p.min_wall_mm}mm`);
    if (p.min_feature_mm !== undefined) bits.push(`feature ≥ ${p.min_feature_mm}mm`);
    if (p.infill_pct !== undefined) bits.push(`infill ${p.infill_pct}%`);
    if (p.layer_height_mm !== undefined) bits.push(`layer ${p.layer_height_mm}mm`);
    if (m.refuseGenerated) bits.push('parametric only');

    const meta = document.createElement('div');
    meta.className = 'preset-recipe-meta';
    meta.textContent = bits.join(' · ');
    recipeStrip.appendChild(meta);

    if (m.notes.length) {
      for (const note of m.notes) {
        const noteEl = document.createElement('div');
        noteEl.className = 'preset-recipe-note';
        noteEl.textContent = note;
        recipeStrip.appendChild(noteEl);
      }
    }
  }

  // ── refusal card ─────────────────────────────────────────────────────
  // Called from blocks() below (composer calls blocks() every time it
  // recomputes submit state — target change, prompt change, chip change,
  // degradation change — so syncing the card's visibility here rather than
  // from a separate DOM event keeps it correct without needing a
  // target-change subscription ctx.composer doesn't offer).
  function syncRefusalCard() {
    const m = merged();
    const target = ctx.composer.getTarget();
    const shouldShow = m.refuseGenerated && target !== 'part' && !refusalOverridden;

    if (!shouldShow) {
      refusalCard.hidden = true;
      refusalCard.innerHTML = '';
      return null;
    }

    refusalCard.hidden = false;
    if (!refusalCard.dataset.built || refusalCard.dataset.reason !== m.refusalText) {
      refusalCard.innerHTML = '';
      refusalCard.dataset.built = '1';
      refusalCard.dataset.reason = m.refusalText || '';

      const p = document.createElement('p');
      p.textContent = m.refusalText || 'This preset combination refuses the generated track.';
      refusalCard.appendChild(p);

      const actions = document.createElement('div');
      actions.className = 'preset-refusal-actions';

      const turnOffBtn = document.createElement('button');
      turnOffBtn.type = 'button';
      turnOffBtn.className = 'small-btn';
      turnOffBtn.textContent = 'Turn off Structural';
      // Deactivates every currently-active preset that refuses the
      // generated track (both strong and fits-hardware, if both are on) —
      // "Structural" is the label used because that's the one the user is
      // most likely to have reached for on this path; the button clears
      // whichever refusing preset(s) are actually active.
      turnOffBtn.addEventListener('click', () => {
        const refusingIds = presetsData.presets.filter((pr) => pr.refuse_generated).map((pr) => pr.id);
        activeIds = activeIds.filter((id) => !refusingIds.includes(id));
        refusalOverridden = false;
        renderAll();
        ctx.composer.refresh();
      });
      actions.appendChild(turnOffBtn);

      const anywayBtn = document.createElement('button');
      anywayBtn.type = 'button';
      anywayBtn.className = 'small-btn';
      anywayBtn.textContent = 'Sculpt anyway (decorative only)';
      anywayBtn.addEventListener('click', () => {
        refusalOverridden = true;
        renderAll();
        ctx.composer.refresh();
      });
      actions.appendChild(anywayBtn);

      refusalCard.appendChild(actions);
    }

    return 'Turn off Structural, or choose to sculpt anyway, before submitting.';
  }

  // ── modifier row (material / printer) ───────────────────────────────
  function renderModifierRow() {
    modifierRow.innerHTML = '';
    if (!machineData || !machineData.machines) return;

    const printerGroup = document.createElement('div');
    printerGroup.className = 'preset-modifier-group';
    const printerLabel = document.createElement('span');
    printerLabel.className = 'preset-modifier-label';
    printerLabel.textContent = 'Printer';
    printerGroup.appendChild(printerLabel);

    // The printer name alone is not always unique — machine.json ships both a
    // P1S/PLA and a P1S/PETG profile, which both reduce to "P1S" and render as
    // two identical, indistinguishable chips. Qualify with the material only
    // where the bare name actually collides, so the common case stays short.
    const bareName = (m, id) => (m.label || id).replace(/^Bambu /, '').split(' · ')[0];
    const nameCounts = new Map();
    for (const [id, m] of Object.entries(machineData.machines)) {
      const n = bareName(m, id);
      nameCounts.set(n, (nameCounts.get(n) || 0) + 1);
    }

    for (const [id, machine] of Object.entries(machineData.machines)) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'preset-modifier-chip';
      btn.dataset.machineId = id;
      const on = id === printerId;
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      const name = bareName(machine, id);
      btn.textContent = nameCounts.get(name) > 1 && machine.material
        ? `${name} ${machine.material}`
        : name;
      btn.title = machine.bed && machine.bed.exclude_area
        ? `${machine.label} — has a bed exclusion zone near the origin corner`
        : `${machine.label} — no bed exclusion zone`;
      btn.addEventListener('click', () => {
        printerId = id;
        materialId = machine.material || materialId;
        renderAll();
        ctx.composer.refresh();
      });
      printerGroup.appendChild(btn);
    }
    modifierRow.appendChild(printerGroup);
  }

  // ── render orchestration ─────────────────────────────────────────────
  function renderAll() {
    if (loadError) {
      errorEl.hidden = false;
      errorEl.textContent = `Intent presets unavailable — ${loadError}`;
      chipRow.innerHTML = '';
      recipeStrip.hidden = true;
      modifierRow.innerHTML = '';
      return;
    }
    errorEl.hidden = true;
    renderChips();
    renderStatus();
    renderRecipeStrip();
    renderModifierRow();
    // syncRefusalCard() is also called from blocks(); call it here too so a
    // chip click (which doesn't necessarily trigger composer.refresh()'s
    // own blocks() call before the next paint) shows/hides the card
    // immediately rather than one interaction behind.
    syncRefusalCard();
  }

  // ── composer integration (master plan §4.3) ─────────────────────────
  ctx.composer.registerSection({
    id: 'presets',
    order: 20,
    mount(el) {
      el.appendChild(wrap);
      load();
    },
    preamble() {
      if (!presetsData || !activeIds.length) return [];
      const target = ctx.composer.getTarget();
      const lines = [];

      if (target === 'part') {
        // Nothing is ever silently dropped (§5.1) — every active preset's
        // full parametric instruction block is prepended, in canonical
        // (fidelity, then purpose) order.
        for (const block of merged().promptBlocks) lines.push(block);
        lines.push(
          `Checkpoint discipline: end the new file's first-line // comment with "— presets: ${humanList()}" naming every preset active on this request (this is the only place a future session learns why the file has these numbers).`
        );
      } else {
        // Generated track — the parametric instruction blocks don't apply.
        // window.api is frozen by contextBridge.exposeInMainWorld, so it
        // can't be intercepted directly — but P0/P1 added a ctx-level hook
        // (renderer.js's presetFlagsFor() calls ctx.presetCliFlags(action),
        // set at the bottom of this file) that spreads --ar/--size,
        // --size-mm/--seeds, --target-faces/--flat-cut and --color into
        // pipeline:start's args at all four call sites. The images-stage
        // prompt SUFFIX (not a flag — positional text) still goes through
        // the onSubmit hook below, since that's the only path that reaches
        // the prompt argument itself.
        const m = merged();
        if (m.refuseGenerated) {
          lines.push(`Presets active: ${humanList()} — generated track refused, see the card above.`);
        } else if (m.generated && m.generated.generated.image_suffix) {
          lines.push(`Presets active: ${humanList()} — generator flags (images ar/size, mesh size/seeds, prep faces/cut, checkpoint colour) apply automatically, and an image-style suffix is appended to the prompt before it reaches the image backend.`);
        } else if (m.generated) {
          lines.push(`Presets active: ${humanList()} — generator flags apply automatically (images ar/size, mesh size/seeds, prep faces/cut, checkpoint colour).`);
        }
      }

      const machine = machineData && machineData.machines && machineData.machines[printerId];
      if (machine && machine.bed && machine.bed.exclude_area) {
        const ea = machine.bed.exclude_area;
        lines.push(`Printer: ${machine.label} — has an ${ea.x}x${ea.y}mm exclusion zone at the ${ea.corner} of the bed. Keep the part clear of it, or note that it needs the A1.`);
      } else if (machine) {
        lines.push(`Printer: ${machine.label} — no bed exclusion zone.`);
      }

      return lines;
    },
    blocks() {
      return syncRefusalCard();
    },
  });

  // ── generated-track prompt-suffix injection ─────────────────────────
  // window.api is frozen by contextBridge.exposeInMainWorld — assigning to
  // any of its properties (e.g. wrapping startPipeline, my original attempt)
  // throws a TypeError at mount time, which took down every module mounted
  // after this one in renderer.js's single top-level `mountComposer(ctx);
  // mountUploads(ctx); mountPresets(ctx); mountGallery(ctx);
  // mountOnboarding(ctx);` statement sequence. P1 closed the real gap this
  // exposed: renderer.js now has its own `presetFlagsFor(action)` at each of
  // the four pipeline:start call sites (images/mesh/prep/checkpoint), which
  // calls `ctx.presetCliFlags(action)` — a plain field on the mutable `ctx`
  // object (never frozen; only window.api is), set at the bottom of this
  // function. That's the real flag path now: --ar/--size, --size-mm/--seeds,
  // --target-faces/--flat-cut, --color. See renderer/preset-merge.js's pure
  // `cliFlagsFor()` for the actual per-stage logic (tested in
  // tests/preset-merge.js's "[cliFlagsFor]" block).
  //
  // The one thing that ISN'T a flag — the images stage's prompt-suffix TEXT
  // (positional, not `--something`) — still goes through the composer's own
  // onSubmit hook (composer.js: "the entire coupling between P2's upload
  // ingest and the composer" — the same mechanism works for us).
  // dispatchGenerate() synchronously reads the composer's `prompt` state
  // into that positional argument immediately after every onSubmit handler
  // resolves, with no await in between, so setting it here and reverting on
  // the next macrotask (after that synchronous read has already happened)
  // gets image_suffix onto the wire without touching window.api, main.js or
  // renderer.js. This is the ONLY path presets-ui.js uses now — it does not
  // also duplicate --ar/--size here, so there's no double-application
  // between this and ctx.presetCliFlags.
  ctx.composer.onSubmit((payload) => {
    if (!presetsData || payload.target === 'part') return;
    const m = merged();
    const suffix = m.generated && m.generated.generated && m.generated.generated.image_suffix;
    if (!suffix) return;
    const original = ctx.composer.getPrompt();
    if (!original) return;
    ctx.composer.setPrompt(`${original}\n\n${suffix}`, { select: false });
    setTimeout(() => ctx.composer.setPrompt(original, { select: false }), 0);
  });

  // ── ctx.presetCliFlags(action) — the hook renderer.js's presetFlagsFor()
  // calls at each pipeline:start call site. `ctx` (renderer/bus.js) is a
  // plain mutable object populated once by renderer.js and never frozen —
  // unlike window.api, setting a field on it after mount is exactly how
  // this interface is meant to be extended.
  ctx.presetCliFlags = function presetCliFlags(action) {
    if (!presetsData) return [];
    return cliFlagsFor(activeIds, presetsData, action);
  };

  // ── ctx.presets — v0.4. Picking a print type in the guided grid (P8) sets
  // the intent chips for you, which is the whole reason a non-CAD user never
  // has to learn what "Fits hardware" means. setActive REPLACES the active
  // set rather than toggling, and goes through the same renderAll() +
  // composer.refresh() path a chip click does, so the chips, the recipe strip
  // and the preamble stay in sync with the grid. Ids the taxonomy names but
  // presets.json doesn't define are dropped silently — a category must never
  // be able to break the chip row.
  ctx.presets = {
    getActive: () => activeIds.slice(),
    has: (id) => activeIds.includes(id),
    setActive(ids) {
      const wanted = Array.isArray(ids) ? ids : [];
      if (!presetsData) {
        // presets.json is still in flight (mount() kicks load() off async and
        // P8 mounts synchronously after us). Remember the request and let
        // load() apply it — dropping it here would leave a category selected
        // with none of its chips on.
        pendingActive = wanted;
        return;
      }
      const known = canonicalOrder(presetsData).map((p) => p.id);
      const next = known.filter((id) => wanted.includes(id));
      if (next.length === activeIds.length && next.every((id, i) => id === activeIds[i])) return;
      activeIds = next;
      lastNote = null;
      refusalOverridden = false;
      renderAll();
      ctx.composer.refresh();
    },
  };
}
