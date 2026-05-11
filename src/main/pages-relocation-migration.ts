/**
 * One-time migration: copy pages from their legacy on-disk locations into
 * the new `<config>/pages/<projectId>/` layout.
 *
 * Pages used to live in two different places that the launcher and MCP
 * server each wrote to separately:
 *   - launcher (per-project): `<workspaceDir>/Projects/<slug>/pages/<id>.{md,py}`
 *   - launcher (Personal):    `<workspaceDir>/{pages,context.md}`
 *   - launcher (root pages):  `<workspaceDir or projectDir>/context.md`
 *   - MCP:                    `<config>/projects/<slug>/pages/<id>.md`
 *
 * After Task #18 they all converge on `<config>/pages/<projectId>/<pageId>.md`
 * (with notebook pages keeping the `.py` extension). This migration scans
 * the legacy paths and **copies** files into the new location. Originals
 * are left in place — the migration is safe to re-run, and if anything
 * goes wrong the user can recover by hand. Destination existence wins, so
 * a second run is a no-op.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { ProjectsRepo } from 'omni-projects-db';

import { getOmniConfigDir, getProjectPagesDir } from '@/main/util';

export interface PagesRelocationSummary {
  /** Number of doc / notebook pages copied from `Projects/<slug>/pages/`. */
  perProjectPagesCopied: number;
  /** Number of root pages copied from a per-project `context.md`. */
  rootPagesFromContextMd: number;
  /** Number of pages copied from the MCP `<config>/projects/<slug>/pages/` tree. */
  mcpPagesCopied: number;
  /** Number of pages skipped because the destination already exists. */
  skippedAlreadyMigrated: number;
  /**
   * Legacy directories/files that still exist on disk after the migration
   * ran. Surfaced to the user so they can choose to clean up; we never
   * delete unprompted. Deduped, absolute paths.
   */
  legacyPaths: string[];
}

const emptySummary = (): PagesRelocationSummary => ({
  perProjectPagesCopied: 0,
  rootPagesFromContextMd: 0,
  mcpPagesCopied: 0,
  skippedAlreadyMigrated: 0,
  legacyPaths: [],
});

/**
 * Launcher default workspace dir (mirrors `getDefaultWorkspaceDir` in
 * `src/main/util.ts`). Pulled in directly so this module stays usable from
 * server mode (which doesn't import electron's `app`).
 */
function getLegacyWorkspaceDir(): string {
  return join(homedir(), 'Omni', 'Workspace');
}

function getLegacyProjectDir(slug: string): string {
  return join(getLegacyWorkspaceDir(), 'Projects', slug);
}

/** MCP's legacy `<config>/projects/<slug>/pages/` location. */
function getLegacyMcpProjectPagesDir(slug: string): string {
  return join(getOmniConfigDir(), 'projects', slug, 'pages');
}

/**
 * Copy `src` to `dst` if (a) `src` exists and (b) `dst` does not. Returns
 * true if a copy actually happened.
 */
function copyIfNew(src: string, dst: string): 'copied' | 'skipped' | 'missing' {
  if (!existsSync(src)) {
    return 'missing';
  }
  if (existsSync(dst)) {
    return 'skipped';
  }
  mkdirSync(join(dst, '..'), { recursive: true });
  copyFileSync(src, dst);
  return 'copied';
}

export function migrateLegacyPagesToConfigDir(repo: ProjectsRepo): PagesRelocationSummary {
  const summary = emptySummary();
  const projects = repo.listProjects();
  const legacyPathSet = new Set<string>();

  for (const project of projects) {
    const projectId = project.id;
    const slug = project.slug;
    const newDir = getProjectPagesDir(projectId);

    const pageRows = repo.listPagesByProject(projectId);
    const rootPage = pageRows.find((p) => p.is_root === 1);
    const pageById = new Map<string, (typeof pageRows)[number]>();
    for (const p of pageRows) {
      pageById.set(p.id, p);
    }

    // 1. Per-project pages: `<workspaceDir>/Projects/<slug>/pages/<id>.{md,py}`
    //    For the Personal project, the legacy location was the workspace
    //    root itself, not under `Projects/`.
    const legacyPerProjectPagesDir = project.is_personal
      ? join(getLegacyWorkspaceDir(), 'pages')
      : join(getLegacyProjectDir(slug), 'pages');

    if (existsSync(legacyPerProjectPagesDir)) {
      legacyPathSet.add(legacyPerProjectPagesDir);
      try {
        const entries = readdirSync(legacyPerProjectPagesDir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isFile()) {
continue;
}
          // Files are named `<pageId>.md` or `<pageId>.py`. Only copy if
          // the page row actually exists — orphan files on disk are left
          // in place for the user to deal with.
          const dotIdx = entry.name.lastIndexOf('.');
          if (dotIdx <= 0) {
continue;
}
          const id = entry.name.slice(0, dotIdx);
          if (!pageById.has(id)) {
continue;
}

          const src = join(legacyPerProjectPagesDir, entry.name);
          const dst = join(newDir, entry.name);
          const result = copyIfNew(src, dst);
          if (result === 'copied') {
summary.perProjectPagesCopied++;
} else if (result === 'skipped') {
summary.skippedAlreadyMigrated++;
}
        }
      } catch (err) {
        console.warn(
          `[pages-migration] failed to scan ${legacyPerProjectPagesDir}:`,
          err
        );
      }
    }

    // 2. Root page from `context.md` — copy into `<newDir>/<rootId>.md`.
    if (rootPage) {
      const legacyContextPath = project.is_personal
        ? join(getLegacyWorkspaceDir(), 'context.md')
        : join(getLegacyProjectDir(slug), 'context.md');
      if (existsSync(legacyContextPath)) {
        legacyPathSet.add(legacyContextPath);
      }
      const dst = join(newDir, `${rootPage.id}.md`);
      const result = copyIfNew(legacyContextPath, dst);
      if (result === 'copied') {
summary.rootPagesFromContextMd++;
} else if (result === 'skipped') {
summary.skippedAlreadyMigrated++;
}
    }

    // 3. MCP legacy pages: `<config>/projects/<slug>/pages/<id>.md`.
    //    MCP only ever wrote markdown (no notebooks), and only writes to
    //    `<id>.md`. Copy any file whose name (minus extension) matches a
    //    known page id for this project. Destination existence wins so
    //    this can't clobber a launcher-side copy from step 1 above.
    const legacyMcpDir = getLegacyMcpProjectPagesDir(slug);
    if (existsSync(legacyMcpDir)) {
      legacyPathSet.add(legacyMcpDir);
      try {
        const entries = readdirSync(legacyMcpDir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isFile() || !entry.name.endsWith('.md')) {
continue;
}
          const id = entry.name.slice(0, -3);
          if (!pageById.has(id)) {
continue;
}

          const src = join(legacyMcpDir, entry.name);
          const dst = join(newDir, entry.name);
          const result = copyIfNew(src, dst);
          if (result === 'copied') {
summary.mcpPagesCopied++;
} else if (result === 'skipped') {
summary.skippedAlreadyMigrated++;
}
        }
      } catch (err) {
        console.warn(`[pages-migration] failed to scan ${legacyMcpDir}:`, err);
      }
    }
  }

  summary.legacyPaths = [...legacyPathSet].sort();
  return summary;
}
