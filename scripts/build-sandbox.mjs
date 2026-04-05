#!/usr/bin/env node

// Build the omni-sandbox Rust binary for the current platform and copy it to assets/bin/.
// Cross-platform (works on Windows without bash).

import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');
const sandboxDir = join(projectRoot, 'sandbox-cli');
const binDir = join(projectRoot, 'assets', 'bin');

const isWindows = process.platform === 'win32';
const isLinux = process.platform === 'linux';
const binName = isWindows ? 'omni-sandbox.exe' : 'omni-sandbox';

console.log('Building omni-sandbox...');

// Build the Rust binary.
execFileSync('cargo', ['build', '--release'], {
  cwd: sandboxDir,
  stdio: 'inherit',
});

mkdirSync(binDir, { recursive: true });

// Copy the binary to assets/bin/.
const src = join(sandboxDir, 'target', 'release', binName);
const dest = join(binDir, binName);
copyFileSync(src, dest);
console.log(`Copied ${binName} to assets/bin/`);

// On Linux, also bundle bwrap if available.
if (isLinux) {
  try {
    const bwrapPath = execFileSync('which', ['bwrap'], { encoding: 'utf-8' }).trim();
    if (bwrapPath) {
      copyFileSync(bwrapPath, join(binDir, 'bwrap'));
      // Preserve executable permission.
      const { chmodSync } = await import('node:fs');
      chmodSync(join(binDir, 'bwrap'), 0o755);
      console.log('Copied bwrap to assets/bin/');
    }
  } catch {
    console.warn('WARNING: bwrap not found on PATH. Linux builds will require system-installed bubblewrap.');
  }
}

console.log('Done.');
