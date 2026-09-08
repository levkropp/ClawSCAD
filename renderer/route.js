// renderer/route.js — P7 (routing engine).
//
// Decides whether a plain-English print request is obvious enough to build
// straight away, or whether it is worth confirming what it looks like first.
//
// PURE by contract: no DOM, no Electron, no imports, no async, no Date, no
// randomness. Same input must produce a deep-equal output, and the input
// object must never be mutated — tests/route.js asserts both.
//
// Full contract: docs/v04-guided-make-contracts.md §P7.

// ── the score table ─────────────────────────────────────────────────────
//
// SIGNALS is the single source of truth for every delta: the scorer reads
// its numbers from here, so the harness can enumerate the rules and a change
// to a delta shows up in the end-to-end scores rather than hiding.

export const SIGNALS = Object.freeze([
  Object.freeze({
    id: 'dimension',
    delta: 20,
    label: 'A real measurement was given',
  }),
  Object.freeze({
    id: 'choice',
    delta: 10,
    label: 'A guided choice was answered',
  }),
  Object.freeze({
    id: 'simple',
    delta: 15,
    label: 'The object is a simple, measurable shape',
  }),
  Object.freeze({
    id: 'organic',
    delta: -25,
    label: 'The object is organic or aesthetic',
  }),
  Object.freeze({
    id: 'unseen',
    delta: -15,
    label: 'It refers to something the app cannot see',
  }),
  Object.freeze({
    id: 'compound',
    delta: -10,
    cap: -20,
    label: 'Extra independent clauses beyond the second',
  }),
  Object.freeze({
    id: 'geometry',
    delta: 15,
    label: 'Geometry was supplied as an attachment',
  }),
]);

const DELTA = SIGNALS.reduce((acc, s) => {
  acc[s.id] = s.delta;
  return acc;
}, Object.create(null));

const CAP = SIGNALS.reduce((acc, s) => {
  if (typeof s.cap === 'number') acc[s.id] = s.cap;
  return acc;
}, Object.create(null));

const BASE_SCORE = 50;
const DIRECT_AT = 60;
const MAX_MISSING = 3;

// ── lexicons ────────────────────────────────────────────────────────────
//
// Every entry lists its own inflections explicitly rather than relying on a
// `\w*` suffix, because a loose match is worse than a missed one here: the
// score is shown to the user as prose. `not` vetoes a hit when the word
// immediately before it makes the match technical rather than descriptive
// ("the mating face" is not a sculpted face).

const SIMPLE_TERMS = [
  { show: 'screw', words: ['screw', 'screws'] },
  { show: 'bolt', words: ['bolt', 'bolts'] },
  { show: 'nut', words: ['nut', 'nuts'] },
  { show: 'washer', words: ['washer', 'washers'] },
  { show: 'spacer', words: ['spacer', 'spacers'] },
  { show: 'standoff', words: ['standoff', 'standoffs', 'stand-off', 'stand-offs'] },
  { show: 'clip', words: ['clip', 'clips'] },
  { show: 'hook', words: ['hook', 'hooks'] },
  { show: 'peg', words: ['peg', 'pegs'] },
  { show: 'pin', words: ['pin', 'pins'] },
  { show: 'shim', words: ['shim', 'shims'] },
  { show: 'plate', words: ['plate', 'plates'] },
  { show: 'bracket', words: ['bracket', 'brackets'] },
  { show: 'mount', words: ['mount', 'mounts', 'mounting', 'mounted'] },
  { show: 'adapter', words: ['adapter', 'adapters', 'adaptor', 'adaptors'] },
  { show: 'grommet', words: ['grommet', 'grommets'] },
  { show: 'knob', words: ['knob', 'knobs'] },
  { show: 'cap', words: ['cap', 'caps'] },
  { show: 'plug', words: ['plug', 'plugs'] },
  { show: 'bushing', words: ['bushing', 'bushings'] },
  { show: 'tube', words: ['tube', 'tubes', 'tubing'] },
  { show: 'ring', words: ['ring', 'rings'] },
  { show: 'disc', words: ['disc', 'discs', 'disk', 'disks'] },
  { show: 'box', words: ['box', 'boxes'] },
  { show: 'lid', words: ['lid', 'lids'] },
  { show: 'tray', words: ['tray', 'trays'] },
  { show: 'holder', words: ['holder', 'holders'] },
  { show: 'stand', words: ['stand', 'stands'] },
  { show: 'jig', words: ['jig', 'jigs'] },
  { show: 'template', words: ['template', 'templates'] },
  { show: 'gauge', words: ['gauge', 'gauges', 'gage', 'gages'] },
];

