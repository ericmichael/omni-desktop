import { File, Folder, FolderOpen, RefreshCw } from 'lucide-react';
import { memo, useCallback, useEffect, useRef, useState } from 'react';

import { cn } from '@/renderer/ds/cn';
import type { TreeItemOpenChangeData } from '@/renderer/ds/Tree';
import { Tree, TreeItem, TreeItemLayout } from '@/renderer/ds/Tree';
import { Button } from '@/renderer/ds/ui/button';
import { Spinner } from '@/renderer/ds/ui/spinner';
import type { FsClient, FsEntry, FsListResult, WatchCallbacks } from '@/renderer/omniagents-ui/rpc/fs';
import { WatchRegistry } from '@/renderer/omniagents-ui/rpc/fs';
import type { ExecutionTarget } from '@/shared/types';

export interface WorkspaceTreeWatchRegistry {
  subscribe(path: string, callbacks: WatchCallbacks): Promise<() => Promise<void>>;
  touch(path: string): void;
}

export type WorkspaceFileTreeProps = {
  fsClient: FsClient;
  executionTarget: ExecutionTarget;
  selectedPath?: string | null;
  onOpenFile: (path: string) => void;
  /** Test/embedding seam. When omitted, the tree owns a WatchRegistry. */
  watchRegistry?: WorkspaceTreeWatchRegistry;
  className?: string;
};

type DirectoryStatus = 'idle' | 'loading' | 'loaded' | 'error';

type DirectoryState = {
  status: DirectoryStatus;
  entries: FsEntry[];
  error?: string;
};

const emptyDirectory: DirectoryState = { status: 'idle', entries: [] };

function entryName(entry: FsEntry): string {
  return entry.path.split('/').at(-1) ?? entry.path;
}

