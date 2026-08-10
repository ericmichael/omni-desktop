import { EllipsisIcon, File, FilePlus, Folder, FolderOpen, FolderPlus, RefreshCw } from 'lucide-react';
import { memo, useCallback, useEffect, useRef, useState } from 'react';

import { cn } from '@/renderer/ds/cn';
import type { TreeItemOpenChangeData } from '@/renderer/ds/Tree';
import { Tree, TreeItem, TreeItemLayout } from '@/renderer/ds/Tree';
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
import { Badge } from '@/renderer/ds/ui/badge';
import { Button } from '@/renderer/ds/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/renderer/ds/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/renderer/ds/ui/dropdown-menu';
import { Input } from '@/renderer/ds/ui/input';
import { Spinner } from '@/renderer/ds/ui/spinner';
import type { FsClient, FsEntry, FsListResult, WatchCallbacks } from '@/renderer/omniagents-ui/rpc/fs';
import { WatchRegistry } from '@/renderer/omniagents-ui/rpc/fs';
import type { ExecutionTarget, WorkspaceMountDescriptor } from '@/shared/types';

export interface WorkspaceTreeWatchRegistry {
  subscribe(path: string, callbacks: WatchCallbacks): Promise<() => Promise<void>>;
  touch(path: string): void;
}

export type WorkspaceFileTreeProps = {
  fsClient: FsClient;
  executionTarget: ExecutionTarget;
  /** Directory the tree roots at, workspace-root-relative ('.' = root).
   *  Single-mount environments pass their mount so the wrapper level
   *  disappears from the listing. */
  rootPath?: string;
  selectedPath?: string | null;
  onOpenFile: (path: string) => void;
  /** Authoritative mount table; multi-mount roots label each mount
   *  (source kind, read-only) on its top-level directory. */
  mounts?: WorkspaceMountDescriptor[];
  /** Enables create/rename/delete (requires the fs mutation operations). */
  canManage?: boolean;
  /** A file this tree created (so the surface can open it for editing). */
  onFileCreated?: (path: string) => void;
  onFileDeleted?: (path: string, isDirectory: boolean) => void;
  onFileRenamed?: (from: string, to: string, isDirectory: boolean) => void;
  /** Test/embedding seam. When omitted, the tree owns a WatchRegistry. */
  watchRegistry?: WorkspaceTreeWatchRegistry;
  className?: string;
};

/** Pending tree mutation, driving the shared name/confirm dialogs. */
type TreeAction =
  | { kind: 'create-file' | 'create-folder'; basePath: string }
  | { kind: 'rename'; path: string; isDirectory: boolean }
  | { kind: 'delete'; path: string; isDirectory: boolean };

function parentOf(path: string): string {
  const separator = path.lastIndexOf('/');
  return separator === -1 ? '.' : path.slice(0, separator);
}

function validNewName(name: string): boolean {
  if (!name || name === '.' || name === '..') {
    return false;
  }
  return !/[/\\\0]/.test(name);
}

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

/** Per-row management menu, revealed on hover/focus (and on iOS tap). */
const TreeNodeActions = ({ entry, onAction }: { entry: FsEntry; onAction: (action: TreeAction) => void }) => {
  const isDirectory = entry.type === 'directory';
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          className="size-5 text-muted-foreground opacity-0 focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100"
          aria-label={`Actions for ${entry.path}`}
          onClick={(event) => event.stopPropagation()}
        >
          <EllipsisIcon className="size-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {isDirectory ? (
          <>
            <DropdownMenuItem onSelect={() => onAction({ kind: 'create-file', basePath: entry.path })}>
              New file…
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onAction({ kind: 'create-folder', basePath: entry.path })}>
              New folder…
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        ) : null}
        <DropdownMenuItem onSelect={() => onAction({ kind: 'rename', path: entry.path, isDirectory })}>
          Rename…
        </DropdownMenuItem>
        <DropdownMenuItem
          className="text-destructive"
          onSelect={() => onAction({ kind: 'delete', path: entry.path, isDirectory })}
        >
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

type WorkspaceTreeNodeProps = {
  entry: FsEntry;
  state: DirectoryState | undefined;
  openItems: Set<string>;
  selectedPath: string | null;
  directoryStates: Map<string, DirectoryState>;
  onOpenFile: WorkspaceFileTreeProps['onOpenFile'];
  onRetry: (path: string) => void;
  onAction?: (action: TreeAction) => void;
  /** Mounts keyed by their top-level path; labels matching directories. */
  mountsByPath?: ReadonlyMap<string, WorkspaceMountDescriptor>;
};

