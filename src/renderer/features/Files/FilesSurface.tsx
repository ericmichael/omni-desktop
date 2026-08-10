import { useStore } from '@nanostores/react';
import { useSelector } from '@xstate/react';
import { PanelLeftIcon, TriangleAlert } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

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
import { ButtonGroup } from '@/renderer/ds/ui/button-group';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/renderer/ds/ui/empty';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/renderer/ds/ui/resizable';
import { Spinner } from '@/renderer/ds/ui/spinner';
import { Toggle } from '@/renderer/ds/ui/toggle';
import { FsClient, WatchRegistry } from '@/renderer/omniagents-ui/rpc/fs';
import { useRPCClient, useRPCConnected } from '@/renderer/omniagents-ui/rpc-context';
import { persistedStoreApi } from '@/renderer/services/store';
import { isThemeDark } from '@/renderer/theme/themes';
import { type FileEditorLease, FileEditorRegistry } from '@/shared/machines/file-editor-registry';
import type { ExecutionTarget, WorkspaceMountDescriptor } from '@/shared/types';

import { CodeMirrorEditor } from './CodeMirrorEditor';
import { FileTabs } from './FileTabs';
import { FsFileEditorIO } from './fs-file-editor-io';
import {
  type OpenFileLocation,
  type OpenFileResult,
  type OpenFileTargetRequest,
  registerOpenFileTarget,
} from './open-file-intent';
import { WorkspaceFileTree } from './WorkspaceFileTree';

type FilesSurfaceProps = {
  executionTarget: ExecutionTarget;
  sessionId?: string;
  workspaceRoot?: string;
  /**
   * Single-mount scope: the environment root wraps exactly one mount
   * (chat scratch dir, one-source project), so the tree roots inside it
   * and displayed paths drop the redundant `<mountName>/` wrapper. All
   * RPC paths stay workspace-root-relative.
   */
  rootPrefix?: string;
  /** Authoritative mount table; labels mounts (read-only badges) when the
   *  tree shows the composite multi-mount root. */
  mounts?: WorkspaceMountDescriptor[];
};

type FileEditorPaneProps = {
  path: string;
  /** Path as shown to the user (root prefix stripped). */
  displayPath: string;
  executionTarget: ExecutionTarget;
  fsClient: FsClient;
  connected: boolean;
  lease: FileEditorLease;
  writeSupported: boolean;
  dark: boolean;
  revealRequest?: { requestId: string; location: OpenFileLocation };
};

type FileSelection = {
  identityKey: string;
  path: string;
  revealRequest?: { requestId: string; location: OpenFileLocation };
};

type FilesResources = {
  identityKey: string;
  fsClient: FsClient;
  watches: WatchRegistry;
  editors: FileEditorRegistry;
};

const FILES_READ_OPERATIONS = [
  'fs_watch',
  'fs_unwatch',
  'fs_list',
  'fs_stat',
  'fs_download_open',
  'fs_download_read',
  'fs_download_close',
  'fs_events',
  'fs_rescan_required',
] as const;

const FILES_WRITE_OPERATIONS = ['fs_upload_open', 'fs_upload_chunk', 'fs_upload_commit', 'fs_upload_abort'] as const;

const FILES_MANAGE_OPERATIONS = ['fs_delete', 'fs_rename', 'fs_mkdir'] as const;

/** Below this surface width the file tree defaults to hidden (the toggle
 *  still overrides) — sidecar columns are usually this narrow. */
const SIDEBAR_AUTO_HIDE_WIDTH = 576;

