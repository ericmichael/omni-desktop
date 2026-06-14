/**
 * Manifest + capability + runtime configuration for an agent project.
 *
 * These types mirror the openai-agents Python SDK's sandbox subsystem so
 * the launcher can serialize a project's configuration as YAML/JSON and
 * the agent process (omni-code / omniagents) can deserialize it directly
 * into Pydantic SDK objects via each type's `type:` discriminator.
 *
 * SDK source-of-truth:
 *   site-packages/agents/sandbox/manifest.py
 *   site-packages/agents/sandbox/entries/{artifacts,mounts}/...
 *   site-packages/agents/sandbox/capabilities/...
 *   site-packages/agents/sandbox/snapshot.py
 *   site-packages/agents/mcp/server.py
 *   site-packages/agents/run_config.py
 *
 * Conventions
 * -----------
 * - Field names use snake_case to match the SDK's Pydantic field names
 *   directly. No serialization step needed. This is the only file in the
 *   launcher that uses snake_case for app-level types — everything else
 *   keeps camelCase.
 * - Discriminated unions key on `type:`. Adding a new variant means
 *   (a) extending the union here, (b) registering a matching subclass on
 *   the Python side. Names prefixed `omni_` are launcher-specific.
 * - These are pure data shapes. The launcher does not run the SDK; it
 *   only persists this configuration and ships it to the agent process.
 */

// ----------------------------------------------------------------------------
// Primitives — match agents/sandbox/types.py
// ----------------------------------------------------------------------------

export type User = {
  name: string;
};

export type Group = {
  name: string;
  users: User[];
};

/** Owner/group/other permission triplet. Matches Pydantic `Permissions`. */
export type Permissions = {
  /** Owner mask — bitwise OR of FileMode values. Default 0o7. */
  owner: number;
  /** Group mask. Default 0. */
  group: number;
  /** Other mask. Default 0. */
  other: number;
  /** True for directories (sets S_IFDIR). Default false. */
  directory?: boolean;
};

/** Bitwise file-mode constants. Match `agents.sandbox.types.FileMode`. */
export const FileMode = {
  NONE: 0,
  EXEC: 1,
  WRITE: 1 << 1,
  READ: 1 << 2,
  ALL: 0o7,
} as const;

// ----------------------------------------------------------------------------
// Environment values — agents/sandbox/manifest.py:EnvValue
// ----------------------------------------------------------------------------

/**
 * Resolvable environment value. Built-in `str` is the literal case (the
 * SDK accepts a bare string in the env map, but for cross-language clarity
 * we wrap everything in a discriminated union).
 *
 * `omni_keychain` is launcher-specific: the Python side resolves it by
 * calling into the launcher's credential service. Matches the
 * `OmniKeychainEnvValue` subclass on that side.
 */
export type EnvValueRef = { type: 'literal'; value: string } | { type: 'omni_keychain'; key: string };

export type EnvEntry = {
  description?: string;
  /**
   * When true, the value is omitted from snapshots and from any rendered
   * manifest description shown to the model.
   */
  ephemeral?: boolean;
  value: EnvValueRef;
};

export type Environment = {
  value: Record<string, string | EnvValueRef | EnvEntry>;
};

// ----------------------------------------------------------------------------
// Manifest entries — agents/sandbox/entries/...
// ----------------------------------------------------------------------------

/** Common fields on every entry. Matches `BaseEntry`. */
export type BaseEntry = {
  description?: string;
  /** When true, the entry is not snapshotted across runs. */
  ephemeral?: boolean;
  /** Optional owner override (User or Group). */
  group?: User | Group;
  permissions?: Permissions;
};

/** Inline file with content declared in the manifest itself. */
export type FileEntry = BaseEntry & {
  type: 'file';
  content: string;
};

/** Directory with declared child entries. Recursive. */
export type DirEntry = BaseEntry & {
  type: 'dir';
  children?: Record<string, ManifestEntry>;
};

