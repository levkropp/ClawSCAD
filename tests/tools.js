#!/usr/bin/env node
/**
 * Standalone harness (no Electron, no Playwright) for renderer/tools.js —
 * the pure tool compiler behind the v0.6 Studio (contracts §S3).
 *
 * renderer/tools.js is an ES module bundled by esbuild, so this CommonJS
 * harness loads it with a dynamic import() — the real file, not a transformed
 * copy, so the harness can never drift onto a stale source. Same idiom as
 * tests/route.js.
 *
 * Every expectation below is a LITERAL. Nothing derives an expected line,
 * word or flag from presets/tools.json: if a rule in the catalog breaks, the
 * assertion goes red instead of moving with it. The one block that iterates
 * the catalog is the integrity block — and there the rules being enforced
 * (ids unique, placeholders declared, actions known, groups real, auto
 * categories real) are themselves fixed, not read from the data.
 *
 * Run: node tests/tools.js
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const TOOLS_PATH = path.join(__dirname, '..', 'presets', 'tools.json');
const CATEGORIES_PATH = path.join(__dirname, '..', 'presets', 'categories.json');

(async () => {
  const {
    readCatalog,
    autoToolsFor,
    toolAppliesTo,
    pruneValues,
    toolHasValues,
    summarise,
    compile,
    composeBrief,
    composeImagePrompt,
    ACTIONS,
  } = await import('../renderer/tools.js');

  const catalog = JSON.parse(fs.readFileSync(TOOLS_PATH, 'utf-8'));
  const taxonomy = JSON.parse(fs.readFileSync(CATEGORIES_PATH, 'utf-8'));

  const tool = (id) => {
    const found = catalog.tools.find((t) => t.id === id);
    assert.ok(found, `tools.json has no "${id}"`);
    return found;
  };

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

  function deepFreeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
      Object.freeze(value);
      for (const key of Object.keys(value)) deepFreeze(value[key]);
    }
    return value;
  }

  const clone = (v) => JSON.parse(JSON.stringify(v));

  /** compile against the real catalog */
  const run = (enabled, values, target) =>
    compile({ tools: catalog.tools, enabled, values, target });

  const emptyResult = () => ({
    lines: [],
    imageWords: [],
    flags: { images: [], mesh: [], prep: [], checkpoint: [] },
    chips: [],
    skipped: [],
  });

  // A full, valid value set for every shipped tool. INPUT ONLY — every
  // expectation about what these compile to is a literal further down.
  const FULL = {
    dimensions: { x: '40', y: '25', z: '12', ref: 'outside' },
    hardware: { thread: 'M4', method: 'heat-set insert', count: '4' },
    fit: { mates: 'a 6 mm round cable', fit: 'snug (hand pressure)', gap: '0.2' },
    mounting: { style: 'screws to a wall', spacing: '75 × 75', countersink: true },
    'existing-part': { what: 'a Bosch dishwasher rack', measured: '18.4 shaft, 32 centres', confidence: 'callipers' },
    text: { text: 'WORKSHOP', mode: 'engraved (cut in)', where: 'top face', depth: '0.8' },
    strength: { duty: 'takes real load', load: 'sideways / bending', walls: '3' },
    material: { filament: 'PETG', where: 'outdoors / UV' },
    printing: { nozzle: '0.4', layer: '0.2', supports: 'design so none are needed' },
    quantity: { count: '4', arrange: true },
    style: { form: 'geometric', finish: 'matte', like: 'mid-century Danish' },
    colour: { name: 'Peru' },
    detail: { level: 'standard' },
  };

  const ALL_TOOL_IDS = [
    'dimensions', 'hardware', 'fit', 'mounting', 'existing-part', 'text',
    'strength', 'material', 'printing', 'quantity', 'style', 'colour', 'detail',
  ];

  // ── exports ────────────────────────────────────────────────────────────

  console.log('[exports]');

  check('ACTIONS is exported, frozen, and is exactly the four pipeline actions', () => {
    assert.ok(Object.isFrozen(ACTIONS), 'ACTIONS is frozen');
    assert.deepStrictEqual(ACTIONS, ['images', 'mesh', 'prep', 'checkpoint']);
  });

  // ── readCatalog: every wrapper shape plus junk ─────────────────────────

  console.log('[readCatalog — wrapper shapes and junk]');

  const FILE = {
    version: 1,
    tools: [{ id: 'alpha' }, { id: 'beta' }],
    groups: [{ id: 'g', label: 'Group' }],
  };

  check("shape 1 — the real tools:load reply, { tools: <parsed file>, source, error }", () => {
    const out = readCatalog({ tools: clone(FILE), source: 'shipped', overridePath: 'x', error: null });
    assert.deepStrictEqual(out.tools.map((t) => t.id), ['alpha', 'beta']);
    assert.deepStrictEqual(out.groups, [{ id: 'g', label: 'Group' }]);
    assert.strictEqual(out.error, null);
  });

  check('shape 2 — { data: <parsed file> }', () => {
    const out = readCatalog({ data: clone(FILE) });
    assert.deepStrictEqual(out.tools.map((t) => t.id), ['alpha', 'beta']);
    assert.deepStrictEqual(out.groups, [{ id: 'g', label: 'Group' }]);
    assert.strictEqual(out.error, null);
  });

  check('shape 3 — { tools: [bare array] }', () => {
    const out = readCatalog({ tools: [{ id: 'alpha' }] });
    assert.deepStrictEqual(out.tools.map((t) => t.id), ['alpha']);
    assert.deepStrictEqual(out.groups, []);
    assert.strictEqual(out.error, null);
  });

  check('shape 4 — a bare parsed file: tools survive (.tools precedence drops groups)', () => {
    // payload.tools (the array) wins over the payload itself, so this shape
    // keeps the tools — the front door — and loses only the menu grouping.
    const out = readCatalog(clone(FILE));
    assert.deepStrictEqual(out.tools.map((t) => t.id), ['alpha', 'beta']);
    assert.deepStrictEqual(out.groups, []);
    assert.strictEqual(out.error, null);
  });

  check('shape 5 — a bare array is taken as the tools themselves', () => {
    const out = readCatalog([{ id: 'alpha' }, { id: 'beta' }]);
    assert.deepStrictEqual(out.tools.map((t) => t.id), ['alpha', 'beta']);
    assert.deepStrictEqual(out.groups, []);
    assert.strictEqual(out.error, null);
  });

  check('null / undefined / falsy report "The tools were not loaded."', () => {
    for (const junk of [null, undefined, 0, '', false]) {
      const out = readCatalog(junk);
      assert.deepStrictEqual(out, { tools: [], groups: [], error: 'The tools were not loaded.' }, String(junk));
    }
  });

  check('a non-object (number, string, true) degrades with the same message', () => {
    for (const junk of [42, 'nope', true]) {
      const out = readCatalog(junk);
      assert.deepStrictEqual(out, { tools: [], groups: [], error: 'The tools were not loaded.' }, String(junk));
    }
  });

  check('an empty object yields the empty catalog with no error', () => {
    assert.deepStrictEqual(readCatalog({}), { tools: [], groups: [], error: null });
  });

  check('{ data: "nope" } — an unusable inner file — yields empty, not a throw', () => {
    assert.deepStrictEqual(readCatalog({ data: 'nope' }), { tools: [], groups: [], error: null });
  });

  check('the error string rides through intact', () => {
    const out = readCatalog({ tools: clone(FILE), error: 'boom | bang' });
    assert.strictEqual(out.error, 'boom | bang');
    assert.deepStrictEqual(out.tools.map((t) => t.id), ['alpha', 'beta']);
  });

  check('an error with no usable file still reports the error', () => {
    assert.deepStrictEqual(readCatalog({ error: 'boom' }), { tools: [], groups: [], error: 'boom' });
  });

  check('tool entries without an id, and non-object entries, are filtered out', () => {
    const out = readCatalog({
      tools: { tools: [{ id: 'a' }, null, {}, 'x', 42, { id: '' }], groups: [{ id: 'g' }, null, {}] },
    });
    assert.deepStrictEqual(out.tools.map((t) => t.id), ['a']);
    assert.deepStrictEqual(out.groups.map((g) => g.id), ['g']);
  });

  // ── autoToolsFor ───────────────────────────────────────────────────────

  console.log('[autoToolsFor]');

  const AUTO_FIXTURE = [
    { id: 't-star', auto: '*' },
    { id: 't-cat', auto: ['catA'] },
    { id: 't-none' },
    { id: 't-empty', auto: [] },
  ];

  check("'*' switches on for every category; a listed id only for its own", () => {
    assert.deepStrictEqual(autoToolsFor(AUTO_FIXTURE, 'catA'), ['t-star', 't-cat']);
    assert.deepStrictEqual(autoToolsFor(AUTO_FIXTURE, 'catB'), ['t-star']);
  });

  check("missing or empty auto means offered, never automatic", () => {
    assert.ok(!autoToolsFor(AUTO_FIXTURE, 'catA').includes('t-none'));
    assert.ok(!autoToolsFor(AUTO_FIXTURE, 'catA').includes('t-empty'));
  });

  check("no categoryId — '*' still applies, listed ids do not", () => {
    assert.deepStrictEqual(autoToolsFor(AUTO_FIXTURE, undefined), ['t-star']);
  });

  check('junk tools argument returns an empty list', () => {
    assert.deepStrictEqual(autoToolsFor(null, 'catA'), []);
    assert.deepStrictEqual(autoToolsFor('nope', 'catA'), []);
  });

  check("the shipped catalog: bracket auto-enables dimensions, hardware, fit, mounting", () => {
    assert.deepStrictEqual(autoToolsFor(catalog.tools, 'bracket'), ['dimensions', 'hardware', 'fit', 'mounting']);
  });

  check('the shipped catalog: replacement auto-enables dimensions, fit, existing-part', () => {
    assert.deepStrictEqual(autoToolsFor(catalog.tools, 'replacement'), ['dimensions', 'fit', 'existing-part']);
  });

  check('the shipped catalog: model auto-enables only style; other auto-enables nothing', () => {
    assert.deepStrictEqual(autoToolsFor(catalog.tools, 'model'), ['style']);
    assert.deepStrictEqual(autoToolsFor(catalog.tools, 'other'), []);
  });

  // ── toolAppliesTo ──────────────────────────────────────────────────────

  console.log('[toolAppliesTo]');

  check('no targets at all means every track', () => {
    for (const target of ['part', 'sculpt', 'image']) {
      assert.strictEqual(toolAppliesTo(tool('style'), target), true, `style on ${target}`);
      assert.strictEqual(toolAppliesTo({ id: 'bare' }, target), true, `bare on ${target}`);
    }
  });

  check('an empty targets array also means every track', () => {
    assert.strictEqual(toolAppliesTo({ id: 'x', targets: [] }, 'image'), true);
  });

  check("hardware is part-only; detail is sculpt-only", () => {
    assert.strictEqual(toolAppliesTo(tool('hardware'), 'part'), true);
    assert.strictEqual(toolAppliesTo(tool('hardware'), 'sculpt'), false);
    assert.strictEqual(toolAppliesTo(tool('hardware'), 'image'), false);
    assert.strictEqual(toolAppliesTo(tool('detail'), 'sculpt'), true);
    assert.strictEqual(toolAppliesTo(tool('detail'), 'part'), false);
  });

  check('a null tool applies nowhere', () => {
    assert.strictEqual(toolAppliesTo(null, 'part'), false);
  });

  // ── pruneValues / toolHasValues ────────────────────────────────────────

  console.log('[pruneValues / toolHasValues]');

  check('an unknown field id is dropped', () => {
    assert.deepStrictEqual(pruneValues(tool('dimensions'), { x: '40', bogus: '9' }), { x: '40' });
  });

  check('empty and whitespace-only values are dropped; kept ones are trimmed', () => {
    assert.deepStrictEqual(pruneValues(tool('dimensions'), { x: '   ', y: ' 25 ', z: '' }), { y: '25' });
  });

  check('non-string values are coerced: number → string, true → "yes", false → dropped', () => {
    assert.deepStrictEqual(pruneValues(tool('dimensions'), { x: 40 }), { x: '40' });
    assert.deepStrictEqual(pruneValues(tool('mounting'), { countersink: true }), { countersink: 'yes' });
    assert.deepStrictEqual(pruneValues(tool('mounting'), { countersink: false }), {});
  });

  check('null values, or a tool with no fields, prune to nothing', () => {
    assert.deepStrictEqual(pruneValues(tool('dimensions'), null), {});
    assert.deepStrictEqual(pruneValues({ id: 'bare' }, { x: '1' }), {});
    assert.deepStrictEqual(pruneValues(null, { x: '1' }), {});
  });

  check('toolHasValues: one real value is enough; unknown or empty fields are not', () => {
    assert.strictEqual(toolHasValues(tool('dimensions'), { x: '40' }), true);
    assert.strictEqual(toolHasValues(tool('dimensions'), {}), false);
    assert.strictEqual(toolHasValues(tool('dimensions'), { bogus: '1' }), false);
    assert.strictEqual(toolHasValues(tool('dimensions'), { x: '  ' }), false);
  });

  // ── compile: first-match-wins on lines ─────────────────────────────────

  console.log('[compile — first match wins on lines]');

  check('a fully-filled Dimensions emits exactly ONE line, the four-field sentence', () => {
    const out = run(['dimensions'], { dimensions: { x: '40', y: '25', z: '12', ref: 'outside' } }, 'part');
    assert.deepStrictEqual(out.lines, [
      'SIZE: 40 × 25 × 12 mm, measured outside. These numbers are contractual — expose them as named variables at the top of the file and do not round them to nicer values.',
    ]);
    assert.deepStrictEqual(out.skipped, []);
  });

  check('the parenthesised choice value flows through the placeholder untouched', () => {
    const out = run(['dimensions'], { dimensions: { x: '40', y: '25', z: '12', ref: 'inside (usable space)' } }, 'part');
    assert.deepStrictEqual(out.lines, [
      'SIZE: 40 × 25 × 12 mm, measured inside (usable space). These numbers are contractual — expose them as named variables at the top of the file and do not round them to nicer values.',
    ]);
  });

  check('x+y+z without ref falls to the second rule', () => {
    const out = run(['dimensions'], { dimensions: { x: '40', y: '25', z: '12' } }, 'part');
    assert.deepStrictEqual(out.lines, [
      'SIZE: 40 × 25 × 12 mm (outside). These numbers are contractual — expose them as named variables at the top of the file and do not round them.',
    ]);
  });

  check('x+y is the footprint sentence', () => {
    const out = run(['dimensions'], { dimensions: { x: '40', y: '25' } }, 'part');
    assert.deepStrictEqual(out.lines, ['FOOTPRINT: 40 × 25 mm. Contractual; expose both as variables.']);
  });

  check('x+z is the across-by-tall sentence', () => {
    const out = run(['dimensions'], { dimensions: { x: '40', z: '12' } }, 'part');
    assert.deepStrictEqual(out.lines, ['SIZE: 40 mm across × 12 mm tall. Contractual; expose both as variables.']);
  });

  check('z alone is HEIGHT; x alone is WIDTH', () => {
    assert.deepStrictEqual(
      run(['dimensions'], { dimensions: { z: '12' } }, 'part').lines,
      ['HEIGHT: 12 mm. Contractual; expose it as a variable.']
    );
    assert.deepStrictEqual(
      run(['dimensions'], { dimensions: { x: '40' } }, 'part').lines,
      ['WIDTH: 40 mm. Contractual; expose it as a variable.']
    );
  });

  check('y alone matches no rule: no line, but the tool still chips and is not skipped', () => {
    const out = run(['dimensions'], { dimensions: { y: '25' } }, 'part');
    assert.deepStrictEqual(out.lines, []);
    assert.deepStrictEqual(out.skipped, []);
    assert.deepStrictEqual(out.chips, [{ toolId: 'dimensions', label: 'Dimensions', text: '25 mm' }]);
  });

  check('multi-field when: hardware thread+method+count takes the three-field sentence only', () => {
    const out = run(['hardware'], { hardware: { thread: 'M4', method: 'heat-set insert', count: '4' } }, 'part');
    assert.deepStrictEqual(out.lines, [
      'HARDWARE: 4 × M4, heat-set insert. Take every diameter, pitch, insert bore and clearance from the FITS SCREWS AND PARTS tables — never from memory, never rounded. State in a comment which table row each number came from.',
    ]);
  });

  check('hardware method alone falls all the way to the last rule', () => {
    const out = run(['hardware'], { hardware: { method: 'nut trap' } }, 'part');
    assert.deepStrictEqual(out.lines, [
      'HARDWARE: fixed by nut trap. Size the feature from the FITS SCREWS AND PARTS tables.',
    ]);
  });

  check('hardware count alone matches no rule — a count with no thread says nothing', () => {
    const out = run(['hardware'], { hardware: { count: '4' } }, 'part');
    assert.deepStrictEqual(out.lines, []);
    assert.deepStrictEqual(out.chips, [{ toolId: 'hardware', label: 'Hardware', text: '4' }]);
  });

  check('fit fully filled takes the three-field sentence', () => {
    const out = run(['fit'], { fit: FULL.fit }, 'part');
    assert.deepStrictEqual(out.lines, [
      'FIT: mates with a 6 mm round cable; should feel like a snug (hand pressure); use 0.2 mm clearance on the mating face. Put the clearance in its own variable so it can be reprinted tighter or looser without touching the geometry.',
    ]);
  });

  check('fit gap alone takes the last rule', () => {
    const out = run(['fit'], { fit: { gap: '0.2' } }, 'part');
    assert.deepStrictEqual(out.lines, ['FIT: 0.2 mm clearance on every mating face, as a named variable.']);
  });

  check('a toggle participates in when: countersink on picks the three-field mounting rule', () => {
    const out = run(['mounting'], { mounting: { style: 'screws to a wall', spacing: '75 × 75', countersink: true } }, 'part');
    assert.deepStrictEqual(out.lines, [
      'MOUNTING: screws to a wall, hole pattern 75 × 75 mm, countersunk so the heads finish flush or below the surface. Expose the pattern as variables.',
    ]);
  });

  check('countersink off (false) is not a value: the two-field mounting rule fires instead', () => {
    const out = run(['mounting'], { mounting: { style: 'screws to a wall', spacing: '75 × 75', countersink: false } }, 'part');
    assert.deepStrictEqual(out.lines, [
      'MOUNTING: screws to a wall, hole pattern 75 × 75 mm. Expose the pattern as variables.',
    ]);
  });

  check('existing-part fully filled carries the calliper-confidence sentence', () => {
    const out = run(['existing-part'], { 'existing-part': FULL['existing-part'] }, 'part');
    assert.deepStrictEqual(out.lines, [
      'REPLACES: a part from a Bosch dishwasher rack. Measured 18.4 shaft, 32 centres (measured with callipers). Treat callipered numbers as exact and ruler/photo numbers as ±0.5 mm — where a number is uncertain, expose it as a variable and add a one-line comment saying to reprint after checking that dimension.',
    ]);
  });

  check('strength duty+load (no walls) takes the two-field rule', () => {
    const out = run(['strength'], { strength: { duty: 'takes real load', load: 'sideways / bending' } }, 'part');
    assert.deepStrictEqual(out.lines, [
      'STRENGTH: takes real load; the load runs sideways / bending. Orient the part so that load runs in the bed plane, never across layer lines, and say in a comment which face goes on the bed. Thicken walls and add fillets at the loaded root.',
    ]);
  });

  check('material environment alone gets the do-not-assume-PLA sentence', () => {
    const out = run(['material'], { material: { where: 'outdoors / UV' } }, 'part');
    assert.deepStrictEqual(out.lines, [
      'ENVIRONMENT: this lives outdoors / UV. Do not assume PLA, and design the geometry so it does not depend on the part staying perfectly stiff.',
    ]);
  });

  check('printing fully filled takes the three-field rule', () => {
    const out = run(['printing'], { printing: FULL.printing }, 'part');
    assert.deepStrictEqual(out.lines, [
      'PRINTING: 0.4 mm nozzle, 0.2 mm layers, design so none are needed. Every wall and every raised or cut detail must be a whole multiple of the nozzle width, and no unsupported overhang may exceed 45° unless supports were allowed.',
    ]);
  });

  check('quantity count+arrange takes the plate sentence; count alone does not', () => {
    assert.deepStrictEqual(
      run(['quantity'], { quantity: { count: '4', arrange: true } }, 'part').lines,
      ['QUANTITY: 4 of these. Expose the count as a variable and arrange that many copies on the plate with a few millimetres between them, so one render is one print.']
    );
    assert.deepStrictEqual(
      run(['quantity'], { quantity: { count: '4' } }, 'part').lines,
      ['QUANTITY: 4 of these. Expose the count as a variable.']
    );
  });

  check('text alone takes the engrave-it default sentence', () => {
    const out = run(['text'], { text: { text: 'WORKSHOP' } }, 'part');
    assert.deepStrictEqual(out.lines, [
      'TEXT: the part carries the text "WORKSHOP". Engrave it 0.6–1 mm deep with strokes at least 0.9 mm wide.',
    ]);
  });

  // ── compile: when [], equals, unknown action ───────────────────────────

  console.log('[compile — when: [], equals, and unknown actions]');

  const SYN = {
    id: 'syn',
    label: 'Synthetic',
    fields: [{ id: 'f1', label: 'F1', kind: 'text' }, { id: 'n', label: 'N', kind: 'number' }],
    lines: [{ when: [], text: 'ALWAYS ON' }],
    imageWords: [{ when: [], text: 'always-word' }, { text: 'no-when-key-word' }],
    flags: [
      { when: [], action: 'transmogrify', args: ['--never-seen'] },
      { when: [], action: 'mesh', args: ['--ok'] },
      { when: ['n'], equals: { n: 5 }, action: 'prep', args: ['--n-five'] },
    ],
  };

  check('when: [] fires whenever the tool is on (with at least one value)', () => {
    const out = compile({ tools: [SYN], enabled: ['syn'], values: { syn: { f1: 'x' } }, target: 'part' });
    assert.deepStrictEqual(out.lines, ['ALWAYS ON']);
  });

  check('a rule with no when key at all behaves as when: []', () => {
    const out = compile({ tools: [SYN], enabled: ['syn'], values: { syn: { f1: 'x' } }, target: 'part' });
    assert.deepStrictEqual(out.imageWords, ['always-word', 'no-when-key-word']);
  });

  check('an unknown flag action is ignored, not thrown on, and invents no key', () => {
    const out = compile({ tools: [SYN], enabled: ['syn'], values: { syn: { f1: 'x' } }, target: 'part' });
    assert.deepStrictEqual(Object.keys(out.flags).sort(), ['checkpoint', 'images', 'mesh', 'prep']);
    assert.deepStrictEqual(out.flags.mesh, ['--ok']);
  });

  check('equals coerces both sides to text: numeric 5 matches the string "5"', () => {
    const out = compile({ tools: [SYN], enabled: ['syn'], values: { syn: { n: '5' } }, target: 'part' });
    assert.deepStrictEqual(out.flags.prep, ['--n-five']);
    const miss = compile({ tools: [SYN], enabled: ['syn'], values: { syn: { n: '6' } }, target: 'part' });
    assert.deepStrictEqual(miss.flags.prep, []);
  });

  check("detail's equals rules: draft → 60000 target faces, and only that one fires", () => {
    const out = run(['detail'], { detail: { level: 'draft (fast)' } }, 'sculpt');
    assert.deepStrictEqual(out.flags.prep, ['--target-faces', '60000']);
    assert.deepStrictEqual(out.lines, []);
    assert.deepStrictEqual(out.chips, [{ toolId: 'detail', label: 'Mesh detail', text: 'draft (fast)' }]);
  });

  check('detail: standard → 150000', () => {
    assert.deepStrictEqual(
      run(['detail'], { detail: { level: 'standard' } }, 'sculpt').flags.prep,
      ['--target-faces', '150000']
    );
  });

  check('detail: fine → 400000', () => {
    assert.deepStrictEqual(
      run(['detail'], { detail: { level: 'fine (slow)' } }, 'sculpt').flags.prep,
      ['--target-faces', '400000']
    );
  });

  check('detail with a level no equals rule names emits no flag but still chips', () => {
    const out = run(['detail'], { detail: { level: 'bogus' } }, 'sculpt');
    assert.deepStrictEqual(out.flags.prep, []);
    assert.strictEqual(out.chips.length, 1);
  });

  // ── compile: all matches apply on imageWords and flags ─────────────────

  console.log('[compile — all matches apply]');

  check('style fully filled: ONE line but THREE image words', () => {
    const out = run(['style'], { style: FULL.style }, 'part');
    assert.deepStrictEqual(out.lines, ['STYLE: geometric, matte surface, in the spirit of mid-century Danish.']);
    assert.deepStrictEqual(out.imageWords, [
      'geometric form language',
      'matte surface',
      'in the spirit of mid-century Danish',
    ]);
  });

  check('colour feeds all three channels from one field', () => {
    const out = run(['colour'], { colour: { name: 'Peru' } }, 'part');
    assert.deepStrictEqual(out.lines, ['COLOUR: tag the model Peru so it reads clearly in the viewport.']);
    assert.deepStrictEqual(out.imageWords, ['in Peru']);
    assert.deepStrictEqual(out.flags.checkpoint, ['--color', 'Peru']);
  });

  check('text contributes its image words alongside its line', () => {
    const out = run(['text'], { text: { text: 'WORKSHOP' } }, 'part');
    assert.deepStrictEqual(out.imageWords, ['with the text "WORKSHOP" on it']);
  });

  check('flags accumulate across several tools into their own actions', () => {
    const out = run(
      ['dimensions', 'colour', 'detail'],
      { dimensions: { z: '12' }, colour: { name: 'Peru' }, detail: { level: 'standard' } },
      'sculpt'
    );
    assert.deepStrictEqual(out.flags, {
      images: [],
      mesh: ['--size-mm', '12'],
      prep: ['--target-faces', '150000'],
      checkpoint: ['--color', 'Peru'],
    });
  });

  // ── compile: skipped, tracks, ordering ─────────────────────────────────

  console.log('[compile — skipped, tracks, catalog order]');

  check('a tool switched on with nothing typed contributes nothing and says why', () => {
    const out = run(['quantity'], {}, 'part');
    assert.deepStrictEqual(out.lines, []);
    assert.deepStrictEqual(out.imageWords, []);
    assert.deepStrictEqual(out.chips, []);
    assert.deepStrictEqual(out.flags, { images: [], mesh: [], prep: [], checkpoint: [] });
    assert.deepStrictEqual(out.skipped, [{ toolId: 'quantity', reason: 'nothing filled in yet' }]);
  });

  check('values for only unknown fields count as nothing typed', () => {
    const out = run(['quantity'], { quantity: { bogus: '9' } }, 'part');
    assert.deepStrictEqual(out.skipped, [{ toolId: 'quantity', reason: 'nothing filled in yet' }]);
  });

  check('a part-only tool is skipped on the sculpt track with the track reason', () => {
    const out = run(['hardware'], { hardware: { thread: 'M4' } }, 'sculpt');
    assert.deepStrictEqual(out.lines, []);
    assert.deepStrictEqual(out.chips, []);
    assert.deepStrictEqual(out.skipped, [{ toolId: 'hardware', reason: 'not used when making sculpts' }]);
  });

  check('the same tool on the image track says "images", not "images s"', () => {
    const out = run(['hardware'], { hardware: { thread: 'M4' } }, 'image');
    assert.deepStrictEqual(out.skipped, [{ toolId: 'hardware', reason: 'not used when making images' }]);
  });

  check('a sculpt-only tool on the part track is skipped too', () => {
    const out = run(['detail'], { detail: { level: 'standard' } }, 'part');
    assert.deepStrictEqual(out.skipped, [{ toolId: 'detail', reason: 'not used when making parts' }]);
    assert.deepStrictEqual(out.flags.prep, []);
  });

  check('the track check outranks the empty check — the reason is the track, not the emptiness', () => {
    const out = run(['hardware'], {}, 'sculpt');
    assert.deepStrictEqual(out.skipped, [{ toolId: 'hardware', reason: 'not used when making sculpts' }]);
  });

  check("no target given defaults to 'part'", () => {
    const out = run(['hardware', 'detail'], { hardware: { thread: 'M4' }, detail: { level: 'standard' } }, undefined);
    assert.deepStrictEqual(out.lines, [
      'HARDWARE: M4. Take the diameter and clearance from the FITS SCREWS AND PARTS tables, not from memory.',
    ]);
    assert.deepStrictEqual(out.skipped, [{ toolId: 'detail', reason: 'not used when making parts' }]);
  });

  check('output follows CATALOG order, not click order', () => {
    const out = run(
      ['colour', 'style', 'dimensions'], // clicked backwards
      { colour: { name: 'Peru' }, style: { form: 'geometric' }, dimensions: { x: '40' } },
      'part'
    );
    assert.deepStrictEqual(out.chips.map((c) => c.toolId), ['dimensions', 'style', 'colour']);
    assert.deepStrictEqual(out.lines, [
      'WIDTH: 40 mm. Contractual; expose it as a variable.',
      'STYLE: geometric.',
      'COLOUR: tag the model Peru so it reads clearly in the viewport.',
    ]);
    assert.deepStrictEqual(out.imageWords, ['geometric form language', 'in Peru']);
  });

  check('an enabled id the catalog does not know is ignored entirely — not even skipped', () => {
    assert.deepStrictEqual(run(['flux-capacitor'], {}, 'part'), emptyResult());
  });

  check('values for tools that are not enabled are ignored', () => {
    assert.deepStrictEqual(run([], clone(FULL), 'part'), emptyResult());
  });

  check('compile with no input at all returns the empty result shape', () => {
    assert.deepStrictEqual(compile(), emptyResult());
    assert.deepStrictEqual(compile({}), emptyResult());
    assert.deepStrictEqual(compile({ tools: 'nope', enabled: 42, values: null, target: 7 }), emptyResult());
  });

  // ── compile: the full studio, both tracks, end to end ──────────────────

  console.log('[compile — every tool filled, part and sculpt tracks]');

  check('part track: 12 tools contribute, detail alone is skipped for the track', () => {
    const out = run(ALL_TOOL_IDS, clone(FULL), 'part');
    assert.strictEqual(out.lines.length, 12, `lines: ${JSON.stringify(out.lines)}`);
    assert.strictEqual(out.lines[0], 'SIZE: 40 × 25 × 12 mm, measured outside. These numbers are contractual — expose them as named variables at the top of the file and do not round them to nicer values.');
    assert.strictEqual(out.lines[9], 'QUANTITY: 4 of these. Expose the count as a variable and arrange that many copies on the plate with a few millimetres between them, so one render is one print.');
    assert.strictEqual(out.lines[11], 'COLOUR: tag the model Peru so it reads clearly in the viewport.');
    assert.deepStrictEqual(out.imageWords, [
      'with the text "WORKSHOP" on it',
      'geometric form language',
      'matte surface',
      'in the spirit of mid-century Danish',
      'in Peru',
    ]);
    assert.deepStrictEqual(out.flags, {
      images: [],
      mesh: ['--size-mm', '12'],
      prep: [],
      checkpoint: ['--color', 'Peru'],
    });
    assert.deepStrictEqual(out.chips.map((c) => c.toolId), [
      'dimensions', 'hardware', 'fit', 'mounting', 'existing-part', 'text',
      'strength', 'material', 'printing', 'quantity', 'style', 'colour',
    ]);
    assert.deepStrictEqual(out.skipped, [{ toolId: 'detail', reason: 'not used when making parts' }]);
  });

  check('sculpt track: only dimensions, style, colour, detail contribute; nine part tools skip', () => {
    const out = run(ALL_TOOL_IDS, clone(FULL), 'sculpt');
    assert.deepStrictEqual(out.lines, [
      'SIZE: 40 × 25 × 12 mm, measured outside. These numbers are contractual — expose them as named variables at the top of the file and do not round them to nicer values.',
      'STYLE: geometric, matte surface, in the spirit of mid-century Danish.',
      'COLOUR: tag the model Peru so it reads clearly in the viewport.',
    ]);
    assert.deepStrictEqual(out.flags, {
      images: [],
      mesh: ['--size-mm', '12'],
      prep: ['--target-faces', '150000'],
      checkpoint: ['--color', 'Peru'],
    });
    assert.deepStrictEqual(out.chips.map((c) => c.toolId), ['dimensions', 'style', 'colour', 'detail']);
    assert.deepStrictEqual(out.skipped, [
      { toolId: 'hardware', reason: 'not used when making sculpts' },
      { toolId: 'fit', reason: 'not used when making sculpts' },
      { toolId: 'mounting', reason: 'not used when making sculpts' },
      { toolId: 'existing-part', reason: 'not used when making sculpts' },
      { toolId: 'text', reason: 'not used when making sculpts' },
      { toolId: 'strength', reason: 'not used when making sculpts' },
      { toolId: 'material', reason: 'not used when making sculpts' },
      { toolId: 'printing', reason: 'not used when making sculpts' },
      { toolId: 'quantity', reason: 'not used when making sculpts' },
    ]);
  });

  // ── compile: purity ────────────────────────────────────────────────────

  console.log('[compile — purity]');

  const FROZEN_INPUT = deepFreeze({
    tools: clone(catalog.tools),
    enabled: clone(ALL_TOOL_IDS),
    values: clone(FULL),
    target: 'part',
  });

  check('a deep-frozen input is never written to (strict-mode ESM would throw)', () => {
    assert.doesNotThrow(() => compile(FROZEN_INPUT));
  });

  check('the same input twice produces a deep-equal output', () => {
    assert.deepStrictEqual(compile(FROZEN_INPUT), compile(FROZEN_INPUT));
  });

  check('the two outputs are separate objects, not one shared instance', () => {
    const a = compile(FROZEN_INPUT);
    const b = compile(FROZEN_INPUT);
    assert.notStrictEqual(a, b);
    assert.notStrictEqual(a.lines, b.lines);
    assert.notStrictEqual(a.flags, b.flags);
    assert.notStrictEqual(a.flags.mesh, b.flags.mesh);
  });

  check('a mutable input — tools, values and enabled — is byte-for-byte unchanged', () => {
    const input = {
      tools: clone(catalog.tools),
      enabled: clone(ALL_TOOL_IDS),
      values: clone(FULL),
      target: 'sculpt',
    };
    const before = JSON.stringify(input);
    compile(input);
    assert.strictEqual(JSON.stringify(input), before);
  });

  // ── summarise ──────────────────────────────────────────────────────────

  console.log('[summarise — the chip body]');

  check('values joined with a middot, units appended, choices verbatim', () => {
    assert.strictEqual(
      summarise(tool('dimensions'), { x: '40', y: '25', z: '12', ref: 'outside' }),
      '40 mm · 25 mm · 12 mm · outside'
    );
  });

  check('a toggle shows its label lowercased, not "yes"', () => {
    assert.strictEqual(
      summarise(tool('mounting'), { style: 'clamps on', countersink: true }),
      'clamps on · countersunk heads'
    );
  });

  check('a false toggle and empty fields contribute nothing', () => {
    assert.strictEqual(summarise(tool('mounting'), { countersink: false }), '');
    assert.strictEqual(summarise(tool('dimensions'), {}), '');
    assert.strictEqual(summarise(tool('dimensions'), null), '');
    assert.strictEqual(summarise(null, { x: '1' }), '');
  });

  check('a chip label falls back to the tool id when there is no label', () => {
    const bare = { id: 'nameless', fields: [{ id: 'f', label: 'F', kind: 'text' }] };
    const out = compile({ tools: [bare], enabled: ['nameless'], values: { nameless: { f: 'v' } }, target: 'part' });
    assert.deepStrictEqual(out.chips, [{ toolId: 'nameless', label: 'nameless', text: 'v' }]);
  });

  // ── composeBrief ───────────────────────────────────────────────────────

  console.log('[composeBrief — block order, user text last]');

  check('the five blocks assemble in contract order with the user text LAST', () => {
    const brief = composeBrief({
      preamble: 'PREAMBLE.',
      categoryPrompt: 'CATEGORY: TEST.',
      lines: ['SIZE: 40 mm.', 'STRENGTH: real load.'],
      prompt: 'a wall hook',
      attachments: ['uploads/ref.png', 'uploads/scan.stl'],
    });
    assert.strictEqual(
      brief,
      'PREAMBLE.\n\n' +
        'CATEGORY: TEST.\n\n' +
        'SIZE: 40 mm.\nSTRENGTH: real load.\n\n' +
        'ATTACHED (already in this workspace — read them before you start):\n- uploads/ref.png\n- uploads/scan.stl\n\n' +
        'a wall hook'
    );
  });

  check('empty blocks vanish without leaving blank seams', () => {
    assert.strictEqual(composeBrief({ prompt: 'just this' }), 'just this');
    assert.strictEqual(composeBrief({ preamble: 'P', prompt: 'U' }), 'P\n\nU');
    assert.strictEqual(composeBrief({ lines: [], attachments: [], prompt: 'U' }), 'U');
    assert.strictEqual(composeBrief({}), '');
  });

  check('falsy lines and attachments are filtered, not printed as holes', () => {
    assert.strictEqual(composeBrief({ lines: ['L1', '', null], prompt: 'U' }), 'L1\n\nU');
    assert.strictEqual(
      composeBrief({ attachments: ['a.png', null, ''], prompt: 'U' }),
      'ATTACHED (already in this workspace — read them before you start):\n- a.png\n\nU'
    );
  });

  check('whitespace-only preamble and prompt count as absent; kept text is trimmed', () => {
    assert.strictEqual(composeBrief({ preamble: '   ', prompt: '  ' }), '');
    assert.strictEqual(composeBrief({ prompt: '  hi  ' }), 'hi');
  });

  // ── composeImagePrompt ─────────────────────────────────────────────────

  console.log('[composeImagePrompt — a different, cleaner string]');

  check('subject plus look words, comma-joined', () => {
    assert.strictEqual(
      composeImagePrompt({ prompt: 'a squat dragon', imageWords: ['organic / flowing form language', 'matte surface'] }),
      'a squat dragon, organic / flowing form language, matte surface'
    );
  });

  check('no words → just the subject; no subject → just the words; neither → empty', () => {
    assert.strictEqual(composeImagePrompt({ prompt: 'a squat dragon', imageWords: [] }), 'a squat dragon');
    assert.strictEqual(composeImagePrompt({ prompt: '', imageWords: ['matte surface', 'in Peru'] }), 'matte surface, in Peru');
    assert.strictEqual(composeImagePrompt({}), '');
  });

  check('junk words are filtered and kept ones trimmed', () => {
    assert.strictEqual(composeImagePrompt({ prompt: '', imageWords: [null, '', '  x  '] }), 'x');
  });

  check('brief ≠ image prompt for the same compiled input', () => {
    const out = run(['dimensions', 'quantity', 'style'], { dimensions: { x: '40' }, quantity: { count: '4' }, style: { form: 'geometric' } }, 'part');
    const brief = composeBrief({ categoryPrompt: 'CATEGORY: TEST.', lines: out.lines, prompt: 'a low table' });
    const image = composeImagePrompt({ prompt: 'a low table', imageWords: out.imageWords });
    assert.notStrictEqual(brief, image);
    assert.strictEqual(image, 'a low table, geometric form language');
  });

  check('the image prompt carries no constraint language, even with every tool filled', () => {
    const out = run(ALL_TOOL_IDS, clone(FULL), 'part');
    const image = composeImagePrompt({ prompt: 'a wall hook', imageWords: out.imageWords });
    assert.strictEqual(
      image,
      'a wall hook, with the text "WORKSHOP" on it, geometric form language, matte surface, in the spirit of mid-century Danish, in Peru'
    );
    assert.ok(
      !/variable|contractual|expose|clearance|comment|tables|SIZE:|HARDWARE:|FIT:|MOUNTING:|STRENGTH:|PRINTING:|QUANTITY:/i.test(image),
      `constraint language leaked into the image prompt: ${image}`
    );
  });

  // ── catalog integrity — the block that pays for itself ─────────────────
  // A typo in tools.json silently drops a user's constraint; nothing else in
  // the suite would catch it. The RULES here are fixed; only the data walks.

  console.log('[catalog integrity — presets/tools.json vs categories.json]');

  check('the catalog ships exactly the thirteen expected tools, ids unique', () => {
    const ids = catalog.tools.map((t) => t.id);
    assert.deepStrictEqual(ids, ALL_TOOL_IDS);
    assert.strictEqual(new Set(ids).size, ids.length, 'tool ids are unique');
  });

  check('the four expected groups exist, ids unique', () => {
    assert.deepStrictEqual(catalog.groups.map((g) => g.id), ['geometry', 'fit', 'making', 'look']);
    assert.ok(catalog.groups.every((g) => typeof g.label === 'string' && g.label.length), 'every group has a label');
  });

  check("every tool's group names a declared group", () => {
    const groupIds = new Set(catalog.groups.map((g) => g.id));
    for (const t of catalog.tools) {
      assert.ok(groupIds.has(t.group), `${t.id}: group "${t.group}" is not in groups`);
    }
  });

  check('every tool has a label and a hint, and field ids are unique per tool', () => {
    for (const t of catalog.tools) {
      assert.ok(typeof t.label === 'string' && t.label.length, `${t.id} has a label`);
      assert.ok(typeof t.hint === 'string' && t.hint.length, `${t.id} has a hint`);
      const fieldIds = (t.fields || []).map((f) => f.id);
      assert.ok(fieldIds.every((id) => typeof id === 'string' && id.length), `${t.id}: every field has an id`);
      assert.strictEqual(new Set(fieldIds).size, fieldIds.length, `${t.id}: field ids are unique`);
    }
  });

  check('every field kind is number | text | choice | toggle; choice defaults are real options', () => {
    const KINDS = ['number', 'text', 'choice', 'toggle'];
    for (const t of catalog.tools) {
      for (const f of t.fields || []) {
        assert.ok(KINDS.includes(f.kind), `${t.id}.${f.id}: kind "${f.kind}"`);
        if (f.kind === 'choice') {
          assert.ok(Array.isArray(f.options) && f.options.length, `${t.id}.${f.id}: choice has options`);
          assert.ok(f.options.every((o) => typeof o === 'string' && o.length), `${t.id}.${f.id}: options are strings`);
          if (f.default !== undefined) {
            assert.ok(f.options.includes(f.default), `${t.id}.${f.id}: default "${f.default}" is not an option`);
          }
        }
      }
    }
  });

  check('every targets entry is part | sculpt | image', () => {
    for (const t of catalog.tools) {
      for (const target of t.targets || []) {
        assert.ok(['part', 'sculpt', 'image'].includes(target), `${t.id}: target "${target}"`);
      }
    }
  });

  const placeholdersIn = (text) => {
    const out = [];
    const re = /\{(\w[\w-]*)\}/g;
    let m;
    while ((m = re.exec(String(text))) !== null) out.push(m[1]);
    return out;
  };

  check('every when id, equals key and {placeholder} names a field the tool declares', () => {
    for (const t of catalog.tools) {
      const fieldIds = new Set((t.fields || []).map((f) => f.id));
      const rules = [
        ...(t.lines || []).map((r) => ['lines', r]),
        ...(t.imageWords || []).map((r) => ['imageWords', r]),
        ...(t.flags || []).map((r) => ['flags', r]),
      ];
      for (const [kind, rule] of rules) {
        for (const id of rule.when || []) {
          assert.ok(fieldIds.has(id), `${t.id} ${kind}: when "${id}" is not a declared field`);
        }
        for (const id of Object.keys(rule.equals || {})) {
          assert.ok(fieldIds.has(id), `${t.id} ${kind}: equals "${id}" is not a declared field`);
        }
        for (const id of placeholdersIn(rule.text || '')) {
          assert.ok(fieldIds.has(id), `${t.id} ${kind}: {${id}} is not a declared field`);
        }
        for (const arg of rule.args || []) {
          for (const id of placeholdersIn(arg)) {
            assert.ok(fieldIds.has(id), `${t.id} ${kind}: arg {${id}} is not a declared field`);
          }
        }
      }
    }
  });

  check('every flags[].action is one of the four ACTIONS, and args are string arrays', () => {
    for (const t of catalog.tools) {
      for (const rule of t.flags || []) {
        assert.ok(
          ['images', 'mesh', 'prep', 'checkpoint'].includes(rule.action),
          `${t.id}: flag action "${rule.action}" is not in ACTIONS`
        );
        assert.ok(Array.isArray(rule.args) && rule.args.length, `${t.id}: flag rule has args`);
        assert.ok(rule.args.every((a) => typeof a === 'string'), `${t.id}: flag args are strings`);
      }
    }
  });

  check('the taxonomy still has the ten shipped categories', () => {
    assert.deepStrictEqual(
      taxonomy.categories.map((c) => c.id).sort(),
      ['bracket', 'decor', 'enclosure', 'furniture', 'hardware', 'model', 'other', 'replacement', 'structural', 'toy']
    );
  });

  check("every auto entry names a real category in categories.json (or is '*')", () => {
    const categoryIds = new Set(taxonomy.categories.map((c) => c.id));
    for (const t of catalog.tools) {
      if (t.auto === '*' || t.auto === undefined) continue;
      assert.ok(Array.isArray(t.auto), `${t.id}: auto is an array or '*'`);
      for (const id of t.auto) {
        assert.ok(categoryIds.has(id), `${t.id}: auto "${id}" is not a category`);
      }
    }
  });

  check('every lines rule is reachable — no rule shadowed dead by an earlier one', () => {
    // Independent re-implementation of the matcher on purpose: filling exactly
    // a rule's own when set must make that rule the first match, or the rule
    // can never fire for any input and is dead weight in the file.
    for (const t of catalog.tools) {
      const rules = t.lines || [];
      rules.forEach((rule, i) => {
        const values = {};
        for (const id of rule.when || []) values[id] = 'x';
        for (const [id, v] of Object.entries(rule.equals || {})) values[id] = String(v);
        const winner = rules.findIndex((r) => {
          const when = Array.isArray(r.when) ? r.when : [];
          if (!when.every((id) => values[id])) return false;
          return Object.entries(r.equals || {}).every(([id, v]) => String(values[id] || '') === String(v));
        });
        assert.strictEqual(winner, i, `${t.id} lines[${i}] is shadowed by lines[${winner}]`);
      });
    }
  });

  check('every flags and imageWords rule is reachable the same way', () => {
    for (const t of catalog.tools) {
      for (const key of ['flags', 'imageWords']) {
        for (const rule of t[key] || []) {
          const values = {};
          for (const id of rule.when || []) values[id] = 'x';
          for (const [id, v] of Object.entries(rule.equals || {})) values[id] = String(v);
          const when = Array.isArray(rule.when) ? rule.when : [];
          const fires =
            when.every((id) => values[id]) &&
            Object.entries(rule.equals || {}).every(([id, v]) => String(values[id] || '') === String(v));
          assert.ok(fires, `${t.id} ${key} rule is self-contradictory: ${JSON.stringify(rule)}`);
        }
      }
    }
  });

  // ── summary ────────────────────────────────────────────────────────────

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) {
    process.exitCode = 1;
    // stdout to a pipe is async on Windows — flush before the hard exit or
    // the failure lines never reach the terminal.
    process.stdout.write('', () => process.exit(1));
  }
})().catch((err) => {
  console.error('FAIL — the tools harness itself threw');
  console.error(err && err.stack ? err.stack : err);
  process.exitCode = 1;
  process.stdout.write('', () => process.exit(1));
});
