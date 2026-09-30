const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { flattenSingleDir } = require('../scripts/download-openscad');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clawscad-openscad-'));
try {
  const nested = path.join(root, 'nested');
  const snapshot = path.join(nested, 'OpenSCAD-snapshot-x86-64');
  fs.mkdirSync(snapshot, { recursive: true });
  fs.writeFileSync(path.join(snapshot, 'openscad.exe'), 'binary');
  fs.writeFileSync(path.join(snapshot, 'support.dll'), 'library');
  assert.equal(flattenSingleDir(nested, 'openscad.exe'), true);
  assert.equal(fs.readFileSync(path.join(nested, 'openscad.exe'), 'utf8'), 'binary');
  assert.equal(fs.readFileSync(path.join(nested, 'support.dll'), 'utf8'), 'library');
  assert.equal(fs.existsSync(snapshot), false);
  assert.equal(flattenSingleDir(nested, 'openscad.exe'), false);

  const flat = path.join(root, 'flat');
  fs.mkdirSync(flat);
  fs.writeFileSync(path.join(flat, 'openscad.exe'), 'already flat');
  assert.equal(flattenSingleDir(flat, 'openscad.exe'), false);
  assert.equal(fs.readFileSync(path.join(flat, 'openscad.exe'), 'utf8'), 'already flat');

  const unrelated = path.join(root, 'unrelated');
  fs.mkdirSync(path.join(unrelated, 'other'), { recursive: true });
  assert.equal(flattenSingleDir(unrelated, 'openscad.exe'), false);
  assert.equal(fs.existsSync(path.join(unrelated, 'other')), true);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

if (process.argv.includes('--vendor')) {
  assert.equal(
    fs.existsSync(path.join(__dirname, '..', 'vendors', 'openscad-win', 'openscad.exe')),
    true,
    'Windows build must bundle vendors/openscad-win/openscad.exe'
  );
}
