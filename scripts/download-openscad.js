#!/usr/bin/env node
/**
 * Downloads the bundled OpenSCAD binary for the current build platform.
 * Run manually:  node scripts/download-openscad.js
 * Run for CI:    node scripts/download-openscad.js --force
 *
 * Output locations (relative to repo root):
 *   Linux  → vendors/openscad-linux.AppImage
 *   macOS  → vendors/OpenSCAD.app/
 *   Windows → vendors/openscad-win/  (extracted from .zip)
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const os = require('os');

const SNAPSHOT = '2026.03.16';
const BASE_URL = 'https://files.openscad.org/snapshots';
const ROOT = path.join(__dirname, '..');
const VENDOR_DIR = path.join(ROOT, 'vendors');

// ── Platform asset definitions ───────────────────────────────────────────────

const ASSETS = {
  'linux-x64': {
    url: `${BASE_URL}/OpenSCAD-${SNAPSHOT}-x86_64.AppImage`,
    tmp: path.join(VENDOR_DIR, '_openscad-linux.AppImage'),
    ready: path.join(VENDOR_DIR, 'openscad-linux.AppImage'),
    finalize(tmp, ready) {
      fs.renameSync(tmp, ready);
      fs.chmodSync(ready, 0o755);
      console.log(`  → ${ready}`);
    },
  },
  'darwin-arm64': {
    url: `${BASE_URL}/OpenSCAD-${SNAPSHOT}.dmg`,
    tmp: path.join(VENDOR_DIR, '_openscad-mac.dmg'),
    ready: path.join(VENDOR_DIR, 'OpenSCAD.app'),
    finalize(tmp, ready) {
      const mountpoint = path.join(os.tmpdir(), 'openscad-dmg-mount');
      try {
        execFileSync('hdiutil', ['attach', tmp, '-mountpoint', mountpoint, '-nobrowse', '-quiet']);
        const src = path.join(mountpoint, 'OpenSCAD.app');
        execFileSync('cp', ['-R', src, ready]);
        execFileSync('hdiutil', ['detach', mountpoint, '-quiet']);
        console.log(`  → ${ready}`);
      } finally {
        fs.rmSync(tmp, { force: true });
      }
    },
  },
  'darwin-x64': {
    // Intel Macs: same DMG ships a universal binary
    url: `${BASE_URL}/OpenSCAD-${SNAPSHOT}.dmg`,
    tmp: path.join(VENDOR_DIR, '_openscad-mac.dmg'),
    ready: path.join(VENDOR_DIR, 'OpenSCAD.app'),
    finalize: null, // set below
  },
  'win32-x64': {
    url: `${BASE_URL}/OpenSCAD-${SNAPSHOT}-x86-64.zip`,
    tmp: path.join(VENDOR_DIR, '_openscad-win.zip'),
    ready: path.join(VENDOR_DIR, 'openscad-win'),
    finalize(tmp, ready) {
      // Re-extraction must not merge a new archive into an old nested layout.
      if (fs.existsSync(ready)) fs.rmSync(ready, { recursive: true, force: true });
      // Use PowerShell on Windows; fall back to unzip on CI runners
      try {
        execFileSync('powershell', [
          '-NoProfile', '-Command',
          `Expand-Archive -Force '${tmp}' '${ready}'`,
        ]);
      } catch {
        execFileSync('unzip', ['-q', tmp, '-d', ready]);
      }
      fs.rmSync(tmp, { force: true });
      flattenSingleDir(ready, 'openscad.exe');
      if (!fs.existsSync(path.join(ready, 'openscad.exe'))) {
        throw new Error('OpenSCAD archive does not contain openscad.exe at the expected location');
      }
      console.log(`  → ${ready}`);
    },
  },
};

// Intel Mac reuses the arm64 finalize
ASSETS['darwin-x64'].finalize = ASSETS['darwin-arm64'].finalize;

// Snapshot zips may contain one enclosing directory. The packaged app expects
// openscad.exe directly inside vendors/openscad-win.
function flattenSingleDir(dir, marker) {
  if (fs.existsSync(path.join(dir, marker))) return false;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  if (entries.length !== 1 || !entries[0].isDirectory()) return false;
  const inner = path.join(dir, entries[0].name);
  if (!fs.existsSync(path.join(inner, marker))) return false;
  for (const name of fs.readdirSync(inner)) {
    fs.renameSync(path.join(inner, name), path.join(dir, name));
  }
  fs.rmdirSync(inner);
  return true;
}

// ── Download helper ───────────────────────────────────────────────────────────

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    let lastPct = -1;

    function get(u) {
      const mod = u.startsWith('https') ? https : http;
      mod.get(u, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          return get(res.headers.location);
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        const total = parseInt(res.headers['content-length'] || '0', 10);
        let got = 0;
        res.on('data', (chunk) => {
          got += chunk.length;
          if (total > 0) {
            const pct = Math.floor((got / total) * 100);
            if (pct !== lastPct && pct % 5 === 0) {
              process.stdout.write(`\r  ${(got / 1e6).toFixed(0)}MB / ${(total / 1e6).toFixed(0)}MB  (${pct}%)`);
              lastPct = pct;
            }
          }
        });
        res.pipe(file);
        file.on('finish', () => { file.close(); process.stdout.write('\n'); resolve(); });
        file.on('error', reject);
      }).on('error', reject);
    }
    get(url);
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const force = process.argv.includes('--force');
  const key = `${process.platform}-${process.arch}`;
  const asset = ASSETS[key];

  if (!asset) {
    console.error(`No OpenSCAD snapshot available for platform: ${key}`);
    console.error('Supported: linux-x64, darwin-arm64, darwin-x64, win32-x64');
    process.exit(1);
  }

  fs.mkdirSync(VENDOR_DIR, { recursive: true });

  // Repair existing downloads made before the Windows archive layout fix.
  if (key === 'win32-x64' && fs.existsSync(asset.ready)) {
    flattenSingleDir(asset.ready, 'openscad.exe');
  }

  // Skip only when the expected executable is actually present.
  if (!force && fs.existsSync(asset.ready)) {
    if (key !== 'win32-x64' || fs.existsSync(path.join(asset.ready, 'openscad.exe'))) {
      console.log(`OpenSCAD ${SNAPSHOT} already present at vendors/ — skipping (use --force to re-download).`);
      return;
    }
  }

  console.log(`Downloading OpenSCAD ${SNAPSHOT} for ${key}...`);
  console.log(`  from: ${asset.url}`);

  await download(asset.url, asset.tmp);
  console.log('Finalizing...');
  asset.finalize(asset.tmp, asset.ready);
  console.log(`Done. OpenSCAD ${SNAPSHOT} is ready.`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error('\nDownload failed:', e.message);
    process.exit(1);
  });
}

module.exports = { flattenSingleDir };