const FileEditorPane = memo(
  ({
    path,
    displayPath,
    executionTarget,
    fsClient,
    connected,
    lease,
    writeSupported,
    dark,
    revealRequest,
  }: FileEditorPaneProps) => {
    const snapshot = useSelector(lease.actor, (value) => value);
    const [writable, setWritable] = useState<boolean | null>(null);
    const [statError, setStatError] = useState<string | null>(null);
    const [statAttempt, setStatAttempt] = useState(0);

    useEffect(() => {
      let active = true;
      setWritable(null);
      setStatError(null);
      if (!connected) {
        return () => {
          active = false;
        };
      }
      void fsClient
        .stat(executionTarget, path)
        .then((result) => {
          if (active) {
            setWritable(result.writable && writeSupported);
          }
        })
        .catch((error: unknown) => {
          if (active) {
            setWritable(null);
            setStatError(error instanceof Error ? error.message : 'Could not check whether this file is writable.');
          }
        });
      return () => {
        active = false;
      };
    }, [connected, executionTarget, fsClient, path, statAttempt, writeSupported]);

    const state = String(snapshot.value);
    const isLoading = snapshot.matches('loading');
    const isLoadError = snapshot.matches('loadError');
    const isSaving = snapshot.matches('saving');
    const isDirty = snapshot.matches('dirty') || snapshot.matches('saveError');
    const isConflict = snapshot.matches('conflict');
    const canSave = connected && writable === true && isDirty;
    const save = useCallback(() => lease.actor.send({ type: 'SAVE' }), [lease.actor]);

    if (isLoading) {
      return (
        <Empty className="h-full rounded-none border-0" role="status">
          <EmptyHeader>
            <EmptyMedia>
              <Spinner />
            </EmptyMedia>
            <EmptyTitle>Loading file</EmptyTitle>
            <EmptyDescription className="break-all">{path}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      );
    }

    if (isLoadError) {
      return (
        <Empty className="h-full rounded-none border-0" role="alert">
          <EmptyHeader>
            <EmptyTitle>Could not load file</EmptyTitle>
            <EmptyDescription>{snapshot.context.error ?? `Could not load ${path}.`}</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button onClick={() => lease.actor.send({ type: 'RETRY_LOAD' })}>Retry</Button>
          </EmptyContent>
        </Empty>
      );
    }

    return (
      <>
        <div className="flex min-h-8 items-center gap-2 border-b border-border bg-card px-3 py-0.5">
          <span
            className="min-w-0 flex-auto overflow-hidden text-ellipsis whitespace-nowrap font-mono text-xs text-muted-foreground"
            title={path}
          >
            {displayPath}
          </span>
          <span
            className={`${'text-xs text-muted-foreground whitespace-nowrap'} ${isDirty || isConflict ? 'text-warning' : ''} ${snapshot.matches('saveError') ? 'text-destructive' : ''}`}
            role="status"
          >
            {isSaving
              ? 'Saving…'
              : isConflict
                ? 'File changed on disk'
                : snapshot.matches('saveError')
                  ? (snapshot.context.error ?? 'Save failed')
                  : isDirty
                    ? 'Unsaved changes'
                    : snapshot.context.diskDeleted
                      ? 'Deleted on disk'
                      : writable === false
                        ? 'Read-only'
                        : 'Saved'}
          </span>
          {writable !== false ? (
            <Button
              aria-label={`Save ${path}`}
              disabled={!canSave || isSaving}
              onClick={save}
              size="sm"
              className="h-6"
            >
              Save
            </Button>
          ) : null}
        </div>
        {isConflict && (
          <Alert className="rounded-none border-x-0 border-t-0 border-warning bg-warning text-warning-foreground">
            <TriangleAlert />
            <AlertTitle>File changed on disk</AlertTitle>
            <AlertDescription className="text-warning-foreground">
              {snapshot.context.diskDeleted
                ? 'This file was deleted outside the editor. Choose which version to keep.'
                : 'This file changed outside the editor. Choose which version to keep.'}
              <ButtonGroup className="mt-2 flex-wrap">
                <Button size="sm" variant="outline" onClick={() => lease.actor.send({ type: 'USE_DISK' })}>
                  Use disk version
                </Button>
                <Button size="sm" onClick={() => lease.actor.send({ type: 'KEEP_LOCAL' })}>
                  Keep my changes
                </Button>
              </ButtonGroup>
            </AlertDescription>
          </Alert>
        )}
        {writable === false && !isConflict && (
          <Alert className="rounded-none border-x-0 border-t-0" role="status">
            <AlertDescription>This source is read-only. You can inspect it, but saving is disabled.</AlertDescription>
          </Alert>
        )}
        {statError && !isConflict && (
          <Alert className="rounded-none border-x-0 border-t-0" variant="destructive">
            <AlertTitle>Could not check file permissions</AlertTitle>
            <AlertDescription>
              {statError}
              <Button size="sm" variant="outline" onClick={() => setStatAttempt((attempt) => attempt + 1)}>
                Retry permissions
              </Button>
            </AlertDescription>
          </Alert>
        )}
        {!connected && (
          <Alert className="rounded-none border-x-0 border-t-0" role="status">
            <AlertDescription>Reconnecting to workspace… Your unsaved changes are preserved.</AlertDescription>
          </Alert>
        )}
        <div className="flex-1 min-h-0 min-w-0" data-editor-state={state}>
          <CodeMirrorEditor
            ariaLabel={`Editor for ${path}`}
            autoFocus
            path={path}
            dark={dark}
            onChange={(content) => lease.actor.send({ type: 'EDIT', content })}
            onSave={save}
            readOnly={!connected || writable !== true || isConflict}
            value={snapshot.context.content}
            revealRequest={revealRequest}
          />
        </div>
      </>
    );
  }
);
FileEditorPane.displayName = 'FileEditorPane';

