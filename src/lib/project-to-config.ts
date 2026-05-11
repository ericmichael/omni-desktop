/**
 * Map a legacy `Project` to a `ProjectConfig`.
 *
 * Pure function — no I/O, no DB, no globals. Takes a `Project` plus the
 * launcher-level defaults that a project doesn't carry itself (skills
 * directory, MCP server path, sandbox image) and returns the equivalent
 * `ProjectConfig` describing the same runtime intent.
 *
 * This exists so the manifest model can be validated against every real
 * project in the DB before any consumer is changed. If `projectToConfig`
 * round-trips cleanly for every row, the data model fits.
 */
import type {
  Capability,
  GitRepoEntry,
  LocalDirEntry,
  Manifest,
  McpServerConfig,
  ProjectConfig,
  RuntimeConfig,
} from '@/shared/manifest';
import type { Project } from '@/shared/types';

/**
 * Defaults the launcher provides at config-build time. The current launcher
 * resolves these from `getOmniConfigDir()`, the bundled MCP CLI path, and
 * the store's `sandboxImage` setting — but `projectToConfig` stays pure
 * by taking them as inputs.
 */
export interface ProjectConfigDefaults {
  /** Absolute path to the host's skills directory (e.g. `~/.config/omni_code/skills`). */
  skillsDir: string;
  /** Absolute path to the bundled `omni-projects-mcp` CLI JS file. */
  projectsMcpCliPath: string;
  /** Default sandbox image used when the project doesn't override it. */
  defaultDockerImage: string;
  /** Extra MCP servers to attach to every project (rarely used). */
  extraMcpServers?: McpServerConfig[];
  /** Override the workspace root path inside the sandbox. SDK default `/workspace`. */
  workspaceRoot?: string;
}

/**
 * Parse a git URL into the `{ host, repo }` pair the SDK's `GitRepo`
 * entry wants. Supports the common HTTPS, SSH, and `git@` forms.
 *
 * Returns `null` for shapes we can't recognize — caller decides whether
 * to fall back (e.g. treat as a context-only project) or surface a
 * config error.
 */
export function parseGitRepoUrl(url: string): { host: string; repo: string } | null {
  const trimmed = url.trim();
  if (!trimmed) {
    return null;
  }

  // git@github.com:owner/repo(.git)?
  const sshShort = /^git@([^:]+):(.+?)(?:\.git)?\/?$/.exec(trimmed);
  if (sshShort) {
    return { host: sshShort[1]!, repo: sshShort[2]! };
  }

  // ssh://git@github.com/owner/repo(.git)?
  // https://github.com/owner/repo(.git)?
  // http://...
  const protocol = /^(?:[a-z][a-z0-9+\-.]*:\/\/)([^@/]+@)?([^/]+)\/(.+?)(?:\.git)?\/?$/i.exec(
    trimmed
  );
  if (protocol) {
    return { host: protocol[2]!, repo: protocol[3]! };
  }

  return null;
}

/**
 * Build the manifest entry for the project's workspace, if it has one.
 * Returns `null` for chat-only / Personal / context-only projects.
 */
function buildWorkspaceEntry(project: Project): LocalDirEntry | GitRepoEntry | null {
  if (!project.source) {
    return null;
  }
  if (project.source.kind === 'local') {
    return {
      type: 'local_dir',
      src: project.source.workspaceDir,
      writable: true,
    };
  }
  if (project.source.kind === 'git-remote') {
    const parsed = parseGitRepoUrl(project.source.repoUrl);
    if (!parsed) {
      // Unparseable URL — surface as a context-only manifest. The caller
      // can validate separately if it wants to refuse the rename.
      return null;
    }
    const entry: GitRepoEntry = {
      type: 'git_repo',
      host: parsed.host,
      repo: parsed.repo,
    };
    if (project.source.defaultBranch) {
      entry.ref = project.source.defaultBranch;
    }
    return entry;
  }
  return null;
}

/**
 * Build the manifest, including the workspace entry (if any) and the
 * `OMNI_PROJECT_ID` env var that every agent needs.
 */
function buildManifest(project: Project, defaults: ProjectConfigDefaults): Manifest {
  const root = defaults.workspaceRoot ?? '/workspace';
  const entries: Manifest['entries'] = {};

  const workspaceEntry = buildWorkspaceEntry(project);
  if (workspaceEntry) {
    entries['.'] = workspaceEntry;
  }

  return {
    root,
    entries,
    environment: {
      value: {
        OMNI_PROJECT_ID: { type: 'literal', value: project.id },
      },
    },
  };
}

/**
 * Default capability set every project gets. Mirrors the SDK's
 * `Capabilities.default()` plus the Skills capability wired to the
 * launcher's shared skills directory.
 */
function buildCapabilities(defaults: ProjectConfigDefaults): Capability[] {
  return [
    { type: 'filesystem' },
    { type: 'shell' },
    {
      type: 'skills',
      lazy_from: { source: { type: 'local_dir', src: defaults.skillsDir } },
    },
    { type: 'compaction', policy: { type: 'dynamic', target_pct: 0.7 } },
  ];
}

/**
 * Resolve the runtime sandbox configuration. The current launcher stores
 * an optional image override on the project; if absent, the launcher's
 * default sandbox image is used. The `omni-sandbox` Rust binary backend
 * isn't surfaced here yet — it would become a third `client:` variant
 * with its own options shape.
 */
function buildRuntime(project: Project, defaults: ProjectConfigDefaults): RuntimeConfig {
  const image = project.sandbox?.image ?? defaults.defaultDockerImage;
  return {
    client: 'docker',
    options: { image },
  };
}

/**
 * Build the MCP server list. Every project gets the `omni-projects` stdio
 * server scoped to its own project id — this replaces the global
 * `mcp.json` entry that `syncMcpConfig` writes today.
 */
function buildMcpServers(
  project: Project,
  defaults: ProjectConfigDefaults
): McpServerConfig[] {
  const omniProjects: McpServerConfig = {
    type: 'stdio',
    name: 'omni-projects',
    command: 'node',
    args: [defaults.projectsMcpCliPath],
    env: { OMNI_PROJECT_ID: project.id },
  };
  return [omniProjects, ...(defaults.extraMcpServers ?? [])];
}

/**
 * Transform a legacy `Project` into the new `ProjectConfig` shape.
 *
 * Returns a value-equivalent `ProjectConfig` — no I/O, no side effects.
 * The four current sources of project configuration all collapse:
 *
 *   - `project.source.kind = 'local'`     → `manifest.entries['.']` (local_dir)
 *   - `project.source.kind = 'git-remote'` → `manifest.entries['.']` (git_repo)
 *   - `project.source = undefined`        → `manifest.entries = {}`
 *   - `project.isPersonal = true`         → same as no source (the flag goes away)
 *   - `project.sandbox.image`             → `runtime.options.image`
 *   - global `mcp.json` omni-projects entry → `mcp_servers[0]` per-project
 *   - global skills dir                   → `Skills` capability
 *   - `project.pipeline`                  → not in ProjectConfig (stays in DB,
 *                                            sourced from FLEET.md inside
 *                                            the manifest at runtime)
 */
export function projectToConfig(
  project: Project,
  defaults: ProjectConfigDefaults
): ProjectConfig {
  return {
    manifest: buildManifest(project, defaults),
    capabilities: buildCapabilities(defaults),
    runtime: buildRuntime(project, defaults),
    mcp_servers: buildMcpServers(project, defaults),
  };
}
