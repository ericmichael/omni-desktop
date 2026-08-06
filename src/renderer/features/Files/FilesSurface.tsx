import { useSelector } from '@xstate/react';
import { TriangleAlert } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';

import { Alert, AlertDescription, AlertTitle } from '@/renderer/ds/ui/alert';
import { Button } from '@/renderer/ds/ui/button';
import { ButtonGroup } from '@/renderer/ds/ui/button-group';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/renderer/ds/ui/empty';
import { Spinner } from '@/renderer/ds/ui/spinner';
import { FsClient, WatchRegistry } from '@/renderer/omniagents-ui/rpc/fs';
import { useRPCClient, useRPCConnected } from '@/renderer/omniagents-ui/rpc-context';
import { type FileEditorLease, FileEditorRegistry } from '@/shared/machines/file-editor-registry';
import type { ExecutionTarget } from '@/shared/types';

import { CodeMirrorEditor } from './CodeMirrorEditor';
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
};

type FileEditorPaneProps = {
  path: string;
  executionTarget: ExecutionTarget;
  fsClient: FsClient;
  connected: boolean;
  lease: FileEditorLease;
  writeSupported: boolean;
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

const FileEditorPane = memo(
  ({ path, executionTarget, fsClient, connected, lease, writeSupported, revealRequest }: FileEditorPaneProps) => {
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
        <div className="flex items-center gap-2 min-h-10.5 px-4 py-1 border-b border-border bg-card">
          <span
            className="min-w-0 flex-auto overflow-hidden text-ellipsis whitespace-nowrap font-mono text-xs text-muted-foreground"
            title={path}
          >
            {path}
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
                        : `Saved ${path}`}
          </span>
          <Button aria-label={`Save ${path}`} disabled={!canSave || isSaving} onClick={save} size="sm">
            Save
          </Button>
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

export const FilesSurface = memo(({ executionTarget, sessionId, workspaceRoot }: FilesSurfaceProps) => {
  const rpc = useRPCClient();
  const connected = useRPCConnected();
  const identityKey = sessionId && workspaceRoot ? JSON.stringify([sessionId, executionTarget, workspaceRoot]) : null;
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<FileSelection | null>(null);
  const [lastOpened, setLastOpened] = useState<{ path: string; location?: OpenFileLocation } | null>(null);
  const selectedPath = selection?.identityKey === identityKey ? selection.path : null;
  const leasesRef = useMemo(() => new Map<string, FileEditorLease>(), []);
  const readSupported = FILES_READ_OPERATIONS.every((operation) => rpc.supportsExperimentalOperation(operation));
  const writeSupported = FILES_WRITE_OPERATIONS.every((operation) => rpc.supportsExperimentalOperation(operation));

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

  const handleOpenFile = useCallback(
    (path: string) => {
      if (!resources || !sessionId || !identityKey) {
        return;
      }
      if (!leasesRef.has(path)) {
        leasesRef.set(path, resources.editors.acquire({ sessionId, path }));
      }
      setSelection({ identityKey, path });
      setLastOpened(null);
    },
    [identityKey, leasesRef, resources, sessionId]
  );
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
      if (!leasesRef.has(intent.path)) {
        leasesRef.set(intent.path, resources.editors.acquire({ sessionId, path: intent.path }));
      }
      setSelection({
        identityKey,
        path: intent.path,
        revealRequest: intent.location ? { requestId, location: intent.location } : undefined,
      });
      setLastOpened({ path: intent.path, location: intent.location });
      return {
        status: 'opened',
        requestId,
        sessionId: intent.sessionId,
        path: intent.path,
        location: intent.location,
      };
    },
    [connected, executionTarget, fsClient, identityKey, leasesRef, readSupported, resources, sessionId, workspaceRoot]
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
      <>
        <div className="w-72 flex-none min-w-0 min-h-0 border-r border-border [@media(max-width:700px)]:basis-1/3 [@media(max-width:700px)]:border-r-0 [@media(max-width:700px)]:border-b border-border">
          <WorkspaceFileTree
            executionTarget={executionTarget}
            fsClient={resources.fsClient}
            onOpenFile={handleOpenFile}
            selectedPath={selectedPath}
            watchRegistry={resources.watches}
          />
        </div>
        <div className="flex flex-1 min-w-0 min-h-0 flex-col">
          {selectedPath && selectedLease ? (
            <FileEditorPane
              connected={connected}
              executionTarget={executionTarget}
              fsClient={resources.fsClient}
              key={`${sessionId}:${selectedPath}`}
              lease={selectedLease}
              path={selectedPath}
              writeSupported={writeSupported}
              revealRequest={selection?.identityKey === identityKey ? selection.revealRequest : undefined}
            />
          ) : (
            <Empty className="h-full rounded-none border-0">
              <EmptyHeader>
                <EmptyTitle>No file selected</EmptyTitle>
                <EmptyDescription>Select a text file to inspect or edit it.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
        </div>
      </>
    );
  }

  return (
    <section
      className="flex min-w-0 min-h-0 w-full h-full bg-card [@media(max-width:700px)]:flex-col"
      aria-label="Workspace files"
    >
      {body}
      {lastOpened && (
        <div className="sr-only" role="status" aria-live="polite">
          Opened {lastOpened.path}
          {lastOpened.location ? ` at line ${lastOpened.location.line}` : ''}
        </div>
      )}
    </section>
  );
});
FilesSurface.displayName = 'FilesSurface';

/** Portal rendered inside the column's existing RPC provider. */
export function WorkspaceFilesPortal({
  host,
  executionTarget,
  sessionId,
  workspaceRoot,
}: FilesSurfaceProps & { host: HTMLDivElement }) {
  return createPortal(
    <FilesSurface executionTarget={executionTarget} sessionId={sessionId} workspaceRoot={workspaceRoot} />,
    host
  );
}
