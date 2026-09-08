// renderer/preset-merge.js — P3 (intent presets). A PURE module: no DOM, no
// Electron, no imports from the app. Implements intent-presets §5.1's merge
// policy table (max / min / and / or / first / concat) and §5.3's/§9.2's
// conflict notes, plus the fidelity group's exclusive-pair auto-deselect
// (master plan §1.3 — auto-deselect, never disable).
//
// Consumed two ways:
//   1. `import { ... } from './preset-merge.js'` from renderer/presets-ui.js,
//      bundled into dist/renderer.js by esbuild (--format=esm) — same ESM
//      idiom as the sibling renderer/bus.js and renderer/composer.js.
//   2. `node tests/preset-merge.js`, which extracts this file's literal
//      source at run time and strips the `export ` keywords before eval
//      (same technique as tests/render-fault-classify.js and
//      tests/error-handler-survival.js use on main.js) so the harness
//      proves the file that actually ships, not a copy of its logic.
// Both consumers need the exact same top-level function set below with no
// external imports — that constraint is what makes this file "pure".

// ── merge policies ──────────────────────────────────────────────────────
// Each policy takes the array of values contributed by the active presets,
// in declared (canonical) order, for one parameter key, and returns the
// merged value. Presets that don't define a key simply don't appear in the
// array — see mergeParams() below.
export const POLICIES = {
  max(values) {
    return values.reduce((a, b) => (b > a ? b : a));
  },
  min(values) {
    return values.reduce((a, b) => (b < a ? b : a));
  },
  and(values) {
    return values.every(Boolean);
  },
  or(values) {
    return values.some(Boolean);
  },
  // Fidelity group wins, then purpose in declared order — i.e. simply the
  // first contributor in canonical order (mergeParams always visits presets
  // in that order, see below).
  first(values) {
    return values[0];
  },
  // Every contributed value, deduplicated, in canonical order. Used for
  // prompt_blocks — nothing is ever silently dropped (intent-presets §5.1).
  concat(values) {
    const out = [];
    for (const v of values) {
      const items = Array.isArray(v) ? v : [v];
      for (const item of items) if (!out.includes(item)) out.push(item);
    }
    return out;
  },
};

/**
 * Canonical order for merge/precedence purposes: fidelity group first (in
 * its declared `order`), then purpose group in declared `order`. This is
 * what "first" and "concat" iterate over, and it's also the order
 * conflict_notes / prompt blocks are surfaced in.
 */
export function canonicalOrder(presetsData) {
  return presetsData.presets
    .slice()
    .sort((a, b) => {
      const ga = presetsData.groups.findIndex((g) => g.id === a.group);
      const gb = presetsData.groups.findIndex((g) => g.id === b.group);
      if (ga !== gb) return ga - gb;
      return (a.order || 0) - (b.order || 0);
    });
}

/** Look up a preset by id; returns undefined if unknown. */
export function findPreset(presetsData, id) {
  return presetsData.presets.find((p) => p.id === id);
}

/**
 * Merge every `params` key contributed by the given set of active preset
 * ids, per presetsData.merge_policy. Keys with no declared policy fall back
 * to "first" (the safest default — later/duplicate contributors never
 * silently overwrite an earlier one in an undeclared way).
 *
 * Returns { params, unknownPolicyKeys } — unknownPolicyKeys is surfaced so a
 * caller (or a test) can catch a preset param that was added without also
 * adding a merge_policy entry for it.
 */
export function mergeParams(activeIds, presetsData) {
  const ordered = canonicalOrder(presetsData).filter((p) => activeIds.includes(p.id));
  const byKey = new Map(); // key -> [values in canonical order]
  for (const preset of ordered) {
    const params = preset.params || {};
    for (const key of Object.keys(params)) {
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(params[key]);
    }
  }

  const params = {};
  const unknownPolicyKeys = [];
  for (const [key, values] of byKey) {
    const policyName = presetsData.merge_policy[key] || 'first';
    if (!presetsData.merge_policy[key]) unknownPolicyKeys.push(key);
    const policy = POLICIES[policyName] || POLICIES.first;
    params[key] = policy(values);
  }
  return { params, unknownPolicyKeys };
}

