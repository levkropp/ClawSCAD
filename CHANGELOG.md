# Changelog

All notable changes to ClawSCAD. Versions follow [semver](https://semver.org/).

`scripts/release.ps1` pulls the release notes for a version straight out of the
matching `## [x.y.z]` section below, so keep the heading format exact.

## [0.6.1] - 2026-09-07

### Added

- **A browser port of the Make view** (`web/`). A zero-dependency `node:http`
  server mounts `renderer/studio.js` **unmodified** against a `fetch` +
  `EventSource` shim shaped like `preload.js`, so a phone or tablet on your own
  network can drive it. The type grid, tools, routing decision, state
  persistence, pictures-first rounds, uploads and recreate all work; the
  three.js viewport, the pty terminal and the checkpoint tree do not, and the
  UI says so rather than offering a dead control. It binds loopback and has
  **no authentication of its own** — see `web/README.md`.
- **Flow A headless in the web port.** "Make it" never needed a pty:
  `claude -p --permission-mode acceptEdits` runs in the workspace and exits,
  streaming progress over SSE. The `.scad` it produced is found by diffing
  workspace `.scad` mtimes rather than by trusting the model to report a path.
- **An OpenSCAD Customizer + export in the web port.** `web/scad-params.mjs`
  parses OpenSCAD's own Customizer syntax; values are applied with `-D`, and
  the preview is a server-side render so it cannot drift from the exported
  artifact. 3MF is the primary export, STL secondary. Checkpoints are never
  rewritten to "customize" them.
- **`CLAWSCAD_WORKSPACE` and `CLAWSCAD_CLAUDE_BIN`.** Explicit escape hatches
  for the two paths the app otherwise has to guess. Every configuration point
  is now listed in `docs/configuration.md`.

### Fixed

- **The bundled OpenSCAD was never found on Windows.** The snapshot zip carries
  a top-level `OpenSCAD-<snapshot>-x86-64/` folder, so `download-openscad.js`
  left the binary at `vendors/openscad-win/OpenSCAD-…/openscad.exe` while the
  app looks for `vendors/openscad-win/openscad.exe`. `electron-builder` copies
  that tree into the installer verbatim, so a shipped Windows build carried
  65 MB of OpenSCAD it could not resolve and told the user to install one. The
  download now flattens a single-directory archive, and leaves an
  already-flat one alone.

### Changed

- **The default workspace is `~/clawscad-workspace` on every platform.** On
  Windows it used to prefer `E:\` then `D:\`, which is one machine's disk
  layout rather than anything true of a fresh install. The launch default is
  now `$CLAWSCAD_WORKSPACE`, else the workspace you last opened if it still
  exists, else `~/clawscad-workspace` — so an existing install keeps opening
  its own work rather than silently starting empty somewhere new.
- **`docs/releasing.md` replaces `HANDOFF-auto-update.md`**, and documents the
  one thing a fork must change before publishing: `build.publish` in
  `package.json` is both the upload target and the update feed, and
  `electron-updater` resolves the newest release *in a repo*, not the newest
  release of a product.

## [0.6.0] - 2026-08-29

### Added

- **Studio — a new front door.** The window now has two views, switched from the
  header: **Make** and **Workbench**. Make is a full-window dashboard — pick what
  you're making, describe it in a sentence, press one button. Previously that
  same flow lived in a 280 px scrolling rail wedged above the terminal, with the
  submit button below the fold.
- **Tools.** Thirteen switchable field groups — Dimensions, Hardware, Fit &
  tolerance, Mounting, The part it replaces, Text & engraving, Strength,
  Material, Print settings, Quantity, Style, Colour, Mesh detail — for saying
  what a sentence can't carry. Picking a print type switches on the ones that
  type usually needs; you can add or remove any of them. Each compiles into
  three separate things: constraints Claude reads, words the image prompt gets,
  and `claw-gen` flags. A tool that doesn't apply to what you're making says so
  in plain words instead of greying out.
- **A toggleable pre-image step.** *Pictures first* has three states — automatic
  (the app decides, and tells you why), always, and never. When it's on you get
  reference images before any mesh work, and you narrow in: **More like this**
  adds a round, **Refine…** adds a round with a change ("bigger eyes"), and
  earlier rounds stay on screen so you can compare. Approving a picture either
  meshes it or hands it to Claude as a reference to build parametrically,
  depending on what you're making.
- **Add a picture.** Attach an image as a **reference** for Claude, or
  **recreate** it directly as a 3D model. Recreating runs
  `claw-gen mesh --image … --new-job` and carries on through prep to a
  checkpoint.
- Per-backend availability. If image generation or 3D meshing is unavailable,
  the studio says so up front with the reason, and keeps every flow that still
  works — rather than failing ten minutes into a job.

### Fixed

- **`composer-state.json` was overwritten wholesale on every write.** With a
  second writer added this release, the composer's per-keystroke save would have
  deleted the studio's state moments after it was written. It now merges by
  top-level key. (An empty object still clears the file.)
- **Refine silently did nothing** (`clawscad-gen` 0.3.0). A new round on an
  existing job reused the job's cached expanded prompt, so a refinement was
  accepted, took a full round to run, and produced the same thing.
- **Every "More like this" started a new job**, whose candidate keys collide
  with the previous job's. Rounds now accumulate in one job.
- **An uploaded image was meshed into whatever job was last in flight**, so it
  was checkpointed under that job's name with two subjects' files interleaved.
  `claw-gen mesh --image` now takes `--new-job`.

### Changed

- **The build no longer rebuilds native modules for Electron.** `node-pty` is
  N-API, whose ABI is stable across Node and Electron, so the `electron-rebuild`
  postinstall was doing nothing but failing — it needed the Spectre-mitigated
  MSVC libraries, which is what blocked `npm run release` on Windows. A new
  `scripts/check-native-deps.js` fails the test run if a native dependency is
  ever added that is *not* N-API, since that one would silently package a binary
  that throws only in the installed app.
- **CI no longer publishes releases.** The three build workflows triggered on
  version tags and uploaded their own installer over the one `npm run release`
  had just published — a different binary, so its hash no longer matched the
  update manifest, permanently breaking that update for every client while the
  release script still printed green. `scripts/release.ps1` now owns the feed
  alone; CI builds on `main` and PRs for verification only.

## [0.5.1] - 2026-08-26

### Added

- **Auto-update.** ClawSCAD now checks its own GitHub releases, downloads a newer
  version in the background, and installs it when you quit — so a long Claude
  session or an in-flight render is never interrupted. A staged update shows as a
  pill in the status bar; clicking it restarts into the new version immediately.
  Checking and downloading stay silent by design.
- `npm run release` — a two-phase publish script that builds with
  `--publish never`, asserts the installer, blockmap and `latest.yml` are all
  present and mutually consistent, uploads them with `gh`, then reads the
  published manifest back over HTTP. This avoids an `electron-builder` race that
  can ship a public release with no update manifest at all.

### Notes

- The build already installed on your machine has no updater, so **one final
  manual install is unavoidable**. Every version after 0.5.1 updates itself.
