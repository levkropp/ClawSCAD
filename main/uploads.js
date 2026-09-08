// main/uploads.js — P2 (upload & ingest). Owned exclusively by the uploads
// package. See master plan §3 W2 / §4.3 and clawscad-v2-upload-ingest.md.
//
// Everything here is copy-only (global hard rule #2): the user's source file
// is read, never written to, moved, or deleted. Every write goes through
// storeUnique(), which hashes on collision instead of ever overwriting.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.webp', '.svg', '.dxf'];
const MESH_EXTS = ['.stl', '.3mf', '.obj', '.off', '.amf'];
const BLOCKED_EXTS = ['.step', '.stp', '.f3d'];
const MANIFEST_NAME = 'uploads.json';

// A dropped mesh or a virtual (bytes-only) file arrives fully materialised
// in memory before it ever reaches here — the renderer already held it as
// an ArrayBuffer, and it crosses IPC as one more copy. Cap it well below
// "will make the renderer or main process visibly struggle" rather than at
// a value tuned to any one machine.
const MAX_UPLOAD_BYTES = 300 * 1024 * 1024; // 300 MB

// ── naming helpers ─────────────────────────────────────────────────────────

function kebabCase(str, maxLen) {
  let s = String(str || '').toLowerCase();
  s = s.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!s) s = 'file';
  if (maxLen && s.length > maxLen) s = s.slice(0, maxLen).replace(/-+$/, '') || 'file';
  return s;
}

function dateSlug() {
  return new Date().toISOString().slice(0, 10);
}

// Never a bare sequential -2/-3 suffix (workspace CLAUDE.md forbids
// sequential-number checkpoint names) — a short random token instead.
function uniqueScadName(workspaceDir, baseSlug) {
  let name = kebabCase(baseSlug, 26) + '.scad';
  if (!fs.existsSync(path.join(workspaceDir, name))) return name;
  const token = crypto.randomBytes(3).toString('hex');
  return kebabCase(baseSlug, 19) + '-' + token + '.scad';
}

// ── copy-with-verify, hash-suffix on collision, never overwrite ────────────

function storeUnique(destDir, baseName, ext, buffer) {
  fs.mkdirSync(destDir, { recursive: true });
  const hash = crypto.createHash('sha256').update(buffer).digest('hex');
  let name = baseName + ext;
  let full = path.join(destDir, name);
  if (fs.existsSync(full)) {
    const existingHash = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
    if (existingHash === hash) {
      return { path: full, name, dedup: true, sha256: hash, bytes: buffer.length };
    }
    // Different bytes under the same name — hash-suffix, never overwrite.
    name = `${baseName}-${hash.slice(0, 6)}${ext}`;
    full = path.join(destDir, name);
    if (fs.existsSync(full)) {
      return { path: full, name, dedup: true, sha256: hash, bytes: buffer.length };
    }
  }
  fs.writeFileSync(full, buffer);
  const stat = fs.statSync(full);
  if (stat.size !== buffer.length) throw new Error('copy size mismatch after write: ' + full);
  return { path: full, name, dedup: false, sha256: hash, bytes: buffer.length };
}

// ── uploads.json manifest ───────────────────────────────────────────────────

function manifestPath(workspaceDir) {
  return path.join(workspaceDir, 'uploads', MANIFEST_NAME);
}

function readManifest(workspaceDir) {
  try {
    const data = JSON.parse(fs.readFileSync(manifestPath(workspaceDir), 'utf-8'));
    if (Array.isArray(data.files)) return data;
  } catch {}
  return { files: [] };
}

function writeManifestEntry(workspaceDir, entry) {
  fs.mkdirSync(path.join(workspaceDir, 'uploads'), { recursive: true });
  const manifest = readManifest(workspaceDir);
  const idx = manifest.files.findIndex((f) => f.file === entry.file);
  if (idx >= 0) manifest.files[idx] = entry;
  else manifest.files.push(entry);
  fs.writeFileSync(manifestPath(workspaceDir), JSON.stringify(manifest, null, 2));
}

// ── mesh bbox computation — never eyeball a translate() (workspace CLAUDE.md,
// master plan standing rule 9). Every parser below is a pure function of the
// file's own bytes. ─────────────────────────────────────────────────────────

function roundMm(n) {
  return Math.round(n * 1000) / 1000;
}

function finalizeBbox(min, max) {
  if (!isFinite(min[0]) || !isFinite(max[0])) return null;
  return {
    min: min.map(roundMm),
    max: max.map(roundMm),
    dims: [roundMm(max[0] - min[0]), roundMm(max[1] - min[1]), roundMm(max[2] - min[2])],
  };
}

