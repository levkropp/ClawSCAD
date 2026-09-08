# ClawSCAD v0.6 — "Studio" contracts

**Status: frozen.** Written by the foundation pass before any feature agent starts, in the same
shape as `docs/v04-guided-make-contracts.md` and for the same reason: three packages built against
that document merged with zero conflicts, because nobody had to guess a selector.

## The product change in one paragraph

v0.4 made the *question* human ("what are you making?") but left the answer being typed into a
280 px scrolling rail wedged above a terminal, with the submit button below the fold. v0.6 makes
the front door a **full-window dashboard**: pick a print type, type a sentence, and press one
button — with three things the rail could never fit.

1. **Tools.** A row of switchable field groups (Dimensions, Hardware, Fit & tolerance, Mounting,
   Strength, Material, Print settings, Text, Style, …). Each compiles into constraints Claude
   reads, words the image prompt gets, and `claw-gen` flags. This is how a user says something
   more specific than a sentence can carry, without learning CAD.
2. **A toggleable pre-image step.** A switch that decides whether to generate reference pictures
   *before* committing ten minutes to a mesh — with rounds, so you can narrow in ("more like this",
   "refine: bigger eyes") until one image is obviously right.
3. **Upload an image to recreate.** Drop a picture, get a model of it.

The window now has **two views**, switched from the header: **Make** (the studio) and **Workbench**
(the existing viewport + checkpoints + terminal). Neither is modal; the switch is always present.

---

## Packages and file ownership (exclusive write)

| # | Package | Owns |
|---|---|---|
| **S1** | Studio behaviour | `renderer/studio.js` |
| **S2** | Studio visual system | `style-studio.css` |
| **S3** | Tool-compiler harness | `tests/tools.js` |
| **S4** | Studio spec | `tests/studio.spec.js` |
| **S5** | Spec migration | `tests/helpers.js` (new) + the `beforeEach` of existing `tests/*.spec.js` |
| — | Foundation (done) | `presets/tools.json`, `renderer/tools.js`, `main/tools.js`, `index.html`, `renderer.js`, `preload.js`, `main.js`, `package.json`, this doc |

**Nobody edits a file they do not own.** Need a foundation change? Say so in your report instead of
making it. S2 may add rules targeting any selector from `style-studio.css`, which is linked last.

**Nobody but the integrator runs Playwright.** Every spec launches Electron against one shared
`%APPDATA%` profile; two suites at once hang at `firstWindow` with no window ever appearing, which
looks exactly like a code failure and is not one (v0.4 standing rule 8). S3's harness is plain
node and may be run freely.

---

## `presets/tools.json` + `renderer/tools.js` (foundation, read-only to agents)

`renderer/tools.js` is **pure** — no DOM, no Electron, no imports — like `route.js`, so `tests/tools.js`
exercises it under plain node.

```js
export function readCatalog(payload)            // tolerant of every tools:load wrapper shape
export function autoToolsFor(tools, categoryId) // tool ids a category switches on by itself
export function toolAppliesTo(tool, target)     // 'part' | 'sculpt' | 'image'
export function pruneValues(tool, values)       // drops values for fields the tool no longer declares
export function toolHasValues(tool, values)
export function summarise(tool, values)         // the chip's one-line body
export function compile({ tools, enabled, values, target })
export function composeBrief({ preamble, categoryPrompt, lines, prompt, attachments })
export function composeImagePrompt({ prompt, imageWords })
export const ACTIONS                            // ['images','mesh','prep','checkpoint']
```

`compile()` returns:

```js
{
  lines:      string[],   // constraints prepended to what Claude reads
  imageWords: string[],   // words appended to the IMAGE prompt only
  flags:      { images: string[], mesh: string[], prep: string[], checkpoint: string[] },
  chips:      [{ toolId, label, text }],
  skipped:    [{ toolId, reason }],   // enabled but contributing nothing, with why
}
```

Rules binding on every package:

- A rule fires when **every** field id in its `when` has a value (`when: []` = whenever the tool is
  on), and every `equals` entry matches exactly.
