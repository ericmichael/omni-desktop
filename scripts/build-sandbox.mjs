#!/usr/bin/env node

// Build the omni-sandbox Rust binary for the current platform and copy it to assets/bin/.
// Cross-platform (works on Windows without bash).

import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');
const sandboxDir = join(projectRoot, 'sandbox-cli');
const binDir = join(projectRoot, 'assets', 'bin');

const isWindows = process.platform === 'win32';
const isLinux = process.platform === 'linux';
const binName = isWindows ? 'omni-sandbox.exe' : 'omni-sandbox';

// Check if the binary already exists (e.g. from a previous build).
const dest = join(binDir, binName);
if (existsSync(dest) && !process.argv.includes('--force')) {
  console.log(`omni-sandbox already exists at assets/bin/, skipping build. Use --force to rebuild.`);
  process.exit(0);
}

// Check if cargo is available before attempting the build.
const MIN_RUST_VERSION = [1, 85, 0]; // Required for Rust edition 2024
let cargoVersion;
try {
  cargoVersion = execFileSync('cargo', ['--version'], { stdio: 'pipe', encoding: 'utf-8' }).trim();
} catch {
  console.warn(
    '\x1b[33m' +
      'WARNING: Rust/Cargo not found — skipping omni-sandbox build.\n' +
      'Install Rust (https://rustup.rs) and run `npm run build:sandbox` to build it.\n' +
      'Sandbox features (local and VM modes) will not work until the binary is built.' +
      '\x1b[0m'
  );
  process.exit(0);
}

// Check Rust version meets minimum requirement (edition 2024 needs 1.85+).
const versionMatch = cargoVersion.match(/(\d+)\.(\d+)\.(\d+)/);
if (versionMatch) {
  const [, major, minor, patch] = versionMatch.map(Number);
  const current = [major, minor, patch];
  const tooOld = current[0] < MIN_RUST_VERSION[0] ||
    (current[0] === MIN_RUST_VERSION[0] && current[1] < MIN_RUST_VERSION[1]) ||
    (current[0] === MIN_RUST_VERSION[0] && current[1] === MIN_RUST_VERSION[1] && current[2] < MIN_RUST_VERSION[2]);
  if (tooOld) {
    console.warn(
      '\x1b[33m' +
        `WARNING: Rust ${major}.${minor}.${patch} is too old — ${MIN_RUST_VERSION.join('.')}+ is required (for edition 2024).\n` +
        'Run `rustup update` to upgrade, then `npm run build:sandbox` to build.\n' +
        'Sandbox features (local and VM modes) will not work until the binary is built.' +
        '\x1b[0m'
    );
    process.exit(0);
  }
}

const isPostinstall = !process.argv.includes('--force');

console.log('Building omni-sandbox...');

try {
  // Build the Rust binary.
  execFileSync('cargo', ['build', '--release'], {
    cwd: sandboxDir,
    stdio: 'inherit',
  });
} catch (err) {
  if (isPostinstall) {
    console.warn(
      '\x1b[33m' +
        'WARNING: omni-sandbox build failed — skipping.\n' +
        'Fix the issue and run `npm run build:sandbox` to retry.\n' +
        'Sandbox features (local and VM modes) will not work until the binary is built.' +
        '\x1b[0m'
    );
    process.exit(0);
  }
  // Explicit build:sandbox — let it fail loud.
  process.exit(1);
}

mkdirSync(binDir, { recursive: true });

// Copy the binary to assets/bin/.
const src = join(sandboxDir, 'target', 'release', binName);
copyFileSync(src, dest);
console.log(`Copied ${binName} to assets/bin/`);

// On Linux, also bundle bwrap if available.
if (isLinux) {
  try {
    const bwrapPath = execFileSync('which', ['bwrap'], { encoding: 'utf-8' }).trim();
    if (bwrapPath) {
      copyFileSync(bwrapPath, join(binDir, 'bwrap'));
      chmodSync(join(binDir, 'bwrap'), 0o755);
      console.log('Copied bwrap to assets/bin/');
    }
  } catch {
    console.warn('WARNING: bwrap not found on PATH. Linux builds will require system-installed bubblewrap.');
  }
}

console.log('Done.');
