#!/usr/bin/env node
/**
 * Standalone harness (no Electron runtime) for classifyRenderFailure().
 *
 * Why this exists: RENDER_ERRORS.md in the real workspace once read
 * "spawn openscad ENOENT" under the heading "The last render failed with
 * errors. Create a NEW fixed .scad file" — the app had told Claude to fix a
 * model in order to cure a missing install, which is an impossible task. The
 * model rendered clean the moment a binary was on PATH.
 *
 * The single rule that must never regress: a spawn/permission failure must NOT
 * classify as 'model', because only 'model' writes RENDER_ERRORS.md and nudges
 * Claude.
 *
 * Like tests/error-handler-survival.js, this extracts the function's literal
 * source from main.js at run time, so deleting the guard in main.js turns this
 * RED rather than leaving a copy of the logic passing in the test file.
 *
 * Run: node tests/render-fault-classify.js
 */

const fs = require('fs');
const path = require('path');

const MAIN = path.join(__dirname, '..', 'main.js');
const src = fs.readFileSync(MAIN, 'utf-8');

const start = src.indexOf('function classifyRenderFailure');
if (start === -1) {
  console.error('FAIL: classifyRenderFailure not found in main.js — was the fault split removed?');
  process.exit(1);
}
// Walk braces to the end of the function.
const open = src.indexOf('{', start);
let depth = 0;
let end = -1;
for (let i = open; i < src.length; i++) {
  if (src[i] === '{') depth++;
  else if (src[i] === '}') {
    depth--;
    if (depth === 0) { end = i + 1; break; }
  }
}
if (end === -1) {
  console.error('FAIL: could not delimit classifyRenderFailure in main.js');
  process.exit(1);
}

// eslint-disable-next-line no-new-func
const classify = new Function(
  'fs',
  `${src.slice(start, end)}; return classifyRenderFailure;`
)(fs);

const MISSING_OUTPUT = path.join(__dirname, '__no_such_output__.3mf');
const PRESENT_OUTPUT = __filename; // any file that definitely exists

const cases = [
  {
    name: 'spawn ENOENT (no openscad installed)',
    err: Object.assign(new Error('spawn openscad ENOENT'), { code: 'ENOENT' }),
    output: MISSING_OUTPUT,
    expect: 'environment',
  },
  {
    name: 'EACCES (binary not executable)',
    err: Object.assign(new Error('permission denied'), { code: 'EACCES' }),
    output: MISSING_OUTPUT,
    expect: 'environment',
  },
  {
    name: 'EPERM',
    err: Object.assign(new Error('operation not permitted'), { code: 'EPERM' }),
    output: MISSING_OUTPUT,
    expect: 'environment',
  },
  {
    name: 'killed by the 120s timeout',
    err: Object.assign(new Error('timed out'), { killed: true, signal: 'SIGTERM' }),
    output: MISSING_OUTPUT,
    expect: 'timeout',
  },
  {
    name: 'non-zero exit with no output (a real model rejection)',
    err: Object.assign(new Error('Command failed'), { code: 1 }),
    output: MISSING_OUTPUT,
    expect: 'model',
  },
  {
    name: 'no error but output missing',
    err: null,
    output: MISSING_OUTPUT,
    expect: 'model',
  },
  {
    name: 'success',
    err: null,
    output: PRESENT_OUTPUT,
    expect: null,
  },
];

let failed = 0;
for (const c of cases) {
  const got = classify(c.err, c.output);
  const ok = got === c.expect;
  if (!ok) failed++;
  console.log(
    `[classify] ${c.name}: expected ${String(c.expect)}, got ${String(got)} — ${ok ? 'pass' : 'FAIL'}`
  );
}

// The load-bearing assertion, stated separately because it is the whole point.
const enoent = classify(
  Object.assign(new Error('spawn openscad ENOENT'), { code: 'ENOENT' }),
  MISSING_OUTPUT
);
if (enoent === 'model') {
  console.error(
    '[classify] FAIL: a missing OpenSCAD binary classified as a MODEL fault — ' +
      'this is what sent Claude to fix a model that was never compiled.'
  );
  failed++;
} else {
  console.log('[classify] missing binary never reaches the model-fix loop (pass)');
}

process.exit(failed ? 1 : 0);
