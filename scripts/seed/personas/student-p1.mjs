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
const P1_CONTENT = path.resolve(HERE, '..', 'content', 'p1');

const SEED_PREFIX = 'student:p1';
const SLUG = 'cs-homework-dsa';

/**
 * P1 — cs-homework-dsa (CS student persona).
 * Rust homework repo with a heap implementation in progress.
 */
export async function seedStudentP1(store, manifest) {
  const projectDir = getProjectDir(SLUG);
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;

  await setupProjectRepo({
    projectDir,
    contentDir: P1_CONTENT,
    commitMessages: ['chore: scaffold cargo project', 'docs: mark start of assignment 3'],
    branches: ['assignment-3'],
    manifest,
  });

  const project = buildProject({
    manifest,
    seedKey: `${SEED_PREFIX}:project`,
    label: 'CS 2341 — Assignment 3',
    slug: SLUG,
    workspaceDir: projectDir,
    createdAt: now - 7 * day,
  });
  store.projects.push(project);

  const milestone = buildMilestone({
    manifest,
    seedKey: `${SEED_PREFIX}:milestone:heap-ps`,
    projectId: project.id,
    title: 'Heap PS — due Fri',
    description: 'Min-heap implementation + priority queue + benchmarks.',
    branch: 'assignment-3',
    brief: `## Problem

The heap problem set needs a working Rust min-heap, a priority queue layered on top, and a benchmark showing we're within 2x of std.

## Appetite

Small — one week max. Late penalty kicks in after Friday.

## Solution direction

- Array-backed binary heap (sift up/down).
- PriorityQueue wraps MinHeap<(priority, item)>.
- Benchmark reuses criterion if it fits, otherwise raw timing + JSON output for the marimo notebook.

## Decisions

- Rust, not C++. Prof said either was fine.
- No generic Ord-only — accept a comparator closure later if needed.

## Out of scope

- Fibonacci heap. Nice but not required.
- Heap sort. Different assignment.
`,
    dueDate: now + 5 * day,
    createdAt: now - 7 * day,
    updatedAt: now - 1 * day,
  });
  store.milestones.push(milestone);

  // --- Pages ---
  const rootPage = buildPage({
    manifest,
    seedKey: `${SEED_PREFIX}:page:root`,
    projectId: project.id,
    title: 'Overview',
    icon: '📘',
    sortOrder: 0,
    isRoot: true,
    createdAt: now - 7 * day,
  });
  store.pages.push(rootPage);
  // Root content is <projectDir>/context.md, already copied from P1_CONTENT.

  const cheatPage = buildPage({
    manifest,
    seedKey: `${SEED_PREFIX}:page:big-o`,
    projectId: project.id,
    title: 'Big-O cheat sheet',
    icon: '📏',
    sortOrder: 1,
    createdAt: now - 6 * day,
    updatedAt: now - 3 * day,
  });
  store.pages.push(cheatPage);
  await writePageFile({
    projectDir,
    pageId: cheatPage.id,
    kind: 'doc',
    contentBytes: await fs.readFile(path.join(P1_CONTENT, 'big-o-cheat-sheet.md'), 'utf-8'),
  });

  const benchPage = buildPage({
    manifest,
    seedKey: `${SEED_PREFIX}:page:benchmarks`,
    projectId: project.id,
    title: 'Benchmarks',
    icon: '📊',
    sortOrder: 2,
    kind: 'notebook',
    createdAt: now - 5 * day,
    updatedAt: now - 1 * day,
  });
  store.pages.push(benchPage);
  await writePageFile({
    projectDir,
    pageId: benchPage.id,
    kind: 'notebook',
    contentBytes: await fs.readFile(path.join(P1_CONTENT, 'benchmarks.py'), 'utf-8'),
  });

  // --- Tickets — blockedBy uses seedKeySuffix, resolved below ---
  const tickets = [
    {
      seedKeySuffix: 'done-min-heap',
      title: 'Implement min-heap',
      description: 'Array-backed binary heap with push / pop / peek. Sift up/down in-place.',
      columnId: 'completed',
      priority: 'high',
      resolution: 'completed',
      createdAgo: 6 * day,
      resolvedAgo: 2 * day,
      phase: 'completed',
    },
    {
      seedKeySuffix: 'in-pr-tests',
      title: 'Heap tests + CI',
      description: 'Unit tests for edge cases (empty, single element, all-equal). Wire into `cargo test`.',
      columnId: 'pr',
      priority: 'high',
      createdAgo: 5 * day,
      blockedBy: ['done-min-heap'],
    },
    {
      seedKeySuffix: 'impl-priority-queue',
      title: 'Priority queue on top of MinHeap',
      description: 'Wrap MinHeap<(priority, item)>. Public API: enqueue(item, priority), dequeue() -> item.',
      columnId: 'implementation',
      priority: 'high',
      createdAgo: 4 * day,
      blockedBy: ['done-min-heap'],
    },
    {
      seedKeySuffix: 'spec-bench',
      title: 'Benchmark vs std::BinaryHeap',
      description: 'Define the benchmark harness. Output JSON rows for the marimo notebook to chart.',
      columnId: 'spec',
      priority: 'medium',
      createdAgo: 3 * day,
      blockedBy: ['impl-priority-queue'],
    },
    {
      seedKeySuffix: 'backlog-writeup',
      title: 'Write README of findings',
      description: 'Summarize benchmark results, note any surprises, include the chart.',
      columnId: 'backlog',
      priority: 'low',
      createdAgo: 2 * day,
      blockedBy: ['spec-bench'],
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
