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
const P4_CONTENT = path.resolve(HERE, '..', 'content', 'p4');

const SEED_PREFIX = 'faculty:p4';
const SLUG = 'paper-reproducibility';

/**
 * P4 — paper-reproducibility (faculty persona, git-backed).
 * Research project reproducing a NeurIPS result. Pages carry methodology,
 * a marimo notebook holds the figure, tickets break the work into phases.
 */
export async function seedFacultyP4(store, manifest) {
  const projectDir = getProjectDir(SLUG);
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;

  await setupProjectRepo({
    projectDir,
    contentDir: P4_CONTENT,
    commitMessages: [
      'chore: scaffold repro harness skeleton',
      'docs: methodology notes from paper read-through',
    ],
    branches: ['repro-table-2'],
    manifest,
  });

  const project = buildProject({
    manifest,
    seedKey: `${SEED_PREFIX}:project`,
    label: 'MoE 1T Reproduction',
    slug: SLUG,
    workspaceDir: projectDir,
    createdAt: now - 21 * day,
  });
  store.projects.push(project);

  const milestone = buildMilestone({
    manifest,
    seedKey: `${SEED_PREFIX}:milestone:reproduce-table-2`,
    projectId: project.id,
    title: 'Reproduce Table 2 by Apr 30',
    description: 'Zero-shot eval reproduction on MMLU / ARC / HellaSwag at 8B.',
    branch: 'repro-table-2',
    brief: `## Problem

The paper claims a sparse MoE at 1T matches a dense 70B on zero-shot. We need to sanity-check the 8B baseline before believing the bigger claim — our team's 2026 scaling roadmap depends on it.

## Appetite

Medium — three weeks of calendar, one FTE-equivalent. We don't reproduce 1T (weights not released).

## Solution direction

- Use lm-evaluation-harness mainline (NOT the paper's fork — document deltas).
- Bf16 inference at batch 8 on our 8×A100 rig.
- One run per benchmark, 95% CI.
- Write up gaps > 1% in methodology.md and flag them to Dr. Chen.

## Decisions

- Seed 42 (the paper doesn't disclose theirs).
- HuggingFace weights only; we're not going to chase the dead "available on request" link.

## Out of scope

- Reproducing 1T — no public weights.
- Fine-tuning. This is a zero-shot eval study.
- Novel benchmarks — stick to what the paper reports in Table 2.
`,
    dueDate: now + 10 * day,
    createdAt: now - 21 * day,
    updatedAt: now - 2 * day,
  });
  store.milestones.push(milestone);

  // --- Pages ---
  const rootPage = buildPage({
    manifest,
    seedKey: `${SEED_PREFIX}:page:root`,
    projectId: project.id,
    title: 'Overview',
    icon: '🧪',
    sortOrder: 0,
    isRoot: true,
    createdAt: now - 21 * day,
  });
  store.pages.push(rootPage);

  const methodPage = buildPage({
    manifest,
    seedKey: `${SEED_PREFIX}:page:methodology`,
    projectId: project.id,
    title: 'Methodology notes',
    icon: '📐',
    sortOrder: 1,
    createdAt: now - 18 * day,
    updatedAt: now - 4 * day,
  });
  store.pages.push(methodPage);
  await writePageFile({
    projectDir,
    pageId: methodPage.id,
    kind: 'doc',
    contentBytes: await fs.readFile(path.join(P4_CONTENT, 'methodology.md'), 'utf-8'),
  });

  const figurePage = buildPage({
    manifest,
    seedKey: `${SEED_PREFIX}:page:figure-3`,
    projectId: project.id,
    title: 'Figure 3 reproduction',
    icon: '📊',
    sortOrder: 2,
    kind: 'notebook',
    createdAt: now - 10 * day,
    updatedAt: now - 1 * day,
  });
  store.pages.push(figurePage);
  await writePageFile({
    projectDir,
    pageId: figurePage.id,
    kind: 'notebook',
    contentBytes: await fs.readFile(path.join(P4_CONTENT, 'figure-3-reproduction.py'), 'utf-8'),
  });

  // --- Tickets ---
  const tickets = [
    {
      seedKeySuffix: 'done-scaffold',
      title: 'Set up repo + venv + requirements',
      description: 'Scaffold Python project, pin torch / transformers / lm-eval versions.',
      columnId: 'completed',
      priority: 'high',
      resolution: 'completed',
      createdAgo: 20 * day,
      resolvedAgo: 18 * day,
      phase: 'completed',
    },
    {
      seedKeySuffix: 'pr-harness',
      title: 'Wire lm-eval-harness for MMLU',
      description: 'First benchmark end-to-end. Confirm numbers land in results/ JSON.',
      columnId: 'pr',
      priority: 'high',
      createdAgo: 14 * day,
      blockedBy: ['done-scaffold'],
    },
    {
      seedKeySuffix: 'impl-arc-hellaswag',
      title: 'Add ARC-Challenge + HellaSwag benchmarks',
      description: 'Extend the harness once MMLU is working. Same output schema.',
      columnId: 'implementation',
      priority: 'medium',
      createdAgo: 8 * day,
      blockedBy: ['pr-harness'],
    },
    {
      seedKeySuffix: 'spec-variance',
      title: 'Decide how to report variance',
      description: 'Paper reports single number. Do we run N times or bootstrap? Discuss with Dr. Chen.',
      columnId: 'spec',
      priority: 'medium',
      createdAgo: 5 * day,
    },
    {
      seedKeySuffix: 'backlog-writeup',
      title: 'Draft reproduction report',
      description: '2-page report: our numbers, paper numbers, deltas, open questions.',
      columnId: 'backlog',
      priority: 'low',
      createdAgo: 2 * day,
      blockedBy: ['impl-arc-hellaswag', 'spec-variance'],
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
