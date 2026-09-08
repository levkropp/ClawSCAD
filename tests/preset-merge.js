#!/usr/bin/env node
/**
 * Standalone harness (no Electron runtime) for renderer/preset-merge.js —
 * the pure merge engine behind the intent-preset chips (master plan §W3).
 *
 * renderer/preset-merge.js is an ES module (`export function ...`), same
 * idiom as its sibling renderer/bus.js and renderer/composer.js, because it
 * is bundled into dist/renderer.js by esbuild (--format=esm). Plain `node`
 * can't `require()` a top-level-`export` file directly, so — like
 * tests/error-handler-survival.js and tests/render-fault-classify.js do to
 * main.js — this harness extracts the LITERAL current source at run time
 * (strips only the `export ` keywords, changes nothing else) and evals it.
 * Edit the merge logic in renderer/preset-merge.js and this harness's
 * result changes with it; it never drifts into testing a stale copy.
 *
 * Run: node tests/preset-merge.js
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const SRC_PATH = path.join(__dirname, '..', 'renderer', 'preset-merge.js');
const PRESETS_PATH = path.join(__dirname, '..', 'presets', 'presets.json');

function loadPresetMerge() {
  const src = fs.readFileSync(SRC_PATH, 'utf-8');
  // The only ESM syntax in this file is `export function` / `export const`
  // at the top level — stripping the `export ` keyword turns it into plain
  // script text that assigns ordinary top-level bindings, which `new
  // Function` can then return as an object.
  const stripped = src.replace(/^export (function|const) /gm, '$1 ');
  const names = [
    'POLICIES', 'canonicalOrder', 'findPreset', 'mergeParams',
    'collectConflictNotes', 'collectPromptBlocks', 'isGeneratedRefused',
    'refusalText', 'activeGenerated', 'mergePresets', 'cliFlagsFor', 'toggleChip',
  ];
  // eslint-disable-next-line no-new-func
  const factory = new Function(`${stripped}\nreturn { ${names.join(', ')} };`);
  return factory();
}

const PM = loadPresetMerge();
const presetsData = JSON.parse(fs.readFileSync(PRESETS_PATH, 'utf-8'));

let failed = 0;
let passed = 0;

function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok — ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL — ${name}`);
    console.log(`  ${err.message}`);
  }
}

// ── the six merge policies, on synthetic data (isolated from presets.json
// so a future edit to real preset numbers can't accidentally hide a broken
// policy implementation) ────────────────────────────────────────────────

console.log('[policies]');

check('max picks the largest contributed value', () => {
  assert.strictEqual(PM.POLICIES.max([0.8, 2.0, 1.2]), 2.0);
});

check('min picks the smallest (finest) contributed value', () => {
  assert.strictEqual(PM.POLICIES.min([0.3, 0.2, 0.8]), 0.2);
});

check('and requires every contributor true', () => {
  assert.strictEqual(PM.POLICIES.and([true, true, true]), true);
  assert.strictEqual(PM.POLICIES.and([true, false, true]), false);
});

check('or requires only one contributor true', () => {
  assert.strictEqual(PM.POLICIES.or([false, false, true]), true);
  assert.strictEqual(PM.POLICIES.or([false, false]), false);
});

check('first picks the canonical-order first contributor', () => {
  assert.strictEqual(PM.POLICIES.first(['fine', 'strong', 'decor']), 'fine');
});

check('concat dedupes across contributors, preserving order', () => {
  assert.deepStrictEqual(
    PM.POLICIES.concat(['a', ['b', 'a'], 'c']),
    ['a', 'b', 'c']
  );
});

// ── mergeParams against the real presets.json, using the declared
// merge_policy table end to end ────────────────────────────────────────

console.log('[mergeParams against presets.json]');

check('miniature alone carries its own fa/fs/min_feature', () => {
  const { params } = PM.mergeParams(['miniature'], presetsData);
  assert.strictEqual(params.fa, 2);
  assert.strictEqual(params.fs, 0.2);
  assert.strictEqual(params.min_feature_mm, 1.0);
});

check('miniature + strong: min_feature_mm merges via max (both declare 1.0)', () => {
  const { params } = PM.mergeParams(['miniature', 'strong'], presetsData);
  assert.strictEqual(params.min_feature_mm, 1.0);
});

check('prototype + strong: min_wall_mm merges via max — Strong keeps its 2.0mm wall', () => {
  const { params } = PM.mergeParams(['prototype', 'strong'], presetsData);
  assert.strictEqual(params.min_wall_mm, 2.0);
});

check('prototype + strong: infill_pct merges via max (40 over 12)', () => {
  const { params } = PM.mergeParams(['prototype', 'strong'], presetsData);
  assert.strictEqual(params.infill_pct, 40);
});

check('fa/fs merge via min (finest wins) across any combo', () => {
  const { params } = PM.mergeParams(['prototype', 'fits-hardware'], presetsData);
  assert.strictEqual(params.fa, Math.min(6, 2));
  assert.strictEqual(params.fs, Math.min(0.8, 0.25));
});

check('slicer_profile merges via first — fidelity wins over purpose', () => {
  const { params } = PM.mergeParams(['miniature', 'strong'], presetsData);
  assert.strictEqual(params.slicer_profile, 'fine');
});

check('every param key shared by 2+ presets has an explicit merge_policy entry', () => {
  // A key unique to a single preset can safely fall back to "first" (there
  // is nothing to merge it against). The real correctness bar is: no key
  // that multiple ACTIVE presets could both contribute is left to an
  // undeclared fallback, because that's exactly the silent-surprise case
  // §5.1 says must never happen.
  const counts = new Map();
  for (const preset of presetsData.presets) {
    for (const key of Object.keys(preset.params || {})) {
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  const sharedKeys = Array.from(counts.entries()).filter(([, n]) => n > 1).map(([k]) => k);
  const undeclared = sharedKeys.filter((k) => !presetsData.merge_policy[k]);
  assert.deepStrictEqual(undeclared, []);
});

// ── every collision case in intent-presets §5.2 ──────────────────────────

console.log('[§5.2 collision cases]');

check('miniature + strong surfaces the min-feature note', () => {
  const notes = PM.collectConflictNotes(['miniature', 'strong'], presetsData);
  assert.strictEqual(notes.length, 1);
  assert.ok(/1\.0 ?mm/.test(notes[0]), 'note mentions the 1.0mm floor');
});

check('miniature + fits-hardware: no note (coherent combo)', () => {
  const notes = PM.collectConflictNotes(['miniature', 'fits-hardware'], presetsData);
  assert.deepStrictEqual(notes, []);
});

check('strong + fits-hardware: no note (the intended bracket case)', () => {
  const notes = PM.collectConflictNotes(['strong', 'fits-hardware'], presetsData);
  assert.deepStrictEqual(notes, []);
});

check('prototype + strong surfaces the infill/curve tradeoff note', () => {
  const notes = PM.collectConflictNotes(['prototype', 'strong'], presetsData);
  assert.strictEqual(notes.length, 1);
  assert.ok(/infill|coarsens/i.test(notes[0]));
});

check('decor-organic + strong surfaces the generator-disabled note', () => {
  const notes = PM.collectConflictNotes(['decor-organic', 'strong'], presetsData);
  assert.strictEqual(notes.length, 1);
  assert.ok(/generator/i.test(notes[0]));
});

check('decor-organic + fits-hardware surfaces the sculpt-then-branch note', () => {
  const notes = PM.collectConflictNotes(['decor-organic', 'fits-hardware'], presetsData);
  assert.strictEqual(notes.length, 1);
  assert.ok(/branch/i.test(notes[0]));
});

check('miniature + prototype is not a conflict_notes entry — it is blocked earlier, at the UI, by exclusivity', () => {
  const notes = PM.collectConflictNotes(['miniature', 'prototype'], presetsData);
  assert.deepStrictEqual(notes, []);
});

// ── exclusive-pair auto-deselect (master plan §1.3) ──────────────────────

console.log('[exclusivity — auto-deselect, never disable]');

check('clicking Prototype while Miniature is active deselects Miniature and notes it', () => {
  const { activeIds, note } = PM.toggleChip(['miniature'], 'prototype', presetsData);
  assert.deepStrictEqual(activeIds.sort(), ['prototype']);
  assert.strictEqual(note, 'Prototype replaces Miniature.');
});

check('clicking Miniature while Prototype is active deselects Prototype and notes it', () => {
  const { activeIds, note } = PM.toggleChip(['prototype'], 'miniature', presetsData);
  assert.deepStrictEqual(activeIds.sort(), ['miniature']);
  assert.strictEqual(note, 'Miniature replaces Prototype.');
});

check('clicking the already-active chip deselects it with no note', () => {
  const { activeIds, note } = PM.toggleChip(['miniature'], 'miniature', presetsData);
  assert.deepStrictEqual(activeIds, []);
  assert.strictEqual(note, null);
});

check('purpose chips stack freely — no auto-deselect, no note', () => {
  const { activeIds, note } = PM.toggleChip(['strong'], 'fits-hardware', presetsData);
  assert.deepStrictEqual(activeIds.sort(), ['fits-hardware', 'strong']);
  assert.strictEqual(note, null);
});

check('a fidelity chip does not touch an active purpose chip', () => {
  const { activeIds } = PM.toggleChip(['strong'], 'miniature', presetsData);
  assert.deepStrictEqual(activeIds.sort(), ['miniature', 'strong']);
});

// ── refusal (master plan §1.4) ────────────────────────────────────────────

console.log('[generated-track refusal]');

check('strong alone refuses the generated track with the §7.3 text', () => {
  const merged = PM.mergePresets(['strong'], presetsData);
  assert.strictEqual(merged.refuseGenerated, true);
  assert.ok(/not dimensionally controlled/.test(merged.refusalText));
  assert.strictEqual(merged.generated, null);
});

check('fits-hardware alone refuses the generated track', () => {
  const merged = PM.mergePresets(['fits-hardware'], presetsData);
  assert.strictEqual(merged.refuseGenerated, true);
});

check('miniature + strong: refusal wins (and policy) even though miniature alone generates', () => {
  const merged = PM.mergePresets(['miniature', 'strong'], presetsData);
  assert.strictEqual(merged.refuseGenerated, true);
  assert.strictEqual(merged.generated, null);
});

check('miniature alone does not refuse and carries its generated.cli block', () => {
  const merged = PM.mergePresets(['miniature'], presetsData);
  assert.strictEqual(merged.refuseGenerated, false);
  assert.ok(merged.generated);
  assert.strictEqual(merged.generated.presetId, 'miniature');
  assert.strictEqual(merged.generated.generated.cli.mesh.size_mm, 32);
});

check('decor-organic + fits-hardware: refused, decor-organic must branch after', () => {
  const merged = PM.mergePresets(['decor-organic', 'fits-hardware'], presetsData);
  assert.strictEqual(merged.refuseGenerated, true);
});

// ── cliFlagsFor — the pure counterpart to ctx.presetCliFlags(action),
// which renderer.js's presetFlagsFor() now calls at all four pipeline:start
// call sites (images/mesh/prep/checkpoint). ──────────────────────────────

console.log('[cliFlagsFor]');

check('miniature: images gets --ar/--size, never -n', () => {
  const flags = PM.cliFlagsFor(['miniature'], presetsData, 'images');
  assert.deepStrictEqual(flags, ['--ar', '3:4', '--size', '2K']);
  assert.ok(!flags.includes('-n'), 'must never emit -n — the user\'s own #gen-count field wins');
});

check('miniature: mesh gets --size-mm/--seeds', () => {
  const flags = PM.cliFlagsFor(['miniature'], presetsData, 'mesh');
  assert.deepStrictEqual(flags, ['--size-mm', '32', '--seeds', '2']);
});

check('miniature: prep gets --target-faces/--flat-cut, never the caveat prose', () => {
  const flags = PM.cliFlagsFor(['miniature'], presetsData, 'prep');
  assert.deepStrictEqual(flags, ['--target-faces', '300000', '--flat-cut', '0']);
});

check('miniature: checkpoint gets --color', () => {
  const flags = PM.cliFlagsFor(['miniature'], presetsData, 'checkpoint');
  assert.deepStrictEqual(flags, ['--color', 'Gainsboro']);
});

check('prototype: mesh skips --size-mm when size_mm is null, keeps --seeds', () => {
  const flags = PM.cliFlagsFor(['prototype'], presetsData, 'mesh');
  assert.deepStrictEqual(flags, ['--seeds', '1']);
});

check('decor-organic: prep never emits flat_cut_caveat as a flag', () => {
  const flags = PM.cliFlagsFor(['decor-organic'], presetsData, 'prep');
  assert.deepStrictEqual(flags, ['--target-faces', '150000', '--flat-cut', '2.5']);
  assert.ok(!flags.some((f) => /caveat|hardcode|plane_normal/.test(f)));
});

check('refused-track combos return [] for every stage (strong alone)', () => {
  for (const action of ['images', 'mesh', 'prep', 'checkpoint']) {
    assert.deepStrictEqual(PM.cliFlagsFor(['strong'], presetsData, action), []);
  }
});

check('refused-track combos return [] even when a generating preset is also active', () => {
  for (const action of ['images', 'mesh', 'prep', 'checkpoint']) {
    assert.deepStrictEqual(PM.cliFlagsFor(['miniature', 'strong'], presetsData, action), []);
  }
});

check('no active presets returns [] for every stage', () => {
  for (const action of ['images', 'mesh', 'prep', 'checkpoint']) {
    assert.deepStrictEqual(PM.cliFlagsFor([], presetsData, action), []);
  }
});

check('an action the active preset has no block for returns []', () => {
  // fits-hardware has no `generated` block at all (refuse_generated), and
  // even a generating preset only ever supplies the four confirmed stages.
  assert.deepStrictEqual(PM.cliFlagsFor(['miniature'], presetsData, 'unknown-stage'), []);
});

// ── dropped knobs (master plan §1.7) never reappear in the shipped data ──

console.log('[§1.7 dropped knobs stay dropped]');

check('no generated.cli.mesh block anywhere carries --octree', () => {
  for (const preset of presetsData.presets) {
    const mesh = preset.generated && preset.generated.cli && preset.generated.cli.mesh;
    if (mesh) assert.ok(!('octree' in mesh), `${preset.id} still declares mesh.octree`);
  }
});

check('no generated.cli block anywhere carries a print stage', () => {
  for (const preset of presetsData.presets) {
    const cli = preset.generated && preset.generated.cli;
    if (cli) assert.ok(!('print' in cli), `${preset.id} still declares a print stage`);
  }
});

check('decor-organic does not claim the -Z flat-cut face', () => {
  const prep = presetsData.presets.find((p) => p.id === 'decor-organic').generated.cli.prep;
  assert.ok(!('flat_cut_face' in prep), 'decor-organic still claims a selectable flat-cut face');
  assert.ok(typeof prep.flat_cut_caveat === 'string' && prep.flat_cut_caveat.length > 0);
});

// ── summary ────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
