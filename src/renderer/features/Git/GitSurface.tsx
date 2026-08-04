import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { Warning20Regular } from '@fluentui/react-icons';
import { useStore } from '@nanostores/react';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';

import { profileRunsOnHost } from '@/lib/artifacts';
import { Button, ConfirmDialog, Select, Spinner } from '@/renderer/ds';
import {
  GitClient,
  type GitConfirmation,
  type GitDiffResult,
  type GitFileSelection,
  type GitListRepositoriesResult,
  type GitRepository,
  type GitSelection,
  type GitStatusResult,
  type WorkspaceRepo,
} from '@/renderer/omniagents-ui/rpc/git';
import { useRPCClient, useRPCConnected } from '@/renderer/omniagents-ui/rpc-context';
import { emitter } from '@/renderer/services/ipc';
import { persistedStoreApi } from '@/renderer/services/store';
import type { CodeTabId, ProjectSource } from '@/shared/types';

import { GitStatusDiffView } from './GitStatusDiffView';

export type GitSurfaceProps = {
  tabId?: CodeTabId;
  environmentId: string;
  sessionId?: string;
  workspaceRoot?: string;
  isGlass?: boolean;
  /** Whether this persistent surface is currently visible in the dock. */
  active?: boolean;
  onOpenFile?: (path: string, line?: number) => void;
};

type GitViewMode = 'session' | 'worktree' | 'staged';
type IdentitySelection<T> = { identityKey: string; value: T };
type RepositoryData = {
  key: string;
  status: GitStatusResult;
  diff: GitDiffResult;
};
type PendingDiscard = {
  repo: WorkspaceRepo;
  selection: GitFileSelection;
  confirmation: GitConfirmation;
};
type ApplyTarget = { source: Extract<ProjectSource, { kind: 'local' }>; localPath: string };

