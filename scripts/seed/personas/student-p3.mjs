import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildInboxItem, buildPage, buildProject, setupProjectRepo, writePageFile } from '../builders.mjs';
import { getProjectDir } from '../paths.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const P3_CONTENT = path.resolve(HERE, '..', 'content', 'p3');

const SEED_PREFIX = 'student:p3';
const SLUG = 'reading-notes';

/**
 * P3 — reading-notes (CS student persona, non-git knowledge project).
 * No git, no tickets, no milestones. Just pages + inbox items — the kind of
 * project a student uses for class notes and reading capture.
 */
export async function seedStudentP3(store, manifest) {
  const projectDir = getProjectDir(SLUG);
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;

  // Non-git: pass no commit messages, setupProjectRepo skips git init.
  await setupProjectRepo({
    projectDir,
    contentDir: P3_CONTENT,
    commitMessages: [],
    manifest,
  });

  // No `workspaceDir` → no source → SIMPLE_PIPELINE by convention.
  const project = buildProject({
    manifest,
    seedKey: `${SEED_PREFIX}:project`,
    label: 'Reading & Class Notes',
    slug: SLUG,
    createdAt: now - 60 * day,
  });
  store.projects.push(project);

  // --- Pages ---
  const rootPage = buildPage({
    manifest,
    seedKey: `${SEED_PREFIX}:page:root`,
    projectId: project.id,
    title: 'Overview',
    icon: '📚',
    sortOrder: 0,
    isRoot: true,
    createdAt: now - 60 * day,
  });
  store.pages.push(rootPage);

  const pages = [
    { suffix: 'reading-list', title: 'Reading list', icon: '📖', file: 'reading-list.md', ageDays: 55 },
    { suffix: 'os-notes', title: 'OS notes', icon: '🖥️', file: 'os-notes.md', ageDays: 40 },
    { suffix: 'algo-notes', title: 'Algorithms notes', icon: '🧠', file: 'algo-notes.md', ageDays: 30 },
  ];

  let sortOrder = 1;
  for (const p of pages) {
    const page = buildPage({
      manifest,
      seedKey: `${SEED_PREFIX}:page:${p.suffix}`,
      projectId: project.id,
      title: p.title,
      icon: p.icon,
      sortOrder: sortOrder++,
      createdAt: now - p.ageDays * day,
      updatedAt: now - 2 * day,
    });
    store.pages.push(page);
    await writePageFile({
      projectDir,
      pageId: page.id,
      kind: 'doc',
      contentBytes: await fs.readFile(path.join(P3_CONTENT, p.file), 'utf-8'),
    });
  }

  // --- Inbox items — mix of states, some project-scoped, some global ---
  const inboxItems = [
    {
      suffix: 'read-gfs',
      title: 'Read GFS paper before week 8',
      note: 'Assigned reading. Skim first, then re-read with section summaries.',
      scoped: true,
      status: 'shaped',
      shaping: {
        outcome: 'Can explain the master-chunkserver split and why 64MB chunks.',
        appetite: 'small',
        notDoing: 'No implementation — just understand the paper.',
      },
      ageDays: 4,
    },
    {
      suffix: 'summarize-algo-lecture',
      title: 'Summarize algorithms lecture 8 (quicksort)',
      note: 'Convert my chicken-scratch into the Algorithms notes page.',
      scoped: true,
      status: 'new',
      ageDays: 1,
    },
    {
      suffix: 'talk-to-prof',
      title: 'Talk to Dr. Kim about OS project topic',
      note: 'Need to pick by next Friday. Leaning toward user-space scheduler.',
      scoped: false,
      status: 'new',
      ageDays: 2,
    },
    {
      suffix: 'later-discrete',
      title: 'Review discrete math induction proofs',
      note: 'Midterm in 3 weeks.',
      scoped: false,
      status: 'later',
      laterAtAgo: 6 * day,
      ageDays: 10,
    },
  ];

  for (const i of inboxItems) {
    store.inboxItems.push(
      buildInboxItem({
        manifest,
        seedKey: `${SEED_PREFIX}:inbox:${i.suffix}`,
        title: i.title,
        note: i.note,
        projectId: i.scoped ? project.id : null,
        status: i.status,
        shaping: i.shaping,
        laterAt: i.laterAtAgo !== undefined ? now - i.laterAtAgo : undefined,
        createdAt: now - i.ageDays * day,
      })
    );
  }
}