- `lines` is **first match wins** — rules are ordered most-specific first, so width+depth+height
  emits one sentence, not three fragments. `imageWords` and `flags` are **all matches apply**.
- A tool with no values contributes **nothing** and lands in `skipped`. Switching a tool on and
  typing nothing must never add a line.
- Output order follows the **catalog**, not the order the user clicked.
- `compile` is pure: same input → deep-equal output, and it mutates neither `values` nor any tool.
- The brief and the image prompt are **deliberately different strings**. An image model handed
  "expose the count as a variable" draws worse pictures.

---

## Shared DOM inventory — the whole contract surface between S1, S2, S4

The foundation ships `<div id="studio" hidden></div>` in `index.html`. **S1 builds everything
inside it**; S2 styles it; S4 asserts it. These names are frozen — renaming one is a breaking
change to two other packages.

```
#studio                                   the view root; [hidden] when Workbench is showing
  .studio-glow                            ambient layer, aria-hidden, pointer-events:none
  #studio-scroll                          the only scrolling element in the view
    #studio-hero
      #studio-title                       "What are we making?"
      #studio-sub                         one quiet line of orientation
    #studio-types            [role=radiogroup]
      button.studio-type     [data-category][role=radio][aria-checked]
        .studio-type-glyph  .studio-type-label  .studio-type-hint
    #studio-console                       the prompt card — the visual centre of the view
      #studio-chips                       active tool + attachment chips
        .studio-chip         [data-tool-id] | [data-attachment]
          .studio-chip-label  .studio-chip-text  button.studio-chip-remove
      #studio-prompt         <textarea>    auto-growing
      #studio-toolbar
        #studio-tools-btn    [aria-haspopup=menu][aria-expanded]
        #studio-preview-toggle [role=switch][aria-checked][data-mode=auto|on|off]
        #studio-attach-btn
        .studio-toolbar-spacer
        #studio-hint                       the time/cost hint ("~10 min")
        #studio-submit                     the primary action
    #studio-tools-menu       [role=menu][hidden]
      .studio-tools-group > .studio-tools-group-label
      button.studio-tool-option [data-tool-id][role=menuitemcheckbox][aria-checked]
    #studio-tool-fields                    expanded field groups for enabled tools
      .studio-tool-panel     [data-tool-id]
        .studio-tool-panel-head  .studio-field  .studio-field-label  .studio-field-input
    #studio-route            [role=status][aria-live=polite]
      #studio-route-text  #studio-route-override
    #studio-stage            [hidden]      the pre-image narrowing process
      #studio-stage-title  #studio-stage-note
      #studio-stepper > .studio-step[data-stage=images|mesh|prep|checkpoint]
      #studio-stage-elapsed
      #studio-candidates
        button.studio-candidate [data-key][aria-pressed]
          img.studio-candidate-img  .studio-candidate-meta
      #studio-stage-actions
        #studio-refine-input  #studio-refine-btn  #studio-more-btn
        #studio-use-btn  #studio-stage-cancel
    #studio-recent           [hidden when empty]
      button.studio-recent-item [data-file]
```

Header (foundation-owned, already in `index.html`):

```
#view-switch [role=tablist]
  #view-studio    [role=tab][aria-selected]   "Make"
  #view-workbench [role=tab][aria-selected]   "Workbench"
```

### Standing rules that constrain the markup

1. **A disabled control is coloured, never faded.** `opacity` stays `1`. Asserted in four specs.
2. **Never rename an existing selector.** `#terminal`, `#terminal-label`, `#composer-prompt`,
   `#gen-prompt`, `#gen-generate-btn`, `#gen-make3d-btn`, `.target-btn` ×3, `#checkpoint-header
   .label` and the `#view-presets .preset-btn` ×7 are asserted verbatim by existing specs.
3. **Never call a `window.api.on*` registrar twice** — use the `ctx` fan-outs (`ctx.onPipelineEvent`,
   `ctx.onCheckpointsChanged`).
4. `npm run build:renderer` after every `renderer/*.js` edit, or you are testing stale code.
5. Any new `userData` write must be reset in the owning spec's `afterAll`.
6. Ingest copies, never moves.
7. Every `mountX(ctx)` guards `if (!el) return;` for DOM another package may not have built.

