# Releasing

ClawSCAD auto-updates itself: `main/updater.js` checks GitHub releases, downloads
in the background, and installs on quit. That only works if the release on GitHub
is *complete*, and the ways it can be silently incomplete are the entire reason
this document and `scripts/release.ps1` exist.

```powershell
npm run release            # build, assert, publish, verify
npm run release:dry        # build + assert only — publishes nothing
```

## Before your first release from a fork

**Repoint the publish target.** `package.json` → `build.publish`:

```json
"publish": [
  { "provider": "github", "owner": "levkropp", "repo": "ClawSCAD", "releaseType": "release" }
]
```

That block is two things at once: where `npm run release` uploads, and where every
installed copy asks for updates. A fork that leaves it pointing at someone else's
repo ships an app that updates itself *into a different fork's builds*.

`electron-updater` resolves **the newest Release in a repo**, not the newest
release of a product. `appId` does not scope the feed — only the repo does. So two
products must never publish to one repo, however different their `appId`s are; the
users of each would be offered the other's installer.

`gh` needs push access to that repo. The app itself needs no token: a public repo's
release assets are fetched anonymously.

## Why not `electron-builder --publish always`

It has a race that publishes a release with **no `latest.yml`**, which every
updater client is blind to — permanently, and silently.

electron-builder creates one publisher per artifact (the `.exe` and its
`.blockmap`). Both ask "does this release exist?", both get "no", and both
`POST /releases` about 25 ms apart. GitHub creates one and rejects the other with
`422 Published releases must have a valid tag`. That rejection throws inside
`PublishManager.awaitTasks()` **before** `writeUpdateInfoFiles()` runs — and that
is the only place `latest.yml` is written. The release page then looks perfectly
normal: an installer, a version, notes. Only the updater knows it is dead.

`scripts/release.ps1` removes the whole class of failure by decoupling the phases:

1. **Build** with `--publish never`. `latest.yml` is still generated (its creation
   was never gated on publishing), but nothing uploads, so nothing can race.
2. **Assert** the `.exe`, `.blockmap` and `latest.yml` all exist and describe the
   same build — matching version, matching path, matching sha512.
3. **Publish** with `gh`, one sequential upload.
4. **Verify** by fetching the published `latest.yml` back over HTTP and checking it
   reports this version, then HEAD-ing the installer. The failure being guarded
   against is invisible, so the script never trusts its own upload.

Two assertions in there are worth naming, because each has its own way of
404-ing the updater forever:

- **`win.artifactName` is pinned** in `package.json`. Left default, electron-builder
  writes a hyphenated URL into the manifest while naming the file with spaces.
  Step 2 asserts `latest.yml`'s `path` still matches the built file's name.
- **sha512 is recomputed** from the actual installer. The updater refuses any
  download whose hash does not match the manifest, so a stale manifest is not a
  wrong update — it is no update at all.

## The CI collision guard

Step 2b refuses to publish under a tag that matches a workflow which uploads
`release/*` to a GitHub release. This is not hypothetical:

1. `gh release create v0.6.1` **creates the tag**.
2. A `tags: ['v*']` trigger fires all the build workflows.
3. Minutes later CI uploads its *own* `ClawSCAD-Setup-0.6.1.exe` over yours — same
   filename, so it replaces it — and nothing else. No `.blockmap`, no `latest.yml`.
4. It is a different binary, so its sha512 no longer matches the manifest you
   published.
5. Every client is now permanently unable to apply that update, and the release
   script already printed green, because CI had not finished when it read back.

The workflows in `.github/workflows/` are therefore **build verification only** —
they build on `main` and on PRs, and upload artifacts to the Actions run, never to
a release. Exactly one publisher may own the update feed, and it is
`scripts/release.ps1`.

If you do want CI to publish, the guard tells you the two ways out: drop the
release-upload step, or publish under a tag the workflows do not match
(`npm run release -- -Tag release-0.6.1`). Do **not** solve it by having CI upload
all three artifacts — `latest.yml` is per-platform, three parallel jobs would race
on it, and you would lose the read-back verification entirely.

## The one-time manual install

A version installed *before* the updater existed cannot update itself. Whoever
cuts the first release has to install that build by hand once, from the release
page. Every version after it arrives on its own. There is no way around this for
any app; it is a one-time cost per machine.

## Release notes

`scripts/release.ps1` pulls the body from `CHANGELOG.md` — specifically the
`## [x.y.z]` section matching `package.json`'s version, so keep that heading format
exact. No matching section is not fatal; you just get a bare `ClawSCAD <version>`
placeholder, which is usually not what you wanted to publish.

## Build prerequisites (Windows)

`npmRebuild` is `false` in the build config. `node-pty` is N-API and ships
`win32-x64` prebuilds, so there is nothing to rebuild, and a rebuild is where
Windows release builds usually die. If you re-enable it, expect two failures:

- `NoDefaultCurrentDirectoryInExePath=1` in the environment makes winpty's gyp step
  fail with `'GetCommitHash.bat' is not recognized`. Clear it for the build.
- MSBuild then wants `MSB8040: Spectre-mitigated libraries` — install them from the
  Visual Studio Installer (Individual Components) for the v143 x64 toolset.
