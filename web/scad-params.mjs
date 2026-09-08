// web/scad-params.js — OpenSCAD Customizer parameter parser. PURE.
//
// No DOM, no fs, no Electron, no imports — the same discipline as
// renderer/tools.js and renderer/route.js, and for the same reason:
// tests/scad-params.js exercises every rule under plain node.
//
// WHY A PARSER AT ALL. Claude writes a .scad whose top-level assignments are
// the knobs — "expose them as named variables" is in half the category
// prompts. OpenSCAD's own Customizer reads exactly those, and `-D name=value`
// overrides them at render time. So the browser can offer real controls
// WITHOUT ever rewriting the file, which matters: every .scad in this app is
// an immutable checkpoint.
//
// THE RULE THAT MATTERS. OpenSCAD only treats assignments BEFORE the first
// module/function definition as customizable. Getting that wrong means
// offering a knob that silently does nothing, because `-D` on an inner
// variable is shadowed by the local assignment. That cutoff is the single
// most important thing in this file and it is what the mutation test breaks.

const NUM_RE = /^-?\d+(?:\.\d+)?$/;

/** Strip block comments, but rewrite a section marker into a line comment so
 *  the line scanner below still sees it. Newlines are preserved so the
 *  "description on the previous line" logic is never thrown off. */
function stripBlockCommentsKeepingSections(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('/*', i);
    if (open === -1) {
      out.push(src.slice(i));
      break;
    }
    out.push(src.slice(i, open));
    const close = src.indexOf('*/', open + 2);
    const body = src.slice(open + 2, close === -1 ? src.length : close);
    const section = /^\s*\[([^\]]*)\]\s*$/.exec(body);
    if (section) out.push(`//__SECTION__${section[1].trim()}`);
    else out.push(body.replace(/[^\n]/g, ''));
    if (close === -1) break;
    i = close + 2;
  }
  return out.join('');
}

/** Where the customizable region ends: the first top-level `module` or
 *  `function` definition. Everything after it is internal. */
function customizableRegion(src) {
  const m = /(^|\n)\s*(module|function)\s+[A-Za-z_$][\w$]*\s*\(/.exec(src);
  return m ? src.slice(0, m.index) : src;
}

/** Split a trailing `// ...` comment off a line, ignoring `//` inside a
 *  string literal (a `label = "http://x";` must not lose its value). */
function splitLineComment(line) {
  let inStr = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === inStr) inStr = null;
    } else if (c === '"' || c === "'") {
      inStr = c;
    } else if (c === '/' && line[i + 1] === '/') {
      return { code: line.slice(0, i), comment: line.slice(i + 2).trim() };
    }
  }
  return { code: line, comment: '' };
}

function parseLiteral(raw) {
  const v = raw.trim().replace(/;$/, '').trim();
  if (v === 'true') return { kind: 'boolean', value: true };
  if (v === 'false') return { kind: 'boolean', value: false };
  if (NUM_RE.test(v)) return { kind: 'number', value: Number(v) };
  const str = /^"((?:[^"\\]|\\.)*)"$/.exec(v) || /^'((?:[^'\\]|\\.)*)'$/.exec(v);
  if (str) return { kind: 'string', value: str[1].replace(/\\(.)/g, '$1') };
  // Vectors and expressions are real OpenSCAD, but they are not something a
  // form control can safely round-trip, so they are reported and not offered.
  return null;
}

/**
 * The `// [...]` annotation after a value. OpenSCAD's four forms:
 *   [min:max]            numeric range
 *   [min:step:max]       stepped range
 *   [a, b, c]            dropdown of literal options
 *   [1:One, 2:Two]       dropdown with labels
 * Anything else is treated as a plain description.
 */
function parseAnnotation(comment) {
  const m = /^\[([^\]]*)\]\s*(.*)$/.exec(comment.trim());
  if (!m) return { annotation: null, description: comment.trim() };
  const body = m[1].trim();
  const rest = m[2].trim();

  if (body.includes(',')) {
    const options = body.split(',').map((part) => {
      const t = part.trim();
      const labelled = /^([^:]+):(.*)$/.exec(t);
      if (labelled) {
        const rawV = labelled[1].trim();
        return { value: NUM_RE.test(rawV) ? Number(rawV) : rawV, label: labelled[2].trim() };
      }
      return { value: NUM_RE.test(t) ? Number(t) : t, label: t };
    });
    return { annotation: { type: 'options', options }, description: rest };
  }

  const nums = body.split(':').map((s) => s.trim());
  if (nums.length >= 2 && nums.every((n) => NUM_RE.test(n))) {
    const parts = nums.map(Number);
    const range =
      parts.length === 2
        ? { type: 'range', min: parts[0], max: parts[1] }
        : { type: 'range', min: parts[0], step: parts[1], max: parts[2] };
    return { annotation: range, description: rest };
  }

  if (body) {
    return {
      annotation: { type: 'options', options: [{ value: NUM_RE.test(body) ? Number(body) : body, label: body }] },
      description: rest,
    };
  }
  return { annotation: null, description: comment.trim() };
}

