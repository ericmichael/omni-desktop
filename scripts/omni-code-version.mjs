#!/usr/bin/env node
// Print the pinned omni-code version. The SINGLE source of truth is
// src/lib/omni-version.ts (OMNI_CODE_VERSION) — both the desktop runtime
// installer (imports it) and the Docker image build (this script feeds it as a
// --build-arg) read from here, so the version is pinned in exactly one place.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', 'src', 'lib', 'omni-version.ts'), 'utf8');
const m = src.match(/OMNI_CODE_VERSION\s*=\s*['"]([^'"]+)['"]/);
if (!m) {
  console.error('omni-code-version: could not find OMNI_CODE_VERSION in src/lib/omni-version.ts');
  process.exit(1);
}
process.stdout.write(m[1]);
