#!/usr/bin/env node
/**
 * Standalone harness (no Electron, no Playwright) for main/composer.js's
 * mergeState — the top-level merge behind composer-state.json.
 *
 * Why this file exists. Until v0.6 the composer was the only writer of
 * composer-state.json and `composer:set-state` overwrote it wholesale. v0.6
 * added a second writer (the studio), which turned that overwrite into silent
 * data loss: the composer's persistState() fires on every keystroke with
 * { target, prompt, height, guided }, so it would delete the studio's `studio`
 * key a fraction of a second after the studio wrote it. The bug would have
 * looked like "the dashboard forgets my tools sometimes".
 *
 * The fix cannot be a plain merge, and that is the whole subtlety worth
 * testing: five existing specs call `composerSetState({})` in afterAll as a
 * whole-file reset, and under a plain merge that reset silently becomes a
 * no-op, leaking state into every later spec. So `{}` clears and everything
 * else merges. Both branches are asserted below; break either and this goes
 * red.
 *
 * Run: node tests/composer-state.js
 */

const assert = require('assert');
const { mergeState } = require('../main/composer.js');

let passed = 0;
let failed = 0;

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

// ── the bug this fix exists for ──────────────────────────────────────────

check("a composer write does not delete the studio's key", () => {
  const prev = { target: 'part', prompt: 'hi', studio: { categoryId: 'furniture', enabled: ['dimensions'] } };
  // exactly what renderer/composer.js persistState() sends
  const next = { target: 'sculpt', prompt: 'hi there', height: undefined, guided: { categoryId: 'decor' } };
  const out = mergeState(prev, next);
  assert.deepStrictEqual(out.studio, { categoryId: 'furniture', enabled: ['dimensions'] });
  assert.strictEqual(out.target, 'sculpt');
  assert.strictEqual(out.prompt, 'hi there');
});

check("a studio write does not delete the composer's keys", () => {
  const prev = { target: 'part', prompt: 'a knob', guided: { categoryId: 'furniture' } };
  const out = mergeState(prev, { studio: { previewMode: 'on' } });
  assert.strictEqual(out.target, 'part');
  assert.strictEqual(out.prompt, 'a knob');
  assert.deepStrictEqual(out.guided, { categoryId: 'furniture' });
  assert.deepStrictEqual(out.studio, { previewMode: 'on' });
});

// ── the reset branch five specs depend on ────────────────────────────────

check('an empty object CLEARS the whole file (the specs’ afterAll reset)', () => {
  const prev = { target: 'sculpt', prompt: 'x', guided: { a: 1 }, studio: { b: 2 } };
  assert.deepStrictEqual(mergeState(prev, {}), {});
});

check('clearing an already-empty state is still empty', () => {
  assert.deepStrictEqual(mergeState({}, {}), {});
});

// ── replacement semantics within a key ───────────────────────────────────

check('a top-level key is REPLACED, not deep-merged', () => {
  // Each owner writes its whole sub-object, so a deep merge would resurrect
  // fields the owner deliberately dropped (a removed tool, a cleared answer).
  const prev = { studio: { categoryId: 'decor', enabled: ['style', 'colour'] } };
  const out = mergeState(prev, { studio: { categoryId: 'decor', enabled: [] } });
  assert.deepStrictEqual(out.studio.enabled, []);
});

check('a later write of the same key wins', () => {
  assert.strictEqual(mergeState({ target: 'part' }, { target: 'image' }).target, 'image');
});

// ── junk in, previous state out — never a throw, never a wipe ────────────

for (const junk of [null, undefined, 'nope', 42, true, []]) {
  check(`${JSON.stringify(junk) ?? 'undefined'} is ignored and leaves state intact`, () => {
    const prev = { target: 'part', studio: { a: 1 } };
    assert.deepStrictEqual(mergeState(prev, junk), prev);
  });
}

check('a junk PREVIOUS state is treated as empty rather than spread', () => {
  assert.deepStrictEqual(mergeState('corrupt', { target: 'part' }), { target: 'part' });
  assert.deepStrictEqual(mergeState(null, { target: 'part' }), { target: 'part' });
});

// ── purity ───────────────────────────────────────────────────────────────

check('mergeState mutates neither argument', () => {
  const prev = { target: 'part', studio: { a: 1 } };
  const next = { prompt: 'x' };
  const prevCopy = structuredClone(prev);
  const nextCopy = structuredClone(next);
  mergeState(prev, next);
  assert.deepStrictEqual(prev, prevCopy);
  assert.deepStrictEqual(next, nextCopy);
});

console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
