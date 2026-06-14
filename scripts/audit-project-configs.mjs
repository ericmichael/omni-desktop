#!/usr/bin/env node
/**
 * Migration audit: read every project from `projects.db`, run it through
 * a `projectToConfig` mapping, and write the resulting `ProjectConfig`
 * as YAML to `/tmp/migration-audit/<projectId>.yml`. Prints a summary
 * that flags any projects whose source data didn't map cleanly
 * (unparseable git URL, missing workspaceDir, etc.).
 *
 * The point is to validate the manifest model against real data BEFORE
 * any consumer is changed. Nothing in the DB is modified.
 *
 *   node scripts/audit-project-configs.mjs
 *   node scripts/audit-project-configs.mjs --db-path /tmp/test.db
 *   node scripts/audit-project-configs.mjs --out-dir /tmp/audit
 *
 * The mapper logic below is a JS mirror of `src/lib/project-to-config.ts`
 * — kept in sync manually. The canonical TypeScript version is what's
 * used in production code and is unit-tested under vitest. This script
 * is plain `.mjs` to avoid Node 25 + tsx path-resolution bugs.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { getDefaultDbPath, openDatabase, ProjectsRepo } from 'omni-projects-db';
import { stringify as yamlStringify } from 'yaml';

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const { values } = parseArgs({
  options: {
    'db-path': { type: 'string' },
    'out-dir': { type: 'string' },
  },
});

const DB_PATH = values['db-path'] ?? getDefaultDbPath();
const OUT_DIR = values['out-dir'] ?? '/tmp/migration-audit';

const DEFAULTS = {
  skillsDir: join(homedir(), '.config', 'omni_code', 'skills'),
  projectsMcpCliPath: '<bundled-mcp-cli-path>',
  defaultDockerImage: 'omni-sandbox:latest',
};

// ---------------------------------------------------------------------------
// Row → Project conversion (mirrors src/main/db-store-bridge.ts:rowToProject).
// ---------------------------------------------------------------------------

function rowToProject(row) {
  const project = {
    id: row.id,
    label: row.label,
    slug: row.slug,
    createdAt: new Date(row.created_at).getTime(),
  };
  if (row.is_personal) {
    project.isPersonal = true;
  }
  if (row.auto_dispatch) {
    project.autoDispatch = true;
  }
  if (row.source) {
    project.source = JSON.parse(row.source);
  }
  if (row.sandbox) {
    project.sandbox = JSON.parse(row.sandbox);
  }
  return project;
}

// ---------------------------------------------------------------------------
// Project → ProjectConfig mapping (mirrors src/lib/project-to-config.ts).
// Keep this in sync with the canonical TS version.
// ---------------------------------------------------------------------------

function parseGitRepoUrl(url) {
  const trimmed = (url ?? '').trim();
  if (!trimmed) return null;

  const sshShort = /^git@([^:]+):(.+?)(?:\.git)?\/?$/.exec(trimmed);
  if (sshShort) return { host: sshShort[1], repo: sshShort[2] };

  const protocol = /^(?:[a-z][a-z0-9+\-.]*:\/\/)([^@/]+@)?([^/]+)\/(.+?)(?:\.git)?\/?$/i.exec(trimmed);
  if (protocol) return { host: protocol[2], repo: protocol[3] };

  return null;
}

function buildWorkspaceEntry(project) {
  if (!project.source) return null;
  if (project.source.kind === 'local') {
    return {
      type: 'local_dir',
      src: project.source.workspaceDir,
      writable: true,
    };
  }
  if (project.source.kind === 'git-remote') {
    const parsed = parseGitRepoUrl(project.source.repoUrl);
    if (!parsed) return null;
    const entry = { type: 'git_repo', host: parsed.host, repo: parsed.repo };
    if (project.source.defaultBranch) entry.ref = project.source.defaultBranch;
    return entry;
  }
  return null;
}

function projectToConfig(project, defaults) {
  const entries = {};
  const workspaceEntry = buildWorkspaceEntry(project);
  if (workspaceEntry) entries['.'] = workspaceEntry;

  const manifest = {
    root: defaults.workspaceRoot ?? '/workspace',
    entries,
    environment: {
      value: {
        OMNI_PROJECT_ID: { type: 'literal', value: project.id },
      },
    },
  };

  const capabilities = [
    { type: 'filesystem' },
    { type: 'shell' },
    {
      type: 'skills',
      lazy_from: { source: { type: 'local_dir', src: defaults.skillsDir } },
    },
    { type: 'compaction', policy: { type: 'dynamic', target_pct: 0.7 } },
  ];

  const runtime = {
    client: 'docker',
    options: { image: project.sandbox?.image ?? defaults.defaultDockerImage },
  };

  const mcp_servers = [
    {
      type: 'stdio',
      name: 'omni-projects',
      command: 'node',
      args: [defaults.projectsMcpCliPath],
      env: { OMNI_PROJECT_ID: project.id },
    },
    ...(defaults.extraMcpServers ?? []),
  ];

  return { manifest, capabilities, runtime, mcp_servers };
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

function classify(project) {
  const findings = [];

  if (!project.source) {
    findings.push({
      projectId: project.id,
      label: project.label,
      severity: 'ok',
      message: 'no source — chat-only / Personal project, empty manifest',
    });
    return findings;
  }

  if (project.source.kind === 'local') {
    const dir = project.source.workspaceDir;
    if (!dir || !dir.trim()) {
      findings.push({
        projectId: project.id,
        label: project.label,
        severity: 'error',
        message: 'local source with empty workspaceDir — cannot build manifest entry',
      });
    } else {
      findings.push({
        projectId: project.id,
        label: project.label,
        severity: 'ok',
        message: `local_dir entry at ${dir}`,
      });
    }
    return findings;
  }

  if (project.source.kind === 'git-remote') {
    const url = project.source.repoUrl;
    const parsed = parseGitRepoUrl(url);
    if (!parsed) {
      findings.push({
        projectId: project.id,
        label: project.label,
        severity: 'warn',
        message: `git-remote URL did not parse (${url}); manifest falls back to empty entries`,
      });
    } else {
      findings.push({
        projectId: project.id,
        label: project.label,
        severity: 'ok',
        message: `git_repo entry parsed from ${url} → ${parsed.host}/${parsed.repo}`,
      });
    }
    return findings;
  }

  return findings;
}

function severityBadge(s) {
  return s === 'ok' ? '[ok]   ' : s === 'warn' ? '[warn] ' : '[ERROR]';
}

function main() {
  console.log(`[audit] db:  ${DB_PATH}`);
  console.log(`[audit] out: ${OUT_DIR}`);
  mkdirSync(OUT_DIR, { recursive: true });

  const db = openDatabase(DB_PATH);
  const repo = new ProjectsRepo(db);
  const rows = repo.listProjects();
  if (rows.length === 0) {
    console.log('[audit] no projects in DB; nothing to do');
    return;
  }

  const findings = [];
  let written = 0;

  for (const row of rows) {
    const project = rowToProject(row);
    findings.push(...classify(project));

    try {
      const config = projectToConfig(project, DEFAULTS);
      const yaml = yamlStringify(config);
      const filePath = join(OUT_DIR, `${project.id}.yml`);
      writeFileSync(
        filePath,
        `# Project: ${project.label} (${project.id})\n# Audit-generated from projects.db; do not edit.\n${yaml}`,
        'utf-8'
      );
      written++;
    } catch (err) {
      findings.push({
        projectId: project.id,
        label: project.label,
        severity: 'error',
        message: `projectToConfig threw: ${err.message}`,
      });
    }
  }

  console.log('');
  for (const f of findings) {
    console.log(`${severityBadge(f.severity)} ${f.projectId}  ${f.label}\n         ${f.message}`);
  }

  const ok = findings.filter((f) => f.severity === 'ok').length;
  const warn = findings.filter((f) => f.severity === 'warn').length;
  const error = findings.filter((f) => f.severity === 'error').length;
  console.log('');
  console.log(`[audit] summary: ${rows.length} projects, ${written} YAML files written`);
  console.log(`[audit]          ok=${ok} warn=${warn} error=${error}`);
  if (error > 0) {
    process.exit(1);
  }
}

main();
