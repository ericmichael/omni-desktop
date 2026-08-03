#!/usr/bin/env node
// Print the pinned omni-code version. The SINGLE source of truth is
// src/lib/product.ts (BUNDLED_PRODUCT.pinnedVersion) — both the desktop runtime
// installer and the Docker image build read the same product definition, so the
// version is pinned in exactly one place.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', 'src', 'lib', 'product.ts'), 'utf8');
const m = src.match(/pinnedVersion:\s*['"]([^'"]+)['"]/);
if (!m) {
  console.error('omni-code-version: could not find BUNDLED_PRODUCT.pinnedVersion in src/lib/product.ts');
  process.exit(1);
}
process.stdout.write(m[1]);