/** Copy a file from the host filesystem at materialization time. */
export type LocalFileEntry = BaseEntry & {
  type: 'local_file';
  /** Absolute path or path relative to the launcher's CWD. */
  src: string;
  /** When true, the file is writable inside the sandbox. */
  writable?: boolean;
  /** When true, no error is raised if the source path doesn't exist. */
  optional?: boolean;
};

/** Copy a directory tree from the host filesystem. */
export type LocalDirEntry = BaseEntry & {
  type: 'local_dir';
  src: string;
  writable?: boolean;
  optional?: boolean;
};

/** Clone a git repository at materialization time. */
export type GitRepoEntry = BaseEntry & {
  type: 'git_repo';
  /** e.g. "github.com" */
  host: string;
  /** e.g. "openai/openai-python" */
  repo: string;
  /** Branch, tag, or commit. Defaults to the repo's default branch. */
  ref?: string;
};

/**
 * Cloud-storage mount entries. The SDK supports S3, GCS, Azure Blob, R2,
 * Box, S3 Files. The mount infrastructure ships with a strategy + pattern
 * model; for launcher purposes we forward the minimum identifying fields
 * and let the SDK fill in defaults.
 *
 * Not enumerated exhaustively — add variants as needed. The SDK accepts
 * `type: "s3_mount" | "gcs_mount" | "azure_blob_mount" | "r2_mount" |
 *  "box_mount" | "s3_files_mount"`.
 */
export type MountEntry = BaseEntry & {
  type: 's3_mount' | 'gcs_mount' | 'azure_blob_mount' | 'r2_mount' | 'box_mount' | 's3_files_mount';
  /** Remaining fields are provider-specific; round-trip as-is. */
  [key: string]: unknown;
};

export type ManifestEntry = FileEntry | DirEntry | LocalFileEntry | LocalDirEntry | GitRepoEntry | MountEntry;

// ----------------------------------------------------------------------------
// Manifest — agents/sandbox/manifest.py:Manifest
// ----------------------------------------------------------------------------

export type Manifest = {
  /** Schema version. Always 1 today. */
  version?: 1;
  /** In-sandbox root path. Defaults to "/workspace". */
  root?: string;
  /** Entries to materialize at start, keyed by path relative to `root`. */
  entries?: Record<string, ManifestEntry>;
  environment?: Environment;
  users?: User[];
  groups?: Group[];
  /** Extra paths outside `root` the sandbox is allowed to access. */
  extra_path_grants?: Array<{ path: string; mode: 'read' | 'write' }>;
  /** Allowlist for commands run on remote-mount paths. SDK default covers ls/cat/grep/etc. */
  remote_mount_command_allowlist?: string[];
};

// ----------------------------------------------------------------------------
// Capabilities — agents/sandbox/capabilities/...
// ----------------------------------------------------------------------------

/** Static threshold-based compaction. Triggers above `threshold` tokens. */
export type StaticCompactionPolicy = {
  type: 'static';
  threshold: number;
};

/** Model-aware dynamic compaction. Triggers when `target_pct` of the model's window is full. */
export type DynamicCompactionPolicy = {
  type: 'dynamic';
  /** Default 0.7 in the SDK. */
  target_pct?: number;
};

export type CompactionPolicy = StaticCompactionPolicy | DynamicCompactionPolicy;

/**
 * Skill source for the Skills capability. Built-in: `local_dir` reads
 * `<src>/<name>/SKILL.md` lazily on demand.
 */
export type LazySkillSourceRef = {
  type: 'local_dir';
  src: string;
};

export type FilesystemCapability = { type: 'filesystem' };
export type ShellCapability = { type: 'shell' };
export type MemoryCapability = {
  type: 'memory';
  /** Backend-specific config; the SDK's Memory class fills in defaults. */
  [key: string]: unknown;
};

export type SkillsCapability = {
  type: 'skills';
  /** Where skills appear inside the sandbox. Default `.agents`. */
  skills_path?: string;
  /** Lazy source for the index — listed up front, loaded on demand. */
  lazy_from?: { source: LazySkillSourceRef };
};

export type CompactionCapability = {
  type: 'compaction';
  policy: CompactionPolicy;
};

