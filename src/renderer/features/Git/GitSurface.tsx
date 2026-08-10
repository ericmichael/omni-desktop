import { useStore } from '@nanostores/react';
import { PanelLeftIcon, RefreshCwIcon, TriangleAlert } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { profileRunsOnHost } from '@/lib/artifacts';
import { cn } from '@/renderer/ds/cn';
import { Alert, AlertDescription, AlertTitle } from '@/renderer/ds/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/renderer/ds/ui/alert-dialog';
import { Button } from '@/renderer/ds/ui/button';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/renderer/ds/ui/empty';
import { NativeSelect } from '@/renderer/ds/ui/native-select';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/renderer/ds/ui/resizable';
import { Spinner } from '@/renderer/ds/ui/spinner';
import { Toggle } from '@/renderer/ds/ui/toggle';
import { ToggleGroup, ToggleGroupItem } from '@/renderer/ds/ui/toggle-group';
import {
  GitClient,
  type GitDiffResult,
  type GitListRepositoriesResult,
  type GitRepository,
  type GitStatusResult,
  type WorkspaceRepo,
} from '@/renderer/omniagents-ui/rpc/git';
import { useRPCClient, useRPCConnected } from '@/renderer/omniagents-ui/rpc-context';
import { emitter } from '@/renderer/services/ipc';
import { persistedStoreApi } from '@/renderer/services/store';
import type { CodeTabId, ExecutionTarget, ProjectSource } from '@/shared/types';

import { mergeUntracked, repositoryLabel } from './diff-model';
import { GitDiffStream, type GitStreamMode } from './GitDiffStream';
import { GitSidebar } from './GitSidebar';
import { type GitRepositoryCapabilities, type GitSyncOptions, GitToolsPanel } from './GitToolsPanel';
import { describeConfirmation, useGitMutations } from './use-git-mutations';

export type GitSurfaceProps = {
  tabId?: CodeTabId;
  executionTarget: ExecutionTarget;
  sessionId?: string;
  workspaceRoot?: string;
  /** Single-mount scope: prefer the repository at this mount by default. */
  rootPrefix?: string;
  /** Whether this persistent surface is currently visible in the dock. */
  active?: boolean;
  onOpenFile?: (path: string, line?: number) => void;
};

type IdentitySelection<T> = { identityKey: string; value: T };
type RepositoryData = {
  key: string;
  status: GitStatusResult;
  diff: GitDiffResult;
};
type ApplyTarget = { source: Extract<ProjectSource, { kind: 'local' }>; localPath: string };

const GIT_READ_OPERATIONS = ['git_list_repositories', 'git_status', 'git_diff'] as const;
const SESSION_BASE_REF = 'refs/tags/omni/seed';

/** Below this surface width the sidebar defaults to hidden (the toggle
 *  still overrides) — sidecar columns are usually this narrow. */
const SIDEBAR_AUTO_HIDE_WIDTH = 576;

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function dataKey(identityKey: string, repo: WorkspaceRepo, mode: GitStreamMode): string {
  return JSON.stringify([identityKey, repo, mode]);
}

function normalizeFsPath(value: string): string {
  return value.replaceAll('\\', '/').replace(/\/+$/, '');
}

/** Match a typed Git repository to the project source that materialized it. */
export function sourceForRepository(sources: ProjectSource[], repository: GitRepository): ProjectSource | null {
  const absoluteRoot = normalizeFsPath(repository.absolute_root);
  const repo = repository.repo;
  const exact = sources.find((source) => {
    const containerRoot = source.mountName === '.' ? '/workspace' : `/workspace/${source.mountName}`;
    const hostRoot = source.kind === 'local' ? normalizeFsPath(source.workspaceDir) : null;
    return (
      absoluteRoot === containerRoot ||
      absoluteRoot.startsWith(`${containerRoot}/`) ||
      absoluteRoot === hostRoot ||
      (hostRoot !== null && absoluteRoot.startsWith(`${hostRoot}/`)) ||
      repo === source.mountName ||
      repo.startsWith(`${source.mountName}/`)
    );
  });
  if (exact) {
    return exact;
  }
  return repo === '.' && sources.length === 1 ? sources[0]! : null;
}

