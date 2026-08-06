import type { GitOperationProgressParams, RpcMethodMap } from '@/generated/omniagents-gui-v1/gui-v1';
import { OmniagentsRpcError } from '@/shared/omniagents-rpc';
import type { ExecutionTarget } from '@/shared/types';

import type { RPCClient } from './client';

type GitMethod = Extract<keyof RpcMethodMap, `git_${string}`>;
type GitParams<M extends GitMethod> = RpcMethodMap[M]['params'];

/** The protocol never accepts an absolute host path as a repository id. */
declare const workspaceRepoBrand: unique symbol;
export type WorkspaceRepo = string & { readonly [workspaceRepoBrand]: true };

export function workspaceRepo(value: string): WorkspaceRepo {
  if (
    value.length === 0 ||
    value.includes('\0') ||
    value.includes('\\') ||
    value.startsWith('/') ||
    /^[A-Za-z]:/.test(value) ||
    (value !== '.' && value.split('/').some((part) => part === '' || part === '.' || part === '..'))
  ) {
    throw new TypeError(`Repository must be a workspace-relative POSIX path: ${value}`);
  }
  return value as WorkspaceRepo;
}

export type GitDiffMode = 'worktree' | 'staged' | 'head' | 'range';
export type GitResetMode = 'soft' | 'mixed' | 'hard';
export type GitFileStatus =
  | 'unmodified'
  | 'modified'
  | 'type_changed'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'unmerged'
  | 'unknown';

export type GitRepository = {
  repo: WorkspaceRepo;
  root: string;
  absolute_root: string;
  branch: string | null;
  detached: boolean;
  bare: boolean;
  git_common_dir: string | null;
  is_linked_worktree: boolean;
  source: Record<string, unknown> | null;
};

export type GitUnreachableSource = {
  mount_name: string | null;
  kind: string | null;
  path: string | null;
  repo_url: string | null;
  reason: 'not_in_workspace';
};

export type GitListRepositoriesResult = {
  environment_id: string;
  path: string;
  repositories: GitRepository[];
  sources: Record<string, unknown>[];
  unreachable_sources: GitUnreachableSource[];
  max_depth: number;
  max_depth_clamped: boolean;
  truncated: boolean;
};

export type GitStatusEntry = {
  path: string;
  orig_path: string | null;
  xy: string;
  index_status: GitFileStatus;
  worktree_status: GitFileStatus;
  staged: boolean;
  unstaged: boolean;
  submodule: boolean;
  similarity: number | null;
  unmerged: Record<string, string> | null;
};

export type GitStatusResult = {
  environment_id: string;
  repo: WorkspaceRepo;
  head: { detached: boolean; unborn: boolean; branch: string | null; oid: string | null };
  upstream: { name: string; ahead: number; behind: number } | null;
  entries: GitStatusEntry[];
  untracked: string[];
  ignored: string[];
  conflicted: string[];
  stash_count: number;
  clean: boolean;
  state: 'clean' | 'merging' | 'rebasing' | 'cherry_picking' | 'reverting';
};

export type GitDiffLine = {
  origin: 'context' | 'add' | 'delete' | 'no_newline';
  content: string;
  old_lineno: number | null;
  new_lineno: number | null;
};

/** A hunk id is content-addressed and valid only for its returned diff scope. */
export type GitDiffHunk = {
  hunk_id: string;
  index: number;
  header: string;
  section_heading: string;
  old_start: number;
  old_lines: number;
  new_start: number;
  new_lines: number;
  lines: GitDiffLine[];
};

export type GitDiffFile = {
  path: string;
  old_path: string | null;
  change: GitFileStatus;
  old_mode: string;
  new_mode: string;
  old_oid: string;
  new_oid: string;
  similarity: number | null;
  binary: boolean;
  added_lines: number | null;
  deleted_lines: number | null;
  unmerged: boolean;
  submodule: boolean;
  hunk_selectable: boolean;
  hunks: GitDiffHunk[];
};

export type GitDiffResult = {
  environment_id: string;
  repo: WorkspaceRepo;
  mode: GitDiffMode;
  context_lines: number;
  context_lines_clamped: boolean;
  files: GitDiffFile[];
};

export type GitCommitSummary = {
  oid: string;
  short_oid: string;
  parents: string[];
  author_name: string;
  author_email: string;
  authored_at: string;
  committer_name: string;
  committer_email: string;
  committed_at: string;
  refs: string[];
  subject: string;
  body: string;
};
export type GitLogResult = {
  environment_id: string;
  repo: WorkspaceRepo;
  commits: GitCommitSummary[];
  max_count: number;
  truncated: boolean;
};

export type GitBranch = {
  ref: string;
  name: string;
  oid: string;
  remote: boolean;
  upstream: string | null;
  upstream_remote: string | null;
  current: boolean;
  worktree_path: string | null;
  category: 'branch' | 'worker';
};
export type GitListBranchesResult = { environment_id: string; repo: WorkspaceRepo; branches: GitBranch[] };

export type GitWorktree = {
  path: string;
  head: string | null;
  branch: string | null;
  detached: boolean;
  bare: boolean;
  locked: boolean;
  lock_reason: string | null;
  prunable: boolean;
  repo: WorkspaceRepo | null;
  accessible: boolean;
  inaccessible_reason: 'outside_workspace' | null;
  category: 'worktree' | 'worker';
};
export type GitListWorktreesResult = { environment_id: string; repo: WorkspaceRepo; worktrees: GitWorktree[] };

export type GitConflictRegion = {
  start_line: number;
  end_line: number;
  ours_label: string;
  base_label: string | null;
  theirs_label: string;
  ours: string[];
  base: string[] | null;
  theirs: string[];
};
export type GitConflict = {
  path: string;
  stages: Partial<
    Record<
      'base' | 'ours' | 'theirs',
      { mode: string; oid: string; content: string | null; content_truncated: boolean }
    >
  >;
  regions: GitConflictRegion[];
  regions_available: boolean;
};
export type GitConflictsResult = {
  environment_id: string;
  repo: WorkspaceRepo;
  state: GitStatusResult['state'];
  conflicts: GitConflict[];
  content_truncated: boolean;
};

