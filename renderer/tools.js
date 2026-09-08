// renderer/tools.js — v0.6 Studio. The tool layer's PURE core.
//
// A "tool" is a small group of fields the user switches on to say something
// more specific than a sentence can. Each tool compiles into three separate
// outputs, and keeping them separate is the whole point:
//
//   lines[]      plain-English constraints prepended to what Claude reads
//   imageWords[] extra words appended to the IMAGE prompt only
//   flags{}      claw-gen CLI flags, keyed by pipeline action
//
// A "STRENGTH: takes real load" line belongs in Claude's brief and would be
// noise in an image prompt; "matte surface" is the reverse. One compiler, three
// channels, no cross-contamination.
//
// NO DOM, NO ELECTRON, NO IMPORTS — the same discipline as route.js, and for
// the same reason: tests/tools.js exercises every rule under plain node with no
// Electron launch. renderer/studio.js owns all the DOM.

const ACTIONS = Object.freeze(['images', 'mesh', 'prep', 'checkpoint']);

// ── small helpers ─────────────────────────────────────────────────────────

function asText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'yes' : '';
  return String(value).trim();
}

function isFilled(value) {
  return asText(value) !== '';
}

/** Substitute {fieldId} from `values`. Unknown/empty placeholders collapse to
 *  '' — but `matches()` has already guaranteed every id in `when` is filled, so
 *  a rule that fires never renders a hole. */
function substitute(template, values) {
  return String(template == null ? '' : template).replace(/\{(\w[\w-]*)\}/g, (_m, key) =>
    asText(values[key])
  );
}

/** A rule fires when every field id in `when` has a value, and every
 *  `equals` entry matches exactly. `when: []` fires whenever the tool is on. */
function matches(rule, values) {
  const when = Array.isArray(rule && rule.when) ? rule.when : [];
  for (const id of when) {
    if (!isFilled(values[id])) return false;
  }
  const equals = rule && rule.equals;
  if (equals && typeof equals === 'object') {
    for (const [id, expected] of Object.entries(equals)) {
      if (asText(values[id]) !== asText(expected)) return false;
    }
  }
  return true;
}

/** FIRST match wins. Used for `lines`: the rules are ordered most-specific
 *  first, so a tool with width+depth+height emits one combined sentence rather
 *  than three fragments that repeat each other. */
function firstMatch(rules, values) {
  const list = Array.isArray(rules) ? rules : [];
  for (const rule of list) {
    if (matches(rule, values)) return rule;
  }
  return null;
}

/** ALL matches apply. Used for `imageWords` and `flags`, which accumulate. */
function allMatches(rules, values) {
  const list = Array.isArray(rules) ? rules : [];
  return list.filter((rule) => matches(rule, values));
}

// ── catalog reading ───────────────────────────────────────────────────────

/** Tolerant of the shapes `tools:load` can hand back — the payload itself, its
 *  `.data`, its `.tools`, a bare parsed file, or a bare array. A front door may
 *  not go blank because a wrapper changed. */
export function readCatalog(payload) {
  const empty = { tools: [], groups: [], error: null };
  if (!payload) return { ...empty, error: 'The tools were not loaded.' };
  if (Array.isArray(payload)) return { ...empty, tools: payload };

  if (typeof payload !== 'object') return { ...empty, error: 'The tools were not loaded.' };

  const error = payload.error || null;
  let file = payload.data || payload.tools || payload;
  if (Array.isArray(file)) file = { tools: file };
  if (!file || typeof file !== 'object') return { ...empty, error };

  const tools = Array.isArray(file.tools) ? file.tools.filter((t) => t && typeof t === 'object' && t.id) : [];
  const groups = Array.isArray(file.groups) ? file.groups.filter((g) => g && g.id) : [];
  return { tools, groups, error };
}

/** The tools a category switches on by itself. `auto: '*'` means every
 *  category; a missing/empty `auto` means "offered, never automatic". */
export function autoToolsFor(tools, categoryId) {
  const out = [];
  for (const tool of Array.isArray(tools) ? tools : []) {
    const auto = tool.auto;
    if (auto === '*') out.push(tool.id);
    else if (Array.isArray(auto) && categoryId && auto.includes(categoryId)) out.push(tool.id);
  }
  return out;
}

/** Whether a tool is offered on a given pipeline track. A tool with no
 *  `targets` is offered everywhere. This is why "Hardware" disappears when you
 *  switch to Images — there is no clearance hole in a picture. */
export function toolAppliesTo(tool, target) {
  if (!tool) return false;
  const targets = tool.targets;
  if (!Array.isArray(targets) || targets.length === 0) return true;
  return targets.includes(target);
}

/** Drop values for fields the tool no longer declares, so a renamed field in
 *  a userData override cannot resurrect a stale value in a compiled line. */
export function pruneValues(tool, values) {
  const out = {};
  const fields = Array.isArray(tool && tool.fields) ? tool.fields : [];
  for (const field of fields) {
    if (field && field.id && isFilled((values || {})[field.id])) out[field.id] = asText(values[field.id]);
  }
  return out;
}