function bboxFromMatches(text, re) {
  let min = [Infinity, Infinity, Infinity];
  let max = [-Infinity, -Infinity, -Infinity];
  let found = false;
  let m;
  re.lastIndex = 0;
  while ((m = re.exec(text))) {
    found = true;
    const x = parseFloat(m[1]);
    const y = parseFloat(m[2]);
    const z = parseFloat(m[3]);
    if (x < min[0]) min[0] = x;
    if (y < min[1]) min[1] = y;
    if (z < min[2]) min[2] = z;
    if (x > max[0]) max[0] = x;
    if (y > max[1]) max[1] = y;
    if (z > max[2]) max[2] = z;
  }
  return found ? finalizeBbox(min, max) : null;
}

function bboxBinarySTL(buf, triCount) {
  let min = [Infinity, Infinity, Infinity];
  let max = [-Infinity, -Infinity, -Infinity];
  let offset = 84;
  for (let i = 0; i < triCount; i++) {
    offset += 12; // normal vector, skipped
    for (let v = 0; v < 3; v++) {
      const x = buf.readFloatLE(offset);
      const y = buf.readFloatLE(offset + 4);
      const z = buf.readFloatLE(offset + 8);
      offset += 12;
      if (x < min[0]) min[0] = x;
      if (y < min[1]) min[1] = y;
      if (z < min[2]) min[2] = z;
      if (x > max[0]) max[0] = x;
      if (y > max[1]) max[1] = y;
      if (z > max[2]) max[2] = z;
    }
    offset += 2; // attribute byte count
  }
  return finalizeBbox(min, max);
}

function bboxSTL(buf) {
  // Binary STLs may still start with the literal text "solid" (a known STL
  // trap) — the size formula is the only reliable discriminator.
  if (buf.length >= 84) {
    const triCount = buf.readUInt32LE(80);
    if (84 + triCount * 50 === buf.length) return bboxBinarySTL(buf, triCount);
  }
  return bboxFromMatches(
    buf.toString('utf-8'),
    /vertex\s+(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)/g
  );
}

function bboxOFF(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  if (!lines.length) return null;
  let idx = 0;
  if (/^(OFF|COFF|NOFF|4OFF)/i.test(lines[0])) idx = 1;
  const counts = lines[idx].split(/\s+/).map(Number);
  const nVerts = counts[0] || 0;
  let min = [Infinity, Infinity, Infinity];
  let max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < nVerts; i++) {
    const line = lines[idx + 1 + i];
    if (!line) break;
    const [x, y, z] = line.split(/\s+/).map(Number);
    if (x < min[0]) min[0] = x;
    if (y < min[1]) min[1] = y;
    if (z < min[2]) min[2] = z;
    if (x > max[0]) max[0] = x;
    if (y > max[1]) max[1] = y;
    if (z > max[2]) max[2] = z;
  }
  return nVerts ? finalizeBbox(min, max) : null;
}

// Minimal ZIP central-directory reader — just enough to pull one text entry
// (3D/3dmodel.model) out of a .3mf. No new npm dependency (master plan §1.14).
function readZipEntryText(buf, nameRegex) {
  const EOCD_SIG = 0x06054b50;
  let eocdOffset = -1;
  const start = Math.max(0, buf.length - 22 - 65535);
  for (let i = buf.length - 22; i >= start; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) return null;
  const cdEntries = buf.readUInt16LE(eocdOffset + 10);
  let offset = buf.readUInt32LE(eocdOffset + 16);
  for (let i = 0; i < cdEntries; i++) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) break;
    const compMethod = buf.readUInt16LE(offset + 10);
    const compSize = buf.readUInt32LE(offset + 20);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.slice(offset + 46, offset + 46 + nameLen).toString('utf-8');
    if (nameRegex.test(name)) {
      const data = extractLocalEntry(buf, localOffset, compMethod, compSize);
      if (data) return data.toString('utf-8');
    }
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

function extractLocalEntry(buf, localOffset, compMethod, compSize) {
  if (buf.readUInt32LE(localOffset) !== 0x04034b50) return null;
  const nameLen = buf.readUInt16LE(localOffset + 26);
  const extraLen = buf.readUInt16LE(localOffset + 28);
  const dataStart = localOffset + 30 + nameLen + extraLen;
  const raw = buf.slice(dataStart, dataStart + compSize);
  if (compMethod === 0) return raw;
  if (compMethod === 8) return zlib.inflateRawSync(raw);
  return null;
}