export type GitHunkRef = { path: string; hunk_id: string };
export type GitFileSelection = {
  paths?: string[];
  hunks?: GitHunkRef[];
  contextLines?: number;
};
export type GitSelection = GitFileSelection & {
  /** Must match the scope which produced each hunk id. */
  mode?: 'worktree' | 'head';
};
export type GitStageResult = {
  environment_id: string;
  repo: WorkspaceRepo;
  staged_paths: string[];
  staged_hunks: GitHunkRef[];
};
export type GitUnstageResult = {
  environment_id: string;
  repo: WorkspaceRepo;
  unstaged_paths: string[];
  unstaged_hunks: GitHunkRef[];
};
export type GitDiscardResult = {
  environment_id: string;
  repo: WorkspaceRepo;
  discarded_paths: string[];
  discarded_hunks: GitHunkRef[];
};
export type GitCommitResult = { environment_id: string; repo: WorkspaceRepo; oid: string; amended: boolean };
export type GitRefUpdate = {
  ref: string;
  old_oid: string | null;
  new_oid: string | null;
  change: 'created' | 'updated' | 'deleted';
};
export type GitFetchResult = {
  environment_id: string;
  repo: WorkspaceRepo;
  remote: string | null;
  updated_refs: GitRefUpdate[];
};
export type GitPullResult = {
  environment_id: string;
  repo: WorkspaceRepo;
  ok: boolean;
  state: GitStatusResult['state'];
  conflicted: string[];
  head: GitStatusResult['head'];
};
export type GitPushUpdate = {
  flag: string;
  status: 'fast_forward' | 'forced_update' | 'deleted' | 'created' | 'rejected' | 'up_to_date' | 'unknown';
  rejected: boolean;
  source_ref: string;
  target_ref: string;
  summary_raw: string;
  reason_raw: string | null;
};
export type GitPushResult = {
  environment_id: string;
  repo: WorkspaceRepo;
  ok: boolean;
  remote_url: string | null;
  updates: GitPushUpdate[];
  rejected: string[];
};

export type GitOperationProgress = GitOperationProgressParams & {
  operation: 'fetch' | 'pull' | 'push';
  phase: 'started' | 'completed' | 'failed';
};

type ConfirmationBinding = {
  method: GitMethod;
  repo: WorkspaceRepo;
  paramsKey: string;
};

/** Opaque, locally single-use handle returned by a server confirmation challenge. */
export class GitConfirmation {
  readonly operation: string;
  readonly impact: Readonly<Record<string, unknown>>;
  readonly repo: WorkspaceRepo;
  readonly #token: string;
  readonly #binding: ConfirmationBinding;
  #used = false;

  private constructor(operation: string, impact: Record<string, unknown>, token: string, binding: ConfirmationBinding) {
    this.operation = operation;
    this.impact = Object.freeze({ ...impact });
    this.repo = binding.repo;
    this.#token = token;
    this.#binding = binding;
  }

  static fromError(error: unknown, binding: ConfirmationBinding): GitConfirmation | null {
    if (!(error instanceof OmniagentsRpcError) || error.code !== -32093) {
      return null;
    }
    const data = record(error.data, 'git confirmation error data');
    if (data.kind !== 'git_confirmation_required') {
      return null;
    }
    const reason = string(data.reason, 'confirmation reason');
    if (reason !== 'confirmation_required' && reason !== 'stale_confirmation') {
      throw new TypeError('Invalid confirmation reason');
    }
    const operation = string(data.operation, 'confirmation operation');
    const token = string(data.confirmation_token, 'confirmation token');
    const challengeRepo = workspaceRepo(string(data.repo, 'confirmation repo'));
    if (challengeRepo !== binding.repo) {
      throw new Error('Git confirmation challenge was issued for a different repository');
    }
    return new GitConfirmation(operation, record(data.impact, 'confirmation impact'), token, binding);
  }

  /** Consume before transport I/O: retries must obtain a fresh server challenge. */
  claim(binding: ConfirmationBinding): string {
    if (this.#used) {
      throw new Error('Git confirmation token has already been used');
    }
    if (
      this.#binding.method !== binding.method ||
      this.#binding.repo !== binding.repo ||
      this.#binding.paramsKey !== binding.paramsKey
    ) {
      throw new Error('Git confirmation does not match this operation');
    }
    this.#used = true;
    return this.#token;
  }
}

export type GitMutationOutcome<T> =
  | { kind: 'completed'; result: T }
  | { kind: 'confirmation_required'; confirmation: GitConfirmation };

type GitTransport = Pick<RPCClient, 'request' | 'on'>;

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`Invalid ${label}`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new TypeError(`Invalid ${label}`);
  }
  return value;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') {
    throw new TypeError(`Invalid ${label}`);
  }
  return value;
}

function number(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`Invalid ${label}`);
  }
  return value;
}

function nullable<T>(value: unknown, parser: (item: unknown, label: string) => T, label: string): T | null {
  return value === null ? null : parser(value, label);
}

function array<T>(value: unknown, parser: (item: unknown, label: string) => T, label: string): T[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`Invalid ${label}`);
  }
  return value.map((item, index) => parser(item, `${label}[${index}]`));
}

const strings = (value: unknown, label: string) => array(value, string, label);
const gitStatuses = new Set<GitFileStatus>([
  'unmodified',
  'modified',
  'type_changed',
  'added',
  'deleted',
  'renamed',
  'copied',
  'unmerged',
  'unknown',
]);
function gitStatus(value: unknown, label: string): GitFileStatus {
  const result = string(value, label) as GitFileStatus;
  if (!gitStatuses.has(result)) {
    throw new TypeError(`Invalid ${label}`);
  }
  return result;
}

function gitPath(value: unknown, label: string): string {
  const path = string(value, label);
  validateGitPath(path);
  return path;
}

function hunkId(value: unknown, label: string): string {
  const id = string(value, label);
  if (!/^[a-f0-9]{16}$/.test(id)) {
    throw new TypeError(`Invalid ${label}`);
  }
  return id;
}