// The contract's list is category words ("animal", "character"). Nobody types
// "an animal" — they type "an owl", and the contract's own worked example of a
// reason is "'owl' isn't something I can measure". So the abstract words are
// carried verbatim and backed by a curated list of the concrete subjects they
// stand for. Only unambiguous nouns are listed: "bear", "duck", "mouse" and
// "bat" are all verbs or hardware elsewhere, so they are deliberately absent.
const ORGANIC_TERMS = [
  { show: 'figurine', words: ['figurine', 'figurines'] },
  { show: 'statue', words: ['statue', 'statues', 'statuette', 'statuettes'] },
  { show: 'sculpture', words: ['sculpture', 'sculptures', 'sculpted', 'sculptural'] },
  { show: 'bust', words: ['bust', 'busts'] },
  { show: 'character', words: ['character', 'characters'] },
  { show: 'animal', words: ['animal', 'animals'] },
  { show: 'creature', words: ['creature', 'creatures'] },
  { show: 'face', words: ['face', 'faces'], not: FACE_GUARD() },
  { show: 'ornate', words: ['ornate'] },
  { show: 'ornament', words: ['ornament', 'ornaments', 'ornamental'] },
  { show: 'decorative', words: ['decorative', 'decorated', 'decoration', 'decorations'] },
  { show: 'flowing', words: ['flowing'] },
  { show: 'organic', words: ['organic'] },
  { show: 'stylised', words: ['stylised', 'stylized', 'stylise', 'stylize', 'stylising', 'stylizing'] },
  { show: 'cute', words: ['cute'] },
  { show: 'realistic', words: ['realistic', 'realism', 'lifelike'] },
  { show: 'detailed model', words: ['detailed model of', 'detailed model', 'highly detailed'] },
  // the concrete subjects behind "animal" / "character" / "creature"
  { show: 'dragon', words: ['dragon', 'dragons'] },
  { show: 'owl', words: ['owl', 'owls'] },
  { show: 'cat', words: ['cat', 'cats', 'kitten', 'kittens'] },
  { show: 'dog', words: ['dog', 'dogs', 'puppy', 'puppies'] },
  { show: 'bird', words: ['bird', 'birds'] },
  { show: 'fox', words: ['fox', 'foxes'] },
  { show: 'wolf', words: ['wolf', 'wolves'] },
  { show: 'lion', words: ['lion', 'lions'] },
  { show: 'tiger', words: ['tiger', 'tigers'] },
  { show: 'elephant', words: ['elephant', 'elephants'] },
  { show: 'giraffe', words: ['giraffe', 'giraffes'] },
  { show: 'penguin', words: ['penguin', 'penguins'] },
  { show: 'octopus', words: ['octopus', 'octopuses', 'octopi'] },
  { show: 'whale', words: ['whale', 'whales'] },
  { show: 'dolphin', words: ['dolphin', 'dolphins'] },
  { show: 'turtle', words: ['turtle', 'turtles', 'tortoise', 'tortoises'] },
  { show: 'rabbit', words: ['rabbit', 'rabbits', 'bunny', 'bunnies'] },
  { show: 'squirrel', words: ['squirrel', 'squirrels'] },
  { show: 'hedgehog', words: ['hedgehog', 'hedgehogs'] },
  { show: 'horse', words: ['horse', 'horses', 'pony', 'ponies'] },
  { show: 'frog', words: ['frog', 'frogs'] },
  { show: 'dinosaur', words: ['dinosaur', 'dinosaurs', 'dino', 't-rex'] },
  { show: 'unicorn', words: ['unicorn', 'unicorns'] },
  { show: 'gnome', words: ['gnome', 'gnomes'] },
  { show: 'troll', words: ['troll', 'trolls'] },
  { show: 'skull', words: ['skull', 'skulls'] },
  { show: 'mermaid', words: ['mermaid', 'mermaids'] },
  { show: 'fairy', words: ['fairy', 'fairies'] },
  { show: 'wizard', words: ['wizard', 'wizards'] },
  { show: 'knight', words: ['knight', 'knights'] },
  { show: 'monster', words: ['monster', 'monsters'] },
];

