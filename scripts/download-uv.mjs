#!/usr/bin/env node

// Wrapper around download_uv.ts that auto-detects the platform.
// Used by postinstall so developers don't need to pass a platform argument.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');
const binDir = join(projectRoot, 'assets', 'bin');

const isWindows = process.platform === 'win32';
const uvBin = isWindows ? 'uv.exe' : 'uv';

if (existsSync(join(binDir, uvBin)) && !process.argv.includes('--force')) {
  console.log(`uv already exists at assets/bin/, skipping download. Use --force to re-download.`);
  process.exit(0);
}

const platformMap = {
  linux: 'linux',
  darwin: process.arch === 'x64' ? 'mac-x64' : 'mac',
  win32: 'win',
};

const platform = platformMap[process.platform];
if (!platform) {
  console.warn(`\x1b[33mWARNING: Unsupported platform "${process.platform}" — skipping uv download.\x1b[0m`);
  process.exit(0);
}

console.log(`Downloading uv for ${platform}...`);
execFileSync('npx', ['ts-node', 'download_uv.ts', platform], {
  cwd: projectRoot,
  stdio: 'inherit',
});
