import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { gitAddAll, gitBranch, gitCommit, gitInit } from './git.mjs';
import { newId } from './ids.mjs';

/**
 * Helper for personas that want inter-ticket blockers. Given an array of
 * ticket specs each with a unique `seedKeySuffix`, pre-generates a stable
 * ID per suffix so specs can reference each other by suffix in their
 * `blockedBy` field. Returns { ids: Record<suffix, id>, resolved: spec[] }
 * where resolved specs have their `blockedBy` suffixes converted to IDs.
 */
export function resolveTicketDeps(specs) {
  const ids = Object.fromEntries(specs.map((s) => [s.seedKeySuffix, newId()]));
  const resolved = specs.map((s) => ({
    ...s,
    id: ids[s.seedKeySuffix],
    blockedBy: (s.blockedBy ?? []).map((suffix) => {
      const id = ids[suffix];
      if (!id) throw new Error(`unknown blocker suffix '${suffix}' for ticket '${s.seedKeySuffix}'`);
      return id;
    }),
  }));
  return { ids, resolved };
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHARED_SKILLS_DIR = path.resolve(HERE, 'content', 'shared-skills');

/** Recursive copy with an optional basename skip-list. */
export async function copyTree(src, dst, skip = new Set()) {
  const entries = await fs.readdir(src, { withFileTypes: true });
  await fs.mkdir(dst, { recursive: true });
  for (const entry of entries) {
    if (skip.has(entry.name)) continue;
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) await copyTree(s, d);
    else await fs.copyFile(s, d);
  }
}

/**
 * Set up a seeded project on disk:
 *   - Wipe and recreate the projectDir.
 *   - Copy `contentDir` into it (skipping `project-skills/`).
 *   - Create pages/ for non-root page files.
 *   - Install shared + project-specific skills into .config/omni_code/skills/.
 *   - If `commitMessages` is non-empty, `git init` and commit them in order.
 *     First commit stages everything; subsequent commits are `--allow-empty`.
 *   - Create each branch in `branches` at HEAD without switching (so worktree
 *     operations against seeded milestone branches succeed).
 *   - Track the project root path in the manifest so reset removes it.
 *
 * Returns the absolute path of the project directory (same as input).
 */
export async function setupProjectRepo({
  projectDir,
  contentDir,
  commitMessages = [],
  branches = [],
  manifest,
}) {
  await fs.rm(projectDir, { recursive: true, force: true });
  await fs.mkdir(projectDir, { recursive: true });

  await copyTree(contentDir, projectDir, new Set(['project-skills']));
  await fs.mkdir(path.join(projectDir, 'pages'), { recursive: true });

  // Skills — shared first so project-specific can overwrite if ever needed.
  const skillsDst = path.join(projectDir, '.config', 'omni_code', 'skills');
  await copyTree(SHARED_SKILLS_DIR, skillsDst);
  const projectSkillsSrc = path.join(contentDir, 'project-skills');
  try {
    await fs.access(projectSkillsSrc);
    await copyTree(projectSkillsSrc, skillsDst);
  } catch {
    // no project-skills dir — fine
  }

  if (commitMessages.length > 0) {
    await gitInit(projectDir);
    await gitAddAll(projectDir);
    const [first, ...rest] = commitMessages;
    await gitCommit(projectDir, first);
    for (const msg of rest) {
      await gitCommit(projectDir, msg);
    }
    for (const branch of branches) {
      await gitBranch(projectDir, branch);
    }
  }

  manifest.paths.push(projectDir);
  return projectDir;
}

// ---------------------------------------------------------------------------
// Entity builders — return store-shaped records with seedKey stamped, and
// push the (id, seedKey) pair into the manifest so reset can find them.
// ---------------------------------------------------------------------------

/**
 * Build a Project record. If `workspaceDir` is provided, the project has a
 * linked local source and gets DEFAULT_PIPELINE. If omitted, the project has
 * no source (knowledge-base style) and gets SIMPLE_PIPELINE.
 */
export function buildProject({ manifest, seedKey, label, slug, workspaceDir, createdAt, gitDetected = true }) {
  const id = newId();
  const project = {
    id,
    label,
    slug,
    createdAt,
    seedKey,
  };
  if (workspaceDir) {
    project.source = { kind: 'local', workspaceDir, gitDetected };
  }
  manifest.entities.projects.push({ id, seedKey });
  return project;
}

export function buildMilestone({
  manifest,
  seedKey,
  projectId,
  title,
  description,
  brief,
  branch,
  status = 'active',
  dueDate,
  createdAt,
  updatedAt = createdAt,
}) {
  const id = newId();
  const milestone = {
    id,
    projectId,
    title,
    description,
    brief,
    branch,
    status,
    dueDate,
    createdAt,
    updatedAt,
    seedKey,
  };
  manifest.entities.milestones.push({ id, seedKey });
  return milestone;
}

export function buildPage({
  manifest,
  seedKey,
  projectId,
  title,
  icon,
  sortOrder,
  kind = 'doc',
  isRoot = false,
  parentId = null,
  createdAt,
  updatedAt = createdAt,
}) {
  const id = newId();
  const page = {
    id,
    projectId,
    parentId,
    title,
    icon,
    sortOrder,
    kind,
    isRoot: isRoot || undefined,
    createdAt,
    updatedAt,
    seedKey,
  };
  manifest.entities.pages.push({ id, seedKey });
  return page;
}

export function buildTicket({
  manifest,
  seedKey,
  projectId,
  milestoneId,
  title,
  description,
  columnId,
  priority = 'medium',
  createdAt,
  resolvedAt,
  resolution,
  phase,
  id = newId(),
  blockedBy = [],
}) {
  const ticket = {
    id,
    projectId,
    milestoneId,
    title,
    description,
    priority,
    blockedBy,
    columnId,
    createdAt,
    updatedAt: createdAt,
    columnChangedAt: createdAt,
    seedKey,
  };
  if (resolution) ticket.resolution = resolution;
  if (resolvedAt !== undefined) ticket.resolvedAt = resolvedAt;
  if (phase) ticket.phase = phase;
  manifest.entities.tickets.push({ id, seedKey });
  return ticket;
}

/**
 * Write a non-root doc/notebook page's content to disk at the location
 * PageManager expects: <projectDir>/pages/<pageId>.<ext>.
 */
export async function writePageFile({ projectDir, pageId, kind, contentBytes }) {
  const ext = kind === 'notebook' ? '.py' : '.md';
  const file = path.join(projectDir, 'pages', `${pageId}${ext}`);
  await fs.writeFile(file, contentBytes);
}

export function buildInboxItem({
  manifest,
  seedKey,
  title,
  note,
  projectId = null,
  status = 'new',
  shaping,
  laterAt,
  createdAt,
  updatedAt = createdAt,
}) {
  const id = newId();
  const item = {
    id,
    title,
    note,
    projectId,
    status,
    createdAt,
    updatedAt,
    seedKey,
  };
  if (shaping) item.shaping = shaping;
  if (laterAt !== undefined) item.laterAt = laterAt;
  manifest.entities.inboxItems.push({ id, seedKey });
  return item;
}