function sortEntries(entries: FsEntry[]): FsEntry[] {
  return [...entries].sort((left, right) => {
    if (left.type !== right.type) {
      return left.type === 'directory' ? -1 : 1;
    }
    return entryName(left).localeCompare(entryName(right), undefined, { numeric: true, sensitivity: 'base' });
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'The folder could not be loaded.';
}

type WorkspaceTreeNodeProps = {
  entry: FsEntry;
  state: DirectoryState | undefined;
  openItems: Set<string>;
  selectedPath: string | null;
  directoryStates: Map<string, DirectoryState>;
  onOpenFile: WorkspaceFileTreeProps['onOpenFile'];
  onRetry: (path: string) => void;
};

const WorkspaceTreeNode = memo(
  ({ entry, state, openItems, selectedPath, directoryStates, onOpenFile, onRetry }: WorkspaceTreeNodeProps) => {
    const name = entryName(entry);
    if (entry.type === 'file') {
      const selected = selectedPath === entry.path;
      return (
        <TreeItem
          aria-selected={selected}
          className={cn(selected && 'bg-accent')}
          itemType="leaf"
          onClick={() => onOpenFile(entry.path)}
          title={entry.path}
          value={entry.path}
        >
          <TreeItemLayout iconBefore={<File className="text-muted-foreground" />}>{name}</TreeItemLayout>
        </TreeItem>
      );
    }

    const expanded = openItems.has(entry.path);
    const directory = state ?? emptyDirectory;
    return (
      <TreeItem itemType="branch" title={entry.path} value={entry.path}>
        <TreeItemLayout
          iconBefore={expanded ? <FolderOpen className="text-chart-4" /> : <Folder className="text-chart-4" />}
          aside={expanded && directory.status === 'loading' ? <Spinner className="ml-2" /> : undefined}
        >
          {name}
        </TreeItemLayout>
        {expanded && (
          <Tree>
            {directory.entries.map((child) => (
              <WorkspaceTreeNode
                key={child.path}
                entry={child}
                state={directoryStates.get(child.path)}
                openItems={openItems}
                selectedPath={selectedPath}
                directoryStates={directoryStates}
                onOpenFile={onOpenFile}
                onRetry={onRetry}
              />
            ))}
            {directory.status === 'loading' && directory.entries.length === 0 && (
              <TreeItem itemType="leaf" value={`${entry.path}:loading`}>
                <TreeItemLayout>
                  <span className="text-muted-foreground italic" role="status">
                    Loading {name}…
                  </span>
                </TreeItemLayout>
              </TreeItem>
            )}
            {directory.status === 'loaded' && directory.entries.length === 0 && (
              <TreeItem itemType="leaf" value={`${entry.path}:empty`}>
                <TreeItemLayout>
                  <span className="text-muted-foreground italic" role="status">
                    This folder is empty.
                  </span>
                </TreeItemLayout>
              </TreeItem>
            )}
            {directory.status === 'error' && (
              <TreeItem itemType="leaf" value={`${entry.path}:error`}>
                <TreeItemLayout>
                  <span className="text-destructive" role="alert">
                    {directory.error}
                  </span>
                  <Button size="sm" variant="ghost" onClick={() => onRetry(entry.path)}>
                    Retry
                  </Button>
                </TreeItemLayout>
              </TreeItem>
            )}
          </Tree>
        )}
      </TreeItem>
    );
  }
);
WorkspaceTreeNode.displayName = 'WorkspaceTreeNode';

export const WorkspaceFileTree = memo(
  ({
    fsClient,
    executionTarget,
    selectedPath = null,
    onOpenFile,
    watchRegistry,
    className,
  }: WorkspaceFileTreeProps) => {
    const [directoryStates, setDirectoryStates] = useState<Map<string, DirectoryState>>(new Map());
    const [openItems, setOpenItems] = useState<Set<string>>(new Set());
    const registryRef = useRef<WorkspaceTreeWatchRegistry | null>(null);
    const ownedRegistryRef = useRef<WatchRegistry | null>(null);
    const subscriptionsRef = useRef<Map<string, Promise<() => Promise<void>>>>(new Map());
    const desiredWatchesRef = useRef<Set<string>>(new Set());
    const refreshTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
    const generationRef = useRef(0);

    const setLoading = useCallback((path: string) => {
      setDirectoryStates((previous) => {
        const current = previous.get(path) ?? emptyDirectory;
        const next = new Map(previous);
        next.set(path, { status: 'loading', entries: current.entries });
        return next;
      });
    }, []);

    const applyListing = useCallback((path: string, listing: FsListResult) => {
      setDirectoryStates((previous) => {
        const next = new Map(previous);
        next.set(path, { status: 'loaded', entries: sortEntries(listing.entries) });
        return next;
      });
    }, []);

    const applyError = useCallback((path: string, error: unknown) => {
      setDirectoryStates((previous) => {
        const current = previous.get(path) ?? emptyDirectory;
        const next = new Map(previous);
        next.set(path, { status: 'error', entries: current.entries, error: errorMessage(error) });
        return next;
      });
    }, []);

    const refreshDirectory = useCallback(
      async (path: string, announce = true) => {
        const generation = generationRef.current;
        if (announce) {
          setLoading(path);
        }
        try {
          const listing = await fsClient.list(executionTarget, path, false);
          if (generation === generationRef.current) {
            applyListing(path, listing);
          }
        } catch (error) {
          if (generation === generationRef.current) {
            applyError(path, error);
          }
        }
      },
      [applyError, applyListing, executionTarget, fsClient, setLoading]
    );

    const scheduleRefresh = useCallback(
      (path: string) => {
        if (refreshTimersRef.current.has(path)) {
          return;
        }
        refreshTimersRef.current.set(
          path,
          setTimeout(() => {
            refreshTimersRef.current.delete(path);
            void refreshDirectory(path, false);
          }, 50)
        );
      },
      [refreshDirectory]
    );

    const subscribeDirectory = useCallback(
      (path: string) => {
        const registry = registryRef.current;
        if (!registry || subscriptionsRef.current.has(path)) {
          return;
        }
        if (path !== '.') {
          // Root mount changes must remain observable even when many folders
          // are expanded and the registry has to evict an older watch.
          registry.touch('.');
        }
        desiredWatchesRef.current.add(path);
        setLoading(path);
        const generation = generationRef.current;
        const subscription = registry.subscribe(path, {
          onEvents: () => scheduleRefresh(path),
          onRescan: (listing) => {
            if (generation === generationRef.current) {
              applyListing(path, listing);
            }
          },
          onError: (error) => {
            if (generation === generationRef.current) {
              applyError(path, error);
            }
          },
          onEvicted: () => {
            subscriptionsRef.current.delete(path);
          },
          onNarrowerWatchRequired: () => {
            applyError(path, new Error('This folder is too large to watch. Expand a narrower folder.'));
          },
        });
        subscriptionsRef.current.set(path, subscription);
        void subscription
          .then(async (unsubscribe) => {
            if (generation !== generationRef.current || !desiredWatchesRef.current.has(path)) {
              await unsubscribe();
              subscriptionsRef.current.delete(path);
            }
          })
          .catch((error) => {
            subscriptionsRef.current.delete(path);
            if (generation === generationRef.current) {
              applyError(path, error);
            }
          });
      },
      [applyError, applyListing, scheduleRefresh, setLoading]
    );

    const releaseDirectory = useCallback((path: string) => {
      desiredWatchesRef.current.delete(path);
      const subscription = subscriptionsRef.current.get(path);
      subscriptionsRef.current.delete(path);
      if (subscription) {
        void subscription.then((unsubscribe) => unsubscribe()).catch(() => {});
      }
    }, []);

    useEffect(() => {
      generationRef.current += 1;
      setDirectoryStates(new Map());
      setOpenItems(new Set());
      const registry = watchRegistry ?? new WatchRegistry(fsClient, executionTarget);
      registryRef.current = registry;
      ownedRegistryRef.current = watchRegistry ? null : (registry as WatchRegistry);
      subscribeDirectory('.');
      const desiredWatches = desiredWatchesRef.current;
      const refreshTimers = refreshTimersRef.current;
      const subscriptions = subscriptionsRef.current;

      return () => {
        generationRef.current += 1;
        registryRef.current = null;
        desiredWatches.clear();
        for (const timer of refreshTimers.values()) {
          clearTimeout(timer);
        }
        refreshTimers.clear();
        for (const subscription of subscriptions.values()) {
          void subscription.then((unsubscribe) => unsubscribe()).catch(() => {});
        }
        subscriptions.clear();
        const owned = ownedRegistryRef.current;
        ownedRegistryRef.current = null;
        if (owned) {
          void owned.dispose();
        }
      };
    }, [executionTarget, fsClient, subscribeDirectory, watchRegistry]);

    const closeBranch = useCallback(
      (path: string) => {
        const prefix = `${path}/`;
        const closing = [...desiredWatchesRef.current].filter(
          (watched) => watched === path || watched.startsWith(prefix)
        );
        for (const watched of closing) {
          if (watched !== '.') {
            releaseDirectory(watched);
          }
        }
        setOpenItems(
          (previous) => new Set([...previous].filter((opened) => opened !== path && !opened.startsWith(prefix)))
        );
      },
      [releaseDirectory]
    );

    const handleOpenChange = useCallback(
      (data: TreeItemOpenChangeData) => {
        const path = String(data.value);
        if (data.open) {
          setOpenItems((previous) => new Set(previous).add(path));
          registryRef.current?.touch(path);
          subscribeDirectory(path);
        } else {
          closeBranch(path);
        }
      },
      [closeBranch, subscribeDirectory]
    );

    const handleRetry = useCallback(
      (path: string) => {
        if (subscriptionsRef.current.has(path)) {
          void refreshDirectory(path);
        } else {
          subscribeDirectory(path);
        }
      },
      [refreshDirectory, subscribeDirectory]
    );

    const rootState = directoryStates.get('.') ?? emptyDirectory;
    return (
      <section
        aria-label="Read-only workspace files"
        className={cn('flex flex-col min-h-0 h-full text-foreground bg-card', className)}
        data-workspace-root="."
      >
        <header className="flex items-center justify-between gap-2 px-4 py-2 border-b border-border">
          <h2 className="m-0 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-sm font-semibold">Files</h2>
          <Button
            disabled={rootState.status === 'loading'}
            onClick={() => void refreshDirectory('.')}
            size="sm"
            variant="ghost"
          >
            <RefreshCw />
            Refresh
          </Button>
        </header>
        <div className="min-h-0 flex-auto overflow-auto p-1">
          {rootState.status === 'loading' && rootState.entries.length === 0 ? (
            <div
              className="flex min-h-28 flex-col items-center justify-center gap-2 p-5 text-center text-muted-foreground"
              role="status"
              aria-live="polite"
            >
              <Spinner />
              <span>Loading workspace files…</span>
            </div>
          ) : rootState.status === 'error' && rootState.entries.length === 0 ? (
            <div
              className="flex min-h-28 flex-col items-center justify-center gap-2 p-5 text-center text-muted-foreground"
              role="alert"
            >
              <span>{rootState.error}</span>
              <Button onClick={() => handleRetry('.')} size="sm" variant="ghost">
                Retry
              </Button>
            </div>
          ) : rootState.status === 'loaded' && rootState.entries.length === 0 ? (
            <div
              className="flex min-h-28 flex-col items-center justify-center gap-2 p-5 text-center text-muted-foreground"
              role="status"
            >
              This workspace is empty.
            </div>
          ) : (
            <>
              {rootState.status === 'loading' && (
                <div className="text-muted-foreground italic" role="status" aria-live="polite">
                  Refreshing workspace files…
                </div>
              )}
              {rootState.status === 'error' && (
                <div className="text-destructive" role="alert">
                  <span>{rootState.error}</span>
                  <Button onClick={() => handleRetry('.')} size="sm" variant="ghost">
                    Retry
                  </Button>
                </div>
              )}
              <Tree
                aria-label="Workspace files"
                className="min-w-max"
                onOpenChange={handleOpenChange}
                openItems={openItems}
              >
                {rootState.entries.map((entry) => (
                  <WorkspaceTreeNode
                    key={entry.path}
                    entry={entry}
                    state={directoryStates.get(entry.path)}
                    openItems={openItems}
                    selectedPath={selectedPath}
                    directoryStates={directoryStates}
                    onOpenFile={onOpenFile}
                    onRetry={handleRetry}
                  />
                ))}
              </Tree>
            </>
          )}
        </div>
      </section>
    );
  }
);
WorkspaceFileTree.displayName = 'WorkspaceFileTree';
