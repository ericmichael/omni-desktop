#!/usr/bin/env node
/**
 * Seed the local dev environment with realistic fixtures.
 *
 * Usage:
 *   npm run seed                  # seed everything (skills + all personas)
 *   npm run seed -- --reset       # remove everything the seeder previously wrote
 *   npm run seed:reset            # same as --reset
 *
 * The seeder writes entity records into the electron-store JSON
 * (~/Library/Application Support/Omni Code/config.json on macOS) and
 * creates real project folders under ~/Omni/Workspace/Projects/.
 *
 * Every seeded entity carries a `seedKey` so `--reset` can find and remove
 * exactly the set the seeder wrote — without touching user data. The mapping
 * of seedKey → id + filesystem path lives in a sibling seed-manifest.json.
 */
import { emptyManifest, readManifest, writeManifest } from './seed/manifest.mjs';
import { seedFacultyP4 } from './seed/personas/faculty-p4.mjs';
import { seedFacultyP5 } from './seed/personas/faculty-p5.mjs';
import { seedStaffP6 } from './seed/personas/staff-p6.mjs';
import { seedStaffP7 } from './seed/personas/staff-p7.mjs';
import { seedStudentP1 } from './seed/personas/student-p1.mjs';
import { seedStudentP2 } from './seed/personas/student-p2.mjs';
import { seedStudentP3 } from './seed/personas/student-p3.mjs';
import { runReset } from './seed/reset.mjs';
import { readStore, writeStore } from './seed/store-io.mjs';

const args = process.argv.slice(2);
const wantReset = args.includes('--reset');

async function runSeed() {
  // If a previous seed exists, reset first so this is idempotent.
  const existing = await readManifest();
  if (existing) {
    console.log('[seed] existing manifest found — resetting before re-seeding');
    await runReset();
  }

  const store = await readStore();
  const manifest = emptyManifest();

  await seedStudentP1(store, manifest);
  await seedStudentP2(store, manifest);
  await seedStudentP3(store, manifest);
  await seedFacultyP4(store, manifest);
  await seedFacultyP5(store, manifest);
  await seedStaffP6(store, manifest);
  await seedStaffP7(store, manifest);

  await writeStore(store);
  await writeManifest(manifest);

  console.log(
    `[seed] seeded ${manifest.entities.projects.length} project(s), ` +
      `${manifest.entities.tickets.length} ticket(s), ` +
      `${manifest.entities.pages.length} page(s), ` +
      `${manifest.entities.inboxItems.length} inbox item(s); ` +
      `skills seeded into each project's .config/omni_code/skills/`
  );
  console.log('[seed] manifest written — run `npm run seed:reset` to undo');
}

try {
  if (wantReset) {
    await runReset();
  } else {
    await runSeed();
  }
} catch (err) {
  console.error('[seed] failed:', err);
  process.exit(1);
}