const WorkspaceTreeNode = memo(
  ({
    entry,
    state,
    openItems,
    selectedPath,
    directoryStates,
    onOpenFile,
    onRetry,
    onAction,
    mountsByPath,
  }: WorkspaceTreeNodeProps) => {
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
          <TreeItemLayout
            className="group min-h-7 py-0.5 text-xs"
            iconBefore={<File className="size-3.5 shrink-0 text-muted-foreground" />}
            aside={onAction ? <TreeNodeActions entry={entry} onAction={onAction} /> : undefined}
          >
            {name}
          </TreeItemLayout>
        </TreeItem>
      );
    }

    const expanded = openItems.has(entry.path);
    const directory = state ?? emptyDirectory;
    const mount = mountsByPath?.get(entry.path);
    return (
      <TreeItem itemType="branch" title={entry.path} value={entry.path}>
        <TreeItemLayout
          className="group min-h-7 py-0.5 text-xs"
          iconBefore={
            expanded ? (
              <FolderOpen className="size-3.5 shrink-0 text-chart-4" />
            ) : (
              <Folder className="size-3.5 shrink-0 text-chart-4" />
            )
          }
          aside={
            <>
              {mount && !mount.writable ? (
                <Badge
                  variant="outline"
                  className="ml-1 shrink-0 px-1 py-0 text-[10px] font-normal text-muted-foreground"
                >
                  read-only
                </Badge>
              ) : null}
              {expanded && directory.status === 'loading' ? <Spinner className="ml-2" /> : null}
              {onAction ? <TreeNodeActions entry={entry} onAction={onAction} /> : null}
            </>
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
                onAction={onAction}
                mountsByPath={mountsByPath}
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
    rootPath = '.',
    selectedPath = null,
    onOpenFile,
    mounts,
    canManage = false,
    onFileCreated,
    onFileDeleted,
    onFileRenamed,
    watchRegistry,
    className,
  }: WorkspaceFileTreeProps) => {
    const [directoryStates, setDirectoryStates] = useState<Map<string, DirectoryState>>(new Map());
    const [openItems, setOpenItems] = useState<Set<string>>(new Set());
    const [pendingAction, setPendingAction] = useState<TreeAction | null>(null);
    const [actionName, setActionName] = useState('');
    const [actionError, setActionError] = useState<string | null>(null);
    const [actionBusy, setActionBusy] = useState(false);
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

    const beginAction = useCallback((action: TreeAction) => {
      setActionError(null);
      setActionBusy(false);
      setActionName(action.kind === 'rename' ? (action.path.split('/').at(-1) ?? '') : '');
      setPendingAction(action);
    }, []);

    const dismissAction = useCallback(() => {
      setPendingAction(null);
      setActionError(null);
      setActionBusy(false);
    }, []);

    const performAction = useCallback(async () => {
      const action = pendingAction;
      if (!action || actionBusy) {
        return;
      }
      setActionBusy(true);
      setActionError(null);
      try {
        if (action.kind === 'delete') {
          await fsClient.delete(executionTarget, action.path, { recursive: action.isDirectory });
          onFileDeleted?.(action.path, action.isDirectory);
          void refreshDirectory(parentOf(action.path), false);
        } else {
          const name = actionName.trim();
          if (!validNewName(name)) {
            throw new Error('Enter a name without path separators.');
          }
          if (action.kind === 'rename') {
            const parent = parentOf(action.path);
            const destination = parent === '.' ? name : `${parent}/${name}`;
            if (destination !== action.path) {
              await fsClient.rename(executionTarget, action.path, destination);
              onFileRenamed?.(action.path, destination, action.isDirectory);
            }
            void refreshDirectory(parent, false);
          } else {
            const target = action.basePath === '.' ? name : `${action.basePath}/${name}`;
            if (action.kind === 'create-folder') {
              await fsClient.mkdir(executionTarget, target);
            } else {
              await fsClient.writeTextFile(executionTarget, target, '', { overwrite: false });
              onFileCreated?.(target);
            }
            void refreshDirectory(action.basePath, false);
          }
        }
        dismissAction();
      } catch (error) {
        setActionError(error instanceof Error && error.message ? error.message : 'The operation failed.');
        setActionBusy(false);
      }
    }, [
      actionBusy,
      actionName,
      dismissAction,
      executionTarget,
      fsClient,
      onFileCreated,
      onFileDeleted,
      onFileRenamed,
      pendingAction,
      refreshDirectory,
    ]);

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
        if (path !== rootPath) {
          // Root mount changes must remain observable even when many folders
          // are expanded and the registry has to evict an older watch.
          registry.touch(rootPath);
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
      [applyError, applyListing, rootPath, scheduleRefresh, setLoading]
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
      subscribeDirectory(rootPath);
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
    }, [executionTarget, fsClient, rootPath, subscribeDirectory, watchRegistry]);

    const closeBranch = useCallback(
      (path: string) => {
        const prefix = `${path}/`;
        const closing = [...desiredWatchesRef.current].filter(
          (watched) => watched === path || watched.startsWith(prefix)
        );
        for (const watched of closing) {
          if (watched !== rootPath) {
            releaseDirectory(watched);
          }
        }
        setOpenItems(
          (previous) => new Set([...previous].filter((opened) => opened !== path && !opened.startsWith(prefix)))
        );
      },
      [releaseDirectory, rootPath]
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

    const rootState = directoryStates.get(rootPath) ?? emptyDirectory;
    // Label mounts only on the composite root — a scoped (single-mount)
    // tree never shows the mount level at all.
    const mountsByPath =
      rootPath === '.' && mounts && mounts.length > 1
        ? new Map(mounts.filter((mount) => mount.path !== '.').map((mount) => [mount.path, mount]))
        : undefined;
    return (
      <section
        aria-label="Workspace file tree"
        className={cn('flex flex-col min-h-0 h-full text-foreground bg-card', className)}
        data-workspace-root={rootPath}
      >
        <header className="flex min-h-9 items-center gap-0.5 border-b border-border px-3 py-1">
          <h2 className="m-0 min-w-0 flex-auto overflow-hidden text-ellipsis whitespace-nowrap text-xs font-semibold">
            Files
          </h2>
          {canManage ? (
            <>
              <Button
                aria-label="New file"
                title="New file"
                className="size-7 text-muted-foreground"
                onClick={() => beginAction({ kind: 'create-file', basePath: rootPath })}
                size="icon-sm"
                variant="ghost"
              >
                <FilePlus className="size-3.5" />
              </Button>
              <Button
                aria-label="New folder"
                title="New folder"
                className="size-7 text-muted-foreground"
                onClick={() => beginAction({ kind: 'create-folder', basePath: rootPath })}
                size="icon-sm"
                variant="ghost"
              >
                <FolderPlus className="size-3.5" />
              </Button>
            </>
          ) : null}
          <Button
            aria-label="Refresh"
            title="Refresh file tree"
            className="size-7 text-muted-foreground"
            disabled={rootState.status === 'loading'}
            onClick={() => void refreshDirectory(rootPath)}
            size="icon-sm"
            variant="ghost"
          >
            <RefreshCw className="size-3.5" />
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
              <Button onClick={() => handleRetry(rootPath)} size="sm" variant="ghost">
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
                  <Button onClick={() => handleRetry(rootPath)} size="sm" variant="ghost">
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
                    onAction={canManage ? beginAction : undefined}
                    mountsByPath={mountsByPath}
                  />
                ))}
              </Tree>
            </>
          )}
        </div>

        <Dialog
          open={pendingAction !== null && pendingAction.kind !== 'delete'}
          onOpenChange={(open) => !open && dismissAction()}
        >
          <DialogContent className="max-w-sm">
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void performAction();
              }}
            >
              <DialogHeader>
                <DialogTitle>
                  {pendingAction?.kind === 'rename'
                    ? 'Rename'
                    : pendingAction?.kind === 'create-folder'
                      ? 'New folder'
                      : 'New file'}
                </DialogTitle>
                <DialogDescription className="break-all">
                  {pendingAction?.kind === 'rename'
                    ? pendingAction.path
                    : pendingAction && pendingAction.kind !== 'delete' && pendingAction.basePath !== rootPath
                      ? `In ${pendingAction.basePath}/`
                      : 'In the workspace root'}
                </DialogDescription>
              </DialogHeader>
              <div className="py-3">
                <Input
                  aria-label="Name"
                  autoFocus
                  value={actionName}
                  onChange={(event) => setActionName(event.target.value)}
                  placeholder={pendingAction?.kind === 'create-folder' ? 'folder-name' : 'file-name.ext'}
                />
                {actionError ? (
                  <p className="mt-2 text-xs text-destructive" role="alert">
                    {actionError}
                  </p>
                ) : null}
              </div>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={dismissAction}>
                  Cancel
                </Button>
                <Button type="submit" disabled={actionBusy || !validNewName(actionName.trim())}>
                  {actionBusy
                    ? 'Working…'
                    : pendingAction?.kind === 'rename'
                      ? 'Rename'
                      : pendingAction?.kind === 'create-folder'
                        ? 'Create folder'
                        : 'Create file'}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>

        <AlertDialog open={pendingAction?.kind === 'delete'} onOpenChange={(open) => !open && dismissAction()}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                Delete {pendingAction?.kind === 'delete' && pendingAction.isDirectory ? 'folder' : 'file'}?
              </AlertDialogTitle>
              <AlertDialogDescription className="break-all">
                {pendingAction?.kind === 'delete'
                  ? `${pendingAction.path}${pendingAction.isDirectory ? ' and everything inside it' : ''} will be deleted. This cannot be undone.`
                  : ''}
              </AlertDialogDescription>
            </AlertDialogHeader>
            {actionError ? (
              <p className="text-xs text-destructive" role="alert">
                {actionError}
              </p>
            ) : null}
            <AlertDialogFooter>
              <AlertDialogCancel onClick={dismissAction}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                disabled={actionBusy}
                onClick={(event) => {
                  // Keep the dialog open until the delete resolves so a
                  // failure stays visible.
                  event.preventDefault();
                  void performAction();
                }}
              >
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </section>
    );
  }
);
WorkspaceFileTree.displayName = 'WorkspaceFileTree';