/** A tool contributes nothing until at least one of its fields is filled.
 *  Switching a tool on and typing nothing must not add a line. */
export function toolHasValues(tool, values) {
  return Object.keys(pruneValues(tool, values)).length > 0;
}

// ── the compiler ──────────────────────────────────────────────────────────

/**
 * compile({ tools, enabled, values, target }) -> {
 *   lines:      string[],                       // for Claude
 *   imageWords: string[],                       // for the image prompt
 *   flags:      { images:[], mesh:[], prep:[], checkpoint:[] },
 *   chips:      [{ toolId, label, text }],      // the compact summary row
 *   skipped:    [{ toolId, reason }],           // enabled but contributing nothing
 * }
 *
 * Pure: same input -> deep-equal output, and neither `values` nor any tool
 * object is mutated.
 */
export function compile(input) {
  const src = input && typeof input === 'object' ? input : {};
  const tools = Array.isArray(src.tools) ? src.tools : [];
  const enabled = Array.isArray(src.enabled) ? src.enabled : [];
  const allValues = src.values && typeof src.values === 'object' ? src.values : {};
  const target = asText(src.target) || 'part';

  const lines = [];
  const imageWords = [];
  const chips = [];
  const skipped = [];
  const flags = {};
  for (const action of ACTIONS) flags[action] = [];

  // Iterate the CATALOG, not the enabled list, so output order is the stable
  // catalog order rather than whatever order the user happened to click.
  for (const tool of tools) {
    if (!enabled.includes(tool.id)) continue;
    if (!toolAppliesTo(tool, target)) {
      skipped.push({ toolId: tool.id, reason: `not used when making ${target === 'image' ? 'images' : target + 's'}` });
      continue;
    }

    const values = pruneValues(tool, allValues[tool.id]);
    if (Object.keys(values).length === 0) {
      skipped.push({ toolId: tool.id, reason: 'nothing filled in yet' });
      continue;
    }

    const lineRule = firstMatch(tool.lines, values);
    if (lineRule && lineRule.text) lines.push(substitute(lineRule.text, values));

    for (const rule of allMatches(tool.imageWords, values)) {
      const text = substitute(rule.text, values);
      if (text) imageWords.push(text);
    }

    for (const rule of allMatches(tool.flags, values)) {
      const action = asText(rule.action);
      if (!flags[action]) continue; // an override naming an action we don't run
      const args = Array.isArray(rule.args) ? rule.args : [];
      for (const arg of args) flags[action].push(substitute(arg, values));
    }

    chips.push({
      toolId: tool.id,
      label: asText(tool.label) || tool.id,
      text: summarise(tool, values),
    });
  }

  return { lines, imageWords, flags, chips, skipped };
}

/** The one-line summary shown on a tool's chip. Values only — the chip already
 *  carries the tool's name, so repeating it reads as stutter. */
export function summarise(tool, values) {
  const fields = Array.isArray(tool && tool.fields) ? tool.fields : [];
  const parts = [];
  for (const field of fields) {
    const value = asText((values || {})[field.id]);
    if (!value) continue;
    if (field.kind === 'toggle') {
      parts.push(asText(field.label).toLowerCase());
    } else {
      parts.push(field.unit ? `${value} ${field.unit}` : value);
    }
  }
  return parts.join(' · ');
}

/**
 * The final text handed to Claude on the part track: the taxonomy preamble,
 * then the category brief, then the tool lines, then the user's own sentence
 * last so it reads as the request rather than as another constraint.
 */
export function composeBrief({ preamble, categoryPrompt, lines, prompt, attachments }) {
  const blocks = [];
  if (asText(preamble)) blocks.push(asText(preamble));
  if (asText(categoryPrompt)) blocks.push(asText(categoryPrompt));

  const constraints = (Array.isArray(lines) ? lines : []).filter(Boolean);
  if (constraints.length) blocks.push(constraints.join('\n'));

  const files = (Array.isArray(attachments) ? attachments : []).filter(Boolean);
  if (files.length) {
    blocks.push(
      'ATTACHED (already in this workspace — read them before you start):\n' +
        files.map((f) => `- ${f}`).join('\n')
    );
  }

  if (asText(prompt)) blocks.push(asText(prompt));
  return blocks.join('\n\n');
}

/**
 * The image-generation prompt. Deliberately NOT the same string as the brief:
 * an image model given "expose the count as a variable" draws worse pictures.
 * Just the subject plus the look words.
 */
export function composeImagePrompt({ prompt, imageWords }) {
  const words = (Array.isArray(imageWords) ? imageWords : []).map(asText).filter(Boolean);
  const subject = asText(prompt);
  if (!words.length) return subject;
  if (!subject) return words.join(', ');
  return `${subject}, ${words.join(', ')}`;
}

export { ACTIONS };
