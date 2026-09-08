// renderer/uploads.js — P2 (upload & ingest). Owned exclusively by the
// uploads package. Extends the composer via ctx.composer.registerSection()
// rather than owning a new top-level DOM container (master plan §4.3).
//
// Design (master plan §3 W2 "done when"): dropping/picking a file only
// STAGES it in memory and renders a chip — nothing touches disk yet. The
// real copy-into-workspace + checkpoint work happens inside the composer's
// onSubmit hook, which the composer AWAITS before it dispatches the prompt
// (renderer/composer.js — this is the entire P1/P2 coupling).
//
// IMPORTANT: renderer.js is bundled as ESM and ESM imports hoist — this
// module's top-level body runs BEFORE renderer.js's own body finishes. All
// work happens inside mountUploads(ctx), never at import time.

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.svg', '.dxf']);
const MESH_EXTS = new Set(['.stl', '.3mf', '.obj', '.off', '.amf']);
const BLOCKED_EXTS = new Set(['.step', '.stp', '.f3d']);
const KNOWN_EXTS = new Set([...IMAGE_EXTS, ...MESH_EXTS, '.scad']);

function extOf(name) {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i).toLowerCase() : '';
}

function classify(name) {
  const ext = extOf(name);
  if (BLOCKED_EXTS.has(ext)) {
    return {
      ext,
      class: 'blocked',
      message: `\`${name}\` can't be imported. OpenSCAD reads STL, 3MF, OBJ, OFF, AMF, SVG and DXF. Export STL or 3MF from your CAD tool and drop it again.`,
    };
  }
  if (IMAGE_EXTS.has(ext)) return { ext, class: 'image' };
  if (MESH_EXTS.has(ext)) return { ext, class: 'mesh' };
  if (ext === '.scad') return { ext, class: 'scad' };
  return {
    ext,
    class: 'blocked',
    message: `ClawSCAD doesn't recognise "${ext || name}". Supported: png, jpg, webp, svg, dxf (images); stl, 3mf, obj, off, amf (models); scad.`,
  };
}

function fmtBbox(bbox) {
  if (!bbox) return '';
  const [dx, dy, dz] = bbox.dims;
  return `${dx} x ${dy} x ${dz} mm`;
}

let seq = 0;
function nextId() {
  seq += 1;
  return 'up_' + seq;
}

