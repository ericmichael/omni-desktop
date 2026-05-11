/**
 * One-time backfill: ensure every project in the SQLite DB has its
 * `config` column populated with a JSON-stringified `ProjectConfig`.
 *
 * Runs on boot, after `migrateFromJson`. Idempotent — projects whose
 * `config` column is already populated are skipped, so this is safe to
 * call on every launcher start.
 *
 * The mapping is performed by `projectToConfig` in `src/lib/`. Defaults
 * (skills directory, MCP CLI path, default Docker image) are resolved
 * from the launcher's environment at call time.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { ProjectsRepo } from 'omni-projects-db';

import type { ProjectConfigDefaults } from '@/lib/project-to-config';
import { projectToConfig } from '@/lib/project-to-config';
import { rowToProject } from '@/main/db-store-bridge';
import { getMcpBinPath } from '@/main/mcp-config-manager';

/** Default docker image when a project doesn't override it. */
const DEFAULT_SANDBOX_IMAGE = 'omni-sandbox:latest';

function resolveDefaults(): ProjectConfigDefaults {
  return {
    skillsDir: join(homedir(), '.config', 'omni_code', 'skills'),
    projectsMcpCliPath: getMcpBinPath(),
    defaultDockerImage: DEFAULT_SANDBOX_IMAGE,
  };
}

/**
 * Populate `projects.config` for any row where it's NULL. Returns the
 * number of rows updated.
 */
export function backfillProjectConfigs(repo: ProjectsRepo): number {
  const defaults = resolveDefaults();
  const rows = repo.listProjects();
  let backfilled = 0;

  for (const row of rows) {
    if (row.config !== null) {
      continue;
    }
    const project = rowToProject(row);
    const config = projectToConfig(project, defaults);
    repo.setProjectConfig(row.id, JSON.stringify(config));
    backfilled++;
  }

  return backfilled;
}