export const GitSurface = memo((props: GitSurfaceProps) => {
  const { tabId, executionTarget, sessionId, workspaceRoot, rootPrefix, active = true, onOpenFile } = props;
  const store = useStore(persistedStoreApi.$atom);
  const rpc = useRPCClient();
  const connected = useRPCConnected();
  const identityKey = sessionId && workspaceRoot ? JSON.stringify([sessionId, executionTarget, workspaceRoot]) : null;
  const gitClient = useMemo(() => new GitClient(rpc, executionTarget), [executionTarget, rpc]);
  const [preparedKey, setPreparedKey] = useState<string | null>(null);
  const [repositories, setRepositories] = useState<IdentitySelection<GitListRepositoriesResult> | null>(null);
  const [selectedRepository, setSelectedRepository] = useState<IdentitySelection<WorkspaceRepo> | null>(null);
  const [diffMode, setDiffMode] = useState<IdentitySelection<GitStreamMode> | null>(null);
  const [repositoryData, setRepositoryData] = useState<RepositoryData | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [collapsedPaths, setCollapsedPaths] = useState<ReadonlySet<string>>(new Set());
  const [toolsOpen, setToolsOpen] = useState(false);
  const [syncOptionsState, setSyncOptionsState] = useState<GitSyncOptions | null>(null);
  const [pendingApply, setPendingApply] = useState<ApplyTarget | null>(null);
  const [applyPending, setApplyPending] = useState(false);
  const [applyStatus, setApplyStatus] = useState<string | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [discoveryRevision, setDiscoveryRevision] = useState(0);
  const [refreshRevision, setRefreshRevision] = useState(0);
  const [detailsRevision, setDetailsRevision] = useState(0);

  const readSupported = GIT_READ_OPERATIONS.every((operation) => rpc.supportsExperimentalOperation(operation));
  const stageSupported = rpc.supportsExperimentalOperation('git_stage');
  const unstageSupported = rpc.supportsExperimentalOperation('git_unstage');
  const discardSupported = rpc.supportsExperimentalOperation('git_discard');
  const capabilities: GitRepositoryCapabilities = {
    commit: rpc.supportsExperimentalOperation('git_commit'),
    log: rpc.supportsExperimentalOperation('git_log'),
    branches: rpc.supportsExperimentalOperation('git_list_branches'),
    worktrees: rpc.supportsExperimentalOperation('git_list_worktrees'),
    conflicts: rpc.supportsExperimentalOperation('git_conflicts'),
    stage: stageSupported,
    checkout: rpc.supportsExperimentalOperation('git_checkout'),
    reset: rpc.supportsExperimentalOperation('git_reset'),
    fetch: rpc.supportsExperimentalOperation('git_fetch'),
    pull: rpc.supportsExperimentalOperation('git_pull'),
    push: rpc.supportsExperimentalOperation('git_push'),
    progress: rpc.supportsExperimentalOperation('git_operation_progress'),
  };
  const currentRepositories = repositories?.identityKey === identityKey ? repositories.value : null;
  const currentRepo = selectedRepository?.identityKey === identityKey ? selectedRepository.value : null;
  const currentMode = diffMode?.identityKey === identityKey ? diffMode.value : 'worktree';
  const currentRepository =
    currentRepositories?.repositories.find((repository) => repository.repo === currentRepo) ?? null;
  const currentTab = tabId ? store.codeTabs.find((tab) => tab.id === tabId) : undefined;
  const currentProject = currentTab?.projectId
    ? store.projects.find((project) => project.id === currentTab.projectId)
    : undefined;
  const activeSource =
    currentRepository && currentProject ? sourceForRepository(currentProject.sources, currentRepository) : null;
  const profileName = currentTab?.profileName ?? currentProject?.sandboxProfile ?? store.defaultProfileName ?? 'host';
  const currentApplyTarget: ApplyTarget | null =
    activeSource?.kind === 'local' && !activeSource.readOnly && !profileRunsOnHost(profileName)
      ? { source: activeSource, localPath: activeSource.workspaceDir }
      : null;
  const hasApplyTarget = currentApplyTarget !== null;
  const expectedDataKey = identityKey && currentRepo ? dataKey(identityKey, currentRepo, currentMode) : null;
  const currentData = repositoryData?.key === expectedDataKey ? repositoryData : null;

  const refresh = useCallback(() => setRefreshRevision((revision) => revision + 1), []);
  const retryDiscovery = useCallback(() => setDiscoveryRevision((revision) => revision + 1), []);
  const handleChanged = useCallback(() => {
    refresh();
    setDetailsRevision((revision) => revision + 1);
  }, [refresh]);

  const mutations = useGitMutations({
    client: gitClient,
    repo: currentRepo,
    subscribeProgress: capabilities.progress,
    onChanged: handleChanged,
  });

  // Sidebar visibility: explicit toggle wins; before the user chooses, it
  // follows the surface width (hidden in narrow sidecar columns).
  const rootRef = useRef<HTMLElement>(null);
  const [wide, setWide] = useState(true);
  const [sidebarPref, setSidebarPref] = useState<boolean | null>(null);
  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof ResizeObserver === 'undefined') {
      return;
    }
    const observer = new ResizeObserver((observations) => {
      const width = observations[0]?.contentRect.width ?? 0;
      setWide(width >= SIDEBAR_AUTO_HIDE_WIDTH);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const sidebarVisible = sidebarPref ?? wide;

  useEffect(() => {
    if (currentMode === 'session' && !hasApplyTarget) {
      setDiffMode(identityKey ? { identityKey, value: 'worktree' } : null);
    }
  }, [currentMode, hasApplyTarget, identityKey]);

  useEffect(() => {
    let alive = true;
    if (!active || !connected || !identityKey || !sessionId || !workspaceRoot) {
      return () => {
        alive = false;
      };
    }
    if (!readSupported) {
      setLoadError('This agent runtime does not support source control.');
      return () => {
        alive = false;
      };
    }
    setDiscovering(true);
    setLoadError(null);
    void gitClient
      .listRepositories()
      .then((result) => {
        if (!alive) {
          return;
        }
        setRepositories({ identityKey, value: result });
        setSelectedRepository((previous) => {
          const previousRepo = previous?.identityKey === identityKey ? previous.value : null;
          const available = previousRepo && result.repositories.some((candidate) => candidate.repo === previousRepo);
          const fallback =
            // A single-mount environment's own repository beats the
            // workspace-root fallback (the root is rarely a repo there).
            result.repositories.find((candidate) => candidate.repo === rootPrefix)?.repo ??
            result.repositories.find((candidate) => candidate.repo === '.')?.repo ??
            result.repositories[0]?.repo ??
            null;
          return available && previousRepo
            ? { identityKey, value: previousRepo }
            : fallback
              ? { identityKey, value: fallback }
              : null;
        });
        setDiffMode((previous) =>
          previous?.identityKey === identityKey ? previous : { identityKey, value: 'worktree' }
        );
        setPreparedKey(identityKey);
      })
      .catch((error: unknown) => {
        if (alive) {
          setLoadError(errorMessage(error, 'Could not discover repositories in this workspace.'));
        }
      })
      .finally(() => {
        if (alive) {
          setDiscovering(false);
        }
      });
    return () => {
      alive = false;
    };
  }, [
    active,
    connected,
    discoveryRevision,
    gitClient,
    identityKey,
    readSupported,
    rootPrefix,
    rpc,
    sessionId,
    workspaceRoot,
  ]);

  useEffect(() => {
    let alive = true;
    if (!active || !connected || !gitClient || !identityKey || !currentRepo || preparedKey !== identityKey) {
      return () => {
        alive = false;
      };
    }
    const key = dataKey(identityKey, currentRepo, currentMode);
    setLoading(true);
    setLoadError(null);
    void Promise.all([
      gitClient.status(currentRepo),
      gitClient.diff(
        currentRepo,
        currentMode === 'session'
          ? { mode: 'range', fromRev: SESSION_BASE_REF }
          : currentMode === 'staged'
            ? { mode: 'staged' }
            : { mode: 'worktree', includeUntracked: true }
      ),
    ])
      .then(([status, diff]) => {
        if (alive) {
          setRepositoryData({ key, status, diff });
        }
      })
      .catch((error: unknown) => {
        if (alive) {
          setLoadError(errorMessage(error, 'Could not load source control changes.'));
        }
      })
      .finally(() => {
        if (alive) {
          setLoading(false);
        }
      });
    return () => {
      alive = false;
    };
  }, [active, connected, currentMode, currentRepo, gitClient, identityKey, preparedKey, refreshRevision]);

  // Live refresh: the server polls porcelain status (git applies ignore
  // rules, so this stays bounded) and pushes a digest event; the surface
  // refetches quietly. Manual Refresh stays as the fallback for older
  // runtimes that lack the watch operations.
  const statusWatchSupported =
    rpc.supportsExperimentalOperation('git_status_watch') && rpc.supportsExperimentalOperation('git_status_unwatch');
  useEffect(() => {
    if (!active || !connected || !currentRepo || preparedKey !== identityKey || !statusWatchSupported) {
      return;
    }
    let alive = true;
    let watchId: string | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = gitClient.onStatusChanged((event) => {
      if (!alive || event.repo !== currentRepo) {
        return;
      }
      // Coalesce bursts (an agent mid-edit) into one refetch.
      if (timer !== null) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => {
        timer = null;
        refresh();
      }, 300);
    });
    void gitClient
      .statusWatch(currentRepo)
      .then((result) => {
        if (!alive) {
          void gitClient.statusUnwatch(result.watch_id).catch(() => {});
          return;
        }
        watchId = result.watch_id;
      })
      .catch(() => {
        // Watch budget exhausted or a race with teardown — the manual
        // Refresh button still works.
      });
    return () => {
      alive = false;
      unsubscribe();
      if (timer !== null) {
        clearTimeout(timer);
      }
      if (watchId !== null) {
        void gitClient.statusUnwatch(watchId).catch(() => {});
      }
    };
  }, [active, connected, currentRepo, gitClient, identityKey, preparedKey, refresh, statusWatchSupported]);

  const openRepositoryFile = useCallback(
    (path: string, line?: number) => {
      if (!onOpenFile) {
        return;
      }
      const workspacePath = currentRepo && currentRepo !== '.' ? `${currentRepo}/${path}` : path;
      onOpenFile(workspacePath, line);
    },
    [currentRepo, onOpenFile]
  );
  const chooseRepository = useCallback(
    (repo: WorkspaceRepo) => {
      if (!identityKey) {
        return;
      }
      setPendingApply(null);
      setApplyStatus(null);
      setApplyError(null);
      setCollapsedPaths(new Set());
      setSyncOptionsState(null);
      setSelectedRepository({ identityKey, value: repo });
    },
    [identityKey]
  );
  const chooseMode = useCallback(
    (mode: GitStreamMode) => {
      if (!identityKey) {
        return;
      }
      setCollapsedPaths(new Set());
      setDiffMode({ identityKey, value: mode });
    },
    [identityKey]
  );
  const setSectionOpen = useCallback((path: string, open: boolean) => {
    setCollapsedPaths((previous) => {
      const next = new Set(previous);
      if (open) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);
  // Sidebar rows are a table of contents: expand the file's section and
  // scroll it into view; the stream itself is never filtered.
  const bodyRef = useRef<HTMLDivElement>(null);
  const scrollToFile = useCallback((path: string) => {
    setCollapsedPaths((previous) => {
      if (!previous.has(path)) {
        return previous;
      }
      const next = new Set(previous);
      next.delete(path);
      return next;
    });
    bodyRef.current?.querySelector(`[data-diff-file="${CSS.escape(path)}"]`)?.scrollIntoView?.({ block: 'start' });
  }, []);

  const confirmApply = useCallback(async () => {
    const target = pendingApply;
    if (!tabId || !target) {
      return;
    }
    setApplyPending(true);
    setApplyError(null);
    setApplyStatus(null);
    try {
      const result = await emitter.invoke('project:apply-code-tab-source-changes', tabId, target.source.id);
      if (!result.ok) {
        setApplyError(result.error ?? 'Could not apply sandbox changes to the local folder.');
        return;
      }
      setPendingApply(null);
      setApplyStatus(`Applied sandbox changes to ${target.localPath}.`);
      refresh();
    } catch (error: unknown) {
      setApplyError(errorMessage(error, 'Could not apply sandbox changes to the local folder.'));
    } finally {
      setApplyPending(false);
    }
  }, [pendingApply, refresh, tabId]);

  const mergedEntries = useMemo(() => (currentData ? mergeUntracked(currentData.status) : []), [currentData]);
  const entriesByPath = useMemo(() => new Map(mergedEntries.map((entry) => [entry.path, entry])), [mergedEntries]);
  const actionsDisabled = mutations.busy !== null || !connected;
  const syncOptions: GitSyncOptions = syncOptionsState ?? {
    rebase: false,
    forceWithLease: false,
    setUpstream: currentData?.status.upstream === null,
  };
  const stats = currentData
    ? {
        files: currentData.diff.files.length,
        additions: currentData.diff.files.reduce((sum, file) => sum + (file.added_lines ?? 0), 0),
        deletions: currentData.diff.files.reduce((sum, file) => sum + (file.deleted_lines ?? 0), 0),
      }
    : null;
  const branch = currentData
    ? (currentData.status.head.branch ?? (currentData.status.head.unborn ? 'new repository' : 'detached HEAD'))
    : null;
  const upstream = currentData?.status.upstream ?? null;
  const hasTools =
    capabilities.log ||
    capabilities.branches ||
    capabilities.worktrees ||
    capabilities.conflicts ||
    capabilities.reset ||
    capabilities.pull ||
    capabilities.push;

  const pendingDescription = mutations.pending ? describeConfirmation(mutations.pending) : null;
  const conflictStatus = currentData?.status;
  const errorText = mutations.error ?? applyError ?? (currentData ? loadError : null);
  const noticeText = mutations.notice ?? applyStatus ?? mutations.progress;

  let body;
  if (!identityKey) {
    body = (
      <Empty className="h-full rounded-none border-0">
        <EmptyHeader>
          <EmptyTitle>Open an agent workspace</EmptyTitle>
          <EmptyDescription>Source control is available after a workspace is connected.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  } else if (!connected && !currentData) {
    body = (
      <Empty className="h-full rounded-none border-0" role="status">
        <EmptyHeader>
          <EmptyMedia>
            <Spinner />
          </EmptyMedia>
          <EmptyTitle>Connecting to source control…</EmptyTitle>
        </EmptyHeader>
      </Empty>
    );
  } else if (loadError && !currentData) {
    body = (
      <Empty className="h-full rounded-none border-0" role="alert">
        <EmptyHeader>
          <EmptyTitle>Source control unavailable</EmptyTitle>
          <EmptyDescription>{loadError}</EmptyDescription>
        </EmptyHeader>
        {connected && (
          <EmptyContent>
            <Button onClick={preparedKey === identityKey ? refresh : retryDiscovery}>Retry</Button>
          </EmptyContent>
        )}
      </Empty>
    );
  } else if (preparedKey !== identityKey || !currentRepositories) {
    body = (
      <Empty className="h-full rounded-none border-0" role="status">
        <EmptyHeader>
          <EmptyMedia>
            <Spinner />
          </EmptyMedia>
          <EmptyTitle>Discovering repositories…</EmptyTitle>
        </EmptyHeader>
      </Empty>
    );
  } else if (currentRepositories.repositories.length === 0) {
    body = (
      <Empty className="h-full rounded-none border-0" role="status">
        <EmptyHeader>
          <EmptyTitle>No repositories found</EmptyTitle>
          <EmptyDescription>
            {currentRepositories.unreachable_sources.length > 0
              ? 'Configured Git sources were not materialized in this environment. Check the selected workspace and profile.'
              : 'No Git repositories were found in this workspace.'}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  } else if (!currentData) {
    body = (
      <Empty className="h-full rounded-none border-0" role="status">
        <EmptyHeader>
          <EmptyMedia>
            <Spinner />
          </EmptyMedia>
          <EmptyTitle>Loading source control…</EmptyTitle>
        </EmptyHeader>
      </Empty>
    );
  } else {
    body = (
      <ResizablePanelGroup orientation="horizontal" className="h-full">
        {sidebarVisible && (
          <>
            <ResizablePanel id="git-files" defaultSize={240} minSize={180} maxSize={420}>
              <GitSidebar
                key={`${identityKey}:${currentRepo}`}
                status={currentData.status}
                entries={mergedEntries}
                contextLines={currentData.diff.context_lines}
                canCommit={capabilities.commit}
                canStage={stageSupported}
                canUnstage={unstageSupported}
                disabled={!connected}
                mutations={mutations}
                onSelectFile={scrollToFile}
              />
            </ResizablePanel>
            <ResizableHandle />
          </>
        )}
        <ResizablePanel id="git-diff" minSize={240}>
          <div ref={bodyRef} className="h-full overflow-auto">
            {currentData.diff.context_lines_clamped ? (
              <p className="border-b border-border px-3 py-1.5 text-xs text-muted-foreground" role="note">
                Diff context was limited to {currentData.diff.context_lines} lines.
              </p>
            ) : null}
            <GitDiffStream
              files={currentData.diff.files}
              entriesByPath={entriesByPath}
              conflicted={currentData.status.conflicted}
              mode={currentMode}
              contextLines={currentData.diff.context_lines}
              collapsedPaths={collapsedPaths}
              onSectionOpenChange={setSectionOpen}
              onOpenFile={onOpenFile ? openRepositoryFile : undefined}
              onStage={stageSupported ? (selection) => void mutations.stage(selection) : undefined}
              onUnstage={unstageSupported ? (selection) => void mutations.unstage(selection) : undefined}
              onDiscard={discardSupported ? (selection) => void mutations.discard(selection) : undefined}
              actionsDisabled={actionsDisabled}
            />
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
    );
  }

  return (
    <section
      ref={rootRef}
      className="flex h-full w-full min-w-0 min-h-0 flex-col bg-card text-foreground"
      aria-label="Source control"
    >
      <div className="flex min-h-9 shrink-0 flex-wrap items-center gap-1 border-b border-border px-2 py-1">
        <Toggle
          size="sm"
          className="h-7 min-w-7 px-1"
          pressed={sidebarVisible}
          onPressedChange={(pressed) => setSidebarPref(pressed)}
          title={sidebarVisible ? 'Hide changes list' : 'Show changes list'}
          aria-label={sidebarVisible ? 'Hide changes list' : 'Show changes list'}
        >
          <PanelLeftIcon className="size-4" />
        </Toggle>
        {currentRepositories && currentRepositories.repositories.length > 1 ? (
          <NativeSelect
            aria-label="Repository"
            className="h-7 w-auto max-w-56 border-0 bg-transparent text-xs shadow-none"
            disabled={!connected}
            onChange={(event) => chooseRepository(event.target.value as WorkspaceRepo)}
            value={currentRepo ?? ''}
          >
            {!currentRepo && <option value="">No repository</option>}
            {currentRepositories.repositories.map((repository) => (
              <option key={repository.repo} value={repository.repo}>
                {repositoryLabel(repository)}
              </option>
            ))}
          </NativeSelect>
        ) : null}
        <ToggleGroup
          type="single"
          spacing={0}
          value={currentMode}
          onValueChange={(value) => value && chooseMode(value as GitStreamMode)}
          className="flex items-center"
          aria-label="Diff view"
        >
          <ToggleGroupItem value="worktree" className="h-7 px-2 text-xs">
            Working tree
          </ToggleGroupItem>
          <ToggleGroupItem value="staged" className="h-7 px-2 text-xs">
            Staged
          </ToggleGroupItem>
          {hasApplyTarget && (
            <ToggleGroupItem value="session" className="h-7 px-2 text-xs">
              Session changes
            </ToggleGroupItem>
          )}
        </ToggleGroup>
        <span className="flex-auto" />
        {mutations.busy ? <span className="text-xs text-muted-foreground">{mutations.busy}…</span> : null}
        {stats && branch ? (
          <span className="whitespace-nowrap text-xs text-muted-foreground">
            {branch} · {stats.files} {stats.files === 1 ? 'file' : 'files'}{' '}
            <span className="text-success">+{stats.additions}</span>{' '}
            <span className="text-destructive">−{stats.deletions}</span>
            {upstream ? (
              <span title={`${upstream.ahead} ahead, ${upstream.behind} behind ${upstream.name}`}>
                {' '}
                ↑{upstream.ahead} ↓{upstream.behind}
              </span>
            ) : null}
          </span>
        ) : null}
        {currentRepo && capabilities.fetch ? (
          <Button
            variant="ghost"
            size="xs"
            className="h-7"
            disabled={actionsDisabled}
            onClick={() => void mutations.fetchRemote()}
          >
            Fetch
          </Button>
        ) : null}
        {currentRepo && capabilities.pull ? (
          <Button
            variant="ghost"
            size="xs"
            className="h-7"
            disabled={actionsDisabled}
            onClick={() => void mutations.pull({ rebase: syncOptions.rebase })}
          >
            Pull
          </Button>
        ) : null}
        {currentRepo && capabilities.push ? (
          <Button
            variant="ghost"
            size="xs"
            className="h-7"
            disabled={actionsDisabled}
            onClick={() =>
              void mutations.push({
                ...(syncOptions.forceWithLease ? { forceWithLease: true } : {}),
                ...(syncOptions.setUpstream ? { setUpstream: true } : {}),
              })
            }
          >
            Push
          </Button>
        ) : null}
        {currentRepo && hasTools ? (
          <Toggle
            size="sm"
            className="h-7 px-2 text-xs"
            pressed={toolsOpen}
            onPressedChange={setToolsOpen}
            aria-label="Repository tools"
          >
            Tools
          </Toggle>
        ) : null}
        {currentApplyTarget && (
          <Button
            disabled={!connected || applyPending}
            onClick={() => setPendingApply(currentApplyTarget)}
            size="sm"
            className="h-7"
          >
            {applyPending ? 'Applying…' : 'Apply to local folder'}
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          className="size-7"
          aria-label="Refresh source control"
          disabled={!connected || loading}
          onClick={refresh}
        >
          <RefreshCwIcon className={cn('size-4', (loading || discovering) && 'animate-spin')} />
        </Button>
      </div>
      {!connected && (
        <Alert className="shrink-0 rounded-none border-x-0 border-t-0" role="status">
          <AlertDescription>Reconnecting to source control… The selected repository is preserved.</AlertDescription>
        </Alert>
      )}
      {currentRepositories && currentRepositories.unreachable_sources.length > 0 && (
        <Alert
          className="shrink-0 rounded-none border-x-0 border-t-0 border-warning bg-warning text-warning-foreground"
          role="note"
        >
          <TriangleAlert />
          <AlertTitle>Git sources unavailable</AlertTitle>
          <AlertDescription className="text-warning-foreground">
            Git source{currentRepositories.unreachable_sources.length === 1 ? '' : 's'}{' '}
            {currentRepositories.unreachable_sources
              .map((source) => source.mount_name ?? source.repo_url ?? source.path ?? 'unnamed')
              .join(', ')}{' '}
            {currentRepositories.unreachable_sources.length === 1 ? 'was' : 'were'} not materialized in this environment
            and cannot be opened.
          </AlertDescription>
        </Alert>
      )}
      {currentRepositories?.truncated && (
        <Alert className="shrink-0 rounded-none border-x-0 border-t-0" role="note">
          <AlertDescription>
            Repository discovery reached its limit. Some nested repositories may not be shown.
          </AlertDescription>
        </Alert>
      )}
      {conflictStatus && (conflictStatus.state !== 'clean' || conflictStatus.conflicted.length > 0) && (
        <Alert className="shrink-0 rounded-none border-x-0 border-t-0 border-warning bg-warning text-warning-foreground">
          <TriangleAlert />
          <AlertTitle>Repository needs attention</AlertTitle>
          <AlertDescription className="text-warning-foreground">
            {conflictStatus.state === 'clean'
              ? 'Repository has unresolved conflicts'
              : `Repository is ${conflictStatus.state.replaceAll('_', ' ')}`}
            {conflictStatus.conflicted.length > 0 ? ` with conflicts in ${conflictStatus.conflicted.join(', ')}` : ''}.
          </AlertDescription>
        </Alert>
      )}
      {errorText && (
        <Alert className="shrink-0 rounded-none border-x-0 border-t-0" variant="destructive">
          <AlertDescription>{errorText}</AlertDescription>
        </Alert>
      )}
      {noticeText && !errorText && (
        <Alert className="shrink-0 rounded-none border-x-0 border-t-0" role="status">
          <AlertDescription>{noticeText}</AlertDescription>
        </Alert>
      )}
      {toolsOpen && currentRepo && currentData ? (
        <GitToolsPanel
          client={gitClient}
          repo={currentRepo}
          capabilities={capabilities}
          disabled={!connected}
          mutations={mutations}
          revision={detailsRevision}
          syncOptions={syncOptions}
          onSyncOptionsChange={setSyncOptionsState}
          onOpenFile={onOpenFile ? openRepositoryFile : undefined}
        />
      ) : null}
      <div className="min-h-0 min-w-0 flex-auto overflow-hidden">{body}</div>

      <AlertDialog open={mutations.pending !== null} onOpenChange={(open) => !open && mutations.dismissPending()}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{pendingDescription?.title ?? ''}</AlertDialogTitle>
            <AlertDialogDescription>{pendingDescription?.body ?? ''}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant={pendingDescription?.destructive ? 'destructive' : undefined}
              onClick={mutations.confirm}
            >
              {pendingDescription?.action ?? 'Confirm'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={pendingApply !== null} onOpenChange={(open) => !open && setPendingApply(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Apply sandbox changes to the local folder?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingApply
                ? `Copy every changed and untracked file from the sandbox source “${pendingApply.source.mountName}” to ${pendingApply.localPath}. Local files deleted in the sandbox will be removed; unrelated local files are left untouched.`
                : ''}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void confirmApply()}>Apply changes</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
});
GitSurface.displayName = 'GitSurface';

/** Portal rendered inside the column's existing RPC provider. */
export function WorkspaceGitPortal({
  host,
  active,
  tabId,
  executionTarget,
  sessionId,
  workspaceRoot,
  rootPrefix,
  onOpenFile,
}: GitSurfaceProps & { host: HTMLDivElement }) {
  return createPortal(
    <GitSurface
      active={active}
      tabId={tabId}
      executionTarget={executionTarget}
      sessionId={sessionId}
      workspaceRoot={workspaceRoot}
      rootPrefix={rootPrefix}
      onOpenFile={onOpenFile}
    />,
    host
  );
}