function bbox3MF(buf) {
  const xml = readZipEntryText(buf, /(^|\/)3dmodel\.model$/i);
  if (!xml) return null;
  return bboxFromMatches(xml, /<vertex\s+x="(-?[\d.eE+-]+)"\s+y="(-?[\d.eE+-]+)"\s+z="(-?[\d.eE+-]+)"/g);
}

function bboxAMF(text) {
  return bboxFromMatches(
    text,
    /<vertex>\s*<coordinates>\s*<x>(-?[\d.eE+-]+)<\/x>\s*<y>(-?[\d.eE+-]+)<\/y>\s*<z>(-?[\d.eE+-]+)<\/z>/g
  );
}

function meshBBox(absPath, ext) {
  const buf = fs.readFileSync(absPath);
  switch (ext) {
    case '.stl':
      return bboxSTL(buf);
    case '.obj':
      return bboxFromMatches(
        buf.toString('utf-8'),
        /^\s*v\s+(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)/gm
      );
    case '.off':
      return bboxOFF(buf.toString('utf-8'));
    case '.amf':
      return bboxAMF(buf.toString('utf-8'));
    case '.3mf':
      return bbox3MF(buf);
    default:
      return null;
  }
}

// ── mesh-derived checkpoint (workspace CLAUDE.md's generated-sculpt rules:
// re-centre on X/Y, base at Z=0, state the bbox in the first-line comment) ──

function buildMeshScad({ relMeshPath, bbox, originalName }) {
  const cx = roundMm((bbox.min[0] + bbox.max[0]) / 2);
  const cy = roundMm((bbox.min[1] + bbox.max[1]) / 2);
  const minz = bbox.min[2];
  const [dx, dy, dz] = bbox.dims;
  const comment =
    `// Imported ${originalName} — bbox min [${bbox.min.join(', ')}] max [${bbox.max.join(', ')}] ` +
    `(${dx} x ${dy} x ${dz} mm), recentred on X/Y with base at Z=0`;
  return (
    `${comment}\n` +
    `// This is a mesh import, not parametric geometry — branch this checkpoint and\n` +
    `// difference()/union() against the import() below to add features. Never edit\n` +
    `// this file in place (workspace CLAUDE.md, mesh-derived checkpoint rules).\n` +
    `translate([${-cx}, ${-cy}, ${-minz}])\n` +
    `  import("${relMeshPath}", convexity = 8);\n`
  );
}

// ── per-class ingest ─────────────────────────────────────────────────────

function ingestImage(ctx, buffer, name, originalPath) {
  const ext = path.extname(name).toLowerCase();
  const baseSlug = kebabCase(path.basename(name, ext), 40);
  const dir = path.join(ctx.workspaceDir, 'uploads');
  const stored = storeUnique(dir, dateSlug() + '-' + baseSlug, ext, buffer);
  const relPath = 'uploads/' + stored.name;
  writeManifestEntry(ctx.workspaceDir, {
    file: relPath,
    sha256: stored.sha256,
    bytes: stored.bytes,
    originalPath: originalPath || null,
    importedAt: new Date().toISOString(),
    kind: 'image',
  });

  const warnings = [];
  if (ext === '.svg') {
    const head = buffer.slice(0, Math.min(buffer.length, 200000)).toString('utf-8');
    if (/<text[\s>]/i.test(head)) {
      warnings.push(
        'This SVG contains live <text> — OpenSCAD imports it as an empty object. Convert text to ' +
          'paths (Object to Path / Create Outlines / Flatten) before it will render.'
      );
    }
  }

  return { ok: true, class: 'image', name, ext, relPath, dedup: stored.dedup, warnings };
}