export type Capability =
  | FilesystemCapability
  | ShellCapability
  | SkillsCapability
  | MemoryCapability
  | CompactionCapability;

// ----------------------------------------------------------------------------
// Snapshot — agents/sandbox/snapshot.py
// ----------------------------------------------------------------------------

export type SnapshotSpec =
  | { type: 'local'; base_path: string }
  | { type: 'noop' }
  | { type: 'remote'; client_dependency_key?: string };

// ----------------------------------------------------------------------------
// MCP servers — agents/mcp/server.py
// These live on the agent (Agent.mcp_servers), not in the sandbox.
// ----------------------------------------------------------------------------

export type McpServerStdio = {
  type: 'stdio';
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** Working directory for the spawned process. */
  cwd?: string;
};

export type McpServerSse = {
  type: 'sse';
  name: string;
  url: string;
  headers?: Record<string, string>;
};

export type McpServerStreamableHttp = {
  type: 'streamable_http';
  name: string;
  url: string;
  headers?: Record<string, string>;
};

export type McpServerConfig = McpServerStdio | McpServerSse | McpServerStreamableHttp;

// ----------------------------------------------------------------------------
// Runtime — which SandboxClient + options
// Matches agents/sandbox/session/sandbox_client.py:BaseSandboxClient and
// the built-in subclasses in agents/sandbox/sandboxes/{unix_local,docker}.
// ----------------------------------------------------------------------------

/**
 * Runtime sandbox client choice. The launcher persists which client
 * variant the project uses; the agent process instantiates the matching
 * SDK class.
 *
 * Built-in SDK clients:
 *   - `unix_local`: runs on the host in a tempdir (no isolation; tests only)
 *   - `docker`: runs in a Docker container
 *
 * The launcher's existing `omni-sandbox` Rust binary is not yet wired
 * into this union. If you decide to retire it, all production paths use
 * `docker`. If you decide to keep it, add an `omni_sandbox` variant here
 * and register a matching `OmniSandboxClient` on the Python side.
 */
export type RuntimeConfig =
  | {
      client: 'unix_local';
      options?: {
        exposed_ports?: number[];
      };
    }
  | {
      client: 'docker';
      options: {
        image: string;
        exposed_ports?: number[];
        /** Forwarded to the Docker daemon. */
        docker_args?: string[];
      };
    };

/** Identity inside the sandbox. Forwarded to SandboxAgent.run_as. */
export type RunAs = string | User;

// ----------------------------------------------------------------------------
// Project — top-level shape persisted by the launcher
// ----------------------------------------------------------------------------

/**
 * The full agent-runnable configuration for a project. Replaces the
 * scattered `Project.source` / `Project.sandbox` / `Project.pipeline` /
 * `Project.isPersonal` fields and pulls MCP servers out of the global
 * `mcp.json` into per-project declaration.
 *
 * Persisted as YAML at a stable, ID-keyed path (e.g.
 * `~/Omni/Projects/<projectId>.yml`) so it's hand-editable for power
 * users. The DB row carries the project id, label, autoDispatch,
 * timestamps; everything below is content of the YAML file.
 */
export type ProjectConfig = {
  manifest: Manifest;
  capabilities: Capability[];
  runtime: RuntimeConfig;
  mcp_servers?: McpServerConfig[];
  snapshot?: SnapshotSpec;
  /** Identity inside the sandbox. Matches SandboxAgent.run_as. */
  run_as?: RunAs;
};

// ----------------------------------------------------------------------------
// Shape examples — for type-checking three representative projects
// ----------------------------------------------------------------------------

/**
 * Empty starter manifest. Same as a chat-only / Personal project today.
 * Matches `entries = {}` — sandbox starts with nothing materialized.
 */
export const EMPTY_MANIFEST: Manifest = {
  root: '/workspace',
  entries: {},
};

/** Default capability set when none is specified — mirrors `Capabilities.default()`. */
export const DEFAULT_CAPABILITIES: Capability[] = [
  { type: 'filesystem' },
  { type: 'shell' },
  { type: 'compaction', policy: { type: 'dynamic', target_pct: 0.7 } },
];
