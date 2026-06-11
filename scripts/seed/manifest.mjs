import fs from 'node:fs/promises';

import { getManifestFile, getUserDataDir } from './paths.mjs';

/**
 * Seed manifest tracks every entity ID and filesystem path the seeder created,
 * so `--reset` can tear down exactly that set without touching user data.
 *
 * Shape:
 * {
 *   version: 1,
 *   seededAt: <epoch ms>,
 *   entities: {
 *     projects:   [{ id, seedKey }],
 *     milestones: [{ id, seedKey }],
 *     pages:      [{ id, seedKey }],
 *     tickets:    [{ id, seedKey }],
 *     inboxItems: [{ id, seedKey }],
 *   },
 *   paths: [<absolute path>, ...],  // project dirs, which include project-scoped skills
 * }
 */

export function emptyManifest() {
  return {
    version: 1,
    seededAt: Date.now(),
    entities: {
      projects: [],
      milestones: [],
      pages: [],
      tickets: [],
      inboxItems: [],
    },
    paths: [],
  };
}

export async function readManifest() {
  try {
    const raw = await fs.readFile(getManifestFile(), 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

export async function writeManifest(manifest) {
  await fs.mkdir(getUserDataDir(), { recursive: true });
  await fs.writeFile(getManifestFile(), JSON.stringify(manifest, null, '\t'), 'utf-8');
}

export async function deleteManifest() {
  try {
    await fs.unlink(getManifestFile());
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}
