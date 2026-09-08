#!/usr/bin/env node
/**
 * Standalone harness (no Electron, no Playwright) for renderer/route.js —
 * the pure routing engine behind the guided-make flow (v0.4 contracts §P7).
 *
 * renderer/route.js is an ES module (`export function ...`), same idiom as its
 * siblings renderer/bus.js and renderer/composer.js, because it is bundled
 * into dist/renderer.js by esbuild (--format=esm). This harness is CommonJS,
 * so the module is loaded with a dynamic import() — the real file, not a
 * transformed copy, so the harness can never drift onto a stale source.
 *
 * The scores asserted below are written as literals on purpose. Nothing here
 * derives an expectation from SIGNALS: if a delta, a lexicon or the threshold
 * moves, these numbers go red rather than moving with it.
 *
 * Run: node tests/route.js
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const CATEGORIES_PATH = path.join(__dirname, '..', 'presets', 'categories.json');

(async () => {
  const { decideRoute, explain, SIGNALS } = await import('../renderer/route.js');

  const taxonomy = JSON.parse(fs.readFileSync(CATEGORIES_PATH, 'utf-8'));
  const cat = (id) => {
    const found = taxonomy.categories.find((c) => c.id === id);
    assert.ok(found, `categories.json has no "${id}"`);
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

  // A synthetic `auto` category with bias 0 — every signal is measured against
  // it in isolation, so a change to real taxonomy numbers can never mask a
  // broken scoring rule (and vice versa).
  const AUTO = {
    id: 'probe',
    label: 'Probe',
    route: 'auto',
    target: 'sculpt',
    target_direct: 'part',
    presets: ['p-one', 'p-two'],
    confirm: 'images',
    bias: 0,
    ask: [
      { id: 'num', label: 'Count', kind: 'number', unit: 'mm' },
      { id: 'pick', label: 'Kind', kind: 'choice', options: ['alpha', 'beta'] },
      { id: 'free', label: 'Notes', kind: 'text' },
    ],
  };

  const biased = (bias) => Object.assign({}, AUTO, { bias });

  // score of a prompt against the neutral probe category
  const s = (prompt, extra) =>
    decideRoute(Object.assign({ category: AUTO, prompt, answers: {}, attachments: [] }, extra)).score;

  // ── contract shape ─────────────────────────────────────────────────────

  console.log('[decision shape]');

  const DECISION_KEYS = [
    'confirmMode', 'forced', 'missing', 'presets', 'reasons', 'route', 'score', 'target',
  ];

  check('a decision carries exactly the eight contract keys', () => {
    const d = decideRoute({ category: cat('hardware'), prompt: 'M4 standoff 20mm', answers: {}, attachments: [] });
    assert.deepStrictEqual(Object.keys(d).sort(), DECISION_KEYS);
  });

  check('every field has its contract type', () => {
    const d = decideRoute({ category: cat('decor'), prompt: 'an owl planter', answers: {}, attachments: [] });
    assert.ok(d.route === 'direct' || d.route === 'confirm', 'route is direct|confirm');
    assert.ok(['part', 'sculpt', 'image'].includes(d.target), 'target is part|sculpt|image');
    assert.ok(Array.isArray(d.presets) && d.presets.every((p) => typeof p === 'string'));
    assert.ok(['none', 'images', 'photo', 'both'].includes(d.confirmMode));
    assert.strictEqual(typeof d.score, 'number');
    assert.ok(Number.isInteger(d.score) && d.score >= 0 && d.score <= 100, 'score is 0-100');
    assert.ok(Array.isArray(d.reasons) && d.reasons.every((r) => typeof r === 'string' && r.length));
    assert.ok(Array.isArray(d.missing) && d.missing.every((m) => typeof m === 'string' && m.length));
    assert.strictEqual(typeof d.forced, 'boolean');
  });

  check('SIGNALS is exported, frozen, and declares all seven rules', () => {
    assert.ok(Array.isArray(SIGNALS));
    assert.ok(Object.isFrozen(SIGNALS), 'SIGNALS is frozen');
    assert.deepStrictEqual(
      SIGNALS.map((x) => x.id).sort(),
      ['choice', 'compound', 'dimension', 'geometry', 'organic', 'simple', 'unseen']
    );
    for (const sig of SIGNALS) {
      assert.strictEqual(typeof sig.delta, 'number', `${sig.id} declares a delta`);
      assert.ok(typeof sig.label === 'string' && sig.label.length, `${sig.id} declares a label`);
    }
  });

  // ── graceful / absent input ────────────────────────────────────────────

  console.log('[absent and malformed input]');

  const NULL_DECISION = {
    route: 'direct',
    target: 'part',
    presets: [],
    confirmMode: 'none',
    score: 50,
    reasons: [],
    missing: [],
    forced: false,
  };

  check('category: null returns the contract fallback verbatim', () => {
    assert.deepStrictEqual(
      decideRoute({ category: null, prompt: 'anything at all', answers: {}, attachments: [] }),
      NULL_DECISION
    );
  });

  check('no argument at all does not throw', () => {
    assert.deepStrictEqual(decideRoute(), NULL_DECISION);
  });

  check('an empty object does not throw', () => {
    assert.deepStrictEqual(decideRoute({}), NULL_DECISION);
  });

  check('a category id passed instead of the object degrades to the fallback', () => {
    assert.deepStrictEqual(decideRoute({ category: 'hardware' }), NULL_DECISION);
  });

  check('missing prompt scores as an empty description', () => {
    const d = decideRoute({ category: AUTO, answers: {}, attachments: [] });
    assert.strictEqual(d.score, 50);
    assert.strictEqual(d.route, 'confirm');
  });

  check('answers: undefined is treated as every field untouched', () => {
    assert.strictEqual(decideRoute({ category: AUTO, prompt: 'a thing' }).score, 50);
  });

  check('attachments: undefined is treated as no attachments', () => {
    assert.strictEqual(decideRoute({ category: AUTO, prompt: 'a thing', answers: {} }).score, 50);
  });

  check('junk in attachments is skipped, not thrown on', () => {
    const d = decideRoute({
      category: AUTO,
      prompt: 'a thing',
      answers: {},
      attachments: [null, 'nope', 42, {}, { kind: 'mesh' }],
    });
    assert.strictEqual(d.score, 65);
  });

  check('a non-string answer value does not throw', () => {
    const d = decideRoute({ category: AUTO, prompt: 'a thing', answers: { num: 20, pick: null } });
    assert.strictEqual(d.score, 70, 'a numeric 20 in a number field still counts');
  });

  check('a category with no ask array still scores', () => {
    const bare = { id: 'bare', route: 'auto', target: 'part', bias: 0 };
    const d = decideRoute({ category: bare, prompt: 'a bracket 40mm' });
    assert.strictEqual(d.score, 85);
    assert.deepStrictEqual(d.presets, []);
  });

  check('a category with no route is treated as auto, not as forced', () => {
    const bare = { id: 'bare', target: 'part', bias: 0 };
    const d = decideRoute({ category: bare, prompt: 'a thing' });
    assert.strictEqual(d.forced, false);
    assert.strictEqual(d.route, 'confirm');
  });

  // ── the neutral baseline every isolation test leans on ─────────────────

  console.log('[baseline]');

  check('the neutral probe scores exactly 50 + bias and nothing else', () => {
    assert.strictEqual(s('a thing'), 50);
    assert.strictEqual(decideRoute({ category: biased(25), prompt: 'a thing' }).score, 75);
    assert.strictEqual(decideRoute({ category: biased(-30), prompt: 'a thing' }).score, 20);
  });

  // ── every signal, in isolation ─────────────────────────────────────────

  console.log('[signals in isolation]');

  check('+20 — a dimension in the description', () => {
    assert.strictEqual(s('a thing 40mm'), 70);
  });

  check('+20 — a number-kind ask field with a value (bare number, no unit)', () => {
    assert.strictEqual(s('a thing', { answers: { num: '20' } }), 70);
  });

  check('+20 fires once, not twice, when both sources are present', () => {
    assert.strictEqual(s('a thing 40mm', { answers: { num: '20' } }), 70);
  });

  check('a number-kind field with no digits in it is not a value', () => {
    assert.strictEqual(s('a thing', { answers: { num: '   ' } }), 50);
    assert.strictEqual(s('a thing', { answers: { num: 'dunno' } }), 50);
  });

  check('+10 — a choice-kind ask field with a value', () => {
    assert.strictEqual(s('a thing', { answers: { pick: 'beta' } }), 60);
  });

  check('an untouched choice (empty, or the em-dash placeholder) scores nothing', () => {
    assert.strictEqual(s('a thing', { answers: { pick: '' } }), 50);
    assert.strictEqual(s('a thing', { answers: { pick: '—' } }), 50);
  });

  check('a text-kind field is neither the +20 nor the +10', () => {
    assert.strictEqual(s('a thing', { answers: { free: 'some prose' } }), 50);
  });

  check('a text-kind field that contains a real dimension does earn the +20', () => {
    assert.strictEqual(s('a thing', { answers: { free: '80 × 50 × 25' } }), 70);
  });

  check('+15 — the simple-object lexicon', () => {
    assert.strictEqual(s('a bracket'), 65);
  });

  check('−25 — the organic/aesthetic lexicon', () => {
    assert.strictEqual(s('a dragon'), 25);
  });

  check('−15 — something the app cannot see', () => {
    assert.strictEqual(s('my thing'), 35);
  });

  check('−15 is cancelled by an image attachment', () => {
    assert.strictEqual(s('my thing', { attachments: [{ name: 'p.jpg', kind: 'image' }] }), 50);
  });

  check('−15 is cancelled by a mesh attachment (which also earns its own +15)', () => {
    assert.strictEqual(s('my thing', { attachments: [{ name: 'p.stl', kind: 'mesh' }] }), 65);
  });

  check('a blocked attachment cancels nothing and earns nothing', () => {
    assert.strictEqual(s('my thing', { attachments: [{ name: 'x.exe', kind: 'blocked' }] }), 35);
  });

  check('−10 per clause beyond the second', () => {
    assert.strictEqual(s('one'), 50, '1 clause');
    assert.strictEqual(s('one, two'), 50, '2 clauses');
    assert.strictEqual(s('one, two, three'), 40, '3 clauses');
    assert.strictEqual(s('one, two, three, four'), 30, '4 clauses');
  });

  check('the clause penalty caps at −20', () => {
    assert.strictEqual(s('one, two, three, four, five'), 30);
    assert.strictEqual(s('one, two, three, four, five, six, seven, eight'), 30);
  });

  check('all four clause separators split — comma, semicolon, and, with', () => {
    assert.strictEqual(s('one, two, three'), 40);
    assert.strictEqual(s('one; two; three'), 40);
    assert.strictEqual(s('one and two and three'), 40);
    assert.strictEqual(s('one with two with three'), 40);
  });

  check('"and"/"with" only split as whole words — "sandwith" is one clause', () => {
    assert.strictEqual(s('one sandwithstand two'), 50);
  });

  check('+15 — mesh, scad or vector attachment', () => {
    assert.strictEqual(s('a thing', { attachments: [{ kind: 'mesh' }] }), 65);
    assert.strictEqual(s('a thing', { attachments: [{ kind: 'scad' }] }), 65);
    assert.strictEqual(s('a thing', { attachments: [{ kind: 'vector' }] }), 65);
  });

  check('an image attachment alone is not supplied geometry', () => {
    assert.strictEqual(s('a thing', { attachments: [{ kind: 'image' }] }), 50);
  });

  check('signals stack, and the total clamps to 100', () => {
    const d = decideRoute({
      category: biased(40),
      prompt: 'a bracket 40mm',
      answers: { num: '2', pick: 'beta' },
      attachments: [{ kind: 'mesh' }],
    });
    assert.strictEqual(d.score, 100, '50+40+20+10+15+15 = 150, clamped');
  });

  check('negatives stack, and the total clamps to 0', () => {
    const d = decideRoute({ category: biased(-40), prompt: 'my cute dragon, one, two, three' });
    assert.strictEqual(d.score, 0, '50-40-25-15-20 = -50, clamped');
  });

  // ── the auto threshold ────────────────────────────────────────────────

  console.log('[auto threshold at 59 / 60 / 61]');

  check('59 confirms', () => {
    const d = decideRoute({ category: biased(9), prompt: 'a thing' });
    assert.strictEqual(d.score, 59);
    assert.strictEqual(d.route, 'confirm');
    assert.strictEqual(d.forced, false);
  });

  check('60 is direct — the threshold is inclusive', () => {
    const d = decideRoute({ category: biased(10), prompt: 'a thing' });
    assert.strictEqual(d.score, 60);
    assert.strictEqual(d.route, 'direct');
  });

  check('61 is direct', () => {
    const d = decideRoute({ category: biased(11), prompt: 'a thing' });
    assert.strictEqual(d.score, 61);
    assert.strictEqual(d.route, 'direct');
  });

  check('direct takes target_direct, confirm takes target', () => {
    assert.strictEqual(decideRoute({ category: biased(10), prompt: 'a thing' }).target, 'part');
    assert.strictEqual(decideRoute({ category: biased(9), prompt: 'a thing' }).target, 'sculpt');
  });

  check('target falls back to `target` when target_direct is absent', () => {
    const noDirect = Object.assign({}, biased(10));
    delete noDirect.target_direct;
    assert.strictEqual(decideRoute({ category: noDirect, prompt: 'a thing' }).target, 'sculpt');
  });

  check("confirmMode is the category's on confirm and 'none' on direct", () => {
    assert.strictEqual(decideRoute({ category: biased(9), prompt: 'a thing' }).confirmMode, 'images');
    assert.strictEqual(decideRoute({ category: biased(10), prompt: 'a thing' }).confirmMode, 'none');
  });

  // ── the router never invents a preset ─────────────────────────────────

  console.log('[presets pass through untouched]');

  check("presets are the category's, in order, on both routes", () => {
    assert.deepStrictEqual(decideRoute({ category: biased(10), prompt: 'a thing' }).presets, ['p-one', 'p-two']);
    assert.deepStrictEqual(decideRoute({ category: biased(9), prompt: 'a thing' }).presets, ['p-one', 'p-two']);
  });

  check('presets are a copy — a consumer cannot corrupt the taxonomy', () => {
    const d = decideRoute({ category: AUTO, prompt: 'a thing' });
    assert.notStrictEqual(d.presets, AUTO.presets);
    d.presets.push('injected');
    assert.deepStrictEqual(AUTO.presets, ['p-one', 'p-two']);
  });

  // ── every category's forced route ─────────────────────────────────────

  console.log('[forced routes — every category in the taxonomy]');

  check('the taxonomy still has the ten shipped categories', () => {
    assert.strictEqual(taxonomy.categories.length, 10);
  });

  for (const category of taxonomy.categories) {
    check(`${category.id} (route: ${category.route}) resolves as declared`, () => {
      const d = decideRoute({ category, prompt: 'anything', answers: {}, attachments: [] });
      if (category.route === 'auto') {
        assert.strictEqual(d.forced, false, 'auto is scored, never forced');
      } else {
        assert.strictEqual(d.forced, true, 'an absolute route is forced');
        assert.strictEqual(d.route, category.route);
        assert.strictEqual(d.confirmMode, category.route === 'confirm' ? category.confirm : 'none');
        assert.strictEqual(
          d.target,
          category.route === 'direct' ? category.target_direct || category.target : category.target
        );
        assert.deepStrictEqual(d.presets, category.presets);
        assert.ok(d.reasons.length > 0, 'a forced route still says why');
      }
    });
  }

  check('a forced route ignores every signal that would have flipped it', () => {
    // hardware is absolute-direct: the most organic, most unseeable, most
    // compound description in the world must still go straight through.
    const d = decideRoute({
      category: cat('hardware'),
      prompt: 'my ornate cute dragon figurine, flowing, decorative, stylised',
      answers: {},
      attachments: [],
    });
    assert.strictEqual(d.route, 'direct');
    assert.strictEqual(d.forced, true);
  });

  check('a forced route reports absolute confidence, not a scored number', () => {
    assert.strictEqual(decideRoute({ category: cat('hardware'), prompt: 'x' }).score, 100);
    assert.strictEqual(decideRoute({ category: cat('model'), prompt: 'x' }).score, 0);
  });

  // ── the eight end-to-end cases from the contract table ────────────────

  console.log('[contract §P7 end-to-end table]');

  const TABLE = [
    // NB: the contract's table annotates only row 2 as "(forced)", but
    // `hardware` is route:"direct" in the taxonomy, so row 1 is forced too —
    // the resolved route is what the table asserts, and both rows agree.
    ['hardware', 'M4 standoff 20mm', 'direct', true],
    ['hardware', 'something to hold the thing', 'direct', true],
    ['furniture', 'a 30mm round knob with an M4 insert', 'direct', false],
    ['furniture', 'a mid-century tapered table leg with fluting', 'confirm', false],
    ['decor', 'a 90mm round coaster, 4mm thick', 'direct', false],
    ['decor', 'an owl planter with big round eyes', 'confirm', false],
    ['model', 'anything', 'confirm', true],
    ['replacement', 'anything', 'confirm', true],
  ];

  for (const [id, prompt, route, forced] of TABLE) {
    check(`${id} · "${prompt}" → ${route}${forced ? ' (forced)' : ''}`, () => {
      const d = decideRoute({ category: cat(id), prompt, answers: {}, attachments: [] });
      assert.strictEqual(d.route, route);
      assert.strictEqual(d.forced, forced);
    });
  }

  check('replacement/anything confirms with a photo, on the part track', () => {
    const d = decideRoute({ category: cat('replacement'), prompt: 'anything', answers: {}, attachments: [] });
    assert.strictEqual(d.confirmMode, 'photo');
    assert.strictEqual(d.target, 'part');
  });

  check('model/anything confirms with images, on the sculpt track', () => {
    const d = decideRoute({ category: cat('model'), prompt: 'anything', answers: {}, attachments: [] });
    assert.strictEqual(d.confirmMode, 'images');
    assert.strictEqual(d.target, 'sculpt');
  });

  check('the coaster is direct on the PART track — target_direct, not target', () => {
    const d = decideRoute({ category: cat('decor'), prompt: 'a 90mm round coaster, 4mm thick' });
    assert.strictEqual(d.score, 60, '50 - 10 bias + 20 dimension');
    assert.strictEqual(d.target, 'part');
  });

  check('the owl planter goes to sculpt with images', () => {
    const d = decideRoute({ category: cat('decor'), prompt: 'an owl planter with big round eyes' });
    assert.strictEqual(d.target, 'sculpt');
    assert.strictEqual(d.confirmMode, 'images');
    assert.ok(
      d.reasons.some((r) => r.includes("'owl'")),
      `reasons name the owl: ${JSON.stringify(d.reasons)}`
    );
  });

  check('the confirm→part flow: a described enclosure still lands on part', () => {
    const d = decideRoute({ category: cat('enclosure'), prompt: 'a curvy organic sculpted case' });
    assert.strictEqual(d.route, 'confirm');
    assert.strictEqual(d.target, 'part', 'the most valuable flow in the release');
  });

  // ── lexicon false-positive guards ─────────────────────────────────────

  console.log('[lexicon guards — word boundaries, plurals, spellings]');

  check('"pinion" is not "pin"', () => {
    assert.strictEqual(s('a pinion'), 50);
    assert.strictEqual(s('a pin'), 65);
    assert.strictEqual(s('two pins'), 65);
  });

  check('"boxer" is not "box"', () => {
    assert.strictEqual(s('a boxer'), 50);
    assert.strictEqual(s('a box'), 65);
    assert.strictEqual(s('two boxes'), 65);
  });

  check('"hooked on" is not "hook"', () => {
    assert.strictEqual(s('hooked on it'), 50);
    assert.strictEqual(s('a hook'), 65);
    assert.strictEqual(s('two hooks'), 65);
  });

  check('"mountain" is not "mount", "understand" is not "stand"', () => {
    assert.strictEqual(s('a mountain'), 50);
    assert.strictEqual(s('understand it'), 50);
    assert.strictEqual(s('a mount'), 65);
    assert.strictEqual(s('a stand'), 65);
  });

  check('"capacity" is not "cap", "discount" is not "disc", "spring" is not "ring"', () => {
    assert.strictEqual(s('the capacity of it'), 50);
    assert.strictEqual(s('a discount label'), 50);
    assert.strictEqual(s('a spring'), 50);
  });

  check('"template" matches once and is not caught by "plate"', () => {
    assert.strictEqual(s('a template'), 65);
    assert.strictEqual(s('a plate'), 65);
  });

  check('British and American spellings both match', () => {
    assert.strictEqual(s('an adaptor'), 65, 'adaptor');
    assert.strictEqual(s('an adapter'), 65, 'adapter');
    assert.strictEqual(s('a disc'), 65);
    assert.strictEqual(s('a disk'), 65);
    assert.strictEqual(s('stylised'), 25);
    assert.strictEqual(s('stylized'), 25);
  });

  check('"surface" and "the mating face" are not a sculpted face', () => {
    assert.strictEqual(s('the surface finish'), 50);
    assert.strictEqual(s('the mating face'), 50);
    assert.strictEqual(s('the flat face'), 50);
    assert.strictEqual(s('a carved face'), 25, 'a real face still scores');
  });

  check('the organic lexicon carries the abstract words and the concrete ones', () => {
    for (const word of ['figurine', 'statue', 'sculpture', 'bust', 'character', 'animal', 'creature', 'ornate', 'flowing', 'organic', 'cute', 'realistic']) {
      assert.strictEqual(s(`a ${word}`), 25, word);
    }
    for (const word of ['owl', 'dragon', 'elephant', 'unicorn', 'penguin', 'skull']) {
      assert.strictEqual(s(`an ${word}`), 25, word);
    }
  });

  check('"detailed model of" is matched as a phrase', () => {
    assert.strictEqual(s('a detailed model of it'), 25);
    assert.strictEqual(s('a model'), 50, '"model" alone is not the phrase');
  });

  check('the unseen lexicon matches the contract phrases and nothing near them', () => {
    assert.strictEqual(s('my part'), 35);
    assert.strictEqual(s('the broken part'), 35);
    assert.strictEqual(s('fits the panel'), 35);
    assert.strictEqual(s('replacement for it'), 35);
    assert.strictEqual(s('like the one there'), 35);
    assert.strictEqual(s('same as before'), 35);
    assert.strictEqual(s('myself'), 50, '"myself" is not "my"');
  });

  check('case and curly punctuation do not change a decision', () => {
    assert.strictEqual(s('MY BROKEN THING'), 35);
    assert.strictEqual(s('a 1.5” disc'), 85, 'curly inch mark (+20) and disc (+15)');
  });

  // ── the dimension detector ────────────────────────────────────────────

  console.log('[dimension detector]');

  const DIMENSIONS_YES = [
    '40mm', '40 mm', '1.5"', '6 in', 'M4 × 20', '80 × 50 × 25', '4cm',
    '1.5 m', '6 inches', '80x50', '30 dia', '25 tall', 'Ø30', '120 millimetres',
    "6' across the base",
  ];
  const DIMENSIONS_NO = [
    '40', 'about 20', 'three of them', 'a 5 minute print', '2 in the middle',
    "the 1990's", 'version 2', 'quite big',
  ];

  for (const text of DIMENSIONS_YES) {
    check(`"${text}" is a dimension`, () => {
      assert.strictEqual(s(text), 70, `expected +20 for "${text}"`);
    });
  }

  for (const text of DIMENSIONS_NO) {
    check(`"${text}" is not a dimension`, () => {
      assert.strictEqual(s(text), 50, `expected no dimension bonus for "${text}"`);
    });
  }

  // ── purity ────────────────────────────────────────────────────────────

  console.log('[purity]');

  function deepFreeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
      Object.freeze(value);
      for (const key of Object.keys(value)) deepFreeze(value[key]);
    }
    return value;
  }

  const FROZEN_INPUT = deepFreeze({
    category: JSON.parse(JSON.stringify(cat('enclosure'))),
    prompt: 'A box with a snap lid, 80 × 50 × 25 mm inside, for my broken drawer',
    answers: { inside: '80 × 50 × 25', lid: 'snap-fit', wall: '2' },
    attachments: [{ name: 'ref.png', kind: 'image' }],
  });

  check('a deep-frozen input is never written to (strict-mode ESM would throw)', () => {
    assert.doesNotThrow(() => decideRoute(FROZEN_INPUT));
  });

  check('the same input twice produces a deep-equal decision', () => {
    assert.deepStrictEqual(decideRoute(FROZEN_INPUT), decideRoute(FROZEN_INPUT));
  });

  check('the two decisions are separate objects, not one shared instance', () => {
    const a = decideRoute(FROZEN_INPUT);
    const b = decideRoute(FROZEN_INPUT);
    assert.notStrictEqual(a, b);
    assert.notStrictEqual(a.reasons, b.reasons);
    assert.notStrictEqual(a.missing, b.missing);
  });

  check('a mutable input is byte-for-byte unchanged after a decision', () => {
    const input = {
      category: JSON.parse(JSON.stringify(cat('furniture'))),
      prompt: 'a 30mm round knob with an M4 insert',
      answers: { size: '30 dia × 25 tall', fixing: 'M4 screw' },
      attachments: [{ name: 'a.stl', kind: 'mesh' }],
    };
    const before = JSON.stringify(input);
    decideRoute(input);
    assert.strictEqual(JSON.stringify(input), before);
  });

  check('decisions are stable across the whole taxonomy, twice over', () => {
    for (const category of taxonomy.categories) {
      const input = deepFreeze({
        category,
        prompt: 'a 40mm knob for my broken dryer, cute and ornate, 2 in the middle',
        answers: {},
        attachments: [],
      });
      assert.deepStrictEqual(decideRoute(input), decideRoute(input), category.id);
    }
  });

  // ── reasons: user-facing copy ─────────────────────────────────────────

  console.log('[reasons]');

  const CORPUS = [
    ['hardware', 'M4 standoff 20mm', {}, []],
    ['bracket', 'a clip that snaps onto a 6 mm cable', { screws: 'M4' }, []],
    ['enclosure', 'a box with a lid, 80 × 50 × 25', { wall: '2' }, []],
    ['furniture', 'a mid-century tapered table leg with fluting', {}, []],
    ['structural', 'a hook that holds 8 kg', {}, []],
    ['replacement', 'the knob that snapped off my dryer', {}, []],
    ['model', 'a squat dragon curled around an egg', { height: '32' }, []],
    ['decor', 'an owl planter with big round eyes', {}, []],
    ['toy', 'a 16 mm die with pips', { age: 'kids' }, []],
    ['other', 'my thing, like the one before, and another', {}, [{ kind: 'vector' }]],
  ];

  check('every reason is at most ten words', () => {
    for (const [id, prompt, answers, attachments] of CORPUS) {
      const d = decideRoute({ category: cat(id), prompt, answers, attachments });
      for (const reason of d.reasons) {
        const words = reason.split(/\s+/).filter(Boolean).length;
        assert.ok(words <= 10, `${id}: "${reason}" is ${words} words`);
      }
    }
  });

  check('no reason ever prints the score', () => {
    for (const [id, prompt, answers, attachments] of CORPUS) {
      const d = decideRoute({ category: cat(id), prompt, answers, attachments });
      for (const reason of d.reasons) {
        assert.ok(!/score|points|\/\s*100|\bout of\b/i.test(reason), `${id}: "${reason}" leaks the score`);
      }
    }
  });

  check('a scored decision always says at least one thing about itself', () => {
    const d = decideRoute({ category: cat('decor'), prompt: 'an owl planter with big round eyes' });
    assert.ok(d.reasons.length >= 1);
  });

  check('reasons name the signal that actually fired, in the user\'s terms', () => {
    const dim = decideRoute({ category: AUTO, prompt: 'a thing 40mm' });
    assert.deepStrictEqual(dim.reasons, ['You gave exact measurements']);

    const field = decideRoute({ category: AUTO, prompt: 'a thing', answers: { num: '20' } });
    assert.deepStrictEqual(field.reasons, ['You filled in the measurements']);

    const choice = decideRoute({ category: AUTO, prompt: 'a thing', answers: { pick: 'beta' } });
    assert.deepStrictEqual(choice.reasons, ['You chose beta']);

    const simple = decideRoute({ category: AUTO, prompt: 'a bracket' });
    assert.deepStrictEqual(simple.reasons, ['A bracket is a simple, measurable shape']);

    const vowel = decideRoute({ category: AUTO, prompt: 'an adapter' });
    assert.deepStrictEqual(vowel.reasons, ['An adapter is a simple, measurable shape']);

    const organic = decideRoute({ category: AUTO, prompt: 'an owl' });
    assert.deepStrictEqual(organic.reasons, ["'owl' isn't something I can measure"]);

    const unseen = decideRoute({ category: AUTO, prompt: 'my thing' });
    assert.deepStrictEqual(unseen.reasons, ["You're describing something you have, but I can't see it"]);

    const geometry = decideRoute({ category: AUTO, prompt: 'a thing', attachments: [{ kind: 'scad' }] });
    assert.deepStrictEqual(geometry.reasons, ['The scad file gives me the shape']);
  });

  check('a signal that did NOT fire is never mentioned', () => {
    const d = decideRoute({ category: AUTO, prompt: 'a bracket' });
    assert.ok(!d.reasons.some((r) => /measure|photo|see/.test(r)), JSON.stringify(d.reasons));
  });

  check('a forced route explains itself by category, not by score', () => {
    const direct = decideRoute({ category: cat('hardware'), prompt: 'anything' });
    const photo = decideRoute({ category: cat('replacement'), prompt: 'anything' });
    const images = decideRoute({ category: cat('model'), prompt: 'anything' });
    assert.strictEqual(direct.reasons.length, 1);
    assert.strictEqual(photo.reasons.length, 1);
    assert.strictEqual(images.reasons.length, 1);
    assert.ok(/photo/i.test(photo.reasons[0]), photo.reasons[0]);
    assert.ok(/eye/i.test(images.reasons[0]), images.reasons[0]);
  });

  // ── missing: real questions, capped at three ──────────────────────────

  console.log('[missing]');

  check('missing is empty on every direct route', () => {
    assert.deepStrictEqual(decideRoute({ category: cat('hardware'), prompt: 'M4 standoff 20mm' }).missing, []);
    assert.deepStrictEqual(
      decideRoute({ category: cat('decor'), prompt: 'a 90mm round coaster, 4mm thick' }).missing,
      []
    );
  });

  check('no dimension asks how big it should be', () => {
    const d = decideRoute({ category: cat('decor'), prompt: 'an owl planter with big round eyes' });
    assert.ok(d.missing.includes('How big should it be?'), JSON.stringify(d.missing));
  });

  check('a dimension that was given is never asked for again', () => {
    const d = decideRoute({ category: cat('decor'), prompt: 'an ornate owl planter 150mm tall' });
    assert.strictEqual(d.route, 'confirm');
    assert.ok(!d.missing.includes('How big should it be?'), JSON.stringify(d.missing));
  });

  check('a replacement with no measurements asks for the measurements', () => {
    const d = decideRoute({ category: cat('replacement'), prompt: 'the knob that snapped off my dryer' });
    assert.ok(d.missing.includes('What are the key measurements?'), JSON.stringify(d.missing));
    assert.ok(!d.missing.includes('How big should it be?'), 'not both — one question, not two');
  });

  check('a replacement asks for a photo, and stops asking once one is attached', () => {
    const without = decideRoute({ category: cat('replacement'), prompt: 'the broken knob' });
    assert.ok(without.missing.includes('Can you show me a photo of it?'), JSON.stringify(without.missing));
    const with_ = decideRoute({
      category: cat('replacement'),
      prompt: 'the broken knob',
      attachments: [{ name: 'knob.jpg', kind: 'image' }],
    });
    assert.ok(!with_.missing.includes('Can you show me a photo of it?'), JSON.stringify(with_.missing));
  });

  check('an image-confirm route asks what it should look like, unless style is answered', () => {
    const asked = decideRoute({ category: cat('model'), prompt: 'a knight' });
    assert.ok(asked.missing.includes('What should it look like?'), JSON.stringify(asked.missing));
    const answered = decideRoute({ category: cat('model'), prompt: 'a knight', answers: { style: 'bust', height: '32' } });
    assert.ok(!answered.missing.includes('What should it look like?'), JSON.stringify(answered.missing));
  });

  check('a compound description asks whether it is one piece', () => {
    const d = decideRoute({
      category: cat('furniture'),
      prompt: 'a curvy leg, a foot, a shade and a cover',
    });
    assert.strictEqual(d.route, 'confirm');
    assert.ok(d.missing.includes('Is this one piece, or a few parts?'), JSON.stringify(d.missing));
  });

  check('an empty description asks what they are making', () => {
    const d = decideRoute({ category: cat('other'), prompt: '' });
    assert.strictEqual(d.missing[0], 'What are you making?');
  });

  check('missing is capped at three and never repeats a question', () => {
    const d = decideRoute({ category: cat('other'), prompt: '' });
    assert.strictEqual(d.missing.length, 3);
    assert.strictEqual(new Set(d.missing).size, d.missing.length);
    for (const category of taxonomy.categories) {
      const any = decideRoute({ category, prompt: 'my broken one, and another, and a third' });
      assert.ok(any.missing.length <= 3, `${category.id} asked ${any.missing.length} questions`);
      assert.ok(any.missing.every((q) => q.endsWith('?')), `${category.id} asked something that is not a question`);
    }
  });

  // ── explain ───────────────────────────────────────────────────────────

  console.log('[explain]');

  check('direct gets the contract sentence, verbatim', () => {
    const d = decideRoute({ category: cat('hardware'), prompt: 'M4 standoff 20mm' });
    assert.strictEqual(explain(d), 'This is straightforward — making it now.');
  });

  check('confirm-with-images gets the contract sentence, verbatim', () => {
    const d = decideRoute({ category: cat('model'), prompt: 'a dragon' });
    assert.strictEqual(explain(d), "Let's check the look first — I'll show you a few options.");
  });

  check('confirm-with-photo gets the contract sentence, verbatim', () => {
    const d = decideRoute({ category: cat('replacement'), prompt: 'the broken knob' });
    assert.strictEqual(
      explain(d),
      "I can't see your part, so a photo will make this much more accurate."
    );
  });

  check('confirm-with-both gets its own sentence', () => {
    const d = decideRoute({ category: cat('other'), prompt: 'my ornate flowing thing' });
    assert.strictEqual(d.confirmMode, 'both');
    assert.ok(explain(d).length > 0);
    assert.notStrictEqual(explain(d), "Let's check the look first — I'll show you a few options.");
  });

  check('explain is one sentence, no jargon, for every category', () => {
    for (const category of taxonomy.categories) {
      const line = explain(decideRoute({ category, prompt: 'a thing' }));
      assert.ok(typeof line === 'string' && line.length > 0, category.id);
      assert.ok(/[.!?]$/.test(line), `${category.id}: "${line}" does not end a sentence`);
      assert.strictEqual(line.replace(/[.!?]$/, '').split(/[.!?]\s/).length, 1, `${category.id}: more than one sentence`);
      assert.ok(!/score|route|confirm mode|target|preset|parametric|scad/i.test(line), `${category.id}: "${line}" leaks jargon`);
    }
  });

  check('explain never throws on junk', () => {
    assert.strictEqual(explain(null), '');
    assert.strictEqual(explain(undefined), '');
    assert.strictEqual(explain('nope'), '');
    assert.strictEqual(typeof explain({}), 'string');
  });

  // ── summary ───────────────────────────────────────────────────────────

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) {
    process.exitCode = 1;
    // stdout to a pipe is async on Windows — flush before the hard exit or
    // the failure lines never reach the terminal.
    process.stdout.write('', () => process.exit(1));
  }
})().catch((err) => {
  console.error('FAIL — the route harness itself threw');
  console.error(err && err.stack ? err.stack : err);
  process.exitCode = 1;
  process.stdout.write('', () => process.exit(1));
});