/**
 * Collect the notes that apply to the given active preset set, from
 * presetsData.conflict_notes. A note applies when every id in its `when`
 * array is currently active (subset match) — order of ids in `when` doesn't
 * matter.
 */
export function collectConflictNotes(activeIds, presetsData) {
  const active = new Set(activeIds);
  const notes = [];
  for (const entry of presetsData.conflict_notes || []) {
    if (entry.when.every((id) => active.has(id))) notes.push(entry.note);
  }
  return notes;
}

/**
 * Prompt blocks (parametric track) for every active preset that has one,
 * concatenated in canonical order — intent-presets §5.1's `concat` policy
 * applied to `prompt_blocks`, and the mechanism master plan §W3 "preset →
 * part track" prepends to what Claude receives.
 */
export function collectPromptBlocks(activeIds, presetsData) {
  const ordered = canonicalOrder(presetsData).filter((p) => activeIds.includes(p.id));
  const blocks = [];
  for (const preset of ordered) {
    const text = preset.prompt && preset.prompt.parametric;
    if (text) blocks.push(text);
  }
  return blocks;
}

/**
 * Whether the generated track is refused by the active set — `and` policy
 * over each preset's own `refuse_generated` (§5.1: "a single true decides").
 * Presets that don't set the flag are treated as `false`, matching
 * intent-presets' data (only strong/fits-hardware declare it).
 */
export function isGeneratedRefused(activeIds, presetsData) {
  return activeIds.some((id) => {
    const preset = findPreset(presetsData, id);
    return !!(preset && preset.refuse_generated);
  });
}

/**
 * Refusal text for the currently-refused generated track — the first
 * refusing preset's text in canonical order (strong and fits-hardware
 * currently share identical text, so "first" vs "concat" is not
 * observable yet, but "first" is the correct policy per §5.1's table for
 * anything not declared `concat`).
 */
export function refusalText(activeIds, presetsData) {
  const ordered = canonicalOrder(presetsData).filter((p) => activeIds.includes(p.id));
  for (const preset of ordered) {
    if (preset.refuse_generated && preset.refusal_text) return preset.refusal_text;
  }
  return null;
}

/**
 * The generated-track CLI recipe for the active set, or null if refused or
 * none of the active presets has one. Per master plan §W3, generation flags
 * are NOT merged parameter-by-parameter like the parametric params are —
 * only one preset's `generated` block is ever sent to `claw-gen` in one
 * `pipeline:start` chain, so this picks the first active preset (canonical
 * order: fidelity, then purpose) that actually has a `generated.cli` block.
 * In practice that means the active fidelity preset (miniature/prototype)
 * wins over decor-organic when both are active and neither is refused.
 */
export function activeGenerated(activeIds, presetsData) {
  if (isGeneratedRefused(activeIds, presetsData)) return null;
  const ordered = canonicalOrder(presetsData).filter((p) => activeIds.includes(p.id));
  for (const preset of ordered) {
    if (preset.generated && preset.generated.cli) return { presetId: preset.id, generated: preset.generated };
  }
  return null;
}

/**
 * Full merge result for the active preset id set — the one function
 * renderer/presets-ui.js calls to build the recipe strip, the "What Claude
 * will read" preamble contribution, and the refusal-card content.
 */
export function mergePresets(activeIds, presetsData) {
  const ids = Array.from(new Set(activeIds || []));
  const { params, unknownPolicyKeys } = mergeParams(ids, presetsData);
  return {
    activeIds: ids,
    params,
    unknownPolicyKeys,
    notes: collectConflictNotes(ids, presetsData),
    promptBlocks: collectPromptBlocks(ids, presetsData),
    refuseGenerated: isGeneratedRefused(ids, presetsData),
    refusalText: refusalText(ids, presetsData),
    generated: activeGenerated(ids, presetsData),
  };
}

