import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildMilestone,
  buildPage,
  buildProject,
  buildTicket,
  resolveTicketDeps,
  setupProjectRepo,
  writePageFile,
} from '../builders.mjs';
import { getProjectDir } from '../paths.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const P6_CONTENT = path.resolve(HERE, '..', 'content', 'p6');

const SEED_PREFIX = 'staff:p6';
const SLUG = 'platform-oncall-runbooks';

/**
 * P6 — platform-oncall-runbooks (staff persona, git-backed).
 * Ops repo: runbook pages + a Q2 audit milestone with tickets in every column.
 */
export async function seedStaffP6(store, manifest) {
  const projectDir = getProjectDir(SLUG);
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;

  await setupProjectRepo({
    projectDir,
    contentDir: P6_CONTENT,
    commitMessages: [
      'chore: scaffold runbooks repo',
      'docs: seed initial runbooks (failover, certs, noisy neighbor, unmute)',
      'chore: stub pg_failover script',
    ],
    branches: ['q2-audit'],
    manifest,
  });

  const project = buildProject({
    manifest,
    seedKey: `${SEED_PREFIX}:project`,
    label: 'Platform Oncall Runbooks',
    slug: SLUG,
    workspaceDir: projectDir,
    createdAt: now - 120 * day,
  });
  store.projects.push(project);

  const milestone = buildMilestone({
    manifest,
    seedKey: `${SEED_PREFIX}:milestone:q2-audit`,
    projectId: project.id,
    title: 'Q2 runbook audit',
    description: 'Review + patch every runbook. No more "the script is a stub" surprises at 3am.',
    branch: 'q2-audit',
    brief: `## Problem

Last quarter we had two incidents where the runbook pointed to a stub script. Oncall had to improvise. Morale dropped, rollback took 2x longer than it should have.

## Appetite

Medium — one quarter of 20% time across the platform team. Not a crunch.

## Solution direction

- Every runbook gets read by someone who DIDN'T write it.
- Every \`scripts/\` invocation referenced in a runbook must either work or be replaced with manual steps.
- Add a dry-run skill so oncall can rehearse before incidents.

## Decisions

- No new runbook categories this quarter. Audit what we have.
- Dry-run skill lives in this repo (not the global agent skills library) — it knows our file layout.

## Out of scope

- Automated runbook execution. Not this quarter. Maybe never.
- Merging with the SRE team's runbooks. Different stack, different paging channel.
`,
    dueDate: now + 45 * day,
    createdAt: now - 30 * day,
    updatedAt: now - 1 * day,
  });
  store.milestones.push(milestone);

  // --- Pages: the four runbooks ---
  const rootPage = buildPage({
    manifest,
    seedKey: `${SEED_PREFIX}:page:root`,
    projectId: project.id,
    title: 'Overview',
    icon: '🚨',
    sortOrder: 0,
    isRoot: true,
    createdAt: now - 120 * day,
  });
  store.pages.push(rootPage);

  const runbooks = [
    { suffix: 'db-failover', title: 'Runbook: DB failover', icon: '💽', file: 'db-failover.md', ageDays: 100 },
    { suffix: 'cert-rotation', title: 'Runbook: Cert rotation', icon: '🔐', file: 'cert-rotation.md', ageDays: 90 },
    { suffix: 'noisy-neighbor', title: 'Runbook: Noisy neighbor', icon: '🔊', file: 'noisy-neighbor.md', ageDays: 80 },
    { suffix: 'pager-unmute', title: 'Runbook: Pager unmute', icon: '🔔', file: 'pager-unmute.md', ageDays: 60 },
  ];

  let sortOrder = 1;
  for (const r of runbooks) {
    const page = buildPage({
      manifest,
      seedKey: `${SEED_PREFIX}:page:${r.suffix}`,
      projectId: project.id,
      title: r.title,
      icon: r.icon,
      sortOrder: sortOrder++,
      createdAt: now - r.ageDays * day,
      updatedAt: now - 7 * day,
    });
    store.pages.push(page);
    await writePageFile({
      projectDir,
      pageId: page.id,
      kind: 'doc',
      contentBytes: await fs.readFile(path.join(P6_CONTENT, r.file), 'utf-8'),
    });
  }

  // --- Tickets: Q2 audit across columns ---
  const tickets = [
    {
      seedKeySuffix: 'done-inventory',
      title: 'Inventory existing runbooks',
      description: 'List every runbook, owner, last-edited date. Output to a pinned page.',
      columnId: 'completed',
      priority: 'high',
      resolution: 'completed',
      createdAgo: 28 * day,
      resolvedAgo: 20 * day,
      phase: 'completed',
    },
    {
      seedKeySuffix: 'done-audit-failover',
      title: 'Audit db-failover runbook',
      description: 'Walk through with someone who hasn\'t seen it. Fix any ambiguities.',
      columnId: 'completed',
      priority: 'high',
      resolution: 'completed',
      createdAgo: 25 * day,
      resolvedAgo: 14 * day,
      phase: 'completed',
      blockedBy: ['done-inventory'],
    },
    {
      seedKeySuffix: 'pr-audit-certs',
      title: 'Audit cert-rotation runbook',
      description: 'The ACME deactivated case has zero details. Add the break-glass path.',
      columnId: 'pr',
      priority: 'high',
      createdAgo: 18 * day,
      blockedBy: ['done-inventory'],
    },
    {
      seedKeySuffix: 'review-audit-noisy',
      title: 'Audit noisy-neighbor runbook',
      description: 'The "abuse" branch says "escalate to security" but nobody knows who that is after hours.',
      columnId: 'review',
      priority: 'high',
      createdAgo: 14 * day,
      blockedBy: ['done-inventory'],
    },
    {
      seedKeySuffix: 'impl-pg-failover-script',
      title: 'Replace pg_failover.sh stub with real implementation',
      description: 'This is THE script from the last incident. No more stub.',
      columnId: 'implementation',
      priority: 'critical',
      createdAgo: 10 * day,
      blockedBy: ['done-audit-failover'],
    },
    {
      seedKeySuffix: 'spec-rotation-runbook',
      title: 'Write rotation.md',
      description: 'Currently referenced in context.md but doesn\'t exist. Decide the shape before writing.',
      columnId: 'spec',
      priority: 'medium',
      createdAgo: 7 * day,
    },
    {
      seedKeySuffix: 'backlog-ratelimit-runbook',
      title: 'Write ratelimit.md',
      description: 'Referenced from cert-rotation runbook ("see ratelimit.md") but doesn\'t exist yet.',
      columnId: 'backlog',
      priority: 'low',
      createdAgo: 4 * day,
      blockedBy: ['pr-audit-certs'],
    },
    {
      seedKeySuffix: 'backlog-contacts-page',
      title: 'Write contacts.md',
      description: 'Account-rep contact list referenced from noisy-neighbor. Sensitive data — decide where it lives.',
      columnId: 'backlog',
      priority: 'low',
      createdAgo: 2 * day,
      blockedBy: ['review-audit-noisy'],
    },
  ];

  const { resolved } = resolveTicketDeps(tickets);
  for (const t of resolved) {
    store.tickets.push(
      buildTicket({
        manifest,
        seedKey: `${SEED_PREFIX}:ticket:${t.seedKeySuffix}`,
        id: t.id,
        blockedBy: t.blockedBy,
        projectId: project.id,
        milestoneId: milestone.id,
        title: t.title,
        description: t.description,
        columnId: t.columnId,
        priority: t.priority,
        createdAt: now - t.createdAgo,
        resolvedAt: t.resolvedAgo !== undefined ? now - t.resolvedAgo : undefined,
        resolution: t.resolution,
        phase: t.phase,
      })
    );
  }
}
