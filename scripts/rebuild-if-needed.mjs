#!/usr/bin/env node
/**
 * Rebuild native modules only if their compiled binary doesn't match the
 * current Node ABI. Cheap on the happy path (a couple of require() calls);
 * triggers a full `npm rebuild` only when there's an actual mismatch.
 *
 * Used by `dev:server` and `start:server` so native modules are always usable
 * for the running interpreter, without paying ~60s of source rebuild every
 * dev cycle.
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const MODULES = ['node-pty'];

const broken = [];
for (const name of MODULES) {
  try {
    require(name);
  } catch (err) {
    const msg = String(err && err.message);
    // Rebuild when the compiled binary is unusable: an ABI mismatch (built for a
    // different Node/Electron — e.g. after `npm test`'s electron-rebuild), OR the
    // binary is missing entirely (`MODULE_NOT_FOUND` for the .node). Both are
    // exactly what this script exists to repair. Propagate anything else (a truly
    // missing dep, syntax error, etc.) so real breakage isn't masked by a rebuild.
    const isAbiMismatch = msg.includes('NODE_MODULE_VERSION') || msg.includes('was compiled against');
    const isMissingBinary = err?.code === 'MODULE_NOT_FOUND' && (msg.includes('.node') || msg.includes('/build/'));
    if (isAbiMismatch || isMissingBinary) {
      broken.push(name);
    } else {
      console.error(`[rebuild-if-needed] failed to load ${name}:`, msg);
      process.exit(1);
    }
  }
}

if (broken.length === 0) {
  process.exit(0);
}

console.log(`[rebuild-if-needed] stale or missing binary in [${broken.join(', ')}], running npm rebuild...`);
const r = spawnSync('npm', ['rebuild', ...broken], { stdio: 'inherit' });
process.exit(r.status ?? 1);
