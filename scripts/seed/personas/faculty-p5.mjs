import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildInboxItem, buildPage, buildProject, setupProjectRepo, writePageFile } from '../builders.mjs';
import { getProjectDir } from '../paths.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const P5_CONTENT = path.resolve(HERE, '..', 'content', 'p5');

const SEED_PREFIX = 'faculty:p5';
const SLUG = 'cs1410-course-prep';

/**
 * P5 — cs1410-course-prep (faculty persona, non-git).
 * Course-prep project: pages-only, hierarchical (Syllabus + week pages as
 * children of Syllabus). No tickets, no milestones — faculty course work
 * isn't a kanban flow. A couple of inbox items for real capture texture.
 */
export async function seedFacultyP5(store, manifest) {
  const projectDir = getProjectDir(SLUG);
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;

  await setupProjectRepo({
    projectDir,
    contentDir: P5_CONTENT,
    commitMessages: [],
    manifest,
  });

  const project = buildProject({
    manifest,
    seedKey: `${SEED_PREFIX}:project`,
    label: 'CS 1410 — Course Prep',
    slug: SLUG,
    createdAt: now - 90 * day,
  });
  store.projects.push(project);

  // --- Root + Syllabus + 4 week pages (week pages are children of Syllabus) ---
  const rootPage = buildPage({
    manifest,
    seedKey: `${SEED_PREFIX}:page:root`,
    projectId: project.id,
    title: 'Overview',
    icon: '🎓',
    sortOrder: 0,
    isRoot: true,
    createdAt: now - 90 * day,
  });
  store.pages.push(rootPage);

  const syllabusPage = buildPage({
    manifest,
    seedKey: `${SEED_PREFIX}:page:syllabus`,
    projectId: project.id,
    title: 'Syllabus',
    icon: '📄',
    sortOrder: 1,
    createdAt: now - 85 * day,
    updatedAt: now - 20 * day,
  });
  store.pages.push(syllabusPage);
  await writePageFile({
    projectDir,
    pageId: syllabusPage.id,
    kind: 'doc',
    contentBytes: await fs.readFile(path.join(P5_CONTENT, 'syllabus.md'), 'utf-8'),
  });

  const weeks = [
    { suffix: 'week-1', title: 'Week 1 — Hello, Python', file: 'week-1.md', ageDays: 60 },
    { suffix: 'week-2', title: 'Week 2 — Control Flow', file: 'week-2.md', ageDays: 53 },
    { suffix: 'week-3', title: 'Week 3 — Functions', file: 'week-3.md', ageDays: 46 },
    { suffix: 'week-4', title: 'Week 4 — Lists', file: 'week-4.md', ageDays: 39 },
  ];

  let sortOrder = 0;
  for (const w of weeks) {
    const page = buildPage({
      manifest,
      seedKey: `${SEED_PREFIX}:page:${w.suffix}`,
      projectId: project.id,
      parentId: syllabusPage.id,
      title: w.title,
      icon: '📅',
      sortOrder: sortOrder++,
      createdAt: now - w.ageDays * day,
      updatedAt: now - 2 * day,
    });
    store.pages.push(page);
    await writePageFile({
      projectDir,
      pageId: page.id,
      kind: 'doc',
      contentBytes: await fs.readFile(path.join(P5_CONTENT, w.file), 'utf-8'),
    });
  }

  // --- Inbox items for real-life capture flavor ---
  const inboxItems = [
    {
      suffix: 'regrade-request',
      title: 'Student email: regrade request on PS3',
      note: 'Student argues their vowel-counter loses a point unfairly. Read their code before replying.',
      scoped: true,
      status: 'shaped',
      shaping: {
        outcome: 'Decision email sent within 48h with rubric citation.',
        appetite: 'small',
        notDoing: 'Not opening a precedent for everyone — handle on the merits.',
      },
      ageDays: 3,
    },
    {
      suffix: 'ta-office-hours',
      title: 'Add extra TA office hours — I/O confusion cluster',
      note: 'Priya flagged 4 students still stuck. Priya has bandwidth Thurs 3–5pm.',
      scoped: true,
      status: 'new',
      ageDays: 1,
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
        createdAt: now - i.ageDays * day,
      })
    );
  }
}