export function mountUploads(ctx) {
  /** @type {Array<Record>} */
  const records = [];
  let composerSectionEl = null;
  let chipsEl = null;

  // Belt-and-suspenders against a miss-aimed drop navigating the window and
  // blanking the app (upload-ingest gotcha 2) — installed unconditionally,
  // even if the composer container isn't present in a stale harness.
  window.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('drop', (e) => {
    // Only swallow the default (navigate-to-file) behaviour here; actual
    // file handling is wired below, scoped to the composer section, once it
    // exists. A drop outside the composer still must not navigate the app.
    if (!composerSectionEl || !composerSectionEl.contains(e.target)) {
      e.preventDefault();
    }
  });

  if (!ctx.composer) return; // no-op cleanly — nothing else to attach to

  function renderChips() {
    if (!chipsEl) return;
    chipsEl.innerHTML = '';
    const target = ctx.composer.getTarget();
    for (const rec of records) {
      const chip = document.createElement('div');
      chip.className = 'file-chip';
      chip.dataset.class = rec.class;
      chip.dataset.id = rec.id;

      const badge = document.createElement('span');
      badge.className = 'file-chip-badge';
      badge.textContent = rec.ext ? rec.ext.slice(1).toUpperCase() : '?';
      chip.appendChild(badge);

      const nameEl = document.createElement('span');
      nameEl.className = 'file-chip-name';
      nameEl.textContent = rec.name;
      chip.appendChild(nameEl);

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'file-chip-remove';
      removeBtn.setAttribute('aria-label', 'Remove ' + rec.name);
      removeBtn.textContent = '×';
      removeBtn.addEventListener('click', () => {
        const idx = records.indexOf(rec);
        if (idx >= 0) records.splice(idx, 1);
        renderChips();
        ctx.composer.refresh();
      });
      chip.appendChild(removeBtn);

      const notes = [];
      if (rec.class === 'blocked') notes.push(rec.message);
      if (rec.class === 'image' && target !== 'part') {
        notes.push(
          "Reference images don't reach the image backends yet — this file will be ignored for image generation. It works on the Part target."
        );
      }
      if (rec.ingestError) notes.push(rec.ingestError);
      if (rec.warnings && rec.warnings.length) notes.push(...rec.warnings);
      if (rec.ingested && rec.result && rec.result.bbox) {
        notes.push(`bbox ${fmtBbox(rec.result.bbox)}`);
      }
      if (notes.length) {
        const note = document.createElement('div');
        note.className = 'file-chip-note';
        note.textContent = notes.join(' ');
        chip.appendChild(note);
      }

      chipsEl.appendChild(chip);
    }
  }

  async function stageFile(file) {
    const info = classify(file.name);
    const rec = {
      id: nextId(),
      name: file.name,
      ext: info.ext,
      class: info.class,
      message: info.message || null,
      source: 'bytes',
      bytes: null,
      path: null,
      ingested: false,
      ingestError: null,
      result: null,
      warnings: [],
    };
    // Blocked files are staged (so the user sees WHY, per master plan §1.14 —
    // copy must name the fix, never just refuse silently) but their bytes are
    // never read or touched otherwise.
    if (info.class !== 'blocked') {
      // Prefer a real on-disk path over buffering the whole file into
      // renderer memory — File.path was removed in Electron 32+, so this
      // must go through webUtils in preload. Guard for an older preload
      // without the bridge (undefined ctx.api.pathForFile) as well as a
      // virtual file (browser/Outlook drag) that legitimately has no path —
      // both fall back to the bytes route.
      let realPath = null;
      if (ctx.api && typeof ctx.api.pathForFile === 'function') {
        try {
          realPath = ctx.api.pathForFile(file);
        } catch {
          realPath = null;
        }
      }
      if (realPath) {
        rec.source = 'path';
        rec.path = realPath;
      } else {
        try {
          rec.bytes = new Uint8Array(await file.arrayBuffer());
        } catch (err) {
          rec.ingestError = 'Could not read this file in the browser.';
        }
      }
    }
    records.push(rec);
    renderChips();
    ctx.composer.refresh();
  }

  function stagePath(fullPath) {
    const name = fullPath.split(/[\\/]/).pop();
    const info = classify(name);
    records.push({
      id: nextId(),
      name,
      ext: info.ext,
      class: info.class,
      message: info.message || null,
      source: 'path',
      path: fullPath,
      bytes: null,
      ingested: false,
      ingestError: null,
      result: null,
      warnings: [],
    });
    renderChips();
    ctx.composer.refresh();
  }

  async function ingestAll() {
    for (const rec of records) {
      if (rec.class === 'blocked' || rec.ingested) continue;
      try {
        const result =
          rec.source === 'path'
            ? await ctx.api.uploadIngest(rec.path)
            : await ctx.api.uploadIngestBytes(rec.name, rec.bytes);
        if (result && result.ok) {
          rec.ingested = true;
          rec.result = result;
          if (result.warnings) rec.warnings = result.warnings;
        } else {
          rec.ingestError = (result && (result.error || result.message)) || "Couldn't attach this file.";
        }
      } catch (err) {
        rec.ingestError = String((err && err.message) || err);
      }
    }
    renderChips();
  }

  function preamble() {
    const target = ctx.composer.getTarget();
    const lines = [];
    for (const rec of records) {
      if (rec.class === 'blocked') continue; // never reaches Claude or the pipeline
      if (rec.class === 'image' && target !== 'part') {
        lines.push(
          `- ${rec.name}: reference image, not usable by the image/sculpt pipeline yet. Ignored for generation (works on the Part target).`
        );
        continue;
      }
      if (rec.ingested && rec.result) {
        const r = rec.result;
        if (r.class === 'mesh') {
          lines.push(
            `- ${r.relPath}: uploaded mesh, bbox ${fmtBbox(r.bbox)}, recentred on X/Y with base at Z=0 in checkpoint ${
              r.checkpoint && r.checkpoint.file
            }. It has no features — you can only boolean against it (difference()/union()) or transform it, never thicken a wall or edit a dimension.`
          );
        } else if (r.class === 'image') {
          lines.push(`- ${r.relPath}: uploaded image, available to import()/surface() from a part checkpoint.`);
          if (r.warnings) for (const w of r.warnings) lines.push(`  (${w})`);
        } else if (r.class === 'scad') {
          lines.push(`- uploaded .scad landed as checkpoint ${r.checkpoint && r.checkpoint.file}.`);
        }
      } else if (rec.ingestError) {
        lines.push(`- ${rec.name}: not attached (${rec.ingestError}).`);
      } else {
        lines.push(`- ${rec.name}: attached, will be copied into the workspace on submit.`);
      }
    }
    return lines;
  }

  ctx.composer.registerSection({
    id: 'uploads',
    order: 10,
    mount(el) {
      composerSectionEl = el;

      const row = document.createElement('div');
      row.className = 'uploads-row';

      const addBtn = document.createElement('button');
      addBtn.type = 'button';
      addBtn.id = 'uploads-add-btn';
      addBtn.className = 'small-btn';
      addBtn.textContent = 'Add files…';
      addBtn.addEventListener('click', async () => {
        if (!ctx.api || !ctx.api.uploadPick) return;
        const paths = await ctx.api.uploadPick();
        for (const p of paths || []) stagePath(p);
      });
      row.appendChild(addBtn);

      const hint = document.createElement('span');
      hint.className = 'uploads-hint';
      hint.textContent = 'or drop images, meshes, or .scad files here';
      row.appendChild(hint);

      el.appendChild(row);

      chipsEl = document.createElement('div');
      chipsEl.id = 'uploads-chips';
      chipsEl.className = 'file-chip-row';
      el.appendChild(chipsEl);

      el.addEventListener('dragover', (e) => {
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
        el.classList.add('is-drag-over');
      });
      el.addEventListener('dragleave', () => el.classList.remove('is-drag-over'));
      el.addEventListener('drop', (e) => {
        e.preventDefault();
        // Stop this from also reaching the composerRoot listener below — the
        // section is nested inside #composer, so an un-stopped drop here
        // would stage every file twice.
        e.stopPropagation();
        el.classList.remove('is-drag-over');
        const files = e.dataTransfer ? Array.from(e.dataTransfer.files) : [];
        for (const f of files) stageFile(f);
      });

      // Also accept a drop anywhere in the composer/right rail, not just the
      // narrow uploads row — the whole composer is the "front door".
      const composerRoot = el.closest('#composer');
      if (composerRoot) {
        composerRoot.addEventListener('dragover', (e) => {
          e.preventDefault();
          if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
        });
        composerRoot.addEventListener('drop', (e) => {
          e.preventDefault();
          const files = e.dataTransfer ? Array.from(e.dataTransfer.files) : [];
          for (const f of files) stageFile(f);
        });
      }

      // Re-render chips when the target changes so the gen-target raster
      // warning stays live. Listens after the composer's own click handler
      // (delegated on the parent, so bubbling always arrives second).
      const targetsEl = document.getElementById('composer-targets');
      if (targetsEl) targetsEl.addEventListener('click', () => renderChips());

      renderChips();
    },
    preamble,
    blocks() {
      return null; // uploads never block submission — only presets' refusal cards do
    },
  });

  ctx.composer.onSubmit(async () => {
    if (!records.length) return;
    await ingestAll();
  });
}