const GIT_READ_OPERATIONS = ['git_list_repositories', 'git_status', 'git_diff'] as const;
const SESSION_BASE_REF = 'refs/tags/omni/seed';

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    width: '100%',
    height: '100%',
    minWidth: 0,
    minHeight: 0,
    color: tokens.colorNeutralForeground1,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  rootGlass: { backgroundColor: 'transparent' },
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: tokens.spacingHorizontalS,
    minHeight: '44px',
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalM}`,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  repositoryLabel: {
    display: 'flex',
    alignItems: 'center',
    minWidth: 0,
    gap: tokens.spacingHorizontalXS,
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground2,
  },
  repositorySelect: { minWidth: '12rem', maxWidth: '24rem' },
  viewControls: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXXS },
  toolbarSpacer: { flex: '1 1 auto' },
  banner: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    color: tokens.colorNeutralForeground2,
    backgroundColor: tokens.colorNeutralBackground2,
    fontSize: tokens.fontSizeBase200,
  },
  warning: {
    color: tokens.colorPaletteDarkOrangeForeground1,
    backgroundColor: tokens.colorPaletteDarkOrangeBackground1,
  },
  error: {
    color: tokens.colorPaletteRedForeground1,
    backgroundColor: tokens.colorPaletteRedBackground1,
  },
  centered: {
    display: 'flex',
    flex: '1 1 auto',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: tokens.spacingVerticalM,
    minHeight: 0,
    padding: tokens.spacingVerticalXXL,
    textAlign: 'center',
    color: tokens.colorNeutralForeground3,
  },
  content: { flex: '1 1 auto', minWidth: 0, minHeight: 0, overflow: 'hidden' },
});

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function repositoryLabel(repository: GitRepository): string {
  const branch = repository.branch ?? (repository.detached ? 'detached' : 'new repository');
  return `${repository.repo} — ${branch}`;
}

function impactDescription(confirmation: GitConfirmation): string {
  const details = Object.entries(confirmation.impact)
    .map(([label, value]) => {
      const rendered = Array.isArray(value) ? value.join(', ') : String(value);
      return `${label.replaceAll('_', ' ')}: ${rendered}`;
    })
    .join('. ');
  return `Discarding changes cannot be undone.${details ? ` ${details}.` : ''}`;
}

function dataKey(identityKey: string, repo: WorkspaceRepo, mode: GitViewMode, path: string | null): string {
  return JSON.stringify([identityKey, repo, mode, path]);
}

function normalizeFsPath(value: string): string {
  return value.replaceAll('\\', '/').replace(/\/+$/, '');
}

/** Match a typed Git repository to the project source that materialized it. */
export function sourceForRepository(sources: ProjectSource[], repository: GitRepository): ProjectSource | null {
  const absoluteRoot = normalizeFsPath(repository.absolute_root);
  const repo = repository.repo;
  const exact = sources.find((source) => {
    const containerRoot = `/workspace/${source.mountName}`;
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
  const { tabId, environmentId, sessionId, workspaceRoot, isGlass, active = true, onOpenFile } = props;
  const styles = useStyles();
  const store = useStore(persistedStoreApi.$atom);
  const rpc = useRPCClient();
  const connected = useRPCConnected();
  const identityKey = sessionId && workspaceRoot ? JSON.stringify([sessionId, environmentId, workspaceRoot]) : null;
  const gitClient = useMemo(() => new GitClient(rpc, environmentId), [environmentId, rpc]);
  const [preparedKey, setPreparedKey] = useState<string | null>(null);
  const [repositories, setRepositories] = useState<IdentitySelection<GitListRepositoriesResult> | null>(null);
  const [selectedRepository, setSelectedRepository] = useState<IdentitySelection<WorkspaceRepo> | null>(null);
  const [diffMode, setDiffMode] = useState<IdentitySelection<GitViewMode> | null>(null);
  const [selectedPath, setSelectedPath] = useState<(IdentitySelection<string> & { repo: WorkspaceRepo }) | null>(null);
  const [repositoryData, setRepositoryData] = useState<RepositoryData | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [mutationPending, setMutationPending] = useState(false);
  const [pendingDiscard, setPendingDiscard] = useState<PendingDiscard | null>(null);
  const [pendingApply, setPendingApply] = useState<ApplyTarget | null>(null);
  const [applyPending, setApplyPending] = useState(false);
  const [applyStatus, setApplyStatus] = useState<string | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [discoveryRevision, setDiscoveryRevision] = useState(0);
  const [refreshRevision, setRefreshRevision] = useState(0);

  const readSupported = GIT_READ_OPERATIONS.every((operation) => rpc.supportsExperimentalOperation(operation));
  const stageSupported = rpc.supportsExperimentalOperation('git_stage');
  const unstageSupported = rpc.supportsExperimentalOperation('git_unstage');
  const discardSupported = rpc.supportsExperimentalOperation('git_discard');
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
  const currentPath =
    selectedPath?.identityKey === identityKey && selectedPath.repo === currentRepo ? selectedPath.value : null;
  const expectedDataKey =
    identityKey && currentRepo ? dataKey(identityKey, currentRepo, currentMode, currentPath) : null;
  const currentData = repositoryData?.key === expectedDataKey ? repositoryData : null;

  useEffect(() => {
    if (currentMode === 'session' && !hasApplyTarget) {
      setSelectedPath(null);
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
  }, [active, connected, discoveryRevision, gitClient, identityKey, readSupported, rpc, sessionId, workspaceRoot]);

  useEffect(() => {
    let alive = true;
    if (!active || !connected || !gitClient || !identityKey || !currentRepo || preparedKey !== identityKey) {
      return () => {
        alive = false;
      };
    }
    const key = dataKey(identityKey, currentRepo, currentMode, currentPath);
    setLoading(true);
    setLoadError(null);
    void Promise.all([
      gitClient.status(currentRepo),
      gitClient.diff(currentRepo, {
        ...(currentMode === 'session' ? { mode: 'range' as const, fromRev: SESSION_BASE_REF } : { mode: currentMode }),
        ...(currentPath ? { paths: [currentPath] } : {}),
      }),
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
  }, [active, connected, currentMode, currentPath, currentRepo, gitClient, identityKey, preparedKey, refreshRevision]);

  const refresh = useCallback(() => setRefreshRevision((revision) => revision + 1), []);
  const retryDiscovery = useCallback(() => setDiscoveryRevision((revision) => revision + 1), []);
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
      setPendingDiscard(null);
      setPendingApply(null);
      setApplyStatus(null);
      setApplyError(null);
      setSelectedPath(null);
      setSelectedRepository({ identityKey, value: repo });
    },
    [identityKey]
  );
  const chooseMode = useCallback(
    (mode: GitViewMode) => {
      if (!identityKey) {
        return;
      }
      setPendingDiscard(null);
      setSelectedPath(null);
      setDiffMode({ identityKey, value: mode });
    },
    [identityKey]
  );
  const choosePath = useCallback(
    (path: string) => {
      if (!identityKey || !currentRepo) {
        return;
      }
      setSelectedPath({ identityKey, repo: currentRepo, value: path });
    },
    [currentRepo, identityKey]
  );

  const stage = useCallback(
    async (selection: GitSelection) => {
      if (!gitClient || !currentRepo) {
        return;
      }
      setMutationPending(true);
      setOperationError(null);
      try {
        await gitClient.stage(currentRepo, selection);
        refresh();
      } catch (error: unknown) {
        setOperationError(errorMessage(error, 'Could not stage the selected changes.'));
      } finally {
        setMutationPending(false);
      }
    },
    [currentRepo, gitClient, refresh]
  );
  const unstage = useCallback(
    async (selection: GitFileSelection) => {
      if (!gitClient || !currentRepo) {
        return;
      }
      setMutationPending(true);
      setOperationError(null);
      try {
        await gitClient.unstage(currentRepo, selection);
        refresh();
      } catch (error: unknown) {
        setOperationError(errorMessage(error, 'Could not unstage the selected changes.'));
      } finally {
        setMutationPending(false);
      }
    },
    [currentRepo, gitClient, refresh]
  );
  const requestDiscard = useCallback(
    async (selection: GitFileSelection) => {
      if (!gitClient || !currentRepo) {
        return;
      }
      setMutationPending(true);
      setOperationError(null);
      try {
        const outcome = await gitClient.discard(currentRepo, selection);
        if (outcome.kind === 'confirmation_required') {
          setPendingDiscard({ repo: currentRepo, selection, confirmation: outcome.confirmation });
        } else {
          refresh();
        }
      } catch (error: unknown) {
        setOperationError(errorMessage(error, 'Could not prepare the discard operation.'));
      } finally {
        setMutationPending(false);
      }
    },
    [currentRepo, gitClient, refresh]
  );
  const confirmDiscard = useCallback(async () => {
    const pending = pendingDiscard;
    if (!gitClient || !pending) {
      return;
    }
    setMutationPending(true);
    setOperationError(null);
    try {
      const outcome = await gitClient.confirmDiscard(pending.repo, pending.selection, pending.confirmation);
      if (outcome.kind === 'confirmation_required') {
        setPendingDiscard({ ...pending, confirmation: outcome.confirmation });
      } else {
        setPendingDiscard(null);
        refresh();
      }
    } catch (error: unknown) {
      setPendingDiscard(null);
      setOperationError(errorMessage(error, 'Could not discard the selected changes.'));
    } finally {
      setMutationPending(false);
    }
  }, [gitClient, pendingDiscard, refresh]);

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

  let body;
  if (!identityKey) {
    body = <div className={styles.centered}>Open an agent workspace to use source control.</div>;
  } else if (!connected && !currentData) {
    body = (
      <div className={styles.centered} role="status">
        <Spinner size="md" />
        Connecting to source control…
      </div>
    );
  } else if (loadError && !currentData) {
    body = (
      <div className={styles.centered} role="alert">
        <span>{loadError}</span>
        {connected && <Button onClick={preparedKey === identityKey ? refresh : retryDiscovery}>Retry</Button>}
      </div>
    );
  } else if (preparedKey !== identityKey || !currentRepositories) {
    body = (
      <div className={styles.centered} role="status">
        <Spinner size="md" />
        Discovering repositories…
      </div>
    );
  } else if (currentRepositories.repositories.length === 0) {
    body = (
      <div className={styles.centered} role="status">
        {currentRepositories.unreachable_sources.length > 0
          ? 'Configured Git sources were not materialized in this environment. Check the selected workspace and profile.'
          : 'No Git repositories were found in this workspace.'}
      </div>
    );
  } else if (!currentData) {
    body = (
      <div className={styles.centered} role="status">
        <Spinner size="md" />
        Loading source control…
      </div>
    );
  } else {
    body = (
      <GitStatusDiffView
        actionsDisabled={mutationPending || !connected}
        diff={currentData.diff}
        diffHeading={currentMode === 'session' ? 'Session changes' : undefined}
        isGlass={isGlass}
        onDiscard={discardSupported ? requestDiscard : undefined}
        onOpenFile={onOpenFile ? openRepositoryFile : undefined}
        onSelectFile={choosePath}
        onStage={stageSupported ? stage : undefined}
        onUnstage={unstageSupported ? unstage : undefined}
        selectedPath={currentPath}
        status={currentData.status}
      />
    );
  }

  const conflictStatus = currentData?.status;
  return (
    <section className={mergeClasses(styles.root, isGlass && styles.rootGlass)} aria-label="Source control">
      <div className={styles.toolbar}>
        <label className={styles.repositoryLabel}>
          Repository
          <Select
            aria-label="Repository"
            className={styles.repositorySelect}
            disabled={!connected || !currentRepositories?.repositories.length}
            onChange={(event) => chooseRepository(event.target.value as WorkspaceRepo)}
            size="sm"
            value={currentRepo ?? ''}
          >
            {!currentRepo && <option value="">No repository</option>}
            {currentRepositories?.repositories.map((repository) => (
              <option key={repository.repo} value={repository.repo}>
                {repositoryLabel(repository)}
              </option>
            ))}
          </Select>
        </label>
        <div className={styles.viewControls} aria-label="Diff view">
          {currentApplyTarget && (
            <Button
              aria-pressed={currentMode === 'session'}
              onClick={() => chooseMode('session')}
              size="sm"
              variant={currentMode === 'session' ? 'primary' : 'ghost'}
            >
              Session changes
            </Button>
          )}
          <Button
            aria-pressed={currentMode === 'worktree'}
            onClick={() => chooseMode('worktree')}
            size="sm"
            variant={currentMode === 'worktree' ? 'primary' : 'ghost'}
          >
            Working tree
          </Button>
          <Button
            aria-pressed={currentMode === 'staged'}
            onClick={() => chooseMode('staged')}
            size="sm"
            variant={currentMode === 'staged' ? 'primary' : 'ghost'}
          >
            Staged
          </Button>
          {currentPath && (
            <Button size="sm" variant="ghost" onClick={() => setSelectedPath(null)}>
              All changes
            </Button>
          )}
        </div>
        <span className={styles.toolbarSpacer} />
        {currentApplyTarget && (
          <Button
            isDisabled={!connected || applyPending}
            onClick={() => setPendingApply(currentApplyTarget)}
            size="sm"
            variant="primary"
          >
            {applyPending ? 'Applying…' : 'Apply to local folder'}
          </Button>
        )}
        <Button aria-label="Refresh source control" isDisabled={!connected || loading} onClick={refresh} size="sm">
          Refresh
        </Button>
      </div>
      {!connected && (
        <div className={styles.banner} role="status">
          Reconnecting to source control… The selected repository is preserved.
        </div>
      )}
      {connected && discovering && currentRepositories && (
        <div className={styles.banner} role="status">
          Refreshing repositories…
        </div>
      )}
      {connected && loading && currentData && (
        <div className={styles.banner} role="status">
          Refreshing source control…
        </div>
      )}
      {currentRepositories && currentRepositories.unreachable_sources.length > 0 && (
        <div className={mergeClasses(styles.banner, styles.warning)} role="note">
          <Warning20Regular />
          Git source{currentRepositories.unreachable_sources.length === 1 ? '' : 's'}{' '}
          {currentRepositories.unreachable_sources
            .map((source) => source.mount_name ?? source.repo_url ?? source.path ?? 'unnamed')
            .join(', ')}{' '}
          {currentRepositories.unreachable_sources.length === 1 ? 'was' : 'were'} not materialized in this environment
          and cannot be opened.
        </div>
      )}
      {currentRepositories?.truncated && (
        <div className={styles.banner} role="note">
          Repository discovery reached its limit. Some nested repositories may not be shown.
        </div>
      )}
      {conflictStatus && (conflictStatus.state !== 'clean' || conflictStatus.conflicted.length > 0) && (
        <div className={mergeClasses(styles.banner, styles.warning)} role="alert">
          <Warning20Regular />
          {conflictStatus.state === 'clean'
            ? 'Repository has unresolved conflicts'
            : `Repository is ${conflictStatus.state.replaceAll('_', ' ')}`}
          {conflictStatus.conflicted.length > 0 ? ` with conflicts in ${conflictStatus.conflicted.join(', ')}` : ''}.
        </div>
      )}
      {(operationError || (loadError && currentData)) && (
        <div className={mergeClasses(styles.banner, styles.error)} role="alert">
          {operationError ?? loadError}
        </div>
      )}
      {applyError && (
        <div className={mergeClasses(styles.banner, styles.error)} role="alert">
          {applyError}
        </div>
      )}
      {applyStatus && (
        <div className={styles.banner} role="status">
          {applyStatus}
        </div>
      )}
      <div className={styles.content}>{body}</div>
      <ConfirmDialog
        confirmLabel="Discard changes"
        description={pendingDiscard ? impactDescription(pendingDiscard.confirmation) : undefined}
        destructive
        onClose={() => setPendingDiscard(null)}
        onConfirm={() => void confirmDiscard()}
        open={pendingDiscard !== null}
        title="Discard selected changes?"
      />
      <ConfirmDialog
        confirmLabel="Apply changes"
        description={
          pendingApply
            ? `Copy every changed and untracked file from the sandbox source “${pendingApply.source.mountName}” to ${pendingApply.localPath}. Local files deleted in the sandbox will be removed; unrelated local files are left untouched.`
            : undefined
        }
        onClose={() => setPendingApply(null)}
        onConfirm={() => void confirmApply()}
        open={pendingApply !== null}
        title="Apply sandbox changes to the local folder?"
      />
    </section>
  );
});
GitSurface.displayName = 'GitSurface';

/** Portal rendered inside the column's existing RPC provider. */
export function WorkspaceGitPortal({
  host,
  active,
  tabId,
  environmentId,
  sessionId,
  workspaceRoot,
  isGlass,
  onOpenFile,
}: GitSurfaceProps & { host: HTMLDivElement }) {
  return createPortal(
    <GitSurface
      active={active}
      tabId={tabId}
      environmentId={environmentId}
      sessionId={sessionId}
      workspaceRoot={workspaceRoot}
      isGlass={isGlass}
      onOpenFile={onOpenFile}
    />,
    host
  );
}
