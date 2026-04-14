#!/usr/bin/env node

// Downloads a pre-built omni-sandbox binary from the omni-code GitHub releases.
// Usage:
//   node scripts/download-sandbox.mjs            # Auto-detect platform, skip if exists
//   node scripts/download-sandbox.mjs --force    # Force re-download
//   node scripts/download-sandbox.mjs --version v0.2.0  # Specific version

import { execFileSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import https from 'node:https';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');
const binDir = join(projectRoot, 'assets', 'bin');

const REPO = 'ericmichael/omni-code';

const isWindows = process.platform === 'win32';
const sandboxBin = isWindows ? 'omni-sandbox.exe' : 'omni-sandbox';
const sandboxPath = join(binDir, sandboxBin);

// Parse CLI args
const args = process.argv.slice(2);
const force = args.includes('--force');
const versionIdx = args.indexOf('--version');
const requestedVersion = versionIdx !== -1 ? args[versionIdx + 1] : null;

if (existsSync(sandboxPath) && !force) {
  console.log(
    `omni-sandbox already exists at assets/bin/, skipping download. Use --force to re-download.`,
  );
  process.exit(0);
}

// Map platform + arch to release asset name
const assetMap = {
  'linux-x64': 'omni-sandbox-linux-x86_64',
  'darwin-arm64': 'omni-sandbox-macos-aarch64',
  'darwin-x64': 'omni-sandbox-macos-x86_64',
  'win32-x64': 'omni-sandbox-windows-x86_64.exe',
};

const key = `${process.platform}-${process.arch}`;
const assetName = assetMap[key];

if (!assetName) {
  console.warn(
    `\x1b[33mWARNING: No pre-built omni-sandbox binary for ${key} — skipping download.\x1b[0m`,
  );
  console.warn(`You can build it manually: cd ../omni-code && ./scripts/build-sandbox.sh`);
  process.exit(0);
}

/**
 * Follow redirects for HTTPS GET (GitHub releases redirect to S3).
 * Returns a readable stream of the response body.
 */
function httpsGet(url, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { 'User-Agent': 'omni-code-launcher' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          if (maxRedirects <= 0) return reject(new Error('Too many redirects'));
          return httpsGet(res.headers.location, maxRedirects - 1).then(resolve, reject);
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        }
        resolve(res);
      })
      .on('error', reject);
  });
}

async function download() {
  // Determine which release to download from
  let tag = requestedVersion;
  if (!tag) {
    // Get the latest release tag
    console.log(`Fetching latest release from ${REPO}...`);
    try {
      const output = execFileSync('gh', ['release', 'view', '--repo', REPO, '--json', 'tagName', '-q', '.tagName'], {
        encoding: 'utf-8',
      }).trim();
      tag = output;
    } catch {
      console.warn(
        `\x1b[33mWARNING: No release found in ${REPO} — skipping omni-sandbox download.\x1b[0m`,
      );
      process.exit(0);
    }
  }

  const url = `https://github.com/${REPO}/releases/download/${tag}/${assetName}`;
  console.log(`Downloading ${assetName} from release ${tag}...`);

  mkdirSync(binDir, { recursive: true });

  const res = await httpsGet(url);
  const dest = createWriteStream(sandboxPath);
  await pipeline(res, dest);

  if (!isWindows) {
    chmodSync(sandboxPath, 0o755);
  }

  console.log(`Downloaded omni-sandbox to assets/bin/${sandboxBin}`);

  // On Linux, also check for bundled bwrap
  if (process.platform === 'linux') {
    const bwrapPath = join(binDir, 'bwrap');
    if (!existsSync(bwrapPath)) {
      try {
        const which = execFileSync('which', ['bwrap'], { encoding: 'utf-8' }).trim();
        if (which) {
          execFileSync('cp', [which, bwrapPath]);
          chmodSync(bwrapPath, 0o755);
          console.log(`Copied system bwrap to assets/bin/bwrap`);
        }
      } catch {
        console.warn(
          `\x1b[33mWARNING: bwrap not found on PATH. Linux sandbox will require system-installed bubblewrap.\x1b[0m`,
        );
      }
    }
  }
}

download().catch((err) => {
  console.error(`\x1b[31mFailed to download omni-sandbox: ${err.message}\x1b[0m`);
  process.exit(1);
});