---

## S1 — `renderer/studio.js` (`mountStudio(ctx)`)

Mounted from `renderer.js` **after** the confirm gate and guided grid, so `ctx.presets`,
`ctx.confirm`, `ctx.guided` and `ctx.categories` all exist. Guard every one of them anyway.

### State

```js
{
  view:      'studio' | 'workbench',
  categoryId:string,
  prompt:    string,
  enabled:   string[],                  // tool ids, in click order
  values:    { [toolId]: { [fieldId]: string } },
  preview:   'auto' | 'on' | 'off',
  attachment:{ relPath, name, kind, mode:'recreate'|'reference' } | null,
  stage:     null | { phase, job, round, candidates[], selectedKey, prompt },
}
```

Persisted through **`ctx.api.composerSetState`** under a `studio` key. **Never** write
`clawscad.json`, and never add a second `userData` file. `view` persists too: the app reopens where
you left it.

> **Correction (made during implementation).** This section originally claimed the composer "already
> round-trips unknown keys". It did not — `composer:set-state` overwrote `composer-state.json`
> wholesale, so the composer's own per-keystroke `persistState()` would have deleted the `studio`
> key moments after it was written. `main/composer.js` now merges at the top level, with one
> deliberate exception: **an empty object clears the file**, because five specs use
> `composerSetState({})` as their `afterAll` reset and a plain merge would silently turn that into a
> no-op. Top-level keys are replaced, not deep-merged — each owner writes its whole sub-object, and
> a deep merge would resurrect a tool the user had just removed. Proven by `tests/composer-state.js`.
>
> Practical consequence for S1: **write the whole `studio` object every time**, and expect the
> composer's keys to survive alongside it. Do not read-modify-write the file yourself.

### The routing decision

