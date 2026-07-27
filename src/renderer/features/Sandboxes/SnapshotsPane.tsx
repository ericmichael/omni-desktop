/**
 * Sandboxes → Snapshots: workspace rehydration tars under
 * `<config>/snapshots/`. Rows are deletable via the existing
 * `snapshot:delete` channel (idempotent, rides the normal emitter); in-use
 * snapshots — still claimed by a resumable tab/conversation — get the same
 * disabled-with-reason treatment as protected containers in RunningPane.
 */

import { makeStyles, tokens } from '@fluentui/react-components';
import { ArrowClockwise16Regular, Delete16Regular } from '@fluentui/react-icons';
import { useStore } from '@nanostores/react';
import { memo, useCallback, useEffect, useState } from 'react';

import { Badge, Body1, Caption1, Card, ConfirmDialog, IconButton, SectionLabel } from '@/renderer/ds';
import { formatBytes } from '@/renderer/features/Sandboxes/format-bytes';
import { $sandboxesError, $sandboxSnapshots, refreshSandboxSnapshots } from '@/renderer/features/Sandboxes/state';
import { formatRelativeTime } from '@/renderer/omniagents-ui/lib/utils';
import { emitter } from '@/renderer/services/ipc';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM },
  toolbar: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  list: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalM,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalS}`,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  main: { flex: '1 1 0', minWidth: 0, display: 'flex', flexDirection: 'column', gap: '2px' },
  chips: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, flexShrink: 0 },
  summary: { color: tokens.colorNeutralForeground2 },
  error: { color: tokens.colorPaletteRedForeground1 },
  mono: { fontFamily: tokens.fontFamilyMonospace },
  truncated: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
});

/**
 * Session ids are opaque and only differ at the edges — middle-truncate so
 * both the prefix and the disambiguating tail survive.
 */
const middleTruncate = (text: string, max = 28): string => {
  if (text.length <= max) {
    return text;
  }
  const head = Math.ceil((max - 1) / 2);
  const tail = max - 1 - head;
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`;
};

export const SnapshotsPane = memo(() => {
  const styles = useStyles();
  const snapshots = useStore($sandboxSnapshots);
  const fetchError = useStore($sandboxesError);

  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    void refreshSandboxSnapshots();
  }, []);

  const onRefresh = useCallback(() => {
    void refreshSandboxSnapshots();
  }, []);

  const closeConfirm = useCallback(() => setPendingDeleteId(null), []);

  const onConfirmDelete = useCallback(() => {
    if (!pendingDeleteId) {
      return;
    }
    setActionError(null);
    void emitter
      .invoke('snapshot:delete', pendingDeleteId)
      .then(refreshSandboxSnapshots)
      .catch((err: unknown) => setActionError(err instanceof Error ? err.message : String(err)));
  }, [pendingDeleteId]);

  const totalBytes = snapshots.reduce((sum, snapshot) => sum + snapshot.sizeBytes, 0);
  const pendingSnapshot = snapshots.find((s) => s.sessionId === pendingDeleteId) ?? null;

  return (
    <div className={styles.root}>
      <SectionLabel>Snapshots</SectionLabel>
      <div className={styles.toolbar}>
        <Caption1 className={styles.summary}>{`Total on disk: ${formatBytes(totalBytes)}`}</Caption1>
        <IconButton
          aria-label="Refresh snapshots"
          icon={<ArrowClockwise16Regular />}
          size="sm"
          tooltip="Refresh"
          onClick={onRefresh}
        />
      </div>
      <Card>
        <div className={styles.list}>
          {snapshots.length === 0 && <Caption1 className={styles.summary}>No workspace snapshots.</Caption1>}
          {snapshots.map((snapshot) => (
            <div key={snapshot.sessionId} className={styles.row}>
              <div className={styles.main}>
                <Body1 className={styles.truncated}>{snapshot.label ?? middleTruncate(snapshot.sessionId)}</Body1>
                <Caption1 className={`${styles.summary} ${styles.truncated}`}>
                  {`${formatBytes(snapshot.sizeBytes)} · modified ${formatRelativeTime(new Date(snapshot.modifiedAt))}`}
                </Caption1>
                {snapshot.label !== null && (
                  <Caption1 className={`${styles.summary} ${styles.mono} ${styles.truncated}`}>
                    {middleTruncate(snapshot.sessionId)}
                  </Caption1>
                )}
              </div>
              <div className={styles.chips}>{snapshot.inUse && <Badge color="blue">in use</Badge>}</div>
              <IconButton
                aria-label={
                  snapshot.inUse ? 'In use — a tab or conversation can still resume this session' : 'Delete snapshot'
                }
                icon={<Delete16Regular />}
                size="sm"
                isDisabled={snapshot.inUse}
                tooltip={
                  snapshot.inUse ? 'In use — a tab or conversation can still resume this session' : 'Delete snapshot'
                }
                onClick={() => setPendingDeleteId(snapshot.sessionId)}
              />
            </div>
          ))}
        </div>
        {actionError && <Caption1 className={styles.error}>{actionError}</Caption1>}
        {fetchError && <Caption1 className={styles.error}>{fetchError}</Caption1>}
      </Card>

      <ConfirmDialog
        open={pendingDeleteId !== null}
        onClose={closeConfirm}
        onConfirm={onConfirmDelete}
        title="Delete snapshot?"
        description={`Delete the workspace snapshot for ${pendingSnapshot?.label ?? middleTruncate(pendingSnapshot?.sessionId ?? '')}. The session can no longer be rehydrated from it.`}
        confirmLabel="Delete"
        destructive
      />
    </div>
  );
});
SnapshotsPane.displayName = 'SnapshotsPane';
