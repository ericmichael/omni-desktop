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
const P2_CONTENT = path.resolve(HERE, '..', 'content', 'p2');

const SEED_PREFIX = 'student:p2';
const SLUG = 'habit-tracker';

/**
 * P2 — habit-tracker (CS student persona, side project).
 * Vite + React + TS app, pre-v0.1, kanban heavy with tickets across all columns.
 */
export async function seedStudentP2(store, manifest) {
  const projectDir = getProjectDir(SLUG);
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;

  await setupProjectRepo({
    projectDir,
    contentDir: P2_CONTENT,
    commitMessages: [
      'chore: scaffold vite + react + ts',
      'feat: habit model + streak calc',
      'feat: list view + check-off',
    ],
    branches: ['v0.1'],
    manifest,
  });

  const project = buildProject({
    manifest,
    seedKey: `${SEED_PREFIX}:project`,
    label: 'Habit Tracker',
    slug: SLUG,
    workspaceDir: projectDir,
    createdAt: now - 14 * day,
  });
  store.projects.push(project);

  const milestone = buildMilestone({
    manifest,
    seedKey: `${SEED_PREFIX}:milestone:v0-1-launch`,
    projectId: project.id,
    title: 'v0.1 launch',
    description: 'Minimum viable habit tracker I want to use myself.',
    branch: 'v0.1',
    brief: `## Problem

I keep starting habits and forgetting them. Existing apps are over-featured and nag me. I want something I personally would open every morning.

## Appetite

Medium — three weekends.

## Solution direction

- List view. One-tap check-off. Streak count.
- localStorage only; no backend.
- Sunday reflection prompt when I open the app.

## Decisions

- Vite + React + TS. Familiar, fast, deployable as a static site.
- No design system — plain CSS. If v0.2 happens, Tailwind.

## Out of scope

- Mobile native shells. PWA if I feel like it.
- Multi-device sync. See icebox.
- Gamification beyond streaks.
`,
    dueDate: now + 14 * day,
    createdAt: now - 14 * day,
    updatedAt: now - 1 * day,
  });
  store.milestones.push(milestone);

  // --- Pages ---
  const rootPage = buildPage({
    manifest,
    seedKey: `${SEED_PREFIX}:page:root`,
    projectId: project.id,
    title: 'Overview',
    icon: '✅',
    sortOrder: 0,
    isRoot: true,
    createdAt: now - 14 * day,
  });
  store.pages.push(rootPage);

  const notesPage = buildPage({
    manifest,
    seedKey: `${SEED_PREFIX}:page:product-notes`,
    projectId: project.id,
    title: 'Product notes',
    icon: '📝',
    sortOrder: 1,
    createdAt: now - 12 * day,
    updatedAt: now - 2 * day,
  });
  store.pages.push(notesPage);
  await writePageFile({
    projectDir,
    pageId: notesPage.id,
    kind: 'doc',
    contentBytes: await fs.readFile(path.join(P2_CONTENT, 'product-notes.md'), 'utf-8'),
  });

  const iceboxPage = buildPage({
    manifest,
    seedKey: `${SEED_PREFIX}:page:icebox`,
    projectId: project.id,
    title: 'Icebox',
    icon: '🧊',
    sortOrder: 2,
    createdAt: now - 10 * day,
    updatedAt: now - 3 * day,
  });
  store.pages.push(iceboxPage);
  await writePageFile({
    projectDir,
    pageId: iceboxPage.id,
    kind: 'doc',
    contentBytes: await fs.readFile(path.join(P2_CONTENT, 'icebox.md'), 'utf-8'),
  });

  // --- Tickets — 8 spread across all 6 columns ---
  const tickets = [
    {
      seedKeySuffix: 'done-scaffold',
      title: 'Scaffold Vite + React + TS',
      description: 'Fresh Vite template, trim it to what we need, commit.',
      columnId: 'completed',
      priority: 'high',
      resolution: 'completed',
      createdAgo: 13 * day,
      resolvedAgo: 12 * day,
      phase: 'completed',
    },
    {
      seedKeySuffix: 'done-habit-model',
      title: 'Define Habit + CheckIn types',
      description: 'Minimal schema. `Habit` = id, name, frequency, createdAt. `CheckIn` = id, habitId, date, createdAt.',
      columnId: 'completed',
      priority: 'high',
      resolution: 'completed',
      createdAgo: 12 * day,
      resolvedAgo: 10 * day,
      phase: 'completed',
      blockedBy: ['done-scaffold'],
    },
    {
      seedKeySuffix: 'pr-list-view',
      title: 'Habit list with one-tap check-off',
      description: 'Render habits; tap toggles today\'s check-in; optimistic localStorage write.',
      columnId: 'pr',
      priority: 'high',
      createdAgo: 10 * day,
      blockedBy: ['done-habit-model'],
    },
    {
      seedKeySuffix: 'review-add-form',
      title: 'Add-habit form',
      description: 'Text input + submit. Name only for v0.1 (frequency is always daily).',
      columnId: 'review',
      priority: 'high',
      createdAgo: 8 * day,
      blockedBy: ['done-habit-model'],
    },
    {
      seedKeySuffix: 'impl-streaks',
      title: 'Streak calculation',
      description: 'Current streak = longest run of consecutive daily check-ins ending today or yesterday (missing today is forgiven until tomorrow).',
      columnId: 'implementation',
      priority: 'high',
      createdAgo: 6 * day,
      blockedBy: ['done-habit-model'],
    },
    {
      seedKeySuffix: 'spec-reflection',
      title: 'Sunday reflection prompt',
      description: 'When it\'s Sunday and the user opens the app, prompt "what went well?" → saves a weekly reflection entry.',
      columnId: 'spec',
      priority: 'medium',
      createdAgo: 4 * day,
    },
    {
      seedKeySuffix: 'backlog-dark-mode',
      title: 'Dark mode',
      description: 'Deferred from icebox for v0.2 — forces a color system decision.',
      columnId: 'backlog',
      priority: 'low',
      createdAgo: 3 * day,
    },
    {
      seedKeySuffix: 'backlog-icloud',
      title: 'Sync to iCloud',
      description: 'Post-v0.1. Requires Apple dev account + encryption story.',
      columnId: 'backlog',
      priority: 'low',
      createdAgo: 2 * day,
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