function resultBase(value: unknown, expectedEnvironment: string, expectedRepo: WorkspaceRepo, label: string) {
  const item = record(value, label);
  if (string(item.environment_id, `${label}.environment_id`) !== expectedEnvironment) {
    throw new TypeError(`${label} has the wrong environment`);
  }
  if (workspaceRepo(string(item.repo, `${label}.repo`)) !== expectedRepo) {
    throw new TypeError(`${label} has the wrong repository`);
  }
  return item;
}

function parseStatus(value: unknown, environment: string, repo: WorkspaceRepo): GitStatusResult {
  const item = resultBase(value, environment, repo, 'git_status result');
  const head = record(item.head, 'git_status head');
  const upstream = item.upstream === null ? null : record(item.upstream, 'git_status upstream');
  const states = new Set<GitStatusResult['state']>(['clean', 'merging', 'rebasing', 'cherry_picking', 'reverting']);
  const state = string(item.state, 'git_status state') as GitStatusResult['state'];
  if (!states.has(state)) {
    throw new TypeError('Invalid git_status state');
  }
  return {
    environment_id: environment,
    repo,
    head: {
      detached: boolean(head.detached, 'head.detached'),
      unborn: boolean(head.unborn, 'head.unborn'),
      branch: nullable(head.branch, string, 'head.branch'),
      oid: nullable(head.oid, string, 'head.oid'),
    },
    upstream: upstream && {
      name: string(upstream.name, 'upstream.name'),
      ahead: number(upstream.ahead, 'upstream.ahead'),
      behind: number(upstream.behind, 'upstream.behind'),
    },
    entries: array(
      item.entries,
      (entry, label) => {
        const e = record(entry, label);
        const unmerged = e.unmerged === null ? null : record(e.unmerged, `${label}.unmerged`);
        return {
          path: gitPath(e.path, `${label}.path`),
          orig_path: nullable(e.orig_path, gitPath, `${label}.orig_path`),
          xy: string(e.xy, `${label}.xy`),
          index_status: gitStatus(e.index_status, `${label}.index_status`),
          worktree_status: gitStatus(e.worktree_status, `${label}.worktree_status`),
          staged: boolean(e.staged, `${label}.staged`),
          unstaged: boolean(e.unstaged, `${label}.unstaged`),
          submodule: boolean(e.submodule, `${label}.submodule`),
          similarity: nullable(e.similarity, number, `${label}.similarity`),
          unmerged:
            unmerged &&
            Object.fromEntries(
              Object.entries(unmerged).map(([key, val]) => [key, string(val, `${label}.unmerged.${key}`)])
            ),
        };
      },
      'git_status entries'
    ),
    untracked: array(item.untracked, gitPath, 'git_status untracked'),
    ignored: array(item.ignored, gitPath, 'git_status ignored'),
    conflicted: array(item.conflicted, gitPath, 'git_status conflicted'),
    stash_count: number(item.stash_count, 'git_status stash_count'),
    clean: boolean(item.clean, 'git_status clean'),
    state,
  };
}

function parseDiff(value: unknown, environment: string, repo: WorkspaceRepo): GitDiffResult {
  const item = resultBase(value, environment, repo, 'git_diff result');
  const modes = new Set<GitDiffMode>(['worktree', 'staged', 'head', 'range']);
  const mode = string(item.mode, 'git_diff mode') as GitDiffMode;
  if (!modes.has(mode)) {
    throw new TypeError('Invalid git_diff mode');
  }
  return {
    environment_id: environment,
    repo,
    mode,
    context_lines: number(item.context_lines, 'git_diff context_lines'),
    context_lines_clamped: boolean(item.context_lines_clamped, 'context_lines_clamped'),
    files: array(
      item.files,
      (file, fileLabel) => {
        const f = record(file, fileLabel);
        return {
          path: gitPath(f.path, `${fileLabel}.path`),
          old_path: nullable(f.old_path, gitPath, `${fileLabel}.old_path`),
          change: gitStatus(f.change, `${fileLabel}.change`),
          old_mode: string(f.old_mode, `${fileLabel}.old_mode`),
          new_mode: string(f.new_mode, `${fileLabel}.new_mode`),
          old_oid: string(f.old_oid, `${fileLabel}.old_oid`),
          new_oid: string(f.new_oid, `${fileLabel}.new_oid`),
          similarity: nullable(f.similarity, number, `${fileLabel}.similarity`),
          binary: boolean(f.binary, `${fileLabel}.binary`),
          added_lines: nullable(f.added_lines, number, `${fileLabel}.added_lines`),
          deleted_lines: nullable(f.deleted_lines, number, `${fileLabel}.deleted_lines`),
          unmerged: boolean(f.unmerged, `${fileLabel}.unmerged`),
          submodule: boolean(f.submodule, `${fileLabel}.submodule`),
          hunk_selectable: boolean(f.hunk_selectable, `${fileLabel}.hunk_selectable`),
          hunks: array(
            f.hunks,
            (hunk, hunkLabel) => {
              const h = record(hunk, hunkLabel);
              return {
                hunk_id: hunkId(h.hunk_id, `${hunkLabel}.hunk_id`),
                index: number(h.index, `${hunkLabel}.index`),
                header: string(h.header, `${hunkLabel}.header`),
                section_heading: string(h.section_heading, `${hunkLabel}.section_heading`),
                old_start: number(h.old_start, `${hunkLabel}.old_start`),
                old_lines: number(h.old_lines, `${hunkLabel}.old_lines`),
                new_start: number(h.new_start, `${hunkLabel}.new_start`),
                new_lines: number(h.new_lines, `${hunkLabel}.new_lines`),
                lines: array(
                  h.lines,
                  (line, lineLabel) => {
                    const l = record(line, lineLabel);
                    const origins = new Set<GitDiffLine['origin']>(['context', 'add', 'delete', 'no_newline']);
                    const origin = string(l.origin, `${lineLabel}.origin`) as GitDiffLine['origin'];
                    if (!origins.has(origin)) {
                      throw new TypeError(`Invalid ${lineLabel}.origin`);
                    }
                    return {
                      origin,
                      content: string(l.content, `${lineLabel}.content`),
                      old_lineno: nullable(l.old_lineno, number, `${lineLabel}.old_lineno`),
                      new_lineno: nullable(l.new_lineno, number, `${lineLabel}.new_lineno`),
                    };
                  },
                  `${hunkLabel}.lines`
                ),
              };
            },
            `${fileLabel}.hunks`
          ),
        };
      },
      'git_diff files'
    ),
  };
}

