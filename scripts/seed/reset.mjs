import fs from 'node:fs/promises';

import { deleteManifest, readManifest } from './manifest.mjs';
import { readStore, writeStore } from './store-io.mjs';

async function rmSafe(targetPath) {
  try {
    await fs.rm(targetPath, { recursive: true, force: true });
  } catch (err) {
    console.warn(`[seed:reset] could not remove ${targetPath}: ${err.message}`);
  }
}

/** Reset seeded entities listed in the manifest. Idempotent — missing manifest is a no-op. */
export async function runReset() {
  const manifest = await readManifest();
  if (!manifest) {
    console.log('[seed:reset] no manifest found — nothing to reset');
    return;
  }

  // --- Store: remove entities by seedKey ---
  // We key by seedKey presence rather than id — only seeded entities carry
  // `seedKey`, so a user who re-used an id by coincidence is unaffected.
  const store = await readStore();
  const seededProjectIds = new Set(manifest.entities.projects.map((e) => e.id));

  store.projects = store.projects.filter((p) => !p.seedKey);
  store.milestones = store.milestones.filter((m) => !m.seedKey);
  store.pages = store.pages.filter((p) => !p.seedKey);
  store.tickets = store.tickets.filter((t) => !t.seedKey);
  store.inboxItems = store.inboxItems.filter((i) => !i.seedKey);

  // Orphan cleanup: tasks/codeTabs referencing a removed seeded project
  store.tasks = store.tasks.filter((t) => !seededProjectIds.has(t.projectId));
  store.codeTabs = store.codeTabs.filter((t) => !t.projectId || !seededProjectIds.has(t.projectId));

  await writeStore(store);

  // --- Filesystem: project dirs (skills live inside them, so they go too) ---
  for (const p of manifest.paths) {
    await rmSafe(p);
  }

  await deleteManifest();

  console.log(
    `[seed:reset] removed ${manifest.entities.projects.length} project(s), ` +
      `${manifest.entities.tickets.length} ticket(s), ` +
      `${manifest.entities.pages.length} page(s); ` +
      `deleted ${manifest.paths.length} filesystem path(s)`
  );
}
