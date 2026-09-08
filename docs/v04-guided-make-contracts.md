# ClawSCAD v0.4 — "Guided Make" contracts

**Status: frozen.** Written by the foundation pass (W6-0) before any feature agent starts.
Three packages build against this document and never edit each other's files.

## The product change in one paragraph

Today the composer's first question is technical — *Part / Sculpt / Images*. A non-technical
user does not know which of those a phone stand is. v0.4 puts a **human** question first:
**"What are you making?"** — a grid of print types (Screws & hardware, Brackets & mounts,
Boxes & cases, Furniture, Structural, Replacement part, Models & figures, Home decor,
Toys & games, Something else). Picking one **automatically** sets the pipeline target and the
intent presets, so the technical controls become confirmations rather than decisions. The user
then types plain English and presses one button.

What happens next depends on how **obvious** the request is:

- **Obvious** (an M4 × 20 standoff, a 6 mm cable clip, a 3-shelf pin) → straight through to a
  parametric `.scad`. No image step. One button, one model.
- **Not obvious** (an owl planter, a mid-century table leg, "the broken knob on my dryer") →
  a **visual confirm** step first: generate a few reference images (or use the user's own photo)
  and let them say *"yes, that's the thing"* before spending ten minutes on a mesh.

The decision is always **shown and always overridable**. Never a black box.

---

## Packages and file ownership (exclusive write)

| # | Package | Agent | Owns |
|---|---|---|---|
| **P7** | Routing engine | `router` | `renderer/route.js`, `tests/route.js` (node harness), `main/categories.js` |
| **P8** | Guided UI | `guided` | `renderer/categories-ui.js`, `style-categories.css`, `tests/categories.spec.js` |
| **P9** | Confirm gate | `confirm` | `renderer/confirm-gate.js`, `style-confirm.css`, `tests/confirm.spec.js` |
| — | Foundation | (done) | `presets/categories.json`, `renderer/bus.js`, `renderer/composer.js`, `renderer/presets-ui.js` (one addition), `renderer.js`, `main.js`, `preload.js`, `index.html`, `package.json`, this doc |

**Nobody edits a file they do not own.** If you need a foundation change, say so in your report
instead of making it. P8 and P9 may add CSS rules targeting *any* selector from their own
stylesheet — `style-categories.css` and `style-confirm.css` are linked after `style-composer.css`,
so equal-specificity rules win.

---

## `presets/categories.json` — the taxonomy (foundation-owned, read-only to agents)

```jsonc
{
  "version": 1,
  "default": "hardware",              // pre-selected id — never null, the grid always has a selection
  "categories": [
    {
      "id": "hardware",
      "label": "Screws & hardware",
      "glyph": "◎",                   // single character, drawn at 18px
      "hint": "Bolts, spacers, standoffs, washers, adapters",
      "examples": ["M4 × 20 mm hex standoff", "M3 nylon washer, 1 mm thick"],
      "presets": ["fits-hardware"],   // preset ids auto-applied on select (ctx.presets.setActive)
      "target": "part",               // target when the router resolves CONFIRM
      "target_direct": "part",        // target when the router resolves DIRECT (falls back to `target`)
      "route": "direct",              // 'direct' | 'confirm' | 'auto'
      "confirm": "none",              // 'none' | 'images' | 'photo' | 'both'
      "bias": 25,                     // added to the obviousness score in 'auto' mode
      "prompt": "CATEGORY: …",        // prepended to the composed message on the part track
      "ask": [                        // ≤3 guided fields; ALL optional, never blocking
        { "id": "thread", "label": "Thread", "kind": "choice",
          "options": ["M2","M2.5","M3","M4","M5","M6","M8"], "unit": "" },
        { "id": "length", "label": "Length", "kind": "number", "unit": "mm",
          "placeholder": "20" }
      ]
    }
  ]
}
```

Field notes binding on all three packages:

- `ask[].kind` is `"choice"` | `"number"` | `"text"`. A `choice` renders a `<select>` with a
  leading blank option labelled `—`. Nothing in `ask` is ever required: a user who ignores every
  field must still be able to submit.
- `route: "direct"` and `route: "confirm"` are absolute. Only `route: "auto"` consults the score.
- `confirm: "photo"` means *the user's own photo is the useful reference* (replacement parts);
  `"images"` means *generated previews are*; `"both"` offers each.
- `prompt` is prepended **only on the part track**. On the generated track the preset
  `image_suffix` machinery already owns the wire prompt (`presets-ui.js:434`) — do not duplicate.
- The top-level `preamble` string is prepended **before** the category prompt on the part track,
  every time. It is what makes obvious things go straight through ("make reasonable assumptions
  rather than asking questions"). Copy it verbatim; never paraphrase it.
- `target_direct` is why a 90 mm coaster (`decor`, direct) becomes an editable parametric part
  while an owl planter (`decor`, confirm) goes to the sculpt pipeline. The router picks
  `route === 'direct' ? (category.target_direct || category.target) : category.target`.

### The confirm→part flow (do not miss this)

`furniture`, `enclosure` and `other` can resolve to **confirm with `target: 'part'`**. That is
deliberate and it is the most valuable flow in the release: generate reference images, let the user
approve the *look*, then hand the approved image to Claude as a reference and build it
**parametrically**. Uploaded/generated images work on the part track today (master plan §1.5) —
Claude reads the PNG and models from it. So P9's "yes, that one" button has two behaviours:

| `decision.target` | button label | what it does | resolves |
|---|---|---|---|
| `sculpt` | *Yes — make this in 3D* | clicks the candidate card, then `#gen-make3d-btn` | `{proceed:true, handled:true}` |
| `part` | *Yes — build this* | nothing else; hands back the picked image path | `{proceed:true, handled:false, attachment:{path, kind:'image'}}` |

---

## P7 — `renderer/route.js` (pure; no DOM, no Electron, no imports)

```js
export function decideRoute(input) -> Decision
export function explain(decision) -> string     // one user-facing sentence
export const SIGNALS                            // exported for the harness only
```

```js
input = {
  category,      // the category OBJECT from categories.json, or null
  prompt,        // raw user text (may be '')
  answers,       // { [askFieldId]: string } — '' for untouched fields
  attachments,   // [{ name: 'logo.svg', kind: 'image'|'vector'|'mesh'|'scad'|'blocked' }]
}

Decision = {
  route:       'direct' | 'confirm',
  target:      'part' | 'sculpt' | 'image',
  presets:     string[],          // preset ids to activate
  confirmMode: 'none' | 'images' | 'photo' | 'both',
  score:       number,            // 0-100 obviousness; higher = more obviously simple
  reasons:     string[],          // plain English, user-facing, ≤10 words each
  missing:     string[],          // plain English questions the description didn't answer
  forced:      boolean,           // true when the category's route is absolute (not scored)
}
```

Scoring rules (deterministic, explainable — **no LLM call, no network, no async**):

- start at `50 + category.bias`
- **+20** the description contains an explicit dimension (a number adjacent to
  `mm|cm|m|in|inch|"|'`), or any `ask` field of kind `number` has a value
- **+10** an `ask` field of kind `choice` has a value
- **+15** the description matches the simple-object lexicon (screw, bolt, nut, washer, spacer,
  standoff, clip, hook, peg, pin, shim, plate, bracket, mount, adapter, grommet, knob, cap,
  plug, bushing, tube, ring, disc, box, lid, tray, holder, stand, jig, template, gauge)
- **−25** the description matches the organic/aesthetic lexicon (figurine, statue, sculpture,
  bust, character, animal, dragon, creature, face, ornate, decorative, flowing, organic,
  stylised, cute, realistic, detailed model of)
- **−15** the description references something the app cannot see ("my", "the broken", "fits the",
  "replacement for", "like the one", "same as") **and** no image/mesh attachment is present
- **−10** per additional independent clause beyond the second (split on `,` `;` ` and ` ` with `),
  capped at −20 — a long compound description is rarely obvious
- **+15** an attachment of kind `mesh`, `scad`, or `vector` is present (the geometry is given)
- clamp to 0-100

`route = score >= 60 ? 'direct' : 'confirm'` for `auto` categories.

`target = route === 'direct' ? (category.target_direct || category.target) : category.target`.
`confirmMode = route === 'confirm' ? category.confirm : 'none'`.
`presets = category.presets` (unchanged by the router — the router never invents a preset).
With `category === null`, return `{route:'direct', target:'part', presets:[], confirmMode:'none',
score:50, reasons:[], missing:[], forced:false}` — the app must work with the taxonomy absent.

`reasons` must explain the **actual** contributing signals in the user's own terms —
`"You gave exact measurements"`, `"'owl' isn't something I can measure"`,
`"You're describing something you have, but I can't see it"`. Never print the score in `reasons`;
the UI shows it separately if it wants to.

`missing` is populated only when `route === 'confirm'` and is used to seed the confirm sheet's
"anything to add?" line. Example: `["How big should it be?"]` when no dimension was found.

`explain(decision)` returns one sentence, present tense, no jargon. Examples:
- `"This is straightforward — making it now."`
- `"Let's check the look first — I'll show you a few options."`
- `"I can't see your part, so a photo will make this much more accurate."`

**`main/categories.js`** exports `register(ipcMain, deps)` and registers exactly one channel,
`categories:load`, mirroring `main/presets.js`: read `presets/categories.json` from the app dir,
overridable by a same-named file in `app.getPath('userData')/presets/`. Return
`{ categories, error }` — never throw, never let a bad user override kill the load (fall back to
the shipped file and report the parse error in `error`).

**`tests/route.js`** is a node harness (no Electron, no Playwright) wired into `test:harness`.
It must cover: every category's forced route; the score contribution of each signal in isolation;
the `auto` threshold at 59/60/61; that `decideRoute` is pure (same input → deep-equal output, and
the input object is not mutated); and at least these end-to-end cases —

| category | prompt | expected |
|---|---|---|
| `hardware` | `M4 standoff 20mm` | direct |
| `hardware` | `something to hold the thing` | direct (forced) |
| `furniture` | `a 30mm round knob with an M4 insert` | direct |
| `furniture` | `a mid-century tapered table leg with fluting` | confirm |
| `decor` | `a 90mm round coaster, 4mm thick` | direct |
| `decor` | `an owl planter with big round eyes` | confirm |
| `model` | `anything` | confirm (forced) |
| `replacement` | `anything` | confirm/photo (forced) |

---

## P8 — `renderer/categories-ui.js` (`mountGuided(ctx)`)

Mounts into **`ctx.composer.guidedSlot`** — an empty `<div id="composer-guided">` that the
composer creates as the FIRST child of `#composer-body`, above the target row.

Builds, in order:

1. `<div id="category-grid" role="radiogroup" aria-label="What are you making">` — one
   `button.category-tile[data-category][role=radio][aria-checked]` per category. 3 columns.
   Glyph on top, label under it, `hint` as the `title`. Keyboard: arrows move, Home/End jump.
   **Never disabled, never faded.**
2. `<div id="category-ask">` — the selected category's `ask` fields, inline and compact. Values
   live in P8 and are passed to `decideRoute` as `answers`.
3. `<div id="route-note" role="status" aria-live="polite">` — `explain(decision)` plus a single
   override control:
   - when `route === 'direct'`: a text button **"Show me options first"** → forces confirm
   - when `route === 'confirm'`: a text button **"Skip the check, just make it"** → forces direct
   The override is remembered until the category or prompt changes materially (any keystroke that
   changes the decision clears it), and clearing it is announced in the same `role="status"` line.
4. A **"Fine-tune"** `<details>` wrapping nothing of its own — instead P8 moves the existing
   `#preset-chip-row`, `#preset-modifier-row` and `#composer-targets` visual weight down via CSS
   from `style-categories.css`. **Do not reparent `#composer-targets` and do not hide it** — three
   `.target-btn`s must stay visible and clickable (`tests/composer.spec.js` clicks them).
   Demote with type scale, colour and a small `Output` caption only.

Publishes, at the very end of mount:

```js
ctx.guided = {
  getCategory(): object|null,     // the category object, not the id
  setCategory(id): void,
  getAnswers(): object,
  getDecision(): Decision,        // recomputed on demand, never stale
  onChange(cb): void,             // fired on category / answers / prompt / override change
};
```

Wiring P8 owns:

- On category select: `ctx.presets.setActive(category.presets)`,
  `ctx.composer.setTarget(decision.target)`, and set the prompt placeholder from
  `category.examples[0]`. Never clear the prompt.
- Persistence: P8 **must not** call `ctx.api.composerSetState` — the composer owns that file.
  Use `ctx.composer.setGuidedState({ categoryId, answers })` / `getGuidedState()`, which the
  foundation added for exactly this. It round-trips inside `composer-state.json` under a `guided`
  key and is already restored by the time `mountGuided` runs.
- A composer section registered as
  `ctx.composer.registerSection({ id: 'category', order: -10, preamble, blocks })` — **no `mount`**;
  preamble-only sections are supported. `preamble()` returns the category prompt block, the
  answered `ask` fields as `Key: value` lines, and nothing else. `blocks()` returns `null` always
  (the guided flow never blocks submit).
- A submit handler registered with `ctx.composer.onSubmit(async (payload) => …)`:
  - compute the decision; if `route === 'direct'` return `undefined` (composer dispatches normally)
  - if `route === 'confirm'` call `await ctx.confirm.open({ decision, prompt, category, answers })`
    and honour the result:
    - `{ proceed: true, handled: true }` → return `{ handled: true }` (the gate ran the pipeline)
    - `{ proceed: true, handled: false, attachment }` → add the attachment to P8's preamble and
      return `undefined` (composer dispatches normally)
    - `{ proceed: false }` → return `{ handled: true }` (nothing dispatched, no error toast)
  - if `ctx.confirm` is missing (gate failed to mount), log and return `undefined` — the guided
    flow must degrade to today's behaviour, never to a dead button.
- Submit button label: call `ctx.composer.setSubmitLabel(...)` with `"Make it"` for direct and
  `"Check it first"` for confirm; pass `null` to hand the label back to the composer.

`tests/categories.spec.js` must assert: 10 tiles with exactly one `aria-checked="true"` at launch ·
selecting `model` sets `#composer-targets` `.target-btn[data-target="sculpt"]` to
`aria-checked="true"` · selecting `hardware` activates the `fits-hardware` chip
(`#preset-chip-row .preset-chip[data-preset-id="fits-hardware"][aria-pressed="true"]`) ·
`#route-note` text changes between a direct and a confirm category · the three `.target-btn`s are
still visible · `#composer-prompt` value survives a category change · every guided control is
fully opaque when disabled.

---

## P9 — `renderer/confirm-gate.js` (`mountConfirmGate(ctx)`)

Mounts into `#confirm-sheet` (foundation-created, `hidden`, sibling of `#gallery-sheet`).
A modal sheet over `#main-content` — same shape as the gallery: `role="dialog" aria-modal="true"`,
focus trapped, Esc closes and returns focus to the opener, backdrop click closes.

Publishes:

```js
ctx.confirm = {
  open({ decision, prompt, category, answers }): Promise<Result>
};

Result =
  | { proceed: true,  handled: true }                       // the gate drove the pipeline itself
  | { proceed: true,  handled: false, attachment?: {path, kind} }  // let the composer dispatch
  | { proceed: false }                                      // user backed out
```

The sheet's content, by `decision.confirmMode`:

- **`images`** (and the images half of `both`) — headline *"Let's make sure I've got the right
  thing."*, the user's own sentence echoed back, then a primary button **"Show me a few options"**.
  Pressing it drives the EXISTING generate flow — set `#gen-prompt`'s value and click
  `#gen-generate-btn` — and listens on `ctx.onPipelineEvent` for `candidate` events, rendering each
  as a large card (use `ctx.api.readPipelineImage(evt.path)` for the data URI; scores arrive as
  `score` events). The user picks one → **"Yes — make this in 3D"** clicks the matching
  `.gen-candidate[data-key]` card and then `#gen-make3d-btn`, resolves `{proceed:true, handled:true}`,
  and closes. **Never re-implement the pipeline**: no new IPC, no second `pipeline:start` call site.
- **`photo`** (and the photo half of `both`) — headline *"A photo of the real thing makes this much
  more accurate."*, a dropzone plus a **"Choose a photo…"** button (`ctx.api.uploadPick()` then
  `ctx.api.uploadIngest(path)`), a thumbnail of what was ingested, and two exits:
  **"Use this photo"** → `{proceed:true, handled:false, attachment:{path, kind}}`;
  **"Make it without a photo"** → `{proceed:true, handled:false}`.
- always — a quiet **"Skip the check"** text button → `{proceed:true, handled:false}`, and a
  **Cancel** → `{proceed:false}`.
- always — `decision.missing` rendered as a short list under the headline, each one a real question
  ("How big should it be?"), with a one-line input that appends the answer to the prompt via
  `ctx.composer.setPrompt(...)` before proceeding.

Degradation P9 must handle without a dead end: `claw-gen` unconfigured (offer photo + skip, say
why), no candidates after the images stage exits (say so, offer photo + skip), pipeline
`already-running` (say so, offer skip).

**Test seam (contract correction, made during implementation).** The original draft said the spec
calls `ctx.confirm.open()` from `page.evaluate`. That is impossible: `ctx` lives inside the esbuild
bundle's module scope and is not reachable from the page context. Both P8 and P9 therefore also
publish their interface on `window` — `window.clawscadConfirm` and `window.clawscadGuided` — as the
**same object**, not a second implementation, purely as a test handle. No product code path may go
through the `window` alias; in-app callers use `ctx`.

`tests/confirm.spec.js` must assert: the sheet is `hidden` at launch · `window.clawscadConfirm.open()`
from `page.evaluate` shows it with `role="dialog"` · Esc resolves `{proceed:false}` and returns focus ·
the skip button resolves `{proceed:true, handled:false}` · every button is fully opaque when
disabled · nothing in the sheet writes to `userData` (nothing to reset in `afterAll`).

---

## Foundation additions all three packages may rely on

`renderer/bus.js`:

```js
ctx.onPipelineEvent(cb)   // fan-out of the single window.api.onPipelineEvent registration
ctx.guided                // filled by P8; null until then
ctx.confirm               // filled by P9; null until then
ctx.presets               // filled by presets-ui.js: { getActive(), setActive(ids), has(id) }
ctx.categories            // { data, error } — loaded once by renderer.js before the mounts
```

`ctx.composer` gains:

```js
guidedSlot                // HTMLElement — first child of #composer-body, above the targets
setSubmitLabel(text|null) // overrides the submit label; null restores the target's own
getGuidedState()          // { categoryId, answers } round-tripped in composer-state.json
setGuidedState(state)     // persists it (debounced with the rest of the composer state)
```

and `registerSection` now accepts a section with **no `mount`** (preamble/blocks only), and
**`onSubmit` handlers may return `{ handled: true }` to suppress the composer's own dispatch.**

Mount order in `renderer.js` (fixed): composer → uploads → presets → gallery → onboarding →
confirm gate → guided. P8 mounts last because it reads `ctx.presets` and `ctx.confirm`.

---

## Standing rules (inherited — read before touching the DOM)

1. A disabled control is **coloured, never faded**. `opacity` stays `1`. Asserted in three specs.
2. Never rename an existing selector. `#terminal`, `#terminal-label` (`Claude Code` / `Shell`),
   `#checkpoint-header .label` (`Checkpoints`), `#gen-empty`, `#gen-prompt`, `#gen-generate-btn`,
   `#gen-make3d-btn`, `#gen-panel.collapsed`, `.target-btn` ×3, `#view-presets .preset-btn` ×7 are
   all asserted verbatim.
3. Never call a `window.api.on*` registrar twice — use the `ctx` fan-outs.
4. `npm run build:renderer` after every `renderer/*.js` edit or you are testing stale code.
5. Any new `userData` write must be reset in the spec's `afterAll`.
6. Ingest copies, never moves.
7. Run the suite as PowerShell, with `$env:OPENSCAD_BINARY` set — a bash run fails on fnm, and an
   unset binary produces environment faults that look exactly like regressions.
8. **These specs cannot run concurrently.** Every spec launches Electron against the same
   `%APPDATA%\Electron` userData profile and the same `composer-state.json`. Two suites at once time
   out at `electronApplication.firstWindow` with no window ever appearing — which looks exactly like
   a code failure and is not one. Serialise test runs across agents; one full-suite run at a time,
   owned by the integrator.