function stableKey(value: Record<string, unknown>): string {
  const stable = (item: unknown): unknown => {
    if (Array.isArray(item)) {
      return item.map(stable);
    }
    if (item && typeof item === 'object') {
      return Object.fromEntries(
        Object.entries(item as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, nested]) => [key, stable(nested)])
      );
    }
    return item;
  };
  return JSON.stringify(stable(value));
}

function selectionParams(environment: string, repo: WorkspaceRepo, selection: GitSelection): Record<string, unknown> {
  if (!selection.paths?.length && !selection.hunks?.length) {
    throw new TypeError('Git selection must not be empty');
  }
  selection.paths?.forEach((path) => validateGitPath(path));
  selection.hunks?.forEach(({ path, hunk_id }) => {
    validateGitPath(path);
    hunkId(hunk_id, 'Git hunk id');
  });
  const params: Record<string, unknown> = { environment_id: environment, repo };
  if (selection.paths !== undefined) {
    params.paths = selection.paths;
  }
  if (selection.hunks !== undefined) {
    params.hunks = selection.hunks;
  }
  if (selection.contextLines !== undefined) {
    params.context_lines = selection.contextLines;
  }
  if (selection.mode !== undefined) {
    params.mode = selection.mode;
  }
  return params;
}

function validateGitPath(path: string): void {
  if (!path || path.includes('\0') || path.includes('\\') || path.startsWith('/') || path.split('/').includes('..')) {
    throw new TypeError(`Git path must stay inside the repository: ${path}`);
  }
}

export class GitClient {
  readonly #rpc: GitTransport;
  readonly #environment: string;
  readonly #target: ExecutionTarget | null;

  constructor(rpc: GitTransport, target: ExecutionTarget | string) {
    const environmentId = typeof target === 'string' ? target : target.environmentId;
    if (!environmentId) {
      throw new TypeError('Git client requires an environment id');
    }
    this.#rpc = rpc;
    this.#environment = environmentId;
    this.#target = typeof target === 'string' ? null : target;
  }

