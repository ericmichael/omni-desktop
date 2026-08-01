import { Button as FluentButton, makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { Warning20Regular } from '@fluentui/react-icons';
import { useSelector } from '@xstate/react';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';

import { Button, Spinner } from '@/renderer/ds';
import { FsClient, WatchRegistry } from '@/renderer/omniagents-ui/rpc/fs';
import { useRPCClient, useRPCConnected } from '@/renderer/omniagents-ui/rpc-context';
import { type FileEditorLease, FileEditorRegistry } from '@/shared/machines/file-editor-registry';

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
  sessionId?: string;
  workspaceRoot?: string;
  isGlass?: boolean;
};

type FileEditorPaneProps = {
  path: string;
  sessionId: string;
  fsClient: FsClient;
  connected: boolean;
  lease: FileEditorLease;
  writeSupported: boolean;
  isGlass?: boolean;
  revealRequest?: { requestId: string; location: OpenFileLocation };
};

type FileSelection = {
  identityKey: string;
  path: string;
  revealRequest?: { requestId: string; location: OpenFileLocation };
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

const useStyles = makeStyles({
  root: {
    display: 'flex',
    minWidth: 0,
    minHeight: 0,
    width: '100%',
    height: '100%',
    backgroundColor: tokens.colorNeutralBackground1,
    '@media (max-width: 700px)': { flexDirection: 'column' },
  },
  rootGlass: { backgroundColor: 'transparent' },
  treePane: {
    flex: '0 0 18rem',
    minWidth: 0,
    minHeight: 0,
    borderRight: `1px solid ${tokens.colorNeutralStroke2}`,
    '@media (max-width: 700px)': {
      flexBasis: '35%',
      borderRight: 'none',
      borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    },
  },
  editorPane: { display: 'flex', flex: '1 1 0', minWidth: 0, minHeight: 0, flexDirection: 'column' },
  editorHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    minHeight: '42px',
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalM}`,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  editorHeaderGlass: { backgroundColor: 'transparent' },
  path: {
    minWidth: 0,
    flex: '1 1 auto',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground2,
  },
  editorFill: { flex: '1 1 0', minHeight: 0, minWidth: 0 },
  centered: {
    display: 'flex',
    flex: '1 1 0',
    minHeight: 0,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'column',
    gap: tokens.spacingVerticalM,
    padding: tokens.spacingVerticalXXL,
    textAlign: 'center',
    color: tokens.colorNeutralForeground3,
  },
  status: { fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground3, whiteSpace: 'nowrap' },
  dirty: { color: tokens.colorPaletteDarkOrangeForeground1 },
  error: { color: tokens.colorPaletteRedForeground1 },
  banner: {
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: tokens.spacingHorizontalS,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    borderBottom: `1px solid ${tokens.colorPaletteDarkOrangeBorderActive}`,
    backgroundColor: tokens.colorPaletteDarkOrangeBackground1,
    color: tokens.colorNeutralForeground1,
    fontSize: tokens.fontSizeBase200,
  },
  bannerText: { flex: '1 1 18rem' },
  visuallyHidden: {
    position: 'absolute',
    width: '1px',
    height: '1px',
    padding: 0,
    margin: '-1px',
    overflow: 'hidden',
    clip: 'rect(0, 0, 0, 0)',
    whiteSpace: 'nowrap',
    border: 0,
  },
});

const FileEditorPane = memo(
  ({ path, sessionId, fsClient, connected, lease, writeSupported, isGlass, revealRequest }: FileEditorPaneProps) => {
    const styles = useStyles();
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
        .stat(sessionId, path)
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
    }, [connected, fsClient, path, sessionId, statAttempt, writeSupported]);

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
        <div className={styles.centered} role="status">
          <Spinner size="md" />
          Loading {path}…
        </div>
      );
    }

    if (isLoadError) {
      return (
        <div className={styles.centered} role="alert">
          <span>{snapshot.context.error ?? `Could not load ${path}.`}</span>
          <Button onClick={() => lease.actor.send({ type: 'RETRY_LOAD' })}>Retry</Button>
        </div>
      );
    }

    return (
      <>
        <div className={mergeClasses(styles.editorHeader, isGlass && styles.editorHeaderGlass)}>
          <span className={styles.path} title={path}>
            {path}
          </span>
          <span
            className={`${styles.status} ${isDirty || isConflict ? styles.dirty : ''} ${snapshot.matches('saveError') ? styles.error : ''}`}
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
          <FluentButton
            appearance="primary"
            aria-label={`Save ${path}`}
            disabled={!canSave || isSaving}
            onClick={save}
            size="small"
          >
            Save
          </FluentButton>
        </div>
        {isConflict && (
          <div className={styles.banner} role="alert">
            <Warning20Regular />
            <span className={styles.bannerText}>
              {snapshot.context.diskDeleted
                ? 'This file was deleted outside the editor. Choose which version to keep.'
                : 'This file changed outside the editor. Choose which version to keep.'}
            </span>
            <Button size="sm" onClick={() => lease.actor.send({ type: 'USE_DISK' })}>
              Use disk version
            </Button>
            <Button size="sm" variant="primary" onClick={() => lease.actor.send({ type: 'KEEP_LOCAL' })}>
              Keep my changes
            </Button>
          </div>
        )}
        {writable === false && !isConflict && (
          <div className={styles.banner} role="status">
            This source is read-only. You can inspect it, but saving is disabled.
          </div>
        )}
        {statError && !isConflict && (
          <div className={styles.banner} role="alert">
            <span className={styles.bannerText}>{statError}</span>
            <Button size="sm" onClick={() => setStatAttempt((attempt) => attempt + 1)}>
              Retry permissions
            </Button>
          </div>
        )}
        {!connected && (
          <div className={styles.banner} role="status">
            Reconnecting to workspace… Your unsaved changes are preserved.
          </div>
        )}
        <div className={styles.editorFill} data-editor-state={state}>
          <CodeMirrorEditor
            ariaLabel={`Editor for ${path}`}
            autoFocus
            onChange={(content) => lease.actor.send({ type: 'EDIT', content })}
            onSave={save}
            readOnly={!connected || writable !== true || isConflict}
            value={snapshot.context.content}
            isGlass={isGlass}
            revealRequest={revealRequest}
          />
        </div>
      </>
    );
  }
);
FileEditorPane.displayName = 'FileEditorPane';

export const FilesSurface = memo(({ sessionId, workspaceRoot, isGlass }: FilesSurfaceProps) => {
  const styles = useStyles();
  const rpc = useRPCClient();
  const connected = useRPCConnected();
  const fsClient = useMemo(() => new FsClient(rpc), [rpc]);
  useEffect(() => () => fsClient.dispose(), [fsClient]);
  const identityKey = sessionId && workspaceRoot ? JSON.stringify([sessionId, workspaceRoot]) : null;
  const [preparedKey, setPreparedKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<FileSelection | null>(null);
  const [lastOpened, setLastOpened] = useState<{ path: string; location?: OpenFileLocation } | null>(null);
  const selectedPath = selection?.identityKey === identityKey ? selection.path : null;
  const leasesRef = useMemo(() => new Map<string, FileEditorLease>(), []);
  const readSupported = FILES_READ_OPERATIONS.every((operation) => rpc.supportsExperimentalOperation(operation));
  const writeSupported = FILES_WRITE_OPERATIONS.every((operation) => rpc.supportsExperimentalOperation(operation));

  const resources = useMemo(() => {
    if (!sessionId || !workspaceRoot) {
      return null;
    }
    const watches = new WatchRegistry(fsClient, sessionId);
    const editors = new FileEditorRegistry(new FsFileEditorIO(fsClient, watches));
    return { watches, editors };
  }, [fsClient, sessionId, workspaceRoot]);
  useEffect(
    () => () => {
      for (const lease of leasesRef.values()) {
        lease.release();
      }
      leasesRef.clear();
      resources?.editors.dispose();
      void resources?.watches.dispose();
    },
    [leasesRef, resources]
  );

  useEffect(() => {
    let active = true;
    setError(null);
    if (!connected || !sessionId || !workspaceRoot || !identityKey) {
      return () => {
        active = false;
      };
    }
    if (!readSupported) {
      setError('This agent runtime does not support workspace files.');
      return () => {
        active = false;
      };
    }
    void rpc
      .serverCall('session.ensure', { session_id: sessionId, workspace_root: workspaceRoot })
      .then(() => {
        if (active) {
          setPreparedKey(identityKey);
        }
      })
      .catch((reason: unknown) => {
        if (active) {
          setError(reason instanceof Error ? reason.message : 'Could not prepare the workspace session.');
        }
      });
    return () => {
      active = false;
    };
  }, [connected, identityKey, readSupported, rpc, sessionId, workspaceRoot]);

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
      if (!connected || !identityKey || !resources || !sessionId || !workspaceRoot) {
        return failed(
          'workspace-unavailable',
          'Workspace files are reconnecting or the session has no workspace. Try again shortly.'
        );
      }
      if (!readSupported) {
        return failed('unsupported', 'This agent runtime does not support workspace files.');
      }
      if (preparedKey !== identityKey) {
        try {
          await rpc.serverCall('session.ensure', { session_id: sessionId, workspace_root: workspaceRoot });
          setPreparedKey(identityKey);
        } catch (reason) {
          return failed(
            'workspace-unavailable',
            reason instanceof Error ? reason.message : 'Could not prepare the workspace session. Try again.'
          );
        }
      }
      try {
        const stat = await fsClient.stat(sessionId, intent.path);
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
    [connected, fsClient, identityKey, leasesRef, preparedKey, readSupported, resources, rpc, sessionId, workspaceRoot]
  );
  useEffect(() => {
    if (!sessionId) {
      return;
    }
    return registerOpenFileTarget(sessionId, handleOpenFileIntent);
  }, [handleOpenFileIntent, sessionId]);
  const selectedLease = selectedPath ? (leasesRef.get(selectedPath) ?? null) : null;

  let body;
  if (error) {
    body = (
      <div className={styles.centered} role="alert">
        {error}
      </div>
    );
  } else if (!identityKey || preparedKey !== identityKey || !sessionId || !resources) {
    body = (
      <div className={styles.centered} role="status">
        <Spinner size="md" />
        Preparing workspace files…
      </div>
    );
  } else {
    body = (
      <>
        <div className={styles.treePane}>
          <WorkspaceFileTree
            fsClient={fsClient}
            onOpenFile={handleOpenFile}
            selectedPath={selectedPath}
            sessionId={sessionId}
            watchRegistry={resources.watches}
            isGlass={isGlass}
          />
        </div>
        <div className={styles.editorPane}>
          {selectedPath && selectedLease ? (
            <FileEditorPane
              connected={connected}
              fsClient={fsClient}
              key={`${sessionId}:${selectedPath}`}
              lease={selectedLease}
              path={selectedPath}
              sessionId={sessionId}
              writeSupported={writeSupported}
              isGlass={isGlass}
              revealRequest={selection?.identityKey === identityKey ? selection.revealRequest : undefined}
            />
          ) : (
            <div className={styles.centered}>Select a text file to inspect or edit it.</div>
          )}
        </div>
      </>
    );
  }

  return (
    <section className={mergeClasses(styles.root, isGlass && styles.rootGlass)} aria-label="Workspace files">
      {body}
      {lastOpened && (
        <div className={styles.visuallyHidden} role="status" aria-live="polite">
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
  sessionId,
  workspaceRoot,
  isGlass,
}: FilesSurfaceProps & { host: HTMLDivElement }) {
  return createPortal(<FilesSurface sessionId={sessionId} workspaceRoot={workspaceRoot} isGlass={isGlass} />, host);
}
