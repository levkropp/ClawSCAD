// renderer/confirm-gate.js — P9 (visual confirm gate). Owned exclusively by
// the confirm package (docs/v04-guided-make-contracts.md §P9).
//
// The screen that stops the app spending ten minutes on the wrong thing:
// before anything is made, show the person a few reference pictures (or ask
// for a photo of the real object) and let them say "yes, that's the thing".
//
// Two hard constraints shape everything below:
//
//  1. It NEVER re-implements the generation flow. It drives the existing
//     Generate panel — writes #gen-prompt, clicks #gen-generate-btn, and later
//     clicks the matching .gen-candidate card and #gen-make3d-btn. It listens
//     through ctx.onPipelineEvent (the fan-out); window.api.onPipelineEvent is
//     registered exactly once, by renderer.js (standing rule 4).
//  2. It never throws at mount. A throw here takes down every module mounted
//     after it, so every DOM handle is guarded and every async call is wrapped.
//
// ESM imports hoist, so nothing at this file's top level reads the DOM or ctx;
// all of that happens inside mountConfirmGate(ctx).

const HEADLINE_IMAGES = "Let's make sure I've got the right thing.";
const HEADLINE_PHOTO = 'A photo of the real thing makes this much more accurate.';

export function mountConfirmGate(ctx) {
  const sheetEl = ctx && ctx.els && ctx.els.confirmSheet;
  if (!sheetEl) return;

  // ── state ──────────────────────────────────────────────────────────────
  let isOpen = false;
  let openerEl = null;
  let settleFn = null; // resolve() of the promise handed back by open()
  let request = null; // { decision, prompt, category, answers }
  let mode = 'images'; // 'images' | 'photo' | 'both'
  let picturesOffered = true; // false once we know previews aren't possible
  let listening = false; // true between "show me options" and the run ending
  let picked = null; // { key, path }
  let photo = null; // { path, name, url }
  const options = new Map(); // key -> { el, path, scoreEl }
  let runObserver = null;
  const askInputs = [];

  // ── DOM (built once) ───────────────────────────────────────────────────
  sheetEl.innerHTML = '';

  const scrim = document.createElement('div');
  scrim.className = 'confirm-scrim';
  scrim.addEventListener('click', () => settle({ proceed: false }));

  const modal = document.createElement('div');
  modal.className = 'confirm-modal';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-labelledby', 'confirm-title');
  modal.tabIndex = -1;

  const closeBtn = document.createElement('button');
  closeBtn.id = 'confirm-close-btn';
  closeBtn.type = 'button';
  closeBtn.className = 'confirm-close';
  closeBtn.setAttribute('aria-label', 'Close without making anything');
  closeBtn.textContent = '×';
  closeBtn.addEventListener('click', () => settle({ proceed: false }));

  const body = document.createElement('div');
  body.className = 'confirm-body';

  const title = document.createElement('h2');
  title.id = 'confirm-title';
  title.className = 'confirm-title';

  const echo = document.createElement('blockquote');
  echo.id = 'confirm-echo';
  echo.className = 'confirm-echo';

  const askList = document.createElement('div');
  askList.id = 'confirm-missing';
  askList.className = 'confirm-missing';
  askList.hidden = true;

  const note = document.createElement('p');
  note.id = 'confirm-note';
  note.className = 'confirm-note';
  note.setAttribute('role', 'status');
  note.setAttribute('aria-live', 'polite');

  // Pictures section — the grid of large reference images.
  const picturesSec = document.createElement('section');
  picturesSec.id = 'confirm-pictures';
  picturesSec.className = 'confirm-section';
  picturesSec.hidden = true;

  const grid = document.createElement('div');
  grid.id = 'confirm-grid';
  grid.className = 'confirm-grid';
  grid.setAttribute('role', 'group');
  grid.setAttribute('aria-label', 'Reference pictures');
  picturesSec.appendChild(grid);

  // Photo section — the user's own picture of the real object.
  const photoSec = document.createElement('section');
  photoSec.id = 'confirm-photo';
  photoSec.className = 'confirm-section';
  photoSec.hidden = true;

  const photoHead = document.createElement('div');
  photoHead.className = 'confirm-section-head';
  photoHead.id = 'confirm-photo-head';

  const dropzone = document.createElement('div');
  dropzone.id = 'confirm-dropzone';
  dropzone.className = 'confirm-dropzone';

  const dropText = document.createElement('span');
  dropText.className = 'confirm-drop-text';
  dropText.textContent = 'Drop a photo here';

  const photoBtn = document.createElement('button');
  photoBtn.id = 'confirm-photo-btn';
  photoBtn.type = 'button';
  photoBtn.className = 'confirm-btn';
  photoBtn.textContent = 'Choose a photo…';
  photoBtn.addEventListener('click', pickPhoto);

  dropzone.append(dropText, photoBtn);

  const thumbWrap = document.createElement('div');
  thumbWrap.id = 'confirm-photo-thumb';
  thumbWrap.className = 'confirm-thumb';
  thumbWrap.hidden = true;

  const thumbImg = document.createElement('img');
  thumbImg.alt = '';
  thumbImg.addEventListener('error', () => {
    thumbImg.hidden = true;
  });
  const thumbName = document.createElement('span');
  thumbName.className = 'confirm-thumb-name';
  thumbWrap.append(thumbImg, thumbName);

  const noPhotoBtn = document.createElement('button');
  noPhotoBtn.id = 'confirm-nophoto-btn';
  noPhotoBtn.type = 'button';
  noPhotoBtn.className = 'confirm-btn confirm-btn-quiet';
  noPhotoBtn.textContent = 'Make it without a photo';
  noPhotoBtn.addEventListener('click', () => {
    applyAnswers();
    settle({ proceed: true, handled: false });
  });

  photoSec.append(photoHead, dropzone, thumbWrap, noPhotoBtn);

  body.append(title, echo, askList, note, picturesSec, photoSec);

  // Footer — one obvious primary action, every exit clearly labelled.
  const footer = document.createElement('div');
  footer.className = 'confirm-actions';

  const skipBtn = document.createElement('button');
  skipBtn.id = 'confirm-skip-btn';
  skipBtn.type = 'button';
  skipBtn.className = 'confirm-link';
  skipBtn.textContent = 'Skip the check';
  skipBtn.addEventListener('click', () => {
    applyAnswers();
    settle({ proceed: true, handled: false });
  });

  const spacer = document.createElement('span');
  spacer.className = 'confirm-actions-spacer';

  const cancelBtn = document.createElement('button');
  cancelBtn.id = 'confirm-cancel-btn';
  cancelBtn.type = 'button';
  cancelBtn.className = 'confirm-btn';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', () => settle({ proceed: false }));

  const primaryBtn = document.createElement('button');
  primaryBtn.id = 'confirm-primary-btn';
  primaryBtn.type = 'button';
  primaryBtn.className = 'confirm-btn confirm-btn-primary';
  primaryBtn.textContent = 'Show me a few options';
  primaryBtn.addEventListener('click', onPrimary);

  footer.append(skipBtn, spacer, cancelBtn, primaryBtn);

  modal.append(closeBtn, body, footer);
  sheetEl.append(scrim, modal);

  // The single fan-out subscription. Registered once, at mount, and filtered
  // by `listening` rather than subscribing/unsubscribing (ctx.onPipelineEvent
  // has no unsubscribe, exactly like the registrar it wraps).
  if (typeof ctx.onPipelineEvent === 'function') ctx.onPipelineEvent(onPipelineEvent);

  // ── open / close ───────────────────────────────────────────────────────

  function open(opts) {
    // Never throw into the caller's submit path: any bad input degrades to a
    // plain "is this right?" sheet rather than a rejected promise.
    try {
      if (isOpen) settle({ proceed: false });
      request = opts && typeof opts === 'object' ? opts : {};
      const decision = (request.decision && typeof request.decision === 'object') ? request.decision : {};
      const raw = decision.confirmMode;
      mode = raw === 'photo' || raw === 'both' || raw === 'images' ? raw : 'images';
      picturesOffered = mode !== 'photo';
      listening = false;
      picked = null;
      photo = null;
      options.clear();
      grid.innerHTML = '';
      askInputs.length = 0;
      thumbWrap.hidden = true;
      thumbImg.hidden = false;
      thumbImg.removeAttribute('src');
      note.textContent = '';

      renderStatic(decision);
      refreshActions();

      openerEl = document.activeElement;
      isOpen = true;
      sheetEl.hidden = false;
      requestAnimationFrame(() => sheetEl.classList.add('confirm-open'));
      document.addEventListener('keydown', onKeydownTrap, true);
      focusFirstAction();
    } catch (err) {
      console.error('[confirm] open failed', err);
      return Promise.resolve({ proceed: true, handled: false });
    }
    return new Promise((resolve) => {
      settleFn = resolve;
    });
  }

  function settle(result) {
    const resolve = settleFn;
    settleFn = null;
    closeSheet();
    if (typeof resolve === 'function') resolve(result || { proceed: false });
  }

  function closeSheet() {
    if (!isOpen) return;
    isOpen = false;
    // Closing the sheet does not stop a run that is already going — the
    // Generate panel owns it and has its own Cancel. Say where it went rather
    // than leave work happening behind a closed door.
    if (listening && typeof ctx.showToast === 'function') {
      try {
        ctx.showToast('Still making the pictures — they will appear in the Generate panel.', 'info');
      } catch {}
    }
    listening = false;
    stopWatchingRun();
    sheetEl.classList.remove('confirm-open');
    sheetEl.hidden = true;
    document.removeEventListener('keydown', onKeydownTrap, true);
    const opener = openerEl;
    openerEl = null;
    if (opener && typeof opener.focus === 'function' && document.contains(opener)) opener.focus();
  }

  function getFocusable() {
    return Array.from(
      modal.querySelectorAll(
        'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )
    ).filter((el) => !el.closest('[hidden]'));
  }

  function focusFirstAction() {
    const preferred = [primaryBtn, photoBtn].find((b) => b && !b.disabled && !b.closest('[hidden]'));
    const target = preferred || getFocusable()[0] || modal;
    if (target && typeof target.focus === 'function') target.focus();
  }

  function onKeydownTrap(e) {
    if (!isOpen) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      settle({ proceed: false });
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

  // ── static content ─────────────────────────────────────────────────────

  function promptText() {
    if (request && typeof request.prompt === 'string' && request.prompt.trim()) return request.prompt.trim();
    if (ctx.composer && typeof ctx.composer.getPrompt === 'function') {
      const p = ctx.composer.getPrompt();
      if (typeof p === 'string') return p.trim();
    }
    return '';
  }

  function renderStatic(decision) {
    title.textContent = mode === 'photo' ? HEADLINE_PHOTO : HEADLINE_IMAGES;

    const text = promptText();
    const label = request && request.category && request.category.label;
    if (text) {
      echo.hidden = false;
      echo.textContent = `“${text}”`;
    } else if (label) {
      echo.hidden = false;
      echo.textContent = `You picked ${label}.`;
    } else {
      echo.hidden = true;
      echo.textContent = '';
    }

    renderAsk(Array.isArray(decision.missing) ? decision.missing : []);

    photoHead.textContent =
      mode === 'photo'
        ? 'Show me the real thing and I can match its shape and size.'
        : 'Or show me a photo of the real thing.';

    picturesSec.hidden = true; // shown once the first picture arrives
    photoSec.hidden = mode === 'images';
  }

  function renderAsk(missing) {
    askList.innerHTML = '';
    askInputs.length = 0;
    if (!missing.length) {
      askList.hidden = true;
      return;
    }
    askList.hidden = false;
    const lead = document.createElement('div');
    lead.className = 'confirm-missing-lead';
    lead.textContent = 'Anything to add? (optional)';
    askList.appendChild(lead);

    missing.slice(0, 4).forEach((question, i) => {
      const q = String(question || '').trim();
      if (!q) return;
      const row = document.createElement('label');
      row.className = 'confirm-missing-row';
      const span = document.createElement('span');
      span.textContent = q;
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'confirm-missing-input';
      input.dataset.question = q;
      input.id = `confirm-missing-${i}`;
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          if (!primaryBtn.disabled) primaryBtn.click();
        }
      });
      row.append(span, input);
      askList.appendChild(row);
      askInputs.push(input);
    });
  }

  // Every "proceed" path folds the answered questions back into the prompt
  // before anything is made, so the extra detail reaches whatever runs next.
  function applyAnswers() {
    const extra = askInputs
      .map((i) => String(i.value || '').trim())
      .filter(Boolean)
      .join(' ');
    if (!extra) return promptText();
    const base = promptText();
    const merged = base ? `${base} ${extra}` : extra;
    if (request) request.prompt = merged;
    askInputs.forEach((i) => {
      i.value = '';
    });
    try {
      if (ctx.composer && typeof ctx.composer.setPrompt === 'function') {
        ctx.composer.setPrompt(merged);
      }
    } catch (err) {
      console.error('[confirm] could not update the description', err);
    }
    return merged;
  }

  // ── the primary action ─────────────────────────────────────────────────
  //
  // Exactly one button is ever the obvious next step, and its label always
  // says what will happen. Its meaning is derived, never stored:
  //   a picture is picked  -> yes, that one
  //   a photo is chosen    -> use this photo
  //   pictures are offered -> show me a few options
  //   otherwise            -> use this photo (waiting for one)

  function primaryKind() {
    if (picked) return 'yes';
    if (photo) return 'use-photo';
    if (picturesOffered && !listening) return 'generate';
    if (listening) return 'working';
    return 'use-photo';
  }

  function isSculpt() {
    const d = request && request.decision;
    return !!(d && d.target === 'sculpt');
  }

  function refreshActions() {
    const kind = primaryKind();
    if (kind === 'yes') {
      primaryBtn.textContent = isSculpt() ? 'Yes — make this in 3D' : 'Yes — build this';
      // The 3D step can't start while pictures are still arriving (the panel
      // holds the process), so say "one moment" by disabling rather than
      // letting the button refuse a click it looked willing to take.
      primaryBtn.disabled = isSculpt() && listening;
    } else if (kind === 'use-photo') {
      primaryBtn.textContent = 'Use this photo';
      primaryBtn.disabled = !photo;
    } else if (kind === 'working') {
      primaryBtn.textContent = 'Making pictures…';
      primaryBtn.disabled = true;
    } else {
      primaryBtn.textContent = 'Show me a few options';
      primaryBtn.disabled = false;
    }
    primaryBtn.setAttribute(
      'title',
      primaryBtn.disabled && kind === 'use-photo' ? 'Choose a photo first' : primaryBtn.textContent
    );
  }

  function onPrimary() {
    const kind = primaryKind();
    if (kind === 'generate') {
      startPictures();
      return;
    }
    if (kind === 'use-photo') {
      if (!photo) return;
      applyAnswers();
      settle({ proceed: true, handled: false, attachment: { path: photo.path, kind: 'image' } });
      return;
    }
    if (kind === 'yes') confirmPicked();
  }

  // ── pictures: drive the EXISTING generate flow ─────────────────────────

  async function startPictures() {
    const text = applyAnswers();
    if (!text) {
      say('Tell me what it is first — a few words is plenty.');
      return;
    }

    const promptEl = document.getElementById('gen-prompt');
    const generateBtn = document.getElementById('gen-generate-btn');
    if (!promptEl || !generateBtn) {
      degradeToPhoto("I can't make preview pictures right now.");
      return;
    }

    // Is picture-making set up on this machine at all? Read-only check on a
    // channel that already exists.
    let backends = null;
    try {
      if (ctx.api && typeof ctx.api.getPipelineBackends === 'function') {
        backends = await ctx.api.getPipelineBackends();
      }
    } catch (err) {
      console.error('[confirm] could not check the picture maker', err);
    }
    if (!isOpen) return;
    if (backends && !backends.configured) {
      degradeToPhoto(
        'I can’t make preview pictures on this computer — the picture maker isn’t set up yet. Show me a photo instead, or skip this step and make it now.'
      );
      return;
    }

    // Something else is already running: the panel disables its own button
    // for exactly as long as a job holds the process.
    if (generateBtn.disabled) {
      say('Something else is being made right now. Give it a minute and try again, or skip this step and make it now.');
      return;
    }

    listening = true;
    picked = null;
    options.clear();
    grid.innerHTML = '';
    picturesSec.hidden = false;
    say('Making a few pictures — this takes a moment.');
    refreshActions();

    try {
      promptEl.value = text;
      promptEl.dispatchEvent(new Event('input', { bubbles: true }));
      generateBtn.click();
      watchRun(generateBtn);
    } catch (err) {
      console.error('[confirm] could not start the picture run', err);
      listening = false;
      degradeToPhoto("I couldn't start making pictures.");
    }
  }

  // The panel re-enables #gen-generate-btn when a run ends for ANY reason —
  // finished, failed, or cancelled from the panel. That is the one signal
  // available without touching the panel's own exit handler.
  function watchRun(generateBtn) {
    stopWatchingRun();
    if (typeof MutationObserver !== 'function') return;
    runObserver = new MutationObserver(() => {
      if (!listening || !isOpen) return;
      if (!generateBtn.disabled) endRun();
    });
    runObserver.observe(generateBtn, { attributes: true, attributeFilter: ['disabled'] });
  }

  function stopWatchingRun() {
    if (runObserver) {
      runObserver.disconnect();
      runObserver = null;
    }
  }

  function onPipelineEvent(evt) {
    if (!evt || typeof evt !== 'object' || !isOpen || !listening) return;
    if (evt.event === 'candidate') {
      addOption(evt);
    } else if (evt.event === 'score') {
      setScore(evt);
    } else if (evt.event === 'error') {
      endRun(String(evt.message || '').trim());
    } else if (evt.event === 'done' && evt.stage === 'images') {
      endRun();
    }
  }

  function endRun(errorMessage) {
    if (!listening) return;
    listening = false;
    stopWatchingRun();
    if (options.size) {
      say('Pick the one closest to what you mean.');
    } else if (errorMessage) {
      degradeToPhoto(`No pictures this time — ${errorMessage}. Show me a photo instead, or skip this step.`);
    } else {
      degradeToPhoto('No pictures came back this time. Show me a photo instead, or skip this step and make it now.');
    }
    refreshActions();
  }

  async function addOption(evt) {
    const key = `${evt.round}:${evt.index}`;
    if (options.has(key)) return;
    let url = null;
    try {
      if (ctx.api && typeof ctx.api.readPipelineImage === 'function') {
        url = await ctx.api.readPipelineImage(evt.path);
      }
    } catch (err) {
      console.error('[confirm] could not read a picture', err);
    }
    if (!isOpen || options.has(key)) return;

    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'confirm-option';
    card.dataset.key = key;
    card.setAttribute('aria-pressed', 'false');
    card.setAttribute('aria-label', `Option ${options.size + 1}`);

    if (url) {
      const img = document.createElement('img');
      img.src = url;
      img.alt = `Option ${options.size + 1}`;
      card.appendChild(img);
    } else {
      const fallback = document.createElement('div');
      fallback.className = 'confirm-option-fallback';
      fallback.textContent = 'Picture unavailable';
      card.appendChild(fallback);
    }

    const scoreEl = document.createElement('span');
    scoreEl.className = 'confirm-option-score';
    scoreEl.hidden = true;
    card.appendChild(scoreEl);

    card.addEventListener('click', () => {
      picked = { key, path: evt.path };
      for (const entry of options.values()) {
        entry.el.classList.toggle('is-picked', entry.el === card);
        entry.el.setAttribute('aria-pressed', entry.el === card ? 'true' : 'false');
      }
      if (!isSculpt()) say('Good — I’ll build that.');
      else say(listening ? 'Good — one moment while the last pictures finish.' : 'Good — I’ll make that in 3D.');
      refreshActions();
    });

    options.set(key, { el: card, path: evt.path, scoreEl });
    grid.appendChild(card);
    picturesSec.hidden = false;
  }

  function setScore(evt) {
    const entry = options.get(`${evt.round}:${evt.index}`);
    if (!entry || typeof evt.score !== 'number') return;
    entry.scoreEl.hidden = false;
    entry.scoreEl.textContent = `${evt.score}/10`;
    entry.scoreEl.title = `how closely this matches your words, out of 10`;
  }

  // "Yes, that one" — two behaviours, decided by what is being made.
  function confirmPicked() {
    if (!picked) return;
    applyAnswers();

    if (!isSculpt()) {
      settle({ proceed: true, handled: false, attachment: { path: picked.path, kind: 'image' } });
      return;
    }

    const card = document.querySelector(`#gen-image-grid .gen-candidate[data-key="${picked.key}"]`);
    const make3d = document.getElementById('gen-make3d-btn');
    if (!card || !make3d) {
      say("I couldn't hand that picture over to the 3D step. You can skip this check and make it now.");
      return;
    }
    card.click();
    if (make3d.disabled) {
      say('The 3D step is busy right now. Give it a minute, or skip this check and make it now.');
      return;
    }
    make3d.click();
    settle({ proceed: true, handled: true });
  }

  // ── the user's own photo ───────────────────────────────────────────────

  async function pickPhoto() {
    if (!ctx.api || typeof ctx.api.uploadPick !== 'function') {
      say("I can't open the file picker right now — drop a photo onto the box instead.");
      return;
    }
    photoBtn.disabled = true;
    try {
      const paths = await ctx.api.uploadPick();
      if (!isOpen) return;
      if (!Array.isArray(paths) || !paths.length) return; // cancelled — say nothing
      await ingestPath(paths[0]);
    } catch (err) {
      console.error('[confirm] choosing a photo failed', err);
      say("That photo couldn't be opened. Try a different one.");
    } finally {
      photoBtn.disabled = false;
    }
  }

  async function ingestPath(filePath) {
    let res = null;
    try {
      res = await ctx.api.uploadIngest(filePath);
    } catch (err) {
      console.error('[confirm] photo ingest failed', err);
    }
    acceptIngest(res, filePath);
  }

  async function ingestBytes(file) {
    let res = null;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      res = await ctx.api.uploadIngestBytes(file.name, bytes);
    } catch (err) {
      console.error('[confirm] photo ingest failed', err);
    }
    acceptIngest(res, null);
  }

  function acceptIngest(res, sourcePath) {
    if (!isOpen) return;
    if (!res || !res.ok) {
      say((res && (res.message || res.error)) || "That file didn't work. Try a png, jpg or webp photo.");
      return;
    }
    if (res.class !== 'image') {
      say('That looks like a model file rather than a photo. Choose a picture — png, jpg or webp.');
      return;
    }
    photo = { path: res.relPath, name: res.name || res.relPath, url: sourcePath ? fileUrl(sourcePath) : null };
    thumbWrap.hidden = false;
    thumbName.textContent = photo.name;
    if (photo.url) {
      thumbImg.hidden = false;
      thumbImg.src = photo.url;
    } else {
      thumbImg.hidden = true;
      thumbImg.removeAttribute('src');
    }
    say('Got it. That photo will be used as the reference.');
    refreshActions();
    if (!primaryBtn.disabled) primaryBtn.focus();
  }

  function fileUrl(p) {
    try {
      return 'file:///' + encodeURI(String(p).replace(/\\/g, '/')).replace(/#/g, '%23');
    } catch {
      return null;
    }
  }

  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.classList.add('is-over');
  });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('is-over'));
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('is-over');
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (!file || !ctx.api) return;
    let p = null;
    try {
      p = typeof ctx.api.pathForFile === 'function' ? ctx.api.pathForFile(file) : null;
    } catch {
      p = null;
    }
    if (p && typeof ctx.api.uploadIngest === 'function') ingestPath(p);
    else if (typeof ctx.api.uploadIngestBytes === 'function') ingestBytes(file);
  });

  // ── degradation ────────────────────────────────────────────────────────

  function say(message) {
    note.textContent = message || '';
  }

  // Never a dead end: whenever pictures can't happen, the photo route and the
  // skip are both still right there, and the reason is stated.
  function degradeToPhoto(message) {
    picturesOffered = false;
    listening = false;
    stopWatchingRun();
    photoSec.hidden = false;
    say(message);
    refreshActions();
  }

  // ── publish LAST (P8 reads ctx.confirm at its own mount) ───────────────
  ctx.confirm = { open };

  // `ctx` lives inside the esbuild bundle and is unreachable from
  // page.evaluate, so the spec has no other way to call open() without
  // depending on P8's UI. Same object, no second implementation.
  try {
    window.clawscadConfirm = ctx.confirm;
  } catch {}
}