  #request<M extends GitMethod>(method: M, params: GitParams<M>): Promise<RpcMethodMap[M]['result']> {
    return this.#rpc.request(method, {
      ...params,
      ...(this.#target
        ? {
            workspace_id: this.#target.workspaceId,
            environment_id: this.#target.environmentId,
            environment_generation: this.#target.environmentGeneration,
          }
        : {}),
    } as GitParams<M>);
  }

  onOperationProgress(handler: (progress: GitOperationProgress) => void): () => void {
    return this.#rpc.on('git_operation_progress', (payload) => {
      const item = record(payload, 'git operation progress');
      const eventEnvironment = string(item.environment_id, 'progress.environment_id');
      if (eventEnvironment !== this.#environment) {
        return;
      }
      if (
        this.#target &&
        ((item.workspace_id !== undefined && item.workspace_id !== this.#target.workspaceId) ||
          (item.environment_generation !== undefined &&
            item.environment_generation !== this.#target.environmentGeneration))
      ) {
        return;
      }
      const operation = string(item.operation, 'progress.operation') as GitOperationProgress['operation'];
      const phase = string(item.phase, 'progress.phase') as GitOperationProgress['phase'];
      if (!new Set<GitOperationProgress['operation']>(['fetch', 'pull', 'push']).has(operation)) {
        throw new TypeError('Invalid progress.operation');
      }
      if (!new Set<GitOperationProgress['phase']>(['started', 'completed', 'failed']).has(phase)) {
        throw new TypeError('Invalid progress.phase');
      }
      handler({
        ...payload,
        environment_id: eventEnvironment,
        operation_id: string(item.operation_id, 'progress.operation_id'),
        repo: workspaceRepo(string(item.repo, 'progress.repo')),
        operation,
        phase,
        ...(item.detail === undefined ? {} : { detail: record(item.detail, 'progress.detail') }),
      });
    });
  }

  async listRepositories(opts: { path?: string; maxDepth?: number } = {}): Promise<GitListRepositoriesResult> {
    const requestedPath = opts.path === undefined ? workspaceRepo('.') : workspaceRepo(opts.path);
    if (opts.maxDepth !== undefined && (!Number.isSafeInteger(opts.maxDepth) || opts.maxDepth < 0)) {
      throw new TypeError('Repository discovery maxDepth must be a non-negative safe integer');
    }
    const raw = await this.#request('git_list_repositories', {
      environment_id: this.#environment,
      ...(opts.path === undefined ? {} : { path: requestedPath }),
      ...(opts.maxDepth === undefined ? {} : { max_depth: opts.maxDepth }),
    });
    const item = record(raw, 'git_list_repositories result');
    if (string(item.environment_id, 'repositories.environment_id') !== this.#environment) {
      throw new TypeError('Repository result has the wrong environment');
    }
    const resultPath = workspaceRepo(string(item.path, 'repositories.path'));
    if (resultPath !== requestedPath) {
      throw new TypeError('Repository result has the wrong path');
    }
    return {
      environment_id: this.#environment,
      path: resultPath,
      repositories: array(
        item.repositories,
        (repo, label) => {
          const r = record(repo, label);
          return {
            repo: workspaceRepo(string(r.repo, `${label}.repo`)),
            root: string(r.root, `${label}.root`),
            absolute_root: string(r.absolute_root, `${label}.absolute_root`),
            branch: nullable(r.branch, string, `${label}.branch`),
            detached: boolean(r.detached, `${label}.detached`),
            bare: boolean(r.bare, `${label}.bare`),
            git_common_dir: nullable(r.git_common_dir, string, `${label}.git_common_dir`),
            is_linked_worktree: boolean(r.is_linked_worktree, `${label}.is_linked_worktree`),
            source: r.source === null ? null : record(r.source, `${label}.source`),
          };
        },
        'repositories'
      ),
      sources: array(item.sources, record, 'repository sources'),
      unreachable_sources: array(
        item.unreachable_sources,
        (source, label) => {
          const s = record(source, label);
          const reason = string(s.reason, `${label}.reason`);
          if (reason !== 'not_in_workspace') {
            throw new TypeError(`Invalid ${label}.reason`);
          }
          return {
            mount_name: nullable(s.mount_name, string, `${label}.mount_name`),
            kind: nullable(s.kind, string, `${label}.kind`),
            path: nullable(s.path, string, `${label}.path`),
            repo_url: nullable(s.repo_url, string, `${label}.repo_url`),
            reason,
          };
        },
        'unreachable sources'
      ),
      max_depth: number(item.max_depth, 'repositories.max_depth'),
      max_depth_clamped: boolean(item.max_depth_clamped, 'repositories.max_depth_clamped'),
      truncated: boolean(item.truncated, 'repositories.truncated'),
    };
  }

  async status(
    repo: WorkspaceRepo,
    opts: { includeUntracked?: boolean; includeIgnored?: boolean; paths?: string[] } = {}
  ): Promise<GitStatusResult> {
    workspaceRepo(repo);
    opts.paths?.forEach(validateGitPath);
    return parseStatus(
      await this.#request('git_status', {
        environment_id: this.#environment,
        repo,
        ...(opts.includeUntracked === undefined ? {} : { include_untracked: opts.includeUntracked }),
        ...(opts.includeIgnored === undefined ? {} : { include_ignored: opts.includeIgnored }),
        ...(opts.paths === undefined ? {} : { paths: opts.paths }),
      }),
      this.#environment,
      repo
    );
  }

  async diff(
    repo: WorkspaceRepo,
    opts: { mode?: GitDiffMode; paths?: string[]; contextLines?: number; fromRev?: string; toRev?: string } = {}
  ): Promise<GitDiffResult> {
    workspaceRepo(repo);
    opts.paths?.forEach(validateGitPath);
    return parseDiff(
      await this.#request('git_diff', {
        environment_id: this.#environment,
        repo,
        ...(opts.mode === undefined ? {} : { mode: opts.mode }),
        ...(opts.paths === undefined ? {} : { paths: opts.paths }),
        ...(opts.contextLines === undefined ? {} : { context_lines: opts.contextLines }),
        ...(opts.fromRev === undefined ? {} : { from_rev: opts.fromRev }),
        ...(opts.toRev === undefined ? {} : { to_rev: opts.toRev }),
      }),
      this.#environment,
      repo
    );
  }

  async log(
    repo: WorkspaceRepo,
    opts: { rev?: string; maxCount?: number; skip?: number; paths?: string[] } = {}
  ): Promise<GitLogResult> {
    workspaceRepo(repo);
    opts.paths?.forEach(validateGitPath);
    const raw = await this.#request('git_log', {
      environment_id: this.#environment,
      repo,
      ...(opts.rev === undefined ? {} : { rev: opts.rev }),
      ...(opts.maxCount === undefined ? {} : { max_count: opts.maxCount }),
      ...(opts.skip === undefined ? {} : { skip: opts.skip }),
      ...(opts.paths === undefined ? {} : { paths: opts.paths }),
    });
    const item = resultBase(raw, this.#environment, repo, 'git_log result');
    return {
      environment_id: this.#environment,
      repo,
      commits: array(
        item.commits,
        (commit, label) => {
          const c = record(commit, label);
          return {
            oid: string(c.oid, `${label}.oid`),
            short_oid: string(c.short_oid, `${label}.short_oid`),
            parents: strings(c.parents, `${label}.parents`),
            author_name: string(c.author_name, `${label}.author_name`),
            author_email: string(c.author_email, `${label}.author_email`),
            authored_at: string(c.authored_at, `${label}.authored_at`),
            committer_name: string(c.committer_name, `${label}.committer_name`),
            committer_email: string(c.committer_email, `${label}.committer_email`),
            committed_at: string(c.committed_at, `${label}.committed_at`),
            refs: strings(c.refs, `${label}.refs`),
            subject: string(c.subject, `${label}.subject`),
            body: string(c.body, `${label}.body`),
          };
        },
        'git_log commits'
      ),
      max_count: number(item.max_count, 'git_log max_count'),
      truncated: boolean(item.truncated, 'git_log truncated'),
    };
  }

  async branches(repo: WorkspaceRepo, includeRemote?: boolean): Promise<GitListBranchesResult> {
    workspaceRepo(repo);
    const item = resultBase(
      await this.#request('git_list_branches', {
        environment_id: this.#environment,
        repo,
        ...(includeRemote === undefined ? {} : { include_remote: includeRemote }),
      }),
      this.#environment,
      repo,
      'git_list_branches result'
    );
    return {
      environment_id: this.#environment,
      repo,
      branches: array(
        item.branches,
        (branch, label) => {
          const b = record(branch, label);
          const category = string(b.category, `${label}.category`);
          if (category !== 'branch' && category !== 'worker') {
            throw new TypeError(`Invalid ${label}.category`);
          }
          return {
            ref: string(b.ref, `${label}.ref`),
            name: string(b.name, `${label}.name`),
            oid: string(b.oid, `${label}.oid`),
            remote: boolean(b.remote, `${label}.remote`),
            upstream: nullable(b.upstream, string, `${label}.upstream`),
            upstream_remote: nullable(b.upstream_remote, string, `${label}.upstream_remote`),
            current: boolean(b.current, `${label}.current`),
            worktree_path: nullable(b.worktree_path, string, `${label}.worktree_path`),
            category,
          };
        },
        'git branches'
      ),
    };
  }

  async worktrees(repo: WorkspaceRepo): Promise<GitListWorktreesResult> {
    workspaceRepo(repo);
    const item = resultBase(
      await this.#request('git_list_worktrees', { environment_id: this.#environment, repo }),
      this.#environment,
      repo,
      'git_list_worktrees result'
    );
    return {
      environment_id: this.#environment,
      repo,
      worktrees: array(
        item.worktrees,
        (worktree, label) => {
          const w = record(worktree, label);
          const category = string(w.category, `${label}.category`);
          if (category !== 'worktree' && category !== 'worker') {
            throw new TypeError(`Invalid ${label}.category`);
          }
          const reason = nullable(w.inaccessible_reason, string, `${label}.inaccessible_reason`);
          if (reason !== null && reason !== 'outside_workspace') {
            throw new TypeError(`Invalid ${label}.inaccessible_reason`);
          }
          return {
            path: string(w.path, `${label}.path`),
            head: nullable(w.head, string, `${label}.head`),
            branch: nullable(w.branch, string, `${label}.branch`),
            detached: boolean(w.detached, `${label}.detached`),
            bare: boolean(w.bare, `${label}.bare`),
            locked: boolean(w.locked, `${label}.locked`),
            lock_reason: nullable(w.lock_reason, string, `${label}.lock_reason`),
            prunable: boolean(w.prunable, `${label}.prunable`),
            repo: w.repo === null ? null : workspaceRepo(string(w.repo, `${label}.repo`)),
            accessible: boolean(w.accessible, `${label}.accessible`),
            inaccessible_reason: reason,
            category,
          };
        },
        'git worktrees'
      ),
    };
  }

  async conflicts(repo: WorkspaceRepo, paths?: string[]): Promise<GitConflictsResult> {
    workspaceRepo(repo);
    paths?.forEach(validateGitPath);
    const item = resultBase(
      await this.#request('git_conflicts', {
        environment_id: this.#environment,
        repo,
        ...(paths === undefined ? {} : { paths }),
      }),
      this.#environment,
      repo,
      'git_conflicts result'
    );
    const state = string(item.state, 'git_conflicts state') as GitStatusResult['state'];
    const states = new Set<GitStatusResult['state']>(['clean', 'merging', 'rebasing', 'cherry_picking', 'reverting']);
    if (!states.has(state)) {
      throw new TypeError('Invalid git_conflicts state');
    }
    return {
      environment_id: this.#environment,
      repo,
      state,
      conflicts: array(
        item.conflicts,
        (conflict, label) => {
          const c = record(conflict, label);
          const stagesRaw = record(c.stages, `${label}.stages`);
          const stages: GitConflict['stages'] = {};
          for (const name of ['base', 'ours', 'theirs'] as const) {
            if (stagesRaw[name] !== undefined) {
              const stage = record(stagesRaw[name], `${label}.stages.${name}`);
              stages[name] = {
                mode: string(stage.mode, `${label}.stages.${name}.mode`),
                oid: string(stage.oid, `${label}.stages.${name}.oid`),
                content: nullable(stage.content, string, `${label}.stages.${name}.content`),
                content_truncated: boolean(stage.content_truncated, `${label}.stages.${name}.content_truncated`),
              };
            }
          }
          return {
            path: gitPath(c.path, `${label}.path`),
            stages,
            regions: array(
              c.regions,
              (region, regionLabel) => {
                const r = record(region, regionLabel);
                return {
                  start_line: number(r.start_line, `${regionLabel}.start_line`),
                  end_line: number(r.end_line, `${regionLabel}.end_line`),
                  ours_label: string(r.ours_label, `${regionLabel}.ours_label`),
                  base_label: nullable(r.base_label, string, `${regionLabel}.base_label`),
                  theirs_label: string(r.theirs_label, `${regionLabel}.theirs_label`),
                  ours: strings(r.ours, `${regionLabel}.ours`),
                  base: r.base === null ? null : strings(r.base, `${regionLabel}.base`),
                  theirs: strings(r.theirs, `${regionLabel}.theirs`),
                };
              },
              `${label}.regions`
            ),
            regions_available: boolean(c.regions_available, `${label}.regions_available`),
          };
        },
        'git conflicts'
      ),
      content_truncated: boolean(item.content_truncated, 'git_conflicts content_truncated'),
    };
  }

  async stage(repo: WorkspaceRepo, selection: GitSelection): Promise<GitStageResult> {
    const raw = await this.#request(
      'git_stage',
      selectionParams(this.#environment, workspaceRepo(repo), selection) as unknown as GitParams<'git_stage'>
    );
    return this.#selectionResult(raw, repo, 'staged') as GitStageResult;
  }

  async unstage(repo: WorkspaceRepo, selection: GitFileSelection): Promise<GitUnstageResult> {
    const params = selectionParams(this.#environment, workspaceRepo(repo), selection);
    const raw = await this.#request('git_unstage', params as unknown as GitParams<'git_unstage'>);
    return this.#selectionResult(raw, repo, 'unstaged') as GitUnstageResult;
  }

  async discard(repo: WorkspaceRepo, selection: GitFileSelection): Promise<GitMutationOutcome<GitDiscardResult>> {
    return this.#mutation(
      'git_discard',
      repo,
      selectionParams(this.#environment, workspaceRepo(repo), selection),
      (raw) => this.#selectionResult(raw, repo, 'discarded') as GitDiscardResult
    );
  }

  async confirmDiscard(
    repo: WorkspaceRepo,
    selection: GitFileSelection,
    confirmation: GitConfirmation
  ): Promise<GitMutationOutcome<GitDiscardResult>> {
    return this.#confirm(
      'git_discard',
      repo,
      selectionParams(this.#environment, workspaceRepo(repo), selection),
      confirmation,
      (raw) => this.#selectionResult(raw, repo, 'discarded') as GitDiscardResult
    );
  }

  async commit(
    repo: WorkspaceRepo,
    message: string,
    opts: { amend?: boolean; allowEmpty?: boolean; author?: string } = {}
  ): Promise<GitMutationOutcome<GitCommitResult>> {
    if (!message) {
      throw new TypeError('Commit message must not be empty');
    }
    const params = {
      environment_id: this.#environment,
      repo: workspaceRepo(repo),
      message,
      ...(opts.amend === undefined ? {} : { amend: opts.amend }),
      ...(opts.allowEmpty === undefined ? {} : { allow_empty: opts.allowEmpty }),
      ...(opts.author === undefined ? {} : { author: opts.author }),
    };
    return this.#mutation('git_commit', repo, params, (raw) => this.#parseCommit(raw, repo));
  }

  async confirmCommit(
    repo: WorkspaceRepo,
    message: string,
    opts: { amend?: boolean; allowEmpty?: boolean; author?: string },
    confirmation: GitConfirmation
  ): Promise<GitMutationOutcome<GitCommitResult>> {
    const params = {
      environment_id: this.#environment,
      repo: workspaceRepo(repo),
      message,
      ...(opts.amend === undefined ? {} : { amend: opts.amend }),
      ...(opts.allowEmpty === undefined ? {} : { allow_empty: opts.allowEmpty }),
      ...(opts.author === undefined ? {} : { author: opts.author }),
    };
    return this.#confirm('git_commit', repo, params, confirmation, (raw) => this.#parseCommit(raw, repo));
  }

  async checkout(
    repo: WorkspaceRepo,
    branch: string,
    opts: { create?: boolean; startPoint?: string; detach?: boolean; discardChanges?: boolean } = {}
  ): Promise<GitMutationOutcome<GitStatusResult>> {
    if (!branch) {
      throw new TypeError('Checkout branch must not be empty');
    }
    const params = this.#checkoutParams(repo, branch, opts);
    return this.#mutation('git_checkout', repo, params, (raw) => parseStatus(raw, this.#environment, repo));
  }

  async confirmCheckout(
    repo: WorkspaceRepo,
    branch: string,
    opts: { create?: boolean; startPoint?: string; detach?: boolean; discardChanges?: boolean },
    confirmation: GitConfirmation
  ): Promise<GitMutationOutcome<GitStatusResult>> {
    return this.#confirm('git_checkout', repo, this.#checkoutParams(repo, branch, opts), confirmation, (raw) =>
      parseStatus(raw, this.#environment, repo)
    );
  }

  async reset(
    repo: WorkspaceRepo,
    opts: { mode?: GitResetMode; rev?: string; paths?: string[] } = {}
  ): Promise<GitMutationOutcome<GitStatusResult>> {
    opts.paths?.forEach(validateGitPath);
    const params = {
      environment_id: this.#environment,
      repo: workspaceRepo(repo),
      ...(opts.mode === undefined ? {} : { mode: opts.mode }),
      ...(opts.rev === undefined ? {} : { rev: opts.rev }),
      ...(opts.paths === undefined ? {} : { paths: opts.paths }),
    };
    return this.#mutation('git_reset', repo, params, (raw) => parseStatus(raw, this.#environment, repo));
  }

  async confirmReset(
    repo: WorkspaceRepo,
    opts: { mode?: GitResetMode; rev?: string; paths?: string[] },
    confirmation: GitConfirmation
  ): Promise<GitMutationOutcome<GitStatusResult>> {
    opts.paths?.forEach(validateGitPath);
    const params = {
      environment_id: this.#environment,
      repo: workspaceRepo(repo),
      ...(opts.mode === undefined ? {} : { mode: opts.mode }),
      ...(opts.rev === undefined ? {} : { rev: opts.rev }),
      ...(opts.paths === undefined ? {} : { paths: opts.paths }),
    };
    return this.#confirm('git_reset', repo, params, confirmation, (raw) => parseStatus(raw, this.#environment, repo));
  }

  async fetch(
    repo: WorkspaceRepo,
    opts: { remote?: string; refspec?: string; prune?: boolean } = {}
  ): Promise<GitFetchResult> {
    const raw = await this.#request('git_fetch', {
      environment_id: this.#environment,
      repo: workspaceRepo(repo),
      ...(opts.remote === undefined ? {} : { remote: opts.remote }),
      ...(opts.refspec === undefined ? {} : { refspec: opts.refspec }),
      ...(opts.prune === undefined ? {} : { prune: opts.prune }),
    });
    const item = resultBase(raw, this.#environment, repo, 'git_fetch result');
    return {
      environment_id: this.#environment,
      repo,
      remote: nullable(item.remote, string, 'fetch.remote'),
      updated_refs: array(
        item.updated_refs,
        (update, label) => {
          const u = record(update, label);
          const change = string(u.change, `${label}.change`);
          if (change !== 'created' && change !== 'updated' && change !== 'deleted') {
            throw new TypeError(`Invalid ${label}.change`);
          }
          return {
            ref: string(u.ref, `${label}.ref`),
            old_oid: nullable(u.old_oid, string, `${label}.old_oid`),
            new_oid: nullable(u.new_oid, string, `${label}.new_oid`),
            change,
          };
        },
        'fetch.updated_refs'
      ),
    };
  }

  async pull(
    repo: WorkspaceRepo,
    opts: { remote?: string; refspec?: string; rebase?: boolean } = {}
  ): Promise<GitPullResult> {
    const item = resultBase(
      await this.#request('git_pull', {
        environment_id: this.#environment,
        repo: workspaceRepo(repo),
        ...(opts.remote === undefined ? {} : { remote: opts.remote }),
        ...(opts.refspec === undefined ? {} : { refspec: opts.refspec }),
        ...(opts.rebase === undefined ? {} : { rebase: opts.rebase }),
      }),
      this.#environment,
      repo,
      'git_pull result'
    );
    const status = parseStatus(
      {
        ...item,
        entries: [],
        untracked: [],
        ignored: [],
        conflicted: item.conflicted,
        stash_count: 0,
        clean: false,
        upstream: null,
      },
      this.#environment,
      repo
    );
    return {
      environment_id: this.#environment,
      repo,
      ok: boolean(item.ok, 'pull.ok'),
      state: status.state,
      conflicted: strings(item.conflicted, 'pull.conflicted'),
      head: status.head,
    };
  }

  async push(
    repo: WorkspaceRepo,
    opts: { remote?: string; refspec?: string; force?: boolean; forceWithLease?: boolean; setUpstream?: boolean } = {}
  ): Promise<GitMutationOutcome<GitPushResult>> {
    return this.#mutation('git_push', repo, this.#pushParams(repo, opts), (raw) => this.#parsePush(raw, repo));
  }

  async confirmPush(
    repo: WorkspaceRepo,
    opts: { remote?: string; refspec?: string; force?: boolean; forceWithLease?: boolean; setUpstream?: boolean },
    confirmation: GitConfirmation
  ): Promise<GitMutationOutcome<GitPushResult>> {
    return this.#confirm('git_push', repo, this.#pushParams(repo, opts), confirmation, (raw) =>
      this.#parsePush(raw, repo)
    );
  }

  #checkoutParams(
    repo: WorkspaceRepo,
    branch: string,
    opts: { create?: boolean; startPoint?: string; detach?: boolean; discardChanges?: boolean }
  ) {
    if (!branch) {
      throw new TypeError('Checkout branch must not be empty');
    }
    return {
      environment_id: this.#environment,
      repo: workspaceRepo(repo),
      branch,
      ...(opts.create === undefined ? {} : { create: opts.create }),
      ...(opts.startPoint === undefined ? {} : { start_point: opts.startPoint }),
      ...(opts.detach === undefined ? {} : { detach: opts.detach }),
      ...(opts.discardChanges === undefined ? {} : { discard_changes: opts.discardChanges }),
    };
  }

  #pushParams(
    repo: WorkspaceRepo,
    opts: { remote?: string; refspec?: string; force?: boolean; forceWithLease?: boolean; setUpstream?: boolean }
  ) {
    return {
      environment_id: this.#environment,
      repo: workspaceRepo(repo),
      ...(opts.remote === undefined ? {} : { remote: opts.remote }),
      ...(opts.refspec === undefined ? {} : { refspec: opts.refspec }),
      ...(opts.force === undefined ? {} : { force: opts.force }),
      ...(opts.forceWithLease === undefined ? {} : { force_with_lease: opts.forceWithLease }),
      ...(opts.setUpstream === undefined ? {} : { set_upstream: opts.setUpstream }),
    };
  }

  #selectionResult(raw: unknown, repo: WorkspaceRepo, verb: 'staged' | 'unstaged' | 'discarded') {
    const item = resultBase(raw, this.#environment, repo, `git_${verb} result`);
    const parseRefs = (value: unknown, label: string) =>
      array(
        value,
        (ref, refLabel) => {
          const r = record(ref, refLabel);
          return { path: gitPath(r.path, `${refLabel}.path`), hunk_id: hunkId(r.hunk_id, `${refLabel}.hunk_id`) };
        },
        label
      );
    return {
      environment_id: this.#environment,
      repo,
      [`${verb}_paths`]: strings(item[`${verb}_paths`], `${verb}_paths`),
      [`${verb}_hunks`]: parseRefs(item[`${verb}_hunks`], `${verb}_hunks`),
    };
  }

  #parseCommit(raw: unknown, repo: WorkspaceRepo): GitCommitResult {
    const item = resultBase(raw, this.#environment, repo, 'git_commit result');
    return {
      environment_id: this.#environment,
      repo,
      oid: string(item.oid, 'commit.oid'),
      amended: boolean(item.amended, 'commit.amended'),
    };
  }

  #parsePush(raw: unknown, repo: WorkspaceRepo): GitPushResult {
    const item = resultBase(raw, this.#environment, repo, 'git_push result');
    return {
      environment_id: this.#environment,
      repo,
      ok: boolean(item.ok, 'push.ok'),
      remote_url: nullable(item.remote_url, string, 'push.remote_url'),
      updates: array(
        item.updates,
        (update, label) => {
          const u = record(update, label);
          const status = string(u.status, `${label}.status`) as GitPushUpdate['status'];
          const statuses = new Set<GitPushUpdate['status']>([
            'fast_forward',
            'forced_update',
            'deleted',
            'created',
            'rejected',
            'up_to_date',
            'unknown',
          ]);
          if (!statuses.has(status)) {
            throw new TypeError(`Invalid ${label}.status`);
          }
          return {
            flag: string(u.flag, `${label}.flag`),
            status,
            rejected: boolean(u.rejected, `${label}.rejected`),
            source_ref: string(u.source_ref, `${label}.source_ref`),
            target_ref: string(u.target_ref, `${label}.target_ref`),
            summary_raw: string(u.summary_raw, `${label}.summary_raw`),
            reason_raw: nullable(u.reason_raw, string, `${label}.reason_raw`),
          };
        },
        'push.updates'
      ),
      rejected: strings(item.rejected, 'push.rejected'),
    };
  }

  async #mutation<M extends GitMethod, T>(
    method: M,
    repo: WorkspaceRepo,
    params: Record<string, unknown>,
    parse: (raw: unknown) => T
  ): Promise<GitMutationOutcome<T>> {
    const binding = { method, repo, paramsKey: stableKey(params) };
    try {
      return { kind: 'completed', result: parse(await this.#request(method, params as unknown as GitParams<M>)) };
    } catch (error) {
      const confirmation = GitConfirmation.fromError(error, binding);
      if (!confirmation) {
        throw error;
      }
      return { kind: 'confirmation_required', confirmation };
    }
  }

  async #confirm<M extends GitMethod, T>(
    method: M,
    repo: WorkspaceRepo,
    params: Record<string, unknown>,
    confirmation: GitConfirmation,
    parse: (raw: unknown) => T
  ): Promise<GitMutationOutcome<T>> {
    const binding = { method, repo, paramsKey: stableKey(params) };
    const token = confirmation.claim(binding);
    try {
      return {
        kind: 'completed',
        result: parse(await this.#request(method, { ...params, confirmation_token: token } as unknown as GitParams<M>)),
      };
    } catch (error) {
      // A stale/expired token carries a fresh impact and token. Return that
      // challenge for another explicit user decision; never auto-loop.
      const next = GitConfirmation.fromError(error, binding);
      if (!next) {
        throw error;
      }
      return { kind: 'confirmation_required', confirmation: next };
    }
  }
}
