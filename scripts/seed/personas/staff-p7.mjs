import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildInboxItem, buildPage, buildProject, setupProjectRepo, writePageFile } from '../builders.mjs';
import { getProjectDir } from '../paths.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const P7_CONTENT = path.resolve(HERE, '..', 'content', 'p7');

const SEED_PREFIX = 'staff:p7';
const SLUG = 'vendor-evaluation-q2';

/**
 * P7 — vendor-evaluation (staff persona, non-git).
 * Pure knowledge work: comparison matrix + legal checklist + a few inbox items
 * for the live capture of vendor follow-ups.
 */
export async function seedStaffP7(store, manifest) {
  const projectDir = getProjectDir(SLUG);
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;

  await setupProjectRepo({
    projectDir,
    contentDir: P7_CONTENT,
    commitMessages: [],
    manifest,
  });

  const project = buildProject({
    manifest,
    seedKey: `${SEED_PREFIX}:project`,
    label: 'Vendor Evaluation — Q2',
    slug: SLUG,
    createdAt: now - 45 * day,
  });
  store.projects.push(project);

  const rootPage = buildPage({
    manifest,
    seedKey: `${SEED_PREFIX}:page:root`,
    projectId: project.id,
    title: 'Overview',
    icon: '🏷️',
    sortOrder: 0,
    isRoot: true,
    createdAt: now - 45 * day,
  });
  store.pages.push(rootPage);

  const pages = [
    { suffix: 'comparison', title: 'Comparison matrix', icon: '📊', file: 'comparison-matrix.md', ageDays: 35 },
    { suffix: 'legal', title: 'Legal review checklist', icon: '⚖️', file: 'legal-checklist.md', ageDays: 30 },
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
      updatedAt: now - 3 * day,
    });
    store.pages.push(page);
    await writePageFile({
      projectDir,
      pageId: page.id,
      kind: 'doc',
      contentBytes: await fs.readFile(path.join(P7_CONTENT, p.file), 'utf-8'),
    });
  }

  const inboxItems = [
    {
      suffix: 'schedule-relic-demo',
      title: 'Schedule deeper-dive demo with Relic',
      note: 'Request a price sensitivity demo — what does the cliff at 10TB look like in practice?',
      scoped: true,
      status: 'shaped',
      shaping: {
        outcome: 'Demo on the calendar for next week with their SE + our finance lead.',
        appetite: 'small',
        notDoing: 'Not soliciting a counter-offer at this stage.',
      },
      ageDays: 4,
    },
    {
      suffix: 'foresight-trace-status',
      title: 'Ask Foresight for traces GA timeline',
      note: 'They said Q3; we want commit vs aspiration.',
      scoped: true,
      status: 'new',
      ageDays: 2,
    },
    {
      suffix: 'legal-quasar-soc2',
      title: 'Follow up with Quasar on SOC2',
      note: 'They said it\'s "in progress". Get an actual auditor name + report date.',
      scoped: true,
      status: 'later',
      laterAtAgo: 7 * day,
      ageDays: 12,
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