/**
 * The claw-gen CLI flags for one pipeline stage, given the active preset
 * set — the pure counterpart to `ctx.presetCliFlags(action)` in
 * renderer/presets-ui.js (main.js's `presetFlagsFor()` calls that, spreads
 * the result into `pipeline:start`'s `args` at each of the four call sites).
 * Returns `[]` when nothing is active, the generated track is refused, or
 * the active preset simply doesn't set a flag for this stage (e.g.
 * `prototype`'s `mesh.size_mm` is `null` — the user's own size wins).
 *
 * Deliberately narrow: only the four confirmed-real knobs (master plan
 * §1.7's R-2 audit against cli.py) ever become a flag here.
 *   images     → --ar, --size            (never -n — the user's own
 *                                          #gen-count field wins, per the
 *                                          renderer.js call site's own
 *                                          comment)
 *   mesh       → --size-mm, --seeds
 *   prep       → --target-faces, --flat-cut  (flat_cut_caveat is prose for
 *                                              the tooltip, never a flag)
 *   checkpoint → --color
 * `images`'s `image_suffix` text is NOT returned here — it isn't a flag,
 * it's positional prompt text, and reaches the CLI through a different
 * path (composer's onSubmit hook in renderer/presets-ui.js).
 */
export function cliFlagsFor(activeIds, presetsData, action) {
  const merged = mergePresets(activeIds, presetsData);
  if (!merged.generated) return [];
  const cli = merged.generated.generated.cli;
  const flags = [];

  if (action === 'images' && cli.images) {
    if (cli.images.ar) flags.push('--ar', String(cli.images.ar));
    if (cli.images.size) flags.push('--size', String(cli.images.size));
  } else if (action === 'mesh' && cli.mesh) {
    if (cli.mesh.size_mm != null) flags.push('--size-mm', String(cli.mesh.size_mm));
    if (cli.mesh.seeds != null) flags.push('--seeds', String(cli.mesh.seeds));
  } else if (action === 'prep' && cli.prep) {
    if (cli.prep.target_faces != null) flags.push('--target-faces', String(cli.prep.target_faces));
    if (cli.prep.flat_cut_mm != null) flags.push('--flat-cut', String(cli.prep.flat_cut_mm));
  } else if (action === 'checkpoint' && cli.checkpoint && cli.checkpoint.color) {
    flags.push('--color', String(cli.checkpoint.color));
  }

  return flags;
}

// ── exclusive-pair auto-deselect (master plan §1.3) ─────────────────────
/**
 * Apply a chip click. `activeIds` is the current active set (array),
 * `clickedId` the chip just clicked, `presetsData` the loaded data (for
 * group membership + exclusivity + labels).
 *
 * Returns { activeIds, note } — `note` is the one-line role="status" text
 * to surface, or null. Clicking an already-active chip always just
 * deselects it (no note, regardless of group). Clicking an inactive chip in
 * an exclusive group that already has a different active member deselects
 * that member and selects the clicked one, emitting
 * "<Clicked label> replaces <Deselected label>." Clicking an inactive chip
 * in a non-exclusive group (or an exclusive group with no other active
 * member) just adds it — no chip is ever disabled to prevent any of this.
 */
export function toggleChip(activeIds, clickedId, presetsData) {
  const clicked = findPreset(presetsData, clickedId);
  if (!clicked) return { activeIds: activeIds.slice(), note: null };

  const active = new Set(activeIds);
  if (active.has(clickedId)) {
    active.delete(clickedId);
    return { activeIds: Array.from(active), note: null };
  }

  const group = presetsData.groups.find((g) => g.id === clicked.group);
  let note = null;
  if (group && group.exclusive) {
    for (const id of Array.from(active)) {
      const other = findPreset(presetsData, id);
      if (other && other.group === clicked.group && id !== clickedId) {
        active.delete(id);
        note = `${clicked.label.split(' —')[0].trim()} replaces ${other.label.split(' —')[0].trim()}.`;
      }
    }
  }
  active.add(clickedId);
  return { activeIds: Array.from(active), note };
}
