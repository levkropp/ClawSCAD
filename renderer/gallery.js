// renderer/gallery.js — P4 (gallery). Owned exclusively by the gallery
// package.
//
// renderer.js is bundled by esbuild as ESM (--format=esm), and ESM imports
// hoist — this module's top-level body runs BEFORE renderer.js's own body
// finishes executing. Nothing at the top level of this file reads the DOM
// or touches `ctx`; all of that happens inside mountGallery(ctx), which
// renderer.js calls once, at the very end of its init, after `ctx` is fully
// populated (see renderer/bus.js's clawscad:anchor:modules block).
//
// This module never imports renderer/bus.js itself — mountGallery receives
// the same shared `ctx` object as a parameter, which is all it needs.

const FILTERS = [
  ['all', 'All'],
  ['parts', 'Parts'],
  ['sculpts', 'Sculpts'],
  ['images', 'Images'],
];

const KIND_GLYPH = { generated: '◆', image: '▤', parametric: '▣' };
const KIND_WORD = {
  generated: 'generated sculpt',
  image: 'image batch',
  parametric: 'parametric part',
};

export function mountGallery(ctx) {
  const sheetEl = ctx.els && ctx.els.gallerySheet;
  if (!sheetEl) return;

  const state = { scope: 'current', filter: 'all', search: '', selected: null, selectedKey: null };
  let isOpen = false;
  let openerEl = null;
  let headerBtn = null;
  let workspacesData = [];
  let jobsData = { jobsRoot: '', jobs: [], error: null };

  // ── DOM (built once; the sheet's children are otherwise empty per the
  // anchored stub in index.html) ──────────────────────────────────────────

  sheetEl.innerHTML = '';

  const scrim = document.createElement('div');
  scrim.className = 'gallery-scrim';
  scrim.addEventListener('click', closeSheet);

  const modal = document.createElement('div');
  modal.className = 'gallery-modal';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-labelledby', 'gallery-title');
  modal.tabIndex = -1;

  const header = document.createElement('div');
  header.className = 'gallery-header';

  const title = document.createElement('span');
  title.id = 'gallery-title';
  title.className = 'label';
  title.textContent = 'Gallery';

  const scopeSel = document.createElement('select');
  scopeSel.id = 'gallery-scope';
  scopeSel.setAttribute('aria-label', 'Scope');
  scopeSel.addEventListener('change', () => {
    state.scope = scopeSel.value;
    state.selected = null;
    state.selectedKey = null;
    render();
  });

  const filterGroup = document.createElement('div');
  filterGroup.id = 'gallery-filter';
  filterGroup.setAttribute('role', 'group');
  filterGroup.setAttribute('aria-label', 'Filter by kind');
  for (const [key, label] of FILTERS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.filter = key;
    b.textContent = label;
    b.setAttribute('aria-pressed', key === state.filter ? 'true' : 'false');
    b.addEventListener('click', () => {
      state.filter = key;
      render();
    });
    filterGroup.appendChild(b);
  }

  const search = document.createElement('input');
  search.id = 'gallery-search';
  search.type = 'search';
  search.placeholder = 'Search names and descriptions…';
  search.setAttribute('aria-label', 'Search checkpoints and image batches');
  search.addEventListener('input', () => {
    state.search = search.value;
    render();
  });

  const closeBtn = document.createElement('button');
  closeBtn.id = 'gallery-close-btn';
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', 'Close gallery');
  closeBtn.textContent = '×';
  closeBtn.addEventListener('click', closeSheet);

  header.append(title, scopeSel, filterGroup, search, closeBtn);

  const body = document.createElement('div');
  body.className = 'gallery-body';

  const workspaceErrors = document.createElement('div');
  workspaceErrors.className = 'gallery-workspace-errors';
  workspaceErrors.hidden = true;

  const grid = document.createElement('div');
  grid.id = 'gallery-grid';
  grid.setAttribute('role', 'list');

  const empty = document.createElement('div');
  empty.id = 'gallery-empty';
  empty.className = 'gallery-empty';
  empty.hidden = true;

  body.append(workspaceErrors, grid, empty);

  const detail = document.createElement('div');
  detail.id = 'gallery-detail';
  detail.setAttribute('aria-live', 'polite');
  const detailText = document.createElement('div');
  detailText.id = 'gallery-detail-text';
  const detailActions = document.createElement('div');
  detailActions.id = 'gallery-detail-actions';
  detail.append(detailText, detailActions);

  modal.append(header, body, detail);
  sheetEl.append(scrim, modal);

  injectEntryButtons();
  wireGlobalShortcut();
  if (typeof ctx.onCheckpointsChanged === 'function') {
    ctx.onCheckpointsChanged(() => {
      if (isOpen) refresh();
    });
  }

  // ── Entry points ─────────────────────────────────────────────────────

  function injectEntryButtons() {
    const appHeader = document.getElementById('app-header');
    if (appHeader) {
      headerBtn = document.createElement('button');
      headerBtn.id = 'gallery-open-btn';
      headerBtn.type = 'button';
      headerBtn.className = 'header-btn';
      headerBtn.textContent = 'Gallery';
      headerBtn.title = 'Open the gallery (Ctrl+G)';
      headerBtn.addEventListener('click', () => openSheet(headerBtn));
      appHeader.appendChild(headerBtn);
    }

    const cpHeader = document.getElementById('checkpoint-header');
    if (cpHeader) {
      const cpBtn = document.createElement('button');
      cpBtn.id = 'checkpoint-gallery-btn';
      cpBtn.type = 'button';
      cpBtn.className = 'small-btn';
      cpBtn.title = 'Open the gallery';
      cpBtn.textContent = 'Gallery';
      cpBtn.addEventListener('click', () => openSheet(cpBtn));
      // MUST land after .spacer (master plan §4.2 / arch-map §3.2): appending
      // at the very end of the header guarantees that without disturbing
      // #cp-desc-toggle / #resume-session-btn ordering, and leaves
      // #checkpoint-header .label's exact text "Checkpoints" untouched
      // (ui-surfaces.spec.js:120).
      cpHeader.appendChild(cpBtn);
    }
  }

  function wireGlobalShortcut() {
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === 'g' || e.key === 'G')) {
        if (!isOpen) {
          e.preventDefault();
          openSheet(headerBtn || document.activeElement);
        }
      }
    });
  }

  // ── Open / close / focus trap ───────────────────────────────────────────

  function getFocusable() {
    return Array.from(
      modal.querySelectorAll(
        'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )
    );
  }

  function onKeydownTrap(e) {
    if (!isOpen) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      closeSheet();
      return;
    }
    if (e.key !== 'Tab') return;
    const focusables = getFocusable();
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  function openSheet(opener) {
    if (isOpen) return;
    isOpen = true;
    openerEl = opener || document.activeElement;
    sheetEl.hidden = false;
    requestAnimationFrame(() => sheetEl.classList.add('gallery-open'));
    document.addEventListener('keydown', onKeydownTrap, true);
    const focusables = getFocusable();
    (focusables[0] || modal).focus();
    refresh();
  }

  function closeSheet() {
    if (!isOpen) return;
    isOpen = false;
    sheetEl.classList.remove('gallery-open');
    sheetEl.hidden = true;
    document.removeEventListener('keydown', onKeydownTrap, true);
    state.selected = null;
    state.selectedKey = null;
    if (openerEl && typeof openerEl.focus === 'function') openerEl.focus();
    openerEl = null;
  }

  // ── Data ─────────────────────────────────────────────────────────────

  async function loadData() {
    try {
      const [listRes, jobsRes] = await Promise.all([ctx.api.galleryList(), ctx.api.galleryListJobs()]);
      workspacesData = (listRes && listRes.workspaces) || [];
      jobsData = jobsRes || { jobsRoot: '', jobs: [], error: null };
    } catch (err) {
      workspacesData = [];
      jobsData = { jobsRoot: '', jobs: [], error: String((err && err.message) || err) };
    }
    populateScopeOptions();
  }

  async function refresh() {
    await loadData();
    render();
  }

  function populateScopeOptions() {
    const prev = state.scope;
    scopeSel.innerHTML = '';
    const cur = workspacesData.find((w) => w.isCurrent);

    const optCurrent = document.createElement('option');
    optCurrent.value = 'current';
    optCurrent.textContent = 'This workspace' + (cur ? ` (${cur.label})` : '');
    scopeSel.appendChild(optCurrent);

    for (const ws of workspacesData) {
      if (ws.isCurrent) continue;
      const opt = document.createElement('option');
      opt.value = ws.dir;
      opt.textContent = ws.label + (ws.ok === false ? ' — unavailable' : '');
      scopeSel.appendChild(opt);
    }

    if (workspacesData.length > 1) {
      const optAll = document.createElement('option');
      optAll.value = 'all';
      optAll.textContent = 'All recent workspaces';
      scopeSel.appendChild(optAll);
    }

    const values = Array.from(scopeSel.options).map((o) => o.value);
    state.scope = values.includes(prev) ? prev : 'current';
    scopeSel.value = state.scope;
  }

  // ── Items: checkpoints (per-workspace scope) + image jobs (current
  // workspace only — preload's galleryListJobs() takes no workspace arg) ──

  function buildCheckpointItems(ws) {
    const items = [];
    const cps = ws.checkpoints || {};
    for (const [id, cp] of Object.entries(cps)) {
      items.push({
        type: 'checkpoint',
        id,
        workspaceDir: ws.dir,
        workspaceLabel: ws.label,
        isCurrent: ws.isCurrent,
        kind: cp.kind === 'generated' ? 'generated' : 'parametric',
        discovered: !!cp.discovered,
        label: cp.label || cp.file || id,
        description: cp.description || '',
        file: cp.file,
        created: cp.created ? Date.parse(cp.created) || 0 : 0,
        sessionId: cp.sessionId || null,
      });
    }
    return items;
  }

  function buildJobItems(ws) {
    if (!ws || !jobsData || !Array.isArray(jobsData.jobs)) return [];
    return jobsData.jobs
      .filter((j) => !j.error)
      .map((j) => ({
        type: 'job',
        id: j.name,
        workspaceDir: ws.dir,
        workspaceLabel: ws.label,
        isCurrent: true,
        kind: 'image',
        label: j.text || j.slug || j.name,
        description: j.prompt && j.prompt !== j.text ? j.prompt : '',
        created: j.created ? Date.parse(j.created) || 0 : 0,
        thumbs: j.thumbs || [],
        candidateCount: j.candidateCount || 0,
        roundCount: j.roundCount || 0,
        checkpointScad: (j.checkpoint && j.checkpoint.scad) || null,
        dir: j.dir,
      }));
  }

  function collectItems() {
    const items = [];
    const currentWs = workspacesData.find((w) => w.isCurrent);
    for (const ws of workspacesData) {
      if (ws.ok === false) continue; // surfaced separately as an error row
      if (state.scope === 'current' && !ws.isCurrent) continue;
      if (state.scope !== 'current' && state.scope !== 'all' && ws.dir !== state.scope) continue;
      items.push(...buildCheckpointItems(ws));
    }
    const jobsEligible =
      state.scope === 'current' ||
      state.scope === 'all' ||
      (currentWs && state.scope === currentWs.dir);
    if (jobsEligible && currentWs) items.push(...buildJobItems(currentWs));
    return items;
  }

  function visibleItems() {
    const q = state.search.trim().toLowerCase();
    return collectItems()
      .filter((it) => {
        if (state.filter === 'parts' && it.kind !== 'parametric') return false;
        if (state.filter === 'sculpts' && it.kind !== 'generated') return false;
        if (state.filter === 'images' && it.kind !== 'image') return false;
        if (q) {
          const hay = `${it.label} ${it.description}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      })
      .sort((a, b) => b.created - a.created);
  }

  function cardKey(item) {
    return `${item.type}:${item.workspaceDir}:${item.id}`;
  }

  // ── Grouping ─────────────────────────────────────────────────────────

  function dayBucket(ms) {
    if (!ms) return 'Unknown date';
    const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const today = startOfDay(new Date());
    const day = startOfDay(new Date(ms));
    const diffDays = Math.round((today - day) / 86400000);
    if (diffDays === 0) return 'Today';
    if (diffDays === 1) return 'Yesterday';
    if (diffDays > 1 && diffDays <= 7) return 'Earlier this week';
    return new Date(ms).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  }

  // ── Render ───────────────────────────────────────────────────────────

  function render() {
    syncFilterButtons();
    renderWorkspaceErrors();

    const items = visibleItems();
    grid.innerHTML = '';

    if (!items.length) {
      empty.hidden = false;
      grid.hidden = true;
      empty.innerHTML = emptyStateHtml();
    } else {
      empty.hidden = true;
      grid.hidden = false;
      let lastBucket = null;
      for (const it of items) {
        const bucket = dayBucket(it.created);
        if (bucket !== lastBucket) {
          const heading = document.createElement('div');
          heading.className = 'gallery-day-heading';
          heading.style.gridColumn = '1 / -1';
          heading.textContent = bucket;
          grid.appendChild(heading);
          lastBucket = bucket;
        }
        grid.appendChild(buildCard(it));
      }
    }

    renderDetail();
  }

  function syncFilterButtons() {
    filterGroup.querySelectorAll('button').forEach((b) => {
      b.setAttribute('aria-pressed', b.dataset.filter === state.filter ? 'true' : 'false');
    });
  }

  function renderWorkspaceErrors() {
    const errored = workspacesData.filter((w) => !w.isCurrent && w.ok === false);
    if (!errored.length) {
      workspaceErrors.hidden = true;
      workspaceErrors.innerHTML = '';
      return;
    }
    workspaceErrors.hidden = false;
    workspaceErrors.innerHTML = errored
      .map(
        (w) =>
          `<div class="gallery-workspace-error">Could not read ${escapeHtml(w.label)} (${escapeHtml(
            w.dir
          )}): ${escapeHtml(w.error || 'unknown error')}</div>`
      )
      .join('');
  }

  function buildCard(item) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'gallery-card';
    btn.setAttribute('role', 'listitem');
    btn.dataset.id = item.id;
    btn.dataset.type = item.type;

    const glyph = KIND_GLYPH[item.kind] || KIND_GLYPH.parametric;
    const timeLabel = item.created
      ? new Date(item.created).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
      : '';
    btn.setAttribute(
      'aria-label',
      `${item.label}, ${KIND_WORD[item.kind] || 'checkpoint'}${timeLabel ? ', ' + timeLabel : ''}`
    );

    if (item.type === 'job' && item.thumbs && item.thumbs.length) {
      const mosaic = document.createElement('div');
      mosaic.className = 'gallery-thumb-mosaic';
      for (let i = 0; i < 4; i++) {
        if (item.thumbs[i]) {
          const img = document.createElement('img');
          img.src = item.thumbs[i];
          img.alt = '';
          mosaic.appendChild(img);
        } else {
          mosaic.appendChild(document.createElement('div'));
        }
      }
      btn.appendChild(mosaic);
    } else {
      const thumb = document.createElement('div');
      thumb.className = 'gallery-thumb';
      const g = document.createElement('span');
      g.className = 'gallery-card-glyph' + (item.kind === 'generated' ? ' gen' : item.kind === 'image' ? ' image' : '');
      g.textContent = glyph;
      thumb.appendChild(g);
      btn.appendChild(thumb);
    }

    // .cp-badge / .cp-badge-found are REUSED verbatim from style.css (not
    // re-implemented) — same classes, same colours, same text the tree uses.
    const badges = document.createElement('div');
    badges.className = 'gallery-card-badges';
    if (item.kind === 'generated') {
      const b = document.createElement('span');
      b.className = 'cp-badge';
      b.textContent = 'GEN';
      badges.appendChild(b);
    }
    if (item.discovered) {
      const b = document.createElement('span');
      b.className = 'cp-badge cp-badge-found';
      b.textContent = 'FOUND';
      badges.appendChild(b);
    }
    if (badges.childNodes.length) btn.appendChild(badges);

    const cardBody = document.createElement('div');
    cardBody.className = 'gallery-card-body';

    const label = document.createElement('div');
    label.className = 'gallery-card-label';
    label.textContent = item.label;
    label.title = item.label;

    const meta = document.createElement('div');
    meta.className = 'gallery-card-meta';
    const metaGlyph = document.createElement('span');
    metaGlyph.className = 'gallery-card-glyph' + (item.kind === 'generated' ? ' gen' : item.kind === 'image' ? ' image' : '');
    metaGlyph.textContent = glyph;
    meta.appendChild(metaGlyph);
    const metaTime = document.createElement('span');
    metaTime.textContent = timeLabel || '—';
    meta.appendChild(metaTime);
    if (item.type === 'job') {
      const metaCount = document.createElement('span');
      metaCount.textContent = `· ${item.candidateCount || 0}`;
      meta.appendChild(metaCount);
    }
    if (!item.isCurrent) {
      const metaWs = document.createElement('span');
      metaWs.textContent = `· ${item.workspaceLabel}`;
      meta.appendChild(metaWs);
    }

    cardBody.append(label, meta);
    btn.appendChild(cardBody);

    if (cardKey(item) === state.selectedKey) btn.classList.add('selected');

    btn.addEventListener('click', () => selectItem(item));
    return btn;
  }

  function selectItem(item) {
    state.selected = item;
    state.selectedKey = cardKey(item);
    render();
  }

  function renderDetail() {
    const item = state.selected;
    detailActions.innerHTML = '';
    if (!item) {
      detailText.innerHTML = '<span class="gallery-detail-empty">Select a card to see its details.</span>';
      return;
    }
    detailText.textContent = item.description || item.label;

    if (item.type === 'checkpoint') {
      detailActions.appendChild(makeDetailButton('Open', () => actOpen(item)));
      detailActions.appendChild(makeDetailButton('Continue from here', () => actContinue(item)));
      detailActions.appendChild(makeDetailButton('Show in tree', () => actShowInTree(item)));
      detailActions.appendChild(makeDetailButton('Export 3MF', () => actExport(item)));
    } else if (item.type === 'job') {
      const note = document.createElement('span');
      note.className = 'gallery-detail-empty';
      note.textContent = item.candidateCount
        ? `${item.candidateCount} candidate${item.candidateCount === 1 ? '' : 's'} across ${item.roundCount} round${item.roundCount === 1 ? '' : 's'}.`
        : 'No candidates recorded for this batch.';
      detailActions.appendChild(note);
      if (item.checkpointScad) {
        detailActions.appendChild(
          makeDetailButton('Show checkpoint in tree', () => actShowJobCheckpoint(item))
        );
      }
    }
  }

  function makeDetailButton(label, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'small-btn';
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  }

  function emptyStateHtml() {
    const cur = workspacesData.find((w) => w.isCurrent);
    const curDir = cur ? cur.dir : ctx.workspaceDir;
    const jobsRoot = (jobsData && jobsData.jobsRoot) || `${curDir}\\renders\\gen`;
    const otherCount = workspacesData.filter((w) => !w.isCurrent && w.ok !== false).length;

    if (state.scope === 'current' && state.filter === 'all' && !state.search) {
      return (
        '<strong>Nothing here yet.</strong>' +
        `ClawSCAD looked for checkpoints in <code>${escapeHtml(curDir)}</code> ` +
        `and for image batches in <code>${escapeHtml(jobsRoot)}</code> — neither had anything yet.` +
        (otherCount
          ? '<div>Try &ldquo;All recent workspaces&rdquo; in the scope selector above.</div>'
          : '')
      );
    }

    const dirs = workspacesInScopeDirs();
    return (
      `<strong>No previous work found${state.search ? ` for &ldquo;${escapeHtml(state.search)}&rdquo;` : ''}.</strong>` +
      `ClawSCAD looked in ${dirs.map((d) => `<code>${escapeHtml(d)}</code>`).join(', ')}.`
    );
  }

  function workspacesInScopeDirs() {
    if (state.scope === 'current') {
      const cur = workspacesData.find((w) => w.isCurrent);
      return [cur ? cur.dir : ctx.workspaceDir];
    }
    if (state.scope === 'all') return workspacesData.filter((w) => w.ok !== false).map((w) => w.dir);
    return [state.scope];
  }

  // ── Detail actions ───────────────────────────────────────────────────

  async function ensureWorkspace(item) {
    if (item.isCurrent || item.workspaceDir === ctx.workspaceDir) return true;
    const res = await ctx.api.openPath(item.workspaceDir);
    if (!res || res.type !== 'workspace') {
      ctx.showToast(`Could not switch to ${item.workspaceLabel}.`, 'error');
      return false;
    }
    ctx.workspaceDir = res.path;
    return true;
  }

  async function actOpen(item) {
    const ok = await ensureWorkspace(item);
    if (!ok) return;
    await ctx.api.selectCheckpoint(item.id);
    ctx.showToast(`Opened "${item.label}".`, 'success');
    closeSheet();
  }

  async function actShowInTree(item) {
    const ok = await ensureWorkspace(item);
    if (!ok) return;
    await ctx.api.selectCheckpoint(item.id);
    closeSheet();
    requestAnimationFrame(() => {
      const row = document.querySelector(`.cp-node[data-id="${item.id}"]`);
      if (!row) return;
      row.scrollIntoView({ block: 'center' });
      row.classList.add('gallery-flash');
      setTimeout(() => row.classList.remove('gallery-flash'), 1200);
    });
  }

  async function actContinue(item) {
    const ok = await ensureWorkspace(item);
    if (!ok) return;
    await ctx.api.selectCheckpoint(item.id);
    closeSheet();
    // Depends on the getEncodedCwd fix (main.js:660, W0-4) — verified: it
    // now encodes ':' and '\' as well as '/', so sessionId resolves on
    // Windows workspaces. If a checkpoint's sessionId is still null (e.g.
    // adopted from disk, or the .jsonl was pruned), degrade honestly rather
    // than silently no-op.
    if (item.sessionId) {
      const resumed = await ctx.api.restoreCheckpointSession(item.id);
      if (resumed) {
        ctx.showToast(`Resumed the session that created "${item.label}".`, 'success');
        return;
      }
    }
    ctx.showToast(
      `No linked Claude session for "${item.label}" — checkpoint opened. Describe your next change in the console.`,
      'info'
    );
  }

  async function actExport(item) {
    const ok = await ensureWorkspace(item);
    if (!ok) return;
    await ctx.api.selectCheckpoint(item.id);
    const res = await ctx.api.exportModel('3mf');
    if (res && res.path) {
      ctx.showToast(`Exported "${item.label}" to ${res.path}.`, 'success');
    } else if (res && res.canceled) {
      // user cancelled the save dialog — no toast needed
    } else {
      ctx.showToast(`Export failed: ${(res && res.error) || 'unknown error'}`, 'error');
    }
  }

  function actShowJobCheckpoint(item) {
    const currentWs = workspacesData.find((w) => w.isCurrent);
    if (!currentWs) return;
    const match = Object.entries(currentWs.checkpoints || {}).find(([, cp]) => cp.file === item.checkpointScad);
    if (!match) {
      ctx.showToast('That checkpoint is no longer tracked.', 'info');
      return;
    }
    const [id] = match;
    actShowInTree({ id, isCurrent: true, workspaceDir: currentWs.dir, label: item.checkpointScad });
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