Reuse P7 verbatim: `decideRoute({ category, prompt, answers, attachments })` from `./route.js`,
where `answers` is the **flattened union of every enabled tool's values** plus the category's own
`ask` answers if `ctx.guided` supplies them. Show `explain(decision)` in `#studio-route`, and keep
the override control the guided grid already established ("Show me options first" / "Skip the
check, just make it"). The decision is always shown and always overridable — never a black box.

### `#studio-preview-toggle` — the one genuinely new control

Three states, and the distinction matters:

| `data-mode` | `aria-checked` | meaning |
|---|---|---|
| `auto` | mirrors the router | "let the app decide" — the default, and it explains *why* in `#studio-route` |
| `on` | `true` | always show me pictures first |
| `off` | `false` | never; go straight to geometry |

Clicking cycles `auto → on → off → auto`. When the mode is not `auto`, `#studio-route` shows a
"back to automatic" reset. An explicit `off` **overrides a forced-confirm category** — but say so
in one plain sentence rather than silently ignoring the taxonomy.

The effective answer is `previewFirst`: `mode === 'on' ? true : mode === 'off' ? false :
(decision.route === 'confirm' && decision.confirmMode !== 'photo')`.

### The three flows

**A. Direct.** `previewFirst === false`. Compose the brief with
`composeBrief({ preamble, categoryPrompt, lines, prompt, attachments })` and send it with
`ctx.api.composerSendToClaude(message)`. Switch to Workbench so the user sees Claude working.
Toast on failure — the terminal may not be running.

**B. Preview first.** `previewFirst === true`. Reveal `#studio-stage` and drive the **existing**
generate flow: write `composeImagePrompt(...)` into `#gen-prompt`, click `#gen-generate-btn`,
listen on `ctx.onPipelineEvent` for `candidate` / `score` / `done` / `error`, and render each
candidate large in `#studio-candidates` (`ctx.api.readPipelineImage(evt.path)` for the data URI).

> **Never re-implement the pipeline.** No new IPC, no second `pipeline:start` call site. This is
> the rule that kept the v0.4 confirm gate honest and it is not negotiable. `renderer.js` owns the
> `#gen-*` call sites and the `mesh → prep → checkpoint` chain; you drive them.

Narrowing controls, all operating on the same job:
- **More like this** — regenerate a new round from the same prompt (`#gen-generate-btn` again;
  `claw-gen images --round N` keeps rounds in one job). Previous rounds stay visible.
- **Refine…** — `#studio-refine-input` text is appended to the prompt, then a new round.
- **Use this** — behaviour depends on `decision.target`, exactly as the v0.4 gate established:
  - `sculpt` → click the matching `.gen-candidate[data-key]`, then `#gen-make3d-btn`. The existing
    chain carries it through mesh → prep → checkpoint; mirror the stage in `#studio-stepper`.
  - `part` → hand the picked image to Claude as a reference and dispatch flow A with it attached.
    This is the most valuable flow in the app: approve the *look*, then build it **parametrically**.

**C. Recreate an uploaded image.** `#studio-attach-btn` → `ctx.api.uploadPick()` →
`ctx.api.uploadIngest(path)` (which copies into `<workspace>/uploads/` and returns a workspace-
relative `relPath`). Offer two modes on the chip:
- **Reference** — the path joins `attachments` in the brief; Claude reads the picture and models
  from it.
- **Recreate** — mesh the picture directly:
  `ctx.api.startPipeline({ action:'mesh', args:['--image', relPath, '--new-job', ...flags.mesh] })`
  with **no `job`**, then let `renderer.js`'s existing exit handler chain prep → checkpoint.

> `--new-job` is why claw-gen went to 0.3.0. Without it `mesh --image` reuses the most recent job,
> so an upload lands in the last text-prompt's job, is checkpointed under that job's slug, and
> interleaves two subjects' artifacts in one directory. `claw-gen` ≥ 0.3.0 is required for flow C;
> if the flag is unsupported the mesh exits 3 — surface that as "update claw-gen", not as a crash.

`claw-gen` accepts a path relative to its `cwd`, which `main.js` sets to the workspace dir, so
`relPath` goes through unchanged. Do not build an absolute path in the renderer.

### Published interface

```js
ctx.studio = {
  show(), hide(), isVisible(),
  getState(), setCategory(id), setPrompt(text),
  enableTool(id), disableTool(id), setToolValue(toolId, fieldId, value),
  setPreviewMode('auto'|'on'|'off'),
  getDecision(),
  submit(),
};
```

Also published as **`window.clawscadStudio` — the same object, not a second implementation** —
purely as a test handle, because `ctx` lives inside the esbuild bundle's module scope and
`page.evaluate` cannot reach it (the v0.4 test-seam correction). No product code path may go
through the `window` alias.

### Degradation — none of these may dead-end

| Condition | Behaviour |
|---|---|
| `tools:load` failed | studio works with zero tools; say so once, quietly |
| `categories:load` failed | keep the console usable with no type grid and a stated reason |
| `claw-gen` unconfigured | Preview and Recreate explain and offer *Locate claw-gen…*; **Direct still works** |
| Claude CLI missing | Direct explains and offers the setup guide; Preview still works |
| pipeline `already-running` | say so, offer to switch to Workbench and watch |
| images stage exits with no candidates | say so, offer *Try again* and *Skip the pictures* |
| `#gen-*` elements absent | fall back to Direct with a toast; never a dead button |

---

## S2 — `style-studio.css`

Linked **last** in `index.html`, so equal-specificity rules win. Owns only `#studio`, `#view-switch`
and the `body[data-view]` switch. **Never restyle a workbench selector**; four specs assert computed
styles there.

The brief, in the app-shell idiom the rest of the window already uses:

- Reuse `style.css`'s `:root` token layer — surface/border/text ladders, z-index scale, space,
  radii, elevation, motion. Introduce a new token only when nothing existing means the same thing,
  and add it under a `#studio` scope rather than editing `:root`.
- Ambient glow: one or two large radial gradients in the brand violet/blue at low opacity on
  `.studio-glow`, `position:fixed`, `pointer-events:none`.
- The console card is the centre of gravity — generous padding, a real elevation, a focus ring that
  reads at a glance. The submit button must be the most confident thing on the screen.
- Type-tile grid: responsive `auto-fit` columns, never a fixed 3-across at every width. The window
  is resizable and the view must survive 900 px and 2560 px.
- `#studio-scroll` is the only scroll container. `#studio` itself never scrolls.
- Motion respects `prefers-reduced-motion`. Every interactive element has a `:focus-visible` rule —
  the app had none at all before v0.2 and that regression is not to be repeated.
- Contrast: nothing below **4.5:1** for body text or **3:1** for large text and UI edges. The v0.2
  audit found eleven elements between 1.4:1 and 3.6:1; do not add a twelfth. Disabled states are
  **coloured differently, never faded**.
- Tabular numerals on every measurement, elapsed timer and count.

---

## S3 — `tests/tools.js` (node harness, wired into `npm run test:harness`)

Same shape as `tests/route.js`: CommonJS, dynamic `import()` of the real ES module so it can never
drift onto a stale copy, its own `check()` counter, non-zero exit on failure.

Must cover, with expectations written as **literals** (never derived from the catalog, or a broken
rule moves the expectation with it):

- `compile` purity — same input → deep-equal output; neither `values` nor any tool object mutated.
- Every tool in `presets/tools.json`: each `lines` rule reachable with some input, and
  **first-match-wins** proven — a fully-filled Dimensions emits exactly one line, not four.
- `when: []`, multi-field `when`, and `equals` (the `detail` tool's three `--target-faces` values).
- A tool switched on with no values contributes nothing and appears in `skipped` with a reason.
- `toolAppliesTo` — a `part`-only tool is skipped with a reason on the `sculpt`/`image` tracks.
- `pruneValues` drops unknown field ids.
- Flag accumulation across several tools, and that an unknown `action` is ignored rather than
  throwing.
- `composeBrief` block order: preamble → category → constraints → attachments → **user text last**.
- `composeImagePrompt` ≠ `composeBrief` for the same input, and carries no constraint language.
- `readCatalog` against all five wrapper shapes plus junk.
- Catalog integrity: unique tool ids, every `when`/`equals`/`{placeholder}` naming a field the tool
  declares, every `flags[].action` in `ACTIONS`, every `group` present in `groups`, every `auto`
  entry naming a real category in `categories.json`.

That last group is the one that pays for itself: it is a typo in a JSON file that silently drops a
constraint, and nothing else would catch it.

---

## S4 — `tests/studio.spec.js` (Playwright; written now, run by the integrator)

Must assert: studio is the view on first run and `#main-content` is not showing · ten
`.studio-type` tiles with exactly one `aria-checked="true"` · the view switch moves both ways and
`#composer-prompt` is reachable in Workbench · `#studio-submit` is disabled with an empty prompt and
says something other than its ready label · typing enables it · selecting a type auto-enables that
type's tools as chips · adding a tool from `#studio-tools-menu` adds a `.studio-tool-panel` and a
chip, removing it removes both · `#studio-preview-toggle`
cycles `auto → on → off → auto` with `aria-checked` and `#studio-route` tracking · `#studio-route`
text differs between a direct and a confirm category · state survives a relaunch (category, prompt,
enabled tools, preview mode, view) · every studio control is **fully opaque when disabled** · no
`window.api.on*` registrar is called twice.

Drive state through `window.clawscadStudio` where clicking would be brittle, but assert on the DOM.
Reset any `userData` write in `afterAll`.

---

## S5 — spec migration

The default view changed, so specs that exercise workbench DOM must open it first. Add
`tests/helpers.js`:

```js
async function openWorkbench(page) { /* click #view-workbench, await #main-content visible */ }
```

and call it in the `beforeEach` of every existing spec that touches workbench DOM. **Change nothing
else** — not an assertion, not a timeout, not a selector. A spec that needed more than this one
line is a real regression and must be reported, not patched.

---

## Version

`0.5.1 → 0.6.0` in `package.json`, the `## [0.6.0]` heading in `CHANGELOG.md` (which
`scripts/release.ps1` parses for release notes), and `#app-version` renders it from `package.json`,
so there is exactly one place it is declared. `style-studio.css` must be added to `build.files` or
the packaged app ships an unstyled dashboard — `presets/**/*` is already globbed, so `tools.json`
needs nothing.
