#!/usr/bin/env node

// Downloads vc_redist.x64.exe from Microsoft for bundling into the Windows
// NSIS installer. Only relevant when packaging a Windows build; skips
// otherwise.
//
// Why bundled (not downloaded at install time):
//   1. Corporate proxies / firewalls block aka.ms
//   2. Install-time download adds latency + a failure mode users can't debug
//   3. Offline installs (lab machines, air-gapped) need the redist present
//
// Usage:
//   node scripts/download-vcredist.mjs            # Skip if already present
//   node scripts/download-vcredist.mjs --force    # Re-download

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync } from 'node:fs';
import https from 'node:https';
import { dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');
const binDir = join(projectRoot, 'assets', 'bin');
const destPath = join(binDir, 'vc_redist.x64.exe');

const force = process.argv.includes('--force');

// Only the Windows NSIS installer bundles this binary. Skip on all other
// runners (incl. Linux AppImage + macOS DMG CI jobs) — downloading 25 MB to
// never use it just slows the build.
if (process.platform !== 'win32') {
  console.log(`Skipping vc_redist download on ${process.platform} (Windows-only).`);
  process.exit(0);
}

const packageJson = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf-8'));
const config = packageJson.vcredist;

if (!config?.url) {
  console.error('\x1b[31mMissing "vcredist.url" in package.json\x1b[0m');
  process.exit(1);
}

if (existsSync(destPath) && !force) {
  // Verify SHA of the existing file if pinned, so a corrupted cache doesn't
  // silently ship.
  if (config.sha256) {
    const actual = await sha256(destPath);
    if (actual === config.sha256) {
      console.log(`vc_redist.x64.exe already present and verified, skipping.`);
      process.exit(0);
    }
    console.warn(`Cached vc_redist.x64.exe SHA mismatch, re-downloading...`);
  } else {
    console.log(`vc_redist.x64.exe already present, skipping (no SHA pinned).`);
    process.exit(0);
  }
}

mkdirSync(binDir, { recursive: true });

console.log(`Downloading vc_redist.x64.exe from ${config.url}...`);
const res = await httpsGet(config.url);
await pipeline(res, createWriteStream(destPath));

const actual = await sha256(destPath);

if (config.sha256) {
  if (actual !== config.sha256) {
    console.error(
      `\x1b[31mSHA256 mismatch for vc_redist.x64.exe\x1b[0m\n` +
        `  expected: ${config.sha256}\n` +
        `  actual:   ${actual}\n` +
        `If Microsoft has published a new redistributable, verify it came from a\n` +
        `trusted source and update "vcredist.sha256" in package.json.`
    );
    process.exit(1);
  }
  console.log(`Downloaded and verified vc_redist.x64.exe (sha256 ${actual}).`);
} else {
  console.warn(
    `\x1b[33mWARNING: "vcredist.sha256" is not pinned in package.json.\x1b[0m\n` +
      `  Computed sha256: ${actual}\n` +
      `  Add this to package.json under "vcredist.sha256" to pin against supply-chain drift.`
  );
}

// Exit explicitly so any keep-alive HTTPS sockets in the default agent don't
// keep the event loop alive past the work we actually care about.
process.exit(0);

function httpsGet(url, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { 'User-Agent': 'omni-code-launcher' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          // Drain the redirect body so the socket closes instead of lingering
          // in the keep-alive pool and holding the event loop open after the
          // script finishes.
          res.resume();
          if (maxRedirects <= 0) return reject(new Error('Too many redirects'));
          return httpsGet(res.headers.location, maxRedirects - 1).then(resolve, reject);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        }
        resolve(res);
      })
      .on('error', reject);
  });
}

function sha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}