export const FilesSurface = memo(
  ({ executionTarget, sessionId, workspaceRoot, rootPrefix, mounts }: FilesSurfaceProps) => {
    const rpc = useRPCClient();
    const connected = useRPCConnected();
    const stripRootPrefix = useCallback(
      (path: string) => (rootPrefix && path.startsWith(`${rootPrefix}/`) ? path.slice(rootPrefix.length + 1) : path),
      [rootPrefix]
    );
    const store = useStore(persistedStoreApi.$atom);
    const dark = isThemeDark(store.theme ?? 'teams-light');
    const identityKey = sessionId && workspaceRoot ? JSON.stringify([sessionId, executionTarget, workspaceRoot]) : null;
    const [error, setError] = useState<string | null>(null);
    const [selection, setSelection] = useState<FileSelection | null>(null);
    const [openFiles, setOpenFiles] = useState<{ identityKey: string; paths: string[] } | null>(null);
    const [pendingClose, setPendingClose] = useState<string | null>(null);
    const [lastOpened, setLastOpened] = useState<{ path: string; location?: OpenFileLocation } | null>(null);
    const selectedPath = selection?.identityKey === identityKey ? selection.path : null;
    const openPaths = useMemo(
      () => (openFiles?.identityKey === identityKey ? openFiles.paths : []),
      [identityKey, openFiles]
    );
    const leasesRef = useMemo(() => new Map<string, FileEditorLease>(), []);
    const readSupported = FILES_READ_OPERATIONS.every((operation) => rpc.supportsExperimentalOperation(operation));
    const writeSupported = FILES_WRITE_OPERATIONS.every((operation) => rpc.supportsExperimentalOperation(operation));
    const manageSupported =
      writeSupported && FILES_MANAGE_OPERATIONS.every((operation) => rpc.supportsExperimentalOperation(operation));

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

    // These objects have terminal dispose operations, so their ownership must
    // begin inside the effect whose cleanup ends it. React StrictMode runs
    // effect setup → cleanup → setup again in development; creating them in
    // useMemo would reuse the permanently disposed first instance.
    const [resourceState, setResourceState] = useState<FilesResources | null>(null);
    useEffect(() => {
      if (!identityKey) {
        setResourceState(null);
        return;
      }
      const fsClient = new FsClient(rpc);
      const watches = new WatchRegistry(fsClient, executionTarget);
      const editors = new FileEditorRegistry(new FsFileEditorIO(fsClient, watches, executionTarget));
      const next = { identityKey, fsClient, watches, editors };
      setResourceState(next);

      return () => {
        for (const lease of leasesRef.values()) {
          lease.release();
        }
        leasesRef.clear();
        editors.dispose();
        void watches.dispose();
        fsClient.dispose();
        setResourceState((current) => (current === next ? null : current));
      };
    }, [executionTarget, identityKey, leasesRef, rpc]);
    const resources = resourceState?.identityKey === identityKey ? resourceState : null;
    const fsClient = resources?.fsClient ?? null;

    useEffect(() => {
      setError(null);
      if (!connected || !sessionId || !workspaceRoot || !identityKey) {
        return;
      }
      if (!readSupported) {
        setError('This agent runtime does not support workspace files.');
      }
    }, [connected, identityKey, readSupported, sessionId, workspaceRoot]);

    const openInTab = useCallback(
      (path: string, revealRequest?: FileSelection['revealRequest']) => {
        if (!resources || !sessionId || !identityKey) {
          return;
        }
        if (!leasesRef.has(path)) {
          leasesRef.set(path, resources.editors.acquire({ sessionId, path }));
        }
        setOpenFiles((previous) => {
          const paths = previous?.identityKey === identityKey ? previous.paths : [];
          return paths.includes(path) ? previous : { identityKey, paths: [...paths, path] };
        });
        setSelection({ identityKey, path, revealRequest });
      },
      [identityKey, leasesRef, resources, sessionId]
    );

    const handleOpenFile = useCallback(
      (path: string) => {
        openInTab(path);
        setLastOpened(null);
      },
      [openInTab]
    );

    const closeFile = useCallback(
      (path: string) => {
        if (!identityKey) {
          return;
        }
        leasesRef.get(path)?.release();
        leasesRef.delete(path);
        const remaining = openPaths.filter((candidate) => candidate !== path);
        setOpenFiles({ identityKey, paths: remaining });
        if (selectedPath === path) {
          const index = openPaths.indexOf(path);
          const next = remaining[Math.min(Math.max(index, 0), remaining.length - 1)] ?? null;
          setSelection(next ? { identityKey, path: next } : null);
        }
      },
      [identityKey, leasesRef, openPaths, selectedPath]
    );

    const requestClose = useCallback(
      (path: string) => {
        const snapshot = leasesRef.get(path)?.actor.getSnapshot();
        const unsaved =
          snapshot && (snapshot.matches('dirty') || snapshot.matches('saveError') || snapshot.matches('conflict'));
        if (unsaved) {
          setPendingClose(path);
        } else {
          closeFile(path);
        }
      },
      [closeFile, leasesRef]
    );

    // The tree deleted a file or folder: its tabs are dead. The user already
    // confirmed the deletion, so unsaved buffers go with it.
    const handleFileDeleted = useCallback(
      (path: string) => {
        if (!identityKey) {
          return;
        }
        const doomed = openPaths.filter((candidate) => candidate === path || candidate.startsWith(`${path}/`));
        if (doomed.length === 0) {
          return;
        }
        for (const candidate of doomed) {
          leasesRef.get(candidate)?.release();
          leasesRef.delete(candidate);
        }
        const remaining = openPaths.filter((candidate) => !doomed.includes(candidate));
        setOpenFiles({ identityKey, paths: remaining });
        setSelection((previous) => {
          if (!previous || previous.identityKey !== identityKey || !doomed.includes(previous.path)) {
            return previous;
          }
          const index = Math.min(openPaths.indexOf(previous.path), remaining.length - 1);
          const next = remaining[Math.max(index, 0)] ?? null;
          return next ? { identityKey, path: next } : null;
        });
      },
      [identityKey, leasesRef, openPaths]
    );

    // The tree renamed a file or folder: clean tabs follow the new path.
    // Tabs with unsaved changes stay put — their editor machine surfaces the
    // deleted-on-disk conflict and the user decides.
    const handleFileRenamed = useCallback(
      (from: string, to: string) => {
        if (!identityKey || !sessionId || !resources) {
          return;
        }
        const mapped = new Map<string, string>();
        for (const candidate of openPaths) {
          if (candidate !== from && !candidate.startsWith(`${from}/`)) {
            continue;
          }
          const snapshot = leasesRef.get(candidate)?.actor.getSnapshot();
          const unsaved =
            snapshot && (snapshot.matches('dirty') || snapshot.matches('saveError') || snapshot.matches('conflict'));
          if (!unsaved) {
            mapped.set(candidate, `${to}${candidate.slice(from.length)}`);
          }
        }
        if (mapped.size === 0) {
          return;
        }
        for (const [oldPath, newPath] of mapped) {
          leasesRef.get(oldPath)?.release();
          leasesRef.delete(oldPath);
          if (!leasesRef.has(newPath)) {
            leasesRef.set(newPath, resources.editors.acquire({ sessionId, path: newPath }));
          }
        }
        setOpenFiles({ identityKey, paths: openPaths.map((candidate) => mapped.get(candidate) ?? candidate) });
        setSelection((previous) =>
          previous && previous.identityKey === identityKey && mapped.has(previous.path)
            ? { identityKey, path: mapped.get(previous.path)! }
            : previous
        );
      },
      [identityKey, leasesRef, openPaths, resources, sessionId]
    );

    const handleFileCreated = useCallback((path: string) => openInTab(path), [openInTab]);

    const handleOpenFileIntent = useCallback(
      async ({ requestId, intent }: OpenFileTargetRequest): Promise<OpenFileResult> => {
        const failed = (reason: Extract<OpenFileResult, { status: 'failed' }>['reason'], message: string) => ({
          status: 'failed' as const,
          requestId,
          sessionId: intent.sessionId,
          path: intent.path,
          reason,
          message,
        });
        if (!connected || !identityKey || !resources || !fsClient || !sessionId || !workspaceRoot) {
          return failed(
            'workspace-unavailable',
            'Workspace files are reconnecting or the session has no workspace. Try again shortly.'
          );
        }
        if (!readSupported) {
          return failed('unsupported', 'This agent runtime does not support workspace files.');
        }
        try {
          const stat = await fsClient.stat(executionTarget, intent.path);
          if (stat.type !== 'file') {
            return failed('not-a-file', `${intent.path} is not a file.`);
          }
        } catch (reason) {
          const message = reason instanceof Error ? reason.message : `Could not find ${intent.path}.`;
          if (/not found|no such file|enoent/i.test(message)) {
            return failed('missing-file', `${intent.path} does not exist in this workspace.`);
          }
          if (/disconnect|connection|socket/i.test(message)) {
            return failed('workspace-unavailable', 'Workspace files disconnected while opening the file. Try again.');
          }
          return failed('open-failed', message);
        }
        openInTab(intent.path, intent.location ? { requestId, location: intent.location } : undefined);
        setLastOpened({ path: intent.path, location: intent.location });
        return {
          status: 'opened',
          requestId,
          sessionId: intent.sessionId,
          path: intent.path,
          location: intent.location,
        };
      },
      [connected, executionTarget, fsClient, identityKey, openInTab, readSupported, resources, sessionId, workspaceRoot]
    );
    useEffect(() => {
      // Do not advertise this surface until its RPC-backed resources exist.
      // Git may activate Files and dispatch immediately; registering an
      // unready callback would wake that pending request only to reject it.
      if (!connected || !identityKey || !resources || !fsClient || !sessionId || !workspaceRoot) {
        return;
      }
      return registerOpenFileTarget(sessionId, handleOpenFileIntent);
    }, [connected, fsClient, handleOpenFileIntent, identityKey, resources, sessionId, workspaceRoot]);
    const selectedLease = selectedPath ? (leasesRef.get(selectedPath) ?? null) : null;
    const openTabs = useMemo(
      () =>
        openPaths
          .map((path) => {
            const lease = leasesRef.get(path);
            return lease ? { path, lease } : null;
          })
          .filter((tab): tab is { path: string; lease: FileEditorLease } => tab !== null),
      // leasesRef mutates in lockstep with openPaths — paths are the signal.
      [leasesRef, openPaths]
    );

    const selectTab = useCallback(
      (path: string) => {
        if (identityKey) {
          setSelection({ identityKey, path });
        }
      },
      [identityKey]
    );

    const sidebarToggle = (
      <Toggle
        size="sm"
        className="mx-1 h-7 min-w-7 shrink-0 px-1"
        pressed={sidebarVisible}
        onPressedChange={(pressed) => setSidebarPref(pressed)}
        title={sidebarVisible ? 'Hide file tree' : 'Show file tree'}
        aria-label={sidebarVisible ? 'Hide file tree' : 'Show file tree'}
      >
        <PanelLeftIcon className="size-4" />
      </Toggle>
    );

    let body;
    if (error) {
      body = (
        <Empty className="h-full rounded-none border-0" role="alert">
          <EmptyHeader>
            <EmptyTitle>Workspace files unavailable</EmptyTitle>
            <EmptyDescription>{error}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      );
    } else if (!identityKey || !sessionId || !resources) {
      body = (
        <Empty className="h-full rounded-none border-0" role="status">
          <EmptyHeader>
            <EmptyMedia>
              <Spinner />
            </EmptyMedia>
            <EmptyTitle>Preparing workspace files…</EmptyTitle>
          </EmptyHeader>
        </Empty>
      );
    } else {
      body = (
        <ResizablePanelGroup orientation="horizontal" className="h-full">
          {sidebarVisible && (
            <>
              <ResizablePanel id="files-tree" defaultSize={240} minSize={160} maxSize={420}>
                <WorkspaceFileTree
                  executionTarget={executionTarget}
                  fsClient={resources.fsClient}
                  rootPath={rootPrefix ?? '.'}
                  mounts={mounts}
                  onOpenFile={handleOpenFile}
                  selectedPath={selectedPath}
                  canManage={manageSupported}
                  onFileCreated={handleFileCreated}
                  onFileDeleted={handleFileDeleted}
                  onFileRenamed={handleFileRenamed}
                  watchRegistry={resources.watches}
                />
              </ResizablePanel>
              <ResizableHandle />
            </>
          )}
          <ResizablePanel id="files-editor" minSize={240}>
            <div className="flex h-full min-h-0 min-w-0 flex-col">
              <FileTabs
                files={openTabs}
                selectedPath={selectedPath}
                onSelect={selectTab}
                onClose={requestClose}
                leading={sidebarToggle}
              />
              {selectedPath && selectedLease ? (
                <FileEditorPane
                  connected={connected}
                  executionTarget={executionTarget}
                  fsClient={resources.fsClient}
                  key={`${sessionId}:${selectedPath}`}
                  lease={selectedLease}
                  path={selectedPath}
                  displayPath={stripRootPrefix(selectedPath)}
                  writeSupported={writeSupported}
                  dark={dark}
                  revealRequest={selection?.identityKey === identityKey ? selection.revealRequest : undefined}
                />
              ) : (
                <Empty className="h-full rounded-none border-0">
                  <EmptyHeader>
                    <EmptyTitle>No file open</EmptyTitle>
                    <EmptyDescription>Select a text file to inspect or edit it.</EmptyDescription>
                  </EmptyHeader>
                </Empty>
              )}
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      );
    }

    return (
      <section
        ref={rootRef}
        className="flex min-w-0 min-h-0 w-full h-full flex-col bg-card"
        aria-label="Workspace files"
      >
        <div className="min-h-0 min-w-0 flex-auto overflow-hidden">{body}</div>
        {lastOpened && (
          <div className="sr-only" role="status" aria-live="polite">
            Opened {stripRootPrefix(lastOpened.path)}
            {lastOpened.location ? ` at line ${lastOpened.location.line}` : ''}
          </div>
        )}
        <AlertDialog open={pendingClose !== null} onOpenChange={(open) => !open && setPendingClose(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Discard unsaved changes?</AlertDialogTitle>
              <AlertDialogDescription>
                {pendingClose ? `${pendingClose} has unsaved changes. Closing the tab discards them.` : ''}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Keep editing</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                onClick={() => {
                  if (pendingClose) {
                    closeFile(pendingClose);
                  }
                  setPendingClose(null);
                }}
              >
                Discard and close
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </section>
    );
  }
);
FilesSurface.displayName = 'FilesSurface';

/** Portal rendered inside the column's existing RPC provider. */
export function WorkspaceFilesPortal({
  host,
  executionTarget,
  sessionId,
  workspaceRoot,
  rootPrefix,
  mounts,
}: FilesSurfaceProps & { host: HTMLDivElement }) {
  return createPortal(
    <FilesSurface
      executionTarget={executionTarget}
      sessionId={sessionId}
      workspaceRoot={workspaceRoot}
      rootPrefix={rootPrefix}
      mounts={mounts}
    />,
    host
  );
}
