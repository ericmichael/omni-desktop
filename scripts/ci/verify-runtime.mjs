#!/usr/bin/env node
// CI smoke check for the runtime a packaged launcher just installed.
//
// Usage: node scripts/ci/verify-runtime.mjs <venv-dir>
//
// 1. `omni describe --json` reports the omni-code version this launcher pins
//    and the serve protocol it speaks (src/lib/product.ts).
// 2. `omni serve` boots with the same flag shape the launcher uses, prints
//    its ready line, and answers HTTP on the advertised URL.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const venv = process.argv[2];
if (!venv) {
  console.error('usage: verify-runtime.mjs <venv-dir>');
  process.exit(2);
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const product = readFileSync(join(root, 'src', 'lib', 'product.ts'), 'utf8');
const pinned = product.match(/pinnedVersion:\s*['"]([^'"]+)['"]/)?.[1];
const protocol = Number(product.match(/SUPPORTED_SERVE_PROTOCOL\s*=\s*(\d+)/)?.[1]);
if (!pinned || !protocol) {
  throw new Error('could not read pinnedVersion / SUPPORTED_SERVE_PROTOCOL from src/lib/product.ts');
}

const omni = process.platform === 'win32' ? join(venv, 'Scripts', 'omni.exe') : join(venv, 'bin', 'omni');

const described = spawnSync(omni, ['describe', '--json'], { encoding: 'utf8', timeout: 120_000 });
if (described.status !== 0) {
  console.error(described.stdout, described.stderr);
  throw new Error(`omni describe exited ${described.status}`);
}
const info = JSON.parse(described.stdout);
console.log(`installed ${info.name} ${info.version}, serve protocol ${info.serve_protocol}`);
if (info.version !== pinned) {
  throw new Error(`installed omni-code ${info.version} but the launcher pins ${pinned}`);
}
if (info.serve_protocol !== protocol) {
  throw new Error(`runtime speaks serve protocol ${info.serve_protocol}, launcher expects ${protocol}`);
}

const snapshots = mkdtempSync(join(tmpdir(), 'omni-ci-snapshots-'));
const serve = spawn(
  omni,
  [
    'serve',
    '--output',
    'json',
    '--auth-token',
    'ci-smoke',
    '--agent-host-control-token',
    'ci-smoke-control',
    '--snapshot-dir',
    snapshots,
  ],
  { stdio: ['ignore', 'pipe', 'pipe'] }
);

let stdout = '';
let stderr = '';
serve.stderr.on('data', (chunk) => (stderr += chunk));

const ready = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('omni serve printed no ready line within 180s')), 180_000);
  serve.on('exit', (code) => {
    clearTimeout(timer);
    reject(new Error(`omni serve exited early with code ${code}`));
  });
  serve.stdout.on('data', (chunk) => {
    stdout += chunk;
    for (const line of stdout.split(/\r?\n/)) {
      if (!line.trim().startsWith('{')) {
        continue;
      }
      try {
        const parsed = JSON.parse(line);
        if (parsed.ui_url) {
          clearTimeout(timer);
          resolve(parsed);
          return;
        }
      } catch {
        // Partial line; wait for more output.
      }
    }
  });
}).catch((err) => {
  console.error('--- omni serve stdout ---\n' + stdout);
  console.error('--- omni serve stderr ---\n' + stderr);
  serve.kill();
  throw err;
});

try {
  const response = await fetch(ready.ui_url, { signal: AbortSignal.timeout(30_000) });
  console.log(`omni serve ready at ${ready.ui_url} (HTTP ${response.status})`);
  if (response.status >= 500) {
    throw new Error(`omni serve answered HTTP ${response.status}`);
  }
} finally {
  serve.removeAllListeners('exit');
  serve.kill();
}
