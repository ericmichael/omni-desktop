import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import {
  ArrowClockwise20Regular,
  Document20Regular,
  Folder20Regular,
  FolderOpen20Regular,
} from '@fluentui/react-icons';
import { memo, useCallback, useEffect, useRef, useState } from 'react';

import { Button, Spinner, Tree, TreeItem, TreeItemLayout, type TreeItemOpenChangeData } from '@/renderer/ds';
import type { FsClient, FsEntry, FsListResult, WatchCallbacks } from '@/renderer/omniagents-ui/rpc/fs';
import { WatchRegistry } from '@/renderer/omniagents-ui/rpc/fs';

export interface WorkspaceTreeWatchRegistry {
  subscribe(path: string, callbacks: WatchCallbacks): Promise<() => Promise<void>>;
  touch(path: string): void;
}

export type WorkspaceFileTreeProps = {
  fsClient: FsClient;
  environmentId: string;
  selectedPath?: string | null;
  onOpenFile: (path: string) => void;
  /** Test/embedding seam. When omitted, the tree owns a WatchRegistry. */
  watchRegistry?: WorkspaceTreeWatchRegistry;
  className?: string;
  isGlass?: boolean;
};

type DirectoryStatus = 'idle' | 'loading' | 'loaded' | 'error';

type DirectoryState = {
  status: DirectoryStatus;
  entries: FsEntry[];
  error?: string;
};

const emptyDirectory: DirectoryState = { status: 'idle', entries: [] };

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
    height: '100%',
    color: tokens.colorNeutralForeground1,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  rootGlass: { backgroundColor: 'transparent' },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: tokens.spacingHorizontalS,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  heading: {
    margin: 0,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightSemibold,
  },
  body: { minHeight: 0, flex: '1 1 auto', overflow: 'auto', padding: tokens.spacingVerticalXS },
  tree: { minWidth: 'max-content' },
  layout: {
    '& > .fui-TreeItemLayout__main': { minWidth: 0 },
  },
  selected: { backgroundColor: tokens.colorSubtleBackgroundSelected },
  folderIcon: { color: tokens.colorPaletteYellowForeground1 },
  fileIcon: { color: tokens.colorNeutralForeground2 },
  state: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: tokens.spacingVerticalS,
    minHeight: '7rem',
    padding: tokens.spacingVerticalL,
    textAlign: 'center',
    color: tokens.colorNeutralForeground3,
  },
  inlineState: { color: tokens.colorNeutralForeground3, fontStyle: 'italic' },
  inlineError: { color: tokens.colorPaletteRedForeground1 },
  asideSpinner: { marginLeft: tokens.spacingHorizontalS },
});

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
    const styles = useStyles();
    const name = entryName(entry);
    if (entry.type === 'file') {
      const selected = selectedPath === entry.path;
      return (
        <TreeItem
          aria-selected={selected}
          className={mergeClasses(styles.layout, selected && styles.selected)}
          itemType="leaf"
          onClick={() => onOpenFile(entry.path)}
          title={entry.path}
          value={entry.path}
        >
          <TreeItemLayout iconBefore={<Document20Regular className={styles.fileIcon} />}>{name}</TreeItemLayout>
        </TreeItem>
      );
    }

    const expanded = openItems.has(entry.path);
    const directory = state ?? emptyDirectory;
    return (
      <TreeItem itemType="branch" title={entry.path} value={entry.path}>
        <TreeItemLayout
          className={styles.layout}
          iconBefore={
            expanded ? (
              <FolderOpen20Regular className={styles.folderIcon} />
            ) : (
              <Folder20Regular className={styles.folderIcon} />
            )
          }
          aside={
            expanded && directory.status === 'loading' ? (
              <Spinner className={styles.asideSpinner} size="sm" />
            ) : undefined
          }
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
                  <span className={styles.inlineState} role="status">
                    Loading {name}…
                  </span>
                </TreeItemLayout>
              </TreeItem>
            )}
            {directory.status === 'loaded' && directory.entries.length === 0 && (
              <TreeItem itemType="leaf" value={`${entry.path}:empty`}>
                <TreeItemLayout>
                  <span className={styles.inlineState} role="status">
                    This folder is empty.
                  </span>
                </TreeItemLayout>
              </TreeItem>
            )}
            {directory.status === 'error' && (
              <TreeItem itemType="leaf" value={`${entry.path}:error`}>
                <TreeItemLayout>
                  <span className={styles.inlineError} role="alert">
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
    environmentId,
    selectedPath = null,
    onOpenFile,
    watchRegistry,
    className,
    isGlass,
  }: WorkspaceFileTreeProps) => {
    const styles = useStyles();
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
          const listing = await fsClient.list(environmentId, path, false);
          if (generation === generationRef.current) {
            applyListing(path, listing);
          }
        } catch (error) {
          if (generation === generationRef.current) {
            applyError(path, error);
          }
        }
      },
      [applyError, applyListing, environmentId, fsClient, setLoading]
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
      const registry = watchRegistry ?? new WatchRegistry(fsClient, environmentId);
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
    }, [environmentId, fsClient, subscribeDirectory, watchRegistry]);

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
      (_event: unknown, data: TreeItemOpenChangeData) => {
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
        className={mergeClasses(styles.root, isGlass && styles.rootGlass, className)}
        data-workspace-root="."
      >
        <header className={styles.header}>
          <h2 className={styles.heading}>Files</h2>
          <Button
            isDisabled={rootState.status === 'loading'}
            leftIcon={<ArrowClockwise20Regular />}
            onClick={() => void refreshDirectory('.')}
            size="sm"
            variant="ghost"
          >
            Refresh
          </Button>
        </header>
        <div className={styles.body}>
          {rootState.status === 'loading' && rootState.entries.length === 0 ? (
            <div className={styles.state} role="status" aria-live="polite">
              <Spinner size="lg" />
              <span>Loading workspace files…</span>
            </div>
          ) : rootState.status === 'error' && rootState.entries.length === 0 ? (
            <div className={styles.state} role="alert">
              <span>{rootState.error}</span>
              <Button onClick={() => handleRetry('.')} size="sm" variant="ghost">
                Retry
              </Button>
            </div>
          ) : rootState.status === 'loaded' && rootState.entries.length === 0 ? (
            <div className={styles.state} role="status">
              This workspace is empty.
            </div>
          ) : (
            <>
              {rootState.status === 'loading' && (
                <div className={styles.inlineState} role="status" aria-live="polite">
                  Refreshing workspace files…
                </div>
              )}
              {rootState.status === 'error' && (
                <div className={styles.inlineError} role="alert">
                  <span>{rootState.error}</span>
                  <Button onClick={() => handleRetry('.')} size="sm" variant="ghost">
                    Retry
                  </Button>
                </div>
              )}
              <Tree
                aria-label="Workspace files"
                className={styles.tree}
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