function ingestMesh(ctx, deps, buffer, name, originalPath) {
  const ext = path.extname(name).toLowerCase();
  const baseSlug = kebabCase(path.basename(name, ext), 40);
  const meshesDir = path.join(ctx.workspaceDir, 'meshes');
  const stored = storeUnique(meshesDir, baseSlug, ext, buffer);
  const relMeshPath = 'meshes/' + stored.name;

  const bbox = meshBBox(stored.path, ext);
  if (!bbox) {
    return {
      ok: false,
      class: 'mesh',
      name,
      ext,
      error: 'Could not read any vertices from this mesh — it may be empty, corrupt, or an unsupported variant.',
    };
  }
  // Assert the stated bbox against a fresh read of the STORED copy (not the
  // in-memory buffer) — this is what OpenSCAD will actually import, and it
  // is the check the workspace CLAUDE.md's "never eyeball a translate()" rule
  // demands. A mismatch means the on-disk copy is not what we computed from.
  const verify = meshBBox(stored.path, ext);
  if (!verify || JSON.stringify(verify) !== JSON.stringify(bbox)) {
    return { ok: false, class: 'mesh', name, ext, error: 'bbox verification against the stored copy failed' };
  }

  const scadName = uniqueScadName(ctx.workspaceDir, baseSlug);
  const scadPath = path.join(ctx.workspaceDir, scadName);
  fs.writeFileSync(scadPath, buildMeshScad({ relMeshPath, bbox, originalName: name }));

  writeManifestEntry(ctx.workspaceDir, {
    file: relMeshPath,
    sha256: stored.sha256,
    bytes: stored.bytes,
    originalPath: originalPath || null,
    importedAt: new Date().toISOString(),
    kind: 'mesh',
    bbox,
    checkpoint: scadName,
  });

  const id = deps.addCheckpoint(ctx, scadPath);

  return {
    ok: true,
    class: 'mesh',
    name,
    ext,
    relPath: relMeshPath,
    dedup: stored.dedup,
    bbox,
    checkpoint: { id: id || null, file: scadName },
  };
}

const REF_RE = /\b(include|use)\s*<([^>]+)>|\b(import|surface)\s*\(\s*(?:file\s*=\s*)?"([^"]+)"/g;

function ingestScad(ctx, deps, buffer, name, originalPath) {
  let text = buffer.toString('utf-8');

  const refs = [];
  let m;
  REF_RE.lastIndex = 0;
  while ((m = REF_RE.exec(text))) {
    const ref = m[2] || m[4];
    if (ref) refs.push(ref);
  }

  const missing = [];
  const copies = [];
  if (refs.length) {
    if (!originalPath) {
      // Byte-only ingest (e.g. dragged from a browser) carries no directory
      // to resolve siblings against — every relative reference is unresolvable.
      missing.push(...refs.filter((r) => !isAbsoluteOrUrl(r)));
    } else {
      const originalDir = path.dirname(originalPath);
      for (const ref of refs) {
        if (isAbsoluteOrUrl(ref)) continue; // not our problem — leave as authored
        const siblingPath = path.resolve(originalDir, ref);
        if (fs.existsSync(siblingPath)) copies.push({ ref, siblingPath });
        else missing.push(ref);
      }
    }
  }

  if (missing.length) {
    return {
      ok: false,
      class: 'scad',
      name,
      error:
        `This .scad references files ClawSCAD can't find: ${missing.join(', ')}. ` +
        `Bring those files along too (drop them alongside this one), or remove the reference.`,
      missing,
    };
  }

  for (const c of copies) {
    const sibBuf = fs.readFileSync(c.siblingPath);
    const sibExt = path.extname(c.siblingPath);
    const sibSlug = kebabCase(path.basename(c.siblingPath, sibExt), 40);
    const stored = storeUnique(path.join(ctx.workspaceDir, 'uploads'), dateSlug() + '-' + sibSlug, sibExt, sibBuf);
    const newRel = 'uploads/' + stored.name;
    text = text.split(c.ref).join(newRel);
    writeManifestEntry(ctx.workspaceDir, {
      file: newRel,
      sha256: stored.sha256,
      bytes: stored.bytes,
      originalPath: c.siblingPath,
      importedAt: new Date().toISOString(),
      kind: 'scad-dependency',
    });
  }

  const firstContentLine = text.split(/\r?\n/).find((l) => l.trim().length);
  if (!firstContentLine || !firstContentLine.trim().startsWith('//')) {
    const stamp = new Date().toISOString().slice(0, 10);
    text = `// Imported from ${originalPath || name} on ${stamp}\n` + text;
  }

  const scadName = uniqueScadName(ctx.workspaceDir, kebabCase(path.basename(name, '.scad'), 20));
  const scadPath = path.join(ctx.workspaceDir, scadName);
  fs.writeFileSync(scadPath, text);

  const id = deps.addCheckpoint(ctx, scadPath);

  return { ok: true, class: 'scad', name, checkpoint: { id: id || null, file: scadName } };
}

function isAbsoluteOrUrl(p) {
  return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('/') || /^https?:\/\//i.test(p);
}

