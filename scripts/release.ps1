<#
.SYNOPSIS
  Build and publish a ClawSCAD release — safely.

.DESCRIPTION
  Deliberately does NOT use `electron-builder --publish always`, which has a race
  that can put an INCOMPLETE release on GitHub:

    electron-builder creates one publisher per artifact (the .exe and its
    .blockmap). Both check "does this release exist?", both get "no", and both
    POST /releases ~25ms apart. GitHub creates one and rejects the other with
    422 "Published releases must have a valid tag". That rejection throws inside
    PublishManager.awaitTasks() BEFORE writeUpdateInfoFiles() runs — and that is
    the only place latest.yml is written. Result: a public release with an
    installer and no update manifest, which every electron-updater client is
    blind to. It is silent by construction: the build goes green, the release
    page looks right, and only the updater knows.

  This script decouples the two phases, which removes the whole class of failure:

    1. BUILD with --publish never. latest.yml is still generated (its creation is
       not gated on publishing) but nothing is uploaded, so no race can occur.
    2. ASSERT every artifact exists and is self-consistent BEFORE anything
       becomes public.
    3. PUBLISH with `gh`, one sequential upload at a time.
    4. VERIFY the manifest is actually fetchable from the release and names this
       version — the check that catches a partial publish while it can still be
       fixed.

  Requires: `gh` authenticated with push access to the repo named in
  package.json's `build.publish` block — which is also where the update feed
  points, so a fork must change both together. See docs/releasing.md.

.EXAMPLE
  npm run release
  npm run release:dry                                  # build + assert, publish nothing
  pwsh scripts/release.ps1 -PreRelease -Tag v0.6.0-beta.1
  pwsh scripts/release.ps1 -SkipBuild                  # re-publish an already-built release/