// "the mating face", "a flat face" and friends are engineering language, not
// portraiture. Declared as a function so it reads at the call site above.
function FACE_GUARD() {
  return [
    'mating', 'flat', 'top', 'bottom', 'front', 'back', 'rear', 'side', 'inner',
    'outer', 'inside', 'outside', 'contact', 'bearing', 'reference', 'bed',
    'end', 'upper', 'lower', 'sealing', 'datum', 'print', 'printed',
  ];
}

// Phrases that point at an object only the user can see. The contract lists
// six; the rest are the same idea said the way people actually say it.
const UNSEEN_TERMS = [
  { show: 'my', words: ['my'] },
  { show: 'the broken', words: ['the broken', 'the cracked', 'the snapped', 'the damaged', 'the missing'] },
  { show: 'fits the', words: ['fits the', 'fit the', 'fits into the', 'fits onto the', 'fits my'] },
  { show: 'replacement for', words: ['replacement for', 'replacement of', 'replace the', 'replaces the'] },
  { show: 'like the one', words: ['like the one', 'like my', 'like this one'] },
  { show: 'same as', words: ['same as', 'identical to', 'matches the', 'match the'] },
  { show: 'the original', words: ['the original', 'the existing'] },
  { show: 'it broke', words: ['it broke', 'that broke', 'broke off', 'snapped off', 'came off'] },
];

// ── term matching ───────────────────────────────────────────────────────

const RE_CACHE = new Map();