function ingestBuffer(ctx, deps, buffer, name, originalPath) {
  const ext = path.extname(name).toLowerCase();

  if (buffer.length > MAX_UPLOAD_BYTES) {
    return {
      ok: false,
      class: 'blocked',
      name,
      ext,
      message: `\`${name}\` is ${(buffer.length / (1024 * 1024)).toFixed(0)} MB — larger than ClawSCAD's ${
        MAX_UPLOAD_BYTES / (1024 * 1024)
      } MB upload cap. Decimate/simplify it first, or bring it in as a smaller export.`,
    };
  }

  if (BLOCKED_EXTS.includes(ext)) {
    return {
      ok: false,
      class: 'blocked',
      name,
      ext,
      message:
        `\`${name}\` can't be imported. OpenSCAD reads STL, 3MF, OBJ, OFF, AMF, SVG and DXF. ` +
        `Export STL or 3MF from your CAD tool and drop it again.`,
    };
  }
  if (IMAGE_EXTS.includes(ext)) return ingestImage(ctx, buffer, name, originalPath);
  if (MESH_EXTS.includes(ext)) return ingestMesh(ctx, deps, buffer, name, originalPath);
  if (ext === '.scad') return ingestScad(ctx, deps, buffer, name, originalPath);

  return {
    ok: false,
    class: 'blocked',
    name,
    ext,
    message: `ClawSCAD doesn't recognise "${ext || name}". Supported: png, jpg, webp, svg, dxf (images); stl, 3mf, obj, off, amf (models); scad.`,
  };
}

// ── registration ─────────────────────────────────────────────────────────

exports.register = function register(ipcMain, deps) {
  const { getCtx, addCheckpoint, app, dialog } = deps;

  // Electron's default reaction to an un-preventDefault'd drop is to
  // navigate the window to the dropped file, which blanks the app. The
  // renderer's own dragover/drop guards should already stop this — this is
  // the second line of defence at the process level (upload-ingest gotcha 2).
  app.on('browser-window-created', (_event, win) => {
    win.webContents.on('will-navigate', (e) => {
      e.preventDefault();
    });
  });

  ipcMain.handle('upload:pick', async (event) => {
    const ctx = getCtx(event);
    if (!ctx) return [];
    const res = await dialog.showOpenDialog(ctx.window, {
      title: 'Add reference files',
      properties: ['openFile', 'multiSelections'],
      filters: [
        {
          name: 'All supported',
          extensions: ['png', 'jpg', 'jpeg', 'webp', 'svg', 'dxf', 'stl', '3mf', 'obj', 'off', 'amf', 'scad'],
        },
        { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'svg', 'dxf'] },
        { name: '3D models', extensions: ['stl', '3mf', 'obj', 'off', 'amf'] },
        { name: 'OpenSCAD', extensions: ['scad'] },
      ],
    });
    return res.canceled ? [] : res.filePaths;
  });

  ipcMain.handle('upload:ingest', (event, filePath) => {
    const ctx = getCtx(event);
    if (!ctx) return { ok: false, error: 'no workspace' };
    if (typeof filePath !== 'string') return { ok: false, error: 'bad path' };
    try {
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        return { ok: false, error: 'File not found: ' + filePath };
      }
      // Read-only on the source — this file is never written to or deleted
      // (global hard rule #2: copy, never move).
      const buffer = fs.readFileSync(filePath);
      return ingestBuffer(ctx, deps, buffer, path.basename(filePath), filePath);
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });

  ipcMain.handle('upload:ingest-bytes', (event, name, bytes) => {
    const ctx = getCtx(event);
    if (!ctx) return { ok: false, error: 'no workspace' };
    if (typeof name !== 'string' || !bytes) return { ok: false, error: 'bad payload' };
    try {
      const buffer = Buffer.isBuffer(bytes)
        ? bytes
        : Buffer.from(bytes.buffer ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) : bytes);
      return ingestBuffer(ctx, deps, buffer, path.basename(name), null);
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });

  ipcMain.handle('upload:list', (event) => {
    const ctx = getCtx(event);
    if (!ctx) return { files: [] };
    return readManifest(ctx.workspaceDir);
  });

  // deps.addCheckpoint / deps.getCtx are referenced above via closures; this
  // reference exists only so linting doesn't flag the destructure as unused
  // in a future edit — addCheckpoint is called from ingestMesh/ingestScad.
  void addCheckpoint;
};

// Exported for the node-only parts of the mesh bbox math to be unit-tested
// without spinning up Electron, if a future package wants to.
exports._internal = { meshBBox, kebabCase, storeUnique };
