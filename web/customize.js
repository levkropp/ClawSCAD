// web/customize.js — the Customize view: pick a model, turn its knobs, watch
// it re-render, download a printable 3MF.
//
// This is the half of the app the desktop Workbench owns (viewport, export
// buttons) rebuilt for the browser out of the one thing a browser CAN do
// cheaply: ask the server for a PNG. There is no three.js here on purpose — a
// server-side OpenSCAD render is what the exported 3MF will actually be, so
// the preview cannot drift from the artifact the way a client-side re-mesh can.
//
// The parameters come from web/scad-params.js, the SAME module the server uses
// to build its `-D` argv. One parser, so a control can never appear for a knob
// the export would ignore.
//
// The .scad is NEVER rewritten. Every value goes through `-D`, which is
// OpenSCAD's own customizer mechanism — the app's core promise is that every
// file is an immutable checkpoint, and a UI that edited them to "customize"
// would be the easiest possible way to break it.

const PREVIEW_DEBOUNCE_MS = 450;

export function mountCustomize(ctx, api, showToast) {
  const root = document.getElementById('customize');
  if (!root) return null;

  let models = [];
  let current = null; // { file, parameters, sections, skipped }
  let values = {};
  let previewTimer = null;
  let previewSeq = 0;
  let busy = false;

  // ── DOM ────────────────────────────────────────────────────────────────
  root.innerHTML = '';

  const head = el('div', 'cz-head');
  const title = el('h2', 'cz-title');
  title.textContent = 'Customize';
  const sub = el('p', 'cz-sub');
  sub.textContent = 'Turn the knobs, then download a 3MF you can slice and print.';
  head.append(title, sub);

  const pickRow = el('div', 'cz-pick');
  const pickLabel = el('label', 'cz-pick-label');
  pickLabel.textContent = 'Model';
  pickLabel.htmlFor = 'cz-model';
  const picker = document.createElement('select');
  picker.id = 'cz-model';
  picker.className = 'cz-select';
  const refreshBtn = button('cz-refresh', 'cz-btn', 'Refresh');
  pickRow.append(pickLabel, picker, refreshBtn);

  const body = el('div', 'cz-body');
  const fields = el('div', 'cz-fields');
  fields.id = 'cz-fields';

  const previewWrap = el('div', 'cz-preview');
  const previewImg = document.createElement('img');
  previewImg.id = 'cz-preview-img';
  previewImg.alt = 'Rendered preview of the current parameters';
  const previewNote = el('div', 'cz-preview-note');
  previewNote.id = 'cz-preview-note';
  previewWrap.append(previewImg, previewNote);

  body.append(fields, previewWrap);

  const actions = el('div', 'cz-actions');
  const status = el('span', 'cz-status');
  status.id = 'cz-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const stlBtn = button('cz-export-stl', 'cz-btn', 'STL');
  const mfBtn = button('cz-export-3mf', 'cz-btn cz-primary', 'Download 3MF');
  const resetBtn = button('cz-reset', 'cz-btn', 'Reset');
  actions.append(resetBtn, el('span', 'cz-spacer'), status, stlBtn, mfBtn);

  root.append(head, pickRow, body, actions);

  // ── behaviour ──────────────────────────────────────────────────────────

  function setBusy(on, message) {
    busy = on;
    for (const b of [mfBtn, stlBtn, resetBtn, refreshBtn, picker]) b.disabled = on;
    if (message !== undefined) status.textContent = message;
  }

  async function loadModels(preferred) {
    try {
      const res = await api.listModels();
      models = (res && res.models) || [];
    } catch {
      models = [];
    }
    picker.innerHTML = '';
    if (!models.length) {
      const opt = document.createElement('option');
      opt.textContent = 'No .scad files in this workspace yet';
      opt.value = '';
      picker.appendChild(opt);
      status.textContent = 'Make something first — a model will appear here.';
      fields.innerHTML = '';
      return;
    }
    for (const m of models) {
      const opt = document.createElement('option');
      opt.value = m.file;
      opt.textContent = m.file;
      picker.appendChild(opt);
    }
    const pick = preferred && models.some((m) => m.file === preferred) ? preferred : models[0].file;
    picker.value = pick;
    await selectModel(pick);
  }

  async function selectModel(file) {
    if (!file) return;
    setBusy(true, 'Reading parameters…');
    try {
      const info = await api.modelParams(file);
      if (!info || !info.ok) {
        status.textContent = (info && info.error) || 'Could not read that model.';
        fields.innerHTML = '';
        setBusy(false);
        return;
      }
      current = info;
      values = {};
      for (const p of info.parameters) values[p.name] = p.value;
      renderFields();
      setBusy(false, '');
      schedulePreview(true);
    } catch (err) {
      setBusy(false, String((err && err.message) || err));
    }
  }

  function renderFields() {
    fields.innerHTML = '';
    if (!current || !current.parameters.length) {
      const empty = el('div', 'cz-empty');
      empty.textContent =
        'This model exposes no adjustable parameters. Ask for it again and say "expose every ' +
        'dimension as a top-level variable" — OpenSCAD only offers variables declared before the ' +
        'first module.';
      fields.appendChild(empty);
      return;
    }

    // Group by section, preserving the file's own order.
    const groups = new Map();
    for (const p of current.parameters) {
      const key = p.section || '';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(p);
    }

    for (const [section, params] of groups) {
      const group = el('div', 'cz-group');
      if (section) {
        const h = el('div', 'cz-group-label');
        h.textContent = section;
        group.appendChild(h);
      }
      for (const p of params) group.appendChild(fieldFor(p));
      fields.appendChild(group);
    }
  }

  function fieldFor(p) {
    const row = el('div', 'cz-field');
    row.dataset.param = p.name;

    const label = el('label', 'cz-label');
    label.htmlFor = `cz-p-${p.name}`;
    label.textContent = p.name.replace(/^\$/, '').replace(/_/g, ' ');
    row.appendChild(label);

    let input;
    if (p.control === 'checkbox') {
      input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = Boolean(p.value);
      input.className = 'cz-input cz-check';
    } else if (p.control === 'select') {
      input = document.createElement('select');
      input.className = 'cz-input cz-select';
      for (const o of p.options || []) {
        const opt = document.createElement('option');
        opt.value = String(o.value);
        opt.textContent = o.label;
        if (String(o.value) === String(p.value)) opt.selected = true;
        input.appendChild(opt);
      }
    } else if (p.control === 'slider') {
      input = document.createElement('input');
      input.type = 'range';
      input.min = String(p.min);
      input.max = String(p.max);
      input.step = String(p.step ?? guessStep(p));
      input.value = String(p.value);
      input.className = 'cz-input cz-range';
    } else if (p.kind === 'number') {
      input = document.createElement('input');
      input.type = 'number';
      input.value = String(p.value);
      input.className = 'cz-input';
    } else {
      input = document.createElement('input');
      input.type = 'text';
      input.value = String(p.value ?? '');
      input.className = 'cz-input';
    }
    input.id = `cz-p-${p.name}`;
    row.appendChild(input);

    // A slider with no readout is a guess; the number is the point.
    const readout = el('output', 'cz-readout');
    readout.htmlFor = input.id;
    readout.textContent = formatValue(p, p.value);
    if (p.control === 'slider' || p.kind === 'number') row.appendChild(readout);

    if (p.description) {
      const hint = el('div', 'cz-hint');
      hint.textContent = p.description;
      row.appendChild(hint);
    }

    const onInput = () => {
      const v =
        p.control === 'checkbox'
          ? input.checked
          : p.kind === 'number'
            ? Number(input.value)
            : coerceOption(p, input.value);
      values[p.name] = v;
      readout.textContent = formatValue(p, v);
      schedulePreview(false);
    };
    input.addEventListener('input', onInput);
    input.addEventListener('change', onInput);
    return row;
  }

  function coerceOption(p, raw) {
    if (p.control !== 'select') return raw;
    const match = (p.options || []).find((o) => String(o.value) === String(raw));
    return match ? match.value : raw;
  }

  function guessStep(p) {
    const span = Math.abs((p.max ?? 100) - (p.min ?? 0));
    if (!Number.isFinite(span) || span === 0) return 1;
    if (!Number.isInteger(p.value) || span <= 5) return 0.1;
    return span > 200 ? 5 : 1;
  }

  function formatValue(p, v) {
    if (p.control === 'checkbox') return v ? 'on' : 'off';
    if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
    return String(v ?? '');
  }

  /** Debounced so dragging a slider does not spawn an OpenSCAD per pixel.
   *  `previewSeq` discards a stale render that finishes after a newer one. */
  function schedulePreview(immediate) {
    if (!current) return;
    if (previewTimer) clearTimeout(previewTimer);
    previewTimer = setTimeout(runPreview, immediate ? 0 : PREVIEW_DEBOUNCE_MS);
  }

  async function runPreview() {
    if (!current) return;
    const seq = ++previewSeq;
    previewNote.textContent = 'Rendering…';
    try {
      const out = await api.renderPreview(current.file, values);
      if (seq !== previewSeq) return; // a newer render already won
      if (!out || !out.ok) {
        previewNote.textContent = (out && out.error) || 'That did not render.';
        previewImg.removeAttribute('src');
        return;
      }
      previewImg.src = `/api/pipeline/image?path=${encodeURIComponent(out.path)}&t=${Date.now()}`;
      previewNote.textContent = out.warnings ? `Rendered, with warnings: ${out.warnings.slice(0, 160)}` : '';
    } catch (err) {
      if (seq !== previewSeq) return;
      previewNote.textContent = String((err && err.message) || err);
    }
  }

  async function exportModel(format) {
    if (!current || busy) return;
    setBusy(true, `Building ${format.toUpperCase()}…`);
    try {
      const out = await api.exportModel(current.file, values, format);
      if (!out || !out.ok) {
        setBusy(false, (out && out.error) || 'Export failed.');
        showToast((out && out.error) || 'Export failed.', 'error');
        return;
      }
      // A real navigation to the download endpoint: the browser gets
      // Content-Disposition: attachment and saves it, no blob juggling.
      const a = document.createElement('a');
      a.href = `/api/model/download?path=${encodeURIComponent(out.path)}`;
      a.download = '';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setBusy(false, `${format.toUpperCase()} ready — ${(out.bytes / 1024).toFixed(0)} KB`);
      showToast(`${format.toUpperCase()} downloaded`, 'success');
    } catch (err) {
      setBusy(false, String((err && err.message) || err));
    }
  }

  picker.addEventListener('change', () => selectModel(picker.value));
  refreshBtn.addEventListener('click', () => loadModels(picker.value));
  mfBtn.addEventListener('click', () => exportModel('3mf'));
  stlBtn.addEventListener('click', () => exportModel('stl'));
  resetBtn.addEventListener('click', () => {
    if (!current) return;
    values = {};
    for (const p of current.parameters) values[p.name] = p.value;
    renderFields();
    schedulePreview(true);
  });

  loadModels();

  const iface = {
    refresh: (preferred) => loadModels(preferred),
    getValues: () => ({ ...values }),
    getModel: () => (current ? current.file : null),
    selectModel,
  };
  try {
    window.clawscadCustomize = iface;
  } catch {}
  return iface;
}

// ── tiny DOM helpers (same idiom as studio.js) ──────────────────────────
function el(tag, className) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  return n;
}

function button(id, className, text) {
  const b = document.createElement('button');
  b.type = 'button';
  if (id) b.id = id;
  b.className = className;
  b.textContent = text;
  return b;
}