#>
[CmdletBinding()]
param(
  [string]$Tag,
  [switch]$PreRelease,
  [switch]$SkipBuild,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

function Step($msg) { Write-Host "`n=== $msg" -ForegroundColor Cyan }
function Ok($msg)   { Write-Host "  OK  $msg" -ForegroundColor Green }
function Die($msg)  { Write-Host "  FAIL  $msg" -ForegroundColor Red; exit 1 }

# --- version -----------------------------------------------------------------
# package.json is the single source of truth; main.js reads its version from the
# same file, so the two can never drift.
$pkg = Get-Content package.json -Raw | ConvertFrom-Json
$version = $pkg.version
if (-not $Tag) { $Tag = "v$version" }
$exeName = "ClawSCAD-Setup-$version.exe"
$releaseDir = Join-Path $repoRoot 'release'
Step "ClawSCAD $version  ->  tag $Tag"

# --- 1. build ----------------------------------------------------------------
if ($SkipBuild) {
  Write-Host "  (skipping build)"
} else {
  Step 'Building (--publish never: manifest is produced, nothing is uploaded)'
  # Stale artifacts from an older version would otherwise sail through the
  # assertions below and get published.
  if (Test-Path $releaseDir) {
    Get-ChildItem $releaseDir -Filter '*.exe' -ErrorAction SilentlyContinue | Remove-Item -Force
    Get-ChildItem $releaseDir -Filter '*.blockmap' -ErrorAction SilentlyContinue | Remove-Item -Force
    Remove-Item (Join-Path $releaseDir 'latest.yml') -Force -ErrorAction SilentlyContinue
  }

  # OpenSCAD is bundled via extraResources and the renderer is an esbuild
  # bundle — both must exist before electron-builder packs anything.
  & npm run download-openscad
  if ($LASTEXITCODE -ne 0) { Die "download-openscad exited $LASTEXITCODE" }
  & npm run build:renderer
  if ($LASTEXITCODE -ne 0) { Die "build:renderer exited $LASTEXITCODE" }

  & npx electron-builder --win --publish never
  if ($LASTEXITCODE -ne 0) { Die "electron-builder exited $LASTEXITCODE" }
}

# --- 2. assert ---------------------------------------------------------------
Step 'Verifying artifacts before anything becomes public'

$exe  = Join-Path $releaseDir $exeName
$bmap = Join-Path $releaseDir "$exeName.blockmap"
$yml  = Join-Path $releaseDir 'latest.yml'

foreach ($f in @($exe, $bmap, $yml)) {
  if (-not (Test-Path $f)) { Die "missing artifact: $f" }
  Ok "exists: $(Split-Path $f -Leaf) ($([math]::Round((Get-Item $f).Length/1MB,1)) MB)"
}

# latest.yml must describe THIS build, or clients get pointed at the wrong file.
$ymlText = Get-Content $yml -Raw
$ymlVersion = ([regex]::Match($ymlText, '(?m)^version:\s*(.+)$')).Groups[1].Value.Trim()
$ymlPath    = ([regex]::Match($ymlText, '(?m)^path:\s*(.+)$')).Groups[1].Value.Trim()
$ymlSha     = ([regex]::Match($ymlText, '(?m)^sha512:\s*(.+)$')).Groups[1].Value.Trim()

if ($ymlVersion -ne $version) { Die "latest.yml says version $ymlVersion, package.json says $version" }
Ok "latest.yml version matches package.json ($version)"
# The classic 404-forever bug: electron-builder writes a hyphenated URL into the
# manifest but names the default output file with spaces. win.artifactName is
# pinned in package.json to keep these identical; this asserts it stayed that way.
if ($ymlPath -ne $exeName) { Die "latest.yml path is '$ymlPath', expected '$exeName'" }
Ok "latest.yml points at $exeName"

# The updater refuses a download whose hash doesn't match, so a stale manifest
# is a broken update rather than a wrong one. Catch it here instead.
$actualSha = [Convert]::ToBase64String([System.Security.Cryptography.SHA512]::Create().ComputeHash([IO.File]::ReadAllBytes($exe)))
if ($actualSha -ne $ymlSha) { Die "sha512 mismatch: latest.yml does not describe this installer" }
Ok 'latest.yml sha512 matches the built installer'

if ($DryRun) { Write-Host "`nDry run - nothing published." -ForegroundColor Yellow; exit 0 }

# --- 2b. CI collision guard ---------------------------------------------------
# The workflows in .github/workflows/ are build-verification only today; the
# tag triggers and the release-upload steps were removed precisely because of
# what follows. This guard re-checks at run time, so re-adding a workflow that
# uploads `release/*.exe` on a version tag is caught rather than discovered by
# users -- such a workflow uploads the installer and NOTHING else: no
# .blockmap, no latest.yml.
#
# That collides with this script in a way that is silent and permanent:
#
#   1. `gh release create v0.5.1` below CREATES the tag v0.5.1.
#   2. That tag push matches the workflows' `tags: ['v*', '20*']` trigger.
#   3. Minutes later CI finishes its OWN build and action-gh-release uploads its
#      ClawSCAD-Setup-<version>.exe over the one we just published. Same name,
#      so it replaces ours.
#   4. It is a DIFFERENT binary, so its sha512 differs from the one recorded in
#      the latest.yml we uploaded and verified.
#   5. electron-updater refuses any download whose hash does not match the
#      manifest. Every client is now permanently unable to apply that update --
#      and this script will already have printed a green success, because CI had
#      not finished when the read-back ran.
#
# So: refuse, rather than publish into a race we cannot verify. Two one-line
# escapes, both the owner's call (see docs/releasing.md):
#   (a) drop the `tags:` trigger or the "Upload to release" step from the three
#       workflows, leaving releases to this script; or
#   (b) publish under a tag those workflows do not match, e.g.
#       `npm run release -- -Tag release-$version`.
$wfDir = Join-Path $repoRoot '.github/workflows'
if (Test-Path $wfDir) {
  $colliding = @()
  foreach ($wf in Get-ChildItem $wfDir -Filter '*.yml' -ErrorAction SilentlyContinue) {
    $text = Get-Content $wf.FullName -Raw
    if ($text -notmatch 'action-gh-release') { continue }
    $m = [regex]::Match($text, "(?m)^\s*tags:\s*\[(.+)\]\s*$")
    if (-not $m.Success) { continue }
    foreach ($pat in ($m.Groups[1].Value -split ',')) {
      $glob = $pat.Trim().Trim("'").Trim('"')
      if ([string]::IsNullOrWhiteSpace($glob)) { continue }
      # Glob -> regex: only '*' is meaningful in a workflow tag filter.
      $rx = '^' + [regex]::Escape($glob).Replace('\*', '.*') + '$'
      if ($Tag -match $rx) { $colliding += "$($wf.Name) (tags: $glob)"; break }
    }
  }
  if ($colliding.Count -gt 0) {
    Write-Host "`n  FAIL  refusing to publish - CI would clobber this release" -ForegroundColor Red
    Write-Host "  Tag '$Tag' matches tag-triggered release workflows:" -ForegroundColor Red
    $colliding | ForEach-Object { Write-Host "    - $_" -ForegroundColor Red }
    Write-Host ""
    Write-Host "  Those workflows upload their OWN build of the .exe to the same release." -ForegroundColor Yellow
    Write-Host "  It replaces ours, its sha512 no longer matches latest.yml, and every" -ForegroundColor Yellow
    Write-Host "  electron-updater client silently refuses the download - permanently." -ForegroundColor Yellow
    Write-Host "  CI finishes AFTER this script's read-back, so the failure is invisible here." -ForegroundColor Yellow
    Write-Host ""
    Write-Host "  Fix one of these (see docs/releasing.md), then re-run:" -ForegroundColor Cyan
    Write-Host "    (a) remove the 'Upload to release' step or the tags: trigger from those workflows" -ForegroundColor Cyan
    Write-Host "    (b) publish under a non-matching tag:  npm run release -- -Tag release-$version" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "  The build and every artifact assertion above already passed - nothing" -ForegroundColor Cyan
    Write-Host "  else is blocking a release once this is settled." -ForegroundColor Cyan
    exit 1
  }
  Ok 'no tag-triggered release workflow matches this tag'
}

# --- 3. publish --------------------------------------------------------------
Step "Publishing $Tag to GitHub"

# Release notes: this version's CHANGELOG section only, not the whole file.
$notesFile = Join-Path ([IO.Path]::GetTempPath()) "clawscad-notes-$version.md"
if (Test-Path 'CHANGELOG.md') {
  $changelog = Get-Content 'CHANGELOG.md' -Raw
  $section = [regex]::Match($changelog, "(?ms)^##\s*\[$([regex]::Escape($version))\].*?(?=^##\s*\[|\z)")
} else {
  $section = $null
}
if ($section -and $section.Success) {
  ($section.Value.Trim()) | Set-Content $notesFile -Encoding UTF8
  Ok 'release notes extracted from CHANGELOG.md'
} else {
  "ClawSCAD $version" | Set-Content $notesFile -Encoding UTF8
  Write-Host "  note: no CHANGELOG section for $version; using a placeholder" -ForegroundColor Yellow
}

$exists = (& gh release view $Tag --json tagName 2>$null)
if ($LASTEXITCODE -eq 0 -and $exists) {
  Write-Host "  release $Tag already exists - uploading assets with --clobber"
  & gh release upload $Tag $exe $bmap $yml --clobber
  if ($LASTEXITCODE -ne 0) { Die 'gh release upload failed' }
} else {
  # NB: not $args — that is an automatic variable in PowerShell.
  $ghArgs = @('release','create',$Tag,'--title',$version,'--notes-file',$notesFile,$exe,$bmap,$yml)
  if ($PreRelease) { $ghArgs += '--prerelease' }
  & gh @ghArgs
  if ($LASTEXITCODE -ne 0) { Die 'gh release create failed' }
}
Ok 'assets uploaded'

# --- 4. verify the published feed -------------------------------------------
# The failure this script exists to prevent is silent, so never trust the upload
# without reading back what clients will actually fetch.
Step 'Verifying the published update feed'

$assets = (& gh release view $Tag --json assets --jq '[.assets[].name]' | ConvertFrom-Json)
foreach ($want in @($exeName, "$exeName.blockmap", 'latest.yml')) {
  if ($assets -notcontains $want) { Die "asset missing from the release: $want" }
  Ok "published: $want"
}

$base = "https://github.com/$($pkg.build.publish[0].owner)/$($pkg.build.publish[0].repo)/releases/download/$Tag"
try {
  $resp = Invoke-WebRequest "$base/latest.yml" -UseBasicParsing -TimeoutSec 30
  # GitHub serves release assets as application/octet-stream, so PowerShell
  # returns .Content as a byte[] rather than a string. Decode it explicitly, or
  # every regex below quietly matches nothing.
  $remoteYml = if ($resp.Content -is [byte[]]) {
    [System.Text.Encoding]::UTF8.GetString($resp.Content)
  } else {
    [string]$resp.Content
  }
} catch { Die "latest.yml is not fetchable from the release: $_" }

$remoteVersion = ([regex]::Match($remoteYml, '(?m)^version:\s*(.+)$')).Groups[1].Value.Trim()
if ($remoteVersion -ne $version) { Die "published latest.yml says $remoteVersion, expected $version" }
Ok "published latest.yml is reachable and reports $remoteVersion"

try {
  $head = Invoke-WebRequest "$base/$exeName" -Method Head -UseBasicParsing -TimeoutSec 30
  Ok "installer is downloadable (HTTP $($head.StatusCode))"
} catch { Die "installer is not downloadable: $_" }

Remove-Item $notesFile -Force -ErrorAction SilentlyContinue
Write-Host "`nReleased ClawSCAD $version - existing installs will update themselves.`n" -ForegroundColor Green
