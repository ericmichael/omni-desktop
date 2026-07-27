#!/usr/bin/env node

// Builds omni-wsl-payload.tar.gz — the self-contained Linux backend that the
// Windows installer ships and Electron main streams into a WSL distro
// (docs/windows-wsl-backend-plan.md, Phase 5 / Decision 5).
//
// Payload layout (extracted to ~/.omni/launcher/ inside the distro):
//   server/        copy of out/server (vite server bundle, entry index.mjs)
//   browser/       copy of out/browser (SPA served statically by the server)
//   node_modules/  linux-x64 production installs of the five server-bundle
//                  externals from vite.server.config.ts
//   node/          pinned official Node.js linux-x64 runtime (node/bin/node)
//   VERSION        launcher version from package.json
//
// Linux-only: node-pty has no prebuilds and must be compiled for linux-x64
// against the pinned runtime's ABI. Run in CI or inside WSL.
//
// Usage:
//   npm run build:server                        # Prerequisite (not run here)
//   node scripts/build-wsl-payload.mjs          # Full build
//   node scripts/build-wsl-payload.mjs --dry-run  # Skip Node download + npm
//                                                 # install; stage + tar only

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { readFile } from 'node:fs/promises';
import https from 'node:https';
import { dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

// Pinned Node.js runtime shipped in the payload. Source of truth: .nvmrc
// (v22.13.0), consistent with package.json engines (>=22.13.0) and the vite
// server build target (node22). Bump .nvmrc and this together.
const NODE_RUNTIME_VERSION = '22.13.0';

// ws's optional native helpers (see vite.server.config.ts). They are NOT
// dependencies of the launcher itself, so they have no entry in
// package-lock.json — pinned here instead. Both satisfy ws@8's peer ranges
// (bufferutil ^4.0.1, utf-8-validate >=5.0.2) and ship linux-x64 prebuilds.
const WS_NATIVE_HELPER_VERSIONS = {
  bufferutil: '4.0.9',
  'utf-8-validate': '6.0.5',
};

// Externals resolved from the repo's lockfile at build time.
const LOCKFILE_EXTERNALS = ['node-pty', 'ws', '@fastify/websocket'];

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');
const outDir = join(projectRoot, 'out', 'wsl-payload');
const stagingDir = join(outDir, 'staging');
const cacheDir = join(projectRoot, '.cache', 'wsl-payload');
const tarballPath = join(outDir, 'omni-wsl-payload.tar.gz');

const dryRun = process.argv.includes('--dry-run');

// The payload is linux-x64 by construction: the Node runtime tarball is
// linux-x64 and node-pty compiles for the host. Building anywhere else would
// silently produce a payload the WSL distro can't run.
if (process.platform !== 'linux') {
  console.error(
    `\x1b[31mbuild-wsl-payload must run on Linux (got ${process.platform}).\x1b[0m\n` +
      `Run it in CI or inside WSL — the payload contains linux-x64 binaries.`
  );
  process.exit(1);
}

// Require an existing server build; do not auto-build (CI sequences the steps
// explicitly, and a stale local out/ should fail loudly, not silently rebuild).
const serverEntry = join(projectRoot, 'out', 'server', 'index.mjs');
const browserEntry = join(projectRoot, 'out', 'browser', 'index.html');
for (const [label, path] of [
  ['out/server/index.mjs', serverEntry],
  ['out/browser/index.html', browserEntry],
]) {
  if (!existsSync(path)) {
    console.error(`\x1b[31mMissing ${label} — run \`npm run build:server\` first.\x1b[0m`);
    process.exit(1);
  }
}

const packageJson = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf-8'));
const lockfile = JSON.parse(await readFile(join(projectRoot, 'package-lock.json'), 'utf-8'));

// Exact versions for the staged node_modules, pinned from the lockfile so the
// payload can never drift from what the launcher was built against.
const dependencies = { ...WS_NATIVE_HELPER_VERSIONS };
for (const name of LOCKFILE_EXTERNALS) {
  const version = lockfile.packages?.[`node_modules/${name}`]?.version;
  if (!version) {
    console.error(`\x1b[31mCould not resolve ${name} in package-lock.json — is it still a dependency?\x1b[0m`);
    process.exit(1);
  }
  dependencies[name] = version;
}

// node-pty compiles against the running Node's ABI. If the Node executing this
// script is a different major than the runtime we ship, the daemon will fail
// to load pty.node inside the distro.
const runningMajor = Number(process.version.slice(1).split('.')[0]);
const pinnedMajor = Number(NODE_RUNTIME_VERSION.split('.')[0]);
if (runningMajor !== pinnedMajor) {
  console.warn(
    `\x1b[33mWARNING: running Node ${process.version} but the payload ships Node v${NODE_RUNTIME_VERSION}.\x1b[0m\n` +
      `  node-pty is compiled against the running Node's ABI (major ${runningMajor}), which will NOT load\n` +
      `  under the bundled v${NODE_RUNTIME_VERSION} runtime (major ${pinnedMajor}). Re-run under Node ${pinnedMajor}.x.`
  );
}

// --- Stage -----------------------------------------------------------------

rmSync(stagingDir, { recursive: true, force: true });
mkdirSync(stagingDir, { recursive: true });

console.log('Staging server/ and browser/...');
cpSync(join(projectRoot, 'out', 'server'), join(stagingDir, 'server'), { recursive: true });
cpSync(join(projectRoot, 'out', 'browser'), join(stagingDir, 'browser'), { recursive: true });

writeFileSync(join(stagingDir, 'VERSION'), packageJson.version);
console.log(`Stamped VERSION ${packageJson.version}`);

if (dryRun) {
  console.log('\x1b[33m--dry-run: skipping Node runtime download and node_modules install.\x1b[0m');
} else {
  await stageNodeRuntime();
  stageNodeModules();
}

// --- Pack ------------------------------------------------------------------

// Tar entries are rooted at server/, browser/, ... (no wrapping top-level
// dir) so main can extract with `tar xzf - -C ~/.omni/launcher`. Staging
// scratch files (package.json, package-lock.json from the npm install) are
// simply not listed.
const allEntries = ['server', 'browser', 'node_modules', 'node', 'VERSION'];
const entries = allEntries.filter((entry) => existsSync(join(stagingDir, entry)));
console.log(`Packing ${tarballPath} (${entries.join(', ')})...`);
execFileSync('tar', ['-czf', tarballPath, '--owner=0', '--group=0', '--numeric-owner', '-C', stagingDir, ...entries], {
  stdio: 'inherit',
});

const sizeMb = (statSync(tarballPath).size / (1024 * 1024)).toFixed(1);
console.log(`Built omni-wsl-payload.tar.gz (${sizeMb} MB).`);
const missing = allEntries.filter((entry) => !entries.includes(entry));
if (missing.length > 0) {
  console.warn(`\x1b[33mPayload is incomplete (missing: ${missing.join(', ')}) — do not ship it.\x1b[0m`);
}

// Exit explicitly so any keep-alive HTTPS sockets in the default agent don't
// keep the event loop alive past the work we actually care about.
process.exit(0);

// --- Steps -----------------------------------------------------------------

/** Downloads (with cache), verifies, and unpacks the pinned Node runtime into staging as node/. */
async function stageNodeRuntime() {
  const runtimeName = `node-v${NODE_RUNTIME_VERSION}-linux-x64`;
  const runtimeTarball = `${runtimeName}.tar.gz`;
  const cachedPath = join(cacheDir, runtimeTarball);
  const baseUrl = `https://nodejs.org/dist/v${NODE_RUNTIME_VERSION}`;

  // SHASUMS256.txt is the official checksum manifest for the release; both
  // fresh downloads and cache hits verify against it so a corrupted or
  // tampered cache can't ship.
  console.log(`Fetching ${baseUrl}/SHASUMS256.txt...`);
  const shasums = await readBody(await httpsGet(`${baseUrl}/SHASUMS256.txt`));
  const expectedSha = shasums
    .split('\n')
    .find((line) => line.endsWith(`  ${runtimeTarball}`))
    ?.split(/\s+/)[0];
  if (!expectedSha) {
    console.error(`\x1b[31m${runtimeTarball} not listed in SHASUMS256.txt for v${NODE_RUNTIME_VERSION}.\x1b[0m`);
    process.exit(1);
  }

  if (existsSync(cachedPath) && (await sha256(cachedPath)) === expectedSha) {
    console.log(`Node runtime ${runtimeTarball} cached and verified, skipping download.`);
  } else {
    mkdirSync(cacheDir, { recursive: true });
    console.log(`Downloading ${baseUrl}/${runtimeTarball}...`);
    await pipeline(await httpsGet(`${baseUrl}/${runtimeTarball}`), createWriteStream(cachedPath));
    const actual = await sha256(cachedPath);
    if (actual !== expectedSha) {
      console.error(
        `\x1b[31mSHA256 mismatch for ${runtimeTarball}\x1b[0m\n  expected: ${expectedSha}\n  actual:   ${actual}`
      );
      process.exit(1);
    }
    console.log(`Downloaded and verified ${runtimeTarball} (sha256 ${actual}).`);
  }

  const nodeDir = join(stagingDir, 'node');
  mkdirSync(nodeDir, { recursive: true });
  execFileSync('tar', ['-xzf', cachedPath, '-C', nodeDir, '--strip-components=1'], { stdio: 'inherit' });
  console.log(`Unpacked Node runtime into node/ (node/bin/node).`);
}

/** npm-installs the five server externals at pinned versions into staging/node_modules. */
function stageNodeModules() {
  console.log(`Installing server externals: ${Object.keys(dependencies).join(', ')}...`);
  writeFileSync(
    join(stagingDir, 'package.json'),
    JSON.stringify({ name: 'omni-wsl-payload', private: true, dependencies }, null, 2)
  );
  // node-pty has no prebuilds — this compiles it via node-gyp (needs python3 +
  // make + g++, present on CI runners and standard WSL distros).
  execFileSync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error'], {
    cwd: stagingDir,
    stdio: 'inherit',
  });
}

// --- Helpers ---------------------------------------------------------------

function httpsGet(url, maxRedirects = 5) {
  return new Promise((resolvePromise, reject) => {
    https
      .get(url, { headers: { 'User-Agent': 'omni-code-launcher' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          // Drain the redirect body so the socket closes instead of lingering
          // in the keep-alive pool and holding the event loop open after the
          // script finishes.
          res.resume();
          if (maxRedirects <= 0) return reject(new Error('Too many redirects'));
          return httpsGet(res.headers.location, maxRedirects - 1).then(resolvePromise, reject);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        }
        resolvePromise(res);
      })
      .on('error', reject);
  });
}

function readBody(res) {
  return new Promise((resolvePromise, reject) => {
    let body = '';
    res.setEncoding('utf-8');
    res.on('data', (chunk) => (body += chunk));
    res.on('end', () => resolvePromise(body));
    res.on('error', reject);
  });
}

function sha256(filePath) {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolvePromise(hash.digest('hex')));
    stream.on('error', reject);
  });
}
