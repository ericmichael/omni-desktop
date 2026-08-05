/**
 * Sandboxes → Snapshots: workspace rehydration tars under
 * `<config>/snapshots/`. Rows are deletable via the existing
 * `snapshot:delete` channel (idempotent, rides the normal emitter); in-use
 * snapshots — still claimed by a resumable tab/conversation — get the same
 * disabled-with-reason treatment as protected containers in RunningPane.
 */
import { useStore } from '@nanostores/react';
import { RefreshCw, Trash2 } from 'lucide-react';
import { memo, useCallback, useEffect, useState } from 'react';

import { cn } from '@/renderer/ds/cn';
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
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/renderer/ds/ui/card';
import { formatBytes } from '@/renderer/features/Sandboxes/format-bytes';
import { $sandboxesError, $sandboxSnapshots, refreshSandboxSnapshots } from '@/renderer/features/Sandboxes/state';
import { formatRelativeTime } from '@/renderer/omniagents-ui/lib/utils';
import { emitter } from '@/renderer/services/ipc';

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
  const pendingSnapshot = snapshots.find((s) => s.snapshotRef === pendingDeleteId) ?? null;

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Workspace snapshots</CardTitle>
          <CardDescription>{`${formatBytes(totalBytes)} stored on disk for restoring sandbox workspaces.`}</CardDescription>
          <CardAction>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Refresh snapshots"
              onClick={onRefresh}
              title="Refresh"
            >
              <RefreshCw />
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-col gap-1">
            {snapshots.length === 0 && (
              <span className={cn('text-xs text-muted-foreground', 'text-muted-foreground')}>
                No workspace snapshots.
              </span>
            )}
            {snapshots.map((snapshot) => (
              <div
                key={snapshot.snapshotRef}
                className="flex min-w-0 flex-wrap items-center gap-3 p-2 rounded-lg bg-card"
              >
                <div className="flex-1 min-w-0 flex flex-col gap-0.5">
                  <span className={cn('text-sm', 'overflow-hidden text-ellipsis whitespace-nowrap')}>
                    {snapshot.label ?? middleTruncate(snapshot.snapshotRef)}
                  </span>
                  <span
                    className={cn(
                      'text-xs text-muted-foreground',
                      `${'text-muted-foreground'} ${'overflow-hidden text-ellipsis whitespace-nowrap'}`
                    )}
                  >
                    {`${formatBytes(snapshot.sizeBytes)} · modified ${formatRelativeTime(new Date(snapshot.modifiedAt))}`}
                  </span>
                  {snapshot.label !== null && (
                    <span
                      className={cn(
                        'text-xs text-muted-foreground',
                        `${'text-muted-foreground'} ${'font-mono'} ${'overflow-hidden text-ellipsis whitespace-nowrap'}`
                      )}
                    >
                      {middleTruncate(snapshot.snapshotRef)}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  {snapshot.inUse && <Badge variant="secondary">in use</Badge>}
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={snapshot.inUse ? 'In use — an open tab owns this Workspace snapshot' : 'Delete snapshot'}
                  disabled={snapshot.inUse}
                  onClick={() => setPendingDeleteId(snapshot.snapshotRef)}
                  title={snapshot.inUse ? 'In use — an open tab owns this Workspace snapshot' : 'Delete snapshot'}
                >
                  <Trash2 />
                </Button>
              </div>
            ))}
          </div>
          {actionError && (
            <span className={cn('text-xs text-muted-foreground', 'text-destructive')}>{actionError}</span>
          )}
          {fetchError && <span className={cn('text-xs text-muted-foreground', 'text-destructive')}>{fetchError}</span>}
        </CardContent>
      </Card>

      <AlertDialog open={pendingDeleteId !== null} onOpenChange={(open) => !open && closeConfirm()}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete snapshot?</AlertDialogTitle>
            <AlertDialogDescription>
              Delete the Workspace snapshot for{' '}
              {pendingSnapshot?.label ?? middleTruncate(pendingSnapshot?.snapshotRef ?? '')}. Future environments can no
              longer hydrate from it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={onConfirmDelete}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
});
SnapshotsPane.displayName = 'SnapshotsPane';