/**
 * parse(src) -> { parameters: [...], sections: [...], skipped: [...] }
 *
 * Each parameter:
 *   { name, value, kind, section, description, control,
 *     min?, max?, step?, options? }
 *
 * Pure: same input -> deep-equal output, and `src` is never mutated.
 */
export function parse(src) {
  const parameters = [];
  const skipped = [];
  const sectionOrder = [];
  if (typeof src !== 'string' || !src) return { parameters, sections: sectionOrder, skipped };

  const region = customizableRegion(stripBlockCommentsKeepingSections(src));
  const lines = region.split(/\r?\n/);

  let section = '';
  let pendingDescription = '';
  const seen = new Set();

  for (const line of lines) {
    const sectionMark = /^\s*\/\/__SECTION__(.*)$/.exec(line);
    if (sectionMark) {
      section = sectionMark[1].trim();
      // "Hidden" is OpenSCAD's own convention for "stop offering these".
      if (section && !sectionOrder.includes(section) && section.toLowerCase() !== 'hidden') {
        sectionOrder.push(section);
      }
      pendingDescription = '';
      continue;
    }

    const { code, comment } = splitLineComment(line);
    const trimmed = code.trim();

    if (!trimmed) {
      // A standalone `// text` line is the description for the NEXT assignment.
      if (comment && !/^\[/.test(comment.trim())) pendingDescription = comment.trim();
      else if (!comment) pendingDescription = '';
      continue;
    }

    const assign = /^([A-Za-z_$][\w$]*)\s*=\s*(.+?);?\s*$/.exec(trimmed);
    if (!assign) {
      pendingDescription = '';
      continue;
    }

    const name = assign[1];
    const parsed = parseLiteral(assign[2]);
    if (!parsed) {
      skipped.push({ name, reason: 'not a plain number, boolean or string' });
      pendingDescription = '';
      continue;
    }
    if (seen.has(name)) {
      // OpenSCAD's last assignment wins; the Customizer shows one control.
      const prev = parameters.findIndex((x) => x.name === name);
      if (prev !== -1) parameters.splice(prev, 1);
    }
    seen.add(name);

    const { annotation, description } = parseAnnotation(comment);
    if (section.toLowerCase() === 'hidden') {
      skipped.push({ name, reason: 'in a Hidden section' });
      pendingDescription = '';
      continue;
    }

    const param = {
      name,
      value: parsed.value,
      kind: parsed.kind,
      section,
      description: description || pendingDescription || '',
      control: parsed.kind === 'boolean' ? 'checkbox' : parsed.kind === 'number' ? 'number' : 'text',
    };

    if (annotation && annotation.type === 'options') {
      param.control = 'select';
      param.options = annotation.options;
    } else if (annotation && annotation.type === 'range' && parsed.kind === 'number') {
      param.control = 'slider';
      param.min = annotation.min;
      param.max = annotation.max;
      if (annotation.step !== undefined) param.step = annotation.step;
    }

    parameters.push(param);
    pendingDescription = '';
  }

  return { parameters, sections: sectionOrder, skipped };
}

/**
 * Render one parameter as an OpenSCAD `-D` argument.
 *
 * Strings are re-quoted with escapes. This is the injection boundary: a value
 * containing a quote, a backslash or a newline must not be able to close the
 * literal and append code to the render.
 */
export function toDefineArg(name, value, kind) {
  if (!/^[A-Za-z_$][\w$]*$/.test(String(name))) return null;
  if (kind === 'boolean' || typeof value === 'boolean') {
    return `${name}=${value ? 'true' : 'false'}`;
  }
  if (kind === 'number' || (typeof value === 'number' && Number.isFinite(value))) {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    return `${name}=${n}`;
  }
  const s = String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/[\r\n]/g, ' ');
  return `${name}="${s}"`;
}

/** Build the full `-D` argv for a parameter set, skipping anything unsafe. */
export function defineArgs(parameters, values) {
  const args = [];
  for (const p of Array.isArray(parameters) ? parameters : []) {
    if (!values || !Object.prototype.hasOwnProperty.call(values, p.name)) continue;
    const arg = toDefineArg(p.name, values[p.name], p.kind);
    if (arg) args.push('-D', arg);
  }
  return args;
}
