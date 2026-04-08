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
try {
  execFileSync('cargo', ['--version'], { stdio: 'pipe' });
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

console.log('Building omni-sandbox...');

// Build the Rust binary.
execFileSync('cargo', ['build', '--release'], {
  cwd: sandboxDir,
  stdio: 'inherit',
});

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