function escapeRe(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function termRegex(word) {
  let re = RE_CACHE.get(word);
  if (!re) {
    // Spaces in a phrase tolerate any run of whitespace; \b at both ends is
    // what keeps "pinion" off "pin" and "boxer" off "box".
    const body = word.split(/\s+/).map(escapeRe).join('\\s+');
    re = new RegExp(`\\b${body}\\b`, 'g');
    RE_CACHE.set(word, re);
  }
  return re;
}

function precedingWord(text, index) {
  const before = text.slice(0, index).match(/([a-z0-9'-]+)[^a-z0-9'-]*$/);
  return before ? before[1] : '';
}

function matchLexicon(text, terms) {
  if (!text) return null;
  for (const entry of terms) {
    for (const word of entry.words) {
      const re = termRegex(word);
      re.lastIndex = 0;
      let m = re.exec(text);
      while (m) {
        if (!entry.not || !entry.not.includes(precedingWord(text, m.index))) {
          return entry.show;
        }
        m = re.exec(text);
      }
    }
  }
  return null;
}

// ── dimensions ──────────────────────────────────────────────────────────
//
// A bare number is never a dimension (a `number`-kind ask field is handled
// separately, by the caller). A number wearing a unit is, and so is the
// unitless `80 × 50 × 25` / `M4 × 20` shorthand everybody writes.

const DIMENSION_PATTERNS = [
  // 40mm · 40 mm · 4cm · 1.5 m · 120 millimetres
  /\b\d+(?:\.\d+)?\s*(?:millimet(?:er|re)s?|centimet(?:er|re)s?|met(?:er|re)s?|mm|cm|m)\b/,
  // 6 in · 6 inch · 6 inches — but never "2 in the middle"
  /\b\d+(?:\.\d+)?\s*(?:inches|inch|ins|in)\b(?!\s+(?:the|a|an|my|his|her|their|its|each|every|all|this|that|these|those|total|order|place|front|between|it|which|case|fact|and|or|plus)\b)/,
  // 1.5" · 6' · 3 ″ — the (?!\w) keeps "the 90's" out
  /\b\d+(?:\.\d+)?\s*(?:"|″|′|')(?!\w)/,
  // 80 × 50 × 25 · 80x50 · 180 * 30
  /\b\d+(?:\.\d+)?\s*[x×*]\s*\d+(?:\.\d+)?\b/,
  // M4 · M2.5 · the M-number in "M4 × 20"
  /\bm(?:1\.6|2\.5|3\.5|10|12|14|16|18|20|22|24|27|30|2|3|4|5|6|8)\b/,
  // 30 dia · 25 tall · 90 square — but not "2 long screws"
  /\b\d+(?:\.\d+)?\s*(?:tall|high|wide|long|thick|deep|across|dia\.?|diameter|radius|square)\b(?!\s+[a-z])/,
  // Ø30 · dia 30 · diameter of 30
  /ø\s*\d+(?:\.\d+)?/,
  /\b(?:dia\.?|diameter|radius)\s*(?:of\s*)?\d+(?:\.\d+)?/,
];

function hasDimension(text) {
  if (!text) return false;
  for (const re of DIMENSION_PATTERNS) {
    if (re.test(text)) return true;
  }
  return false;
}

// ── input reading (never mutates, never trusts) ─────────────────────────

function asText(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && isFinite(value)) return String(value);
  return '';
}

function normalize(value) {
  return asText(value)
    .toLowerCase()
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

function readFields(category, answers) {
  const ask = Array.isArray(category.ask) ? category.ask : [];
  const bag = answers && typeof answers === 'object' ? answers : {};
  const out = [];
  for (const field of ask) {
    if (!field || typeof field !== 'object' || typeof field.id !== 'string') continue;
    const raw = Object.prototype.hasOwnProperty.call(bag, field.id) ? bag[field.id] : '';
    let value = asText(raw).trim();
    // P8 renders the untouched choice as an em-dash placeholder; treat any
    // placeholder glyph as untouched rather than as an answer.
    if (value === '—' || value === '-') value = '';
    out.push({
      id: field.id,
      label: asText(field.label) || field.id,
      kind: (asText(field.kind) || 'text').toLowerCase(),
      value,
    });
  }
  return out;
}

function readAttachmentKinds(attachments) {
  const out = [];
  if (!Array.isArray(attachments)) return out;
  for (const item of attachments) {
    if (!item || typeof item !== 'object') continue;
    const kind = asText(item.kind).toLowerCase().trim();
    if (kind) out.push(kind);
  }
  return out;
}

function countClauses(text) {
  if (!text) return 0;
  return text
    .split(/,|;|\sand\s|\swith\s/)
    .map((part) => part.trim())
    .filter(Boolean).length;
}

function clamp(score) {
  if (!isFinite(score)) return 0;
  if (score < 0) return 0;
  if (score > 100) return 100;
  return Math.round(score);
}

function article(word) {
  return /^[aeiou]/.test(word) ? 'An' : 'A';
}

// ── the decision ────────────────────────────────────────────────────────

function nullDecision() {
  return {
    route: 'direct',
    target: 'part',
    presets: [],
    confirmMode: 'none',
    score: 50,
    reasons: [],
    missing: [],
    forced: false,
  };
}

function forcedReasons(route, confirmMode) {
  if (route === 'direct') return ['This kind of part is all measurements, no guesswork'];
  if (confirmMode === 'photo') return ["I can't see your part, so a photo helps"];
  if (confirmMode === 'both') return ["I want to be sure I've got this right"];
  return ['This is judged by eye, not by measurement'];
}

function buildMissing(facts) {
  const out = [];
  const push = (question) => {
    if (out.length < MAX_MISSING && !out.includes(question)) out.push(question);
  };

  if (facts.words < 3) push('What are you making?');
  if (!facts.dimension) {
    push(facts.needsMeasurements ? 'What are the key measurements?' : 'How big should it be?');
  } else if (facts.needsMeasurements && !facts.measuredAnswer) {
    push('What are the key measurements?');
  }
  if (facts.wantsPhoto && !facts.hasVisual) push('Can you show me a photo of it?');
  if (facts.wantsLook && !facts.styleAnswer) push('What should it look like?');
  if (facts.extraClauses > 0) push('Is this one piece, or a few parts?');

  return out;
}

export function decideRoute(input) {
  const src = input && typeof input === 'object' ? input : {};
  const category =
    src.category && typeof src.category === 'object' && !Array.isArray(src.category)
      ? src.category
      : null;

  if (!category) return nullDecision();

  const promptText = normalize(src.prompt);
  const fields = readFields(category, src.answers);
  const kinds = readAttachmentKinds(src.attachments);

  // "The description" is everything the user said in words — the sentence plus
  // any guided field they filled in. Joined with a pipe so no pattern can
  // straddle the seam and invent a match that neither half contains.
  const answered = fields.filter((f) => f.value);
  const described = [promptText]
    .concat(answered.map((f) => normalize(f.value)))
    .filter(Boolean)
    .join(' | ');

  const numberAnswer = answered.some((f) => f.kind === 'number' && /\d/.test(f.value));
  const choiceAnswers = answered.filter((f) => f.kind === 'choice');
  const textDimension = hasDimension(described);
  const dimension = textDimension || numberAnswer;

  const simpleHit = matchLexicon(described, SIMPLE_TERMS);
  const organicHit = matchLexicon(described, ORGANIC_TERMS);
  const unseenHit = matchLexicon(described, UNSEEN_TERMS);

  const hasVisual = kinds.includes('image') || kinds.includes('mesh');
  const geometryKind = ['mesh', 'scad', 'vector'].find((k) => kinds.includes(k)) || null;
  const unseen = Boolean(unseenHit) && !hasVisual;

  const clauses = countClauses(promptText);
  const extraClauses = Math.max(0, clauses - 2);

  let score = BASE_SCORE + (typeof category.bias === 'number' && isFinite(category.bias) ? category.bias : 0);
  const reasons = [];

  if (dimension) {
    score += DELTA.dimension;
    reasons.push(textDimension ? 'You gave exact measurements' : 'You filled in the measurements');
  }
  if (choiceAnswers.length) {
    score += DELTA.choice;
    const only = choiceAnswers.length === 1 ? choiceAnswers[0].value : '';
    reasons.push(
      only && only.split(/\s+/).length <= 4 ? `You chose ${only}` : 'You answered the quick questions'
    );
  }
  if (simpleHit) {
    score += DELTA.simple;
    reasons.push(`${article(simpleHit)} ${simpleHit} is a simple, measurable shape`);
  }
  if (organicHit) {
    score += DELTA.organic;
    reasons.push(`'${organicHit}' isn't something I can measure`);
  }
  if (unseen) {
    score += DELTA.unseen;
    reasons.push("You're describing something you have, but I can't see it");
  }
  if (extraClauses > 0) {
    score += Math.max(CAP.compound, DELTA.compound * extraClauses);
    reasons.push("That's several things in one description");
  }
  if (geometryKind) {
    score += DELTA.geometry;
    reasons.push(`The ${geometryKind} file gives me the shape`);
  }

  score = clamp(score);

  const declared = asText(category.route).toLowerCase() || 'auto';
  const forced = declared === 'direct' || declared === 'confirm';
  const route = forced ? declared : score >= DIRECT_AT ? 'direct' : 'confirm';

  const target =
    (route === 'direct' ? category.target_direct || category.target : category.target) || 'part';
  const confirmMode = route === 'confirm' ? asText(category.confirm) || 'none' : 'none';

  const missing =
    route === 'confirm'
      ? buildMissing({
          words: promptText ? promptText.split(' ').filter(Boolean).length : 0,
          dimension,
          needsMeasurements: category.id === 'replacement' || Boolean(unseenHit),
          measuredAnswer: answered.some(
            (f) => /measur|size|dimension/i.test(f.id) || /measur|size|dimension/i.test(f.label)
          ),
          wantsPhoto: confirmMode === 'photo' || confirmMode === 'both' || Boolean(unseenHit),
          hasVisual,
          wantsLook: confirmMode === 'images' || confirmMode === 'both' || Boolean(organicHit),
          styleAnswer: answered.some((f) => /style|look|finish/i.test(f.id) || /style|look|finish/i.test(f.label)),
          extraClauses,
        })
      : [];

  return {
    route,
    // A forced category was never scored, so it never reports a scored number:
    // absolute confidence one way or the other, with `forced` saying why.
    score: forced ? (route === 'direct' ? 100 : 0) : score,
    target,
    presets: Array.isArray(category.presets) ? category.presets.slice() : [],
    confirmMode,
    reasons: forced ? forcedReasons(route, confirmMode) : reasons,
    missing,
    forced,
  };
}

export function explain(decision) {
  if (!decision || typeof decision !== 'object') return '';
  if (decision.route === 'direct') return 'This is straightforward — making it now.';
  if (decision.confirmMode === 'photo') {
    return "I can't see your part, so a photo will make this much more accurate.";
  }
  if (decision.confirmMode === 'both') {
    return "Let's check this first — show me a photo, or I'll show you some options.";
  }
  return "Let's check the look first — I'll show you a few options.";
}
