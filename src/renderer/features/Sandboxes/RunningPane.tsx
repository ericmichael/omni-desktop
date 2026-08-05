/**
 * Sandboxes → Running: containers carrying the omni-code label, with the
 * session/tab that owns each. Actions are conservative (sandboxes-tab-plan.md
 * Decision 7): per-row remove for orphans only — protected rows show WHY
 * they're protected — plus the orphan sweep made visible. Per-row Logs opens
 * a dialog with the last 500 lines from `sandbox:container-logs`.
 */
import { useStore } from '@nanostores/react';
import { FileText, RefreshCw, Trash2 } from 'lucide-react';
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
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/renderer/ds/ui/dialog';
import { $sandboxContainers, $sandboxesError, refreshSandboxContainers } from '@/renderer/features/Sandboxes/state';
import { formatRelativeTime } from '@/renderer/omniagents-ui/lib/utils';
import { emitter } from '@/renderer/services/ipc';
import type { SandboxContainerSummary } from '@/shared/types';

const POLL_MS = 5000;

/** Tail length for the container-logs dialog. */
const LOG_TAIL_LINES = 500;

const OWNER_KIND_LABELS: Record<SandboxContainerSummary['ownerKind'], string> = {
  process: 'live session',
  orphan: 'orphan',
};

/**
 * Docker's `.CreatedAt` ("2026-07-27 10:00:00 +0000 UTC") isn't a JS-parsable
 * date as-is — strip the trailing zone name; fall back to the raw string.
 */
const relativeCreated = (createdAt: string): string => {
  const parsed = new Date(createdAt.replace(/ [A-Z]{3,4}$/, ''));
  return Number.isNaN(parsed.getTime()) ? createdAt : formatRelativeTime(parsed);
};

export const RunningPane = memo(() => {
  const containers = useStore($sandboxContainers);
  const fetchError = useStore($sandboxesError);

  const [pendingRemoveId, setPendingRemoveId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [sweeping, setSweeping] = useState(false);
  const [sweepResult, setSweepResult] = useState<string | null>(null);

  // Logs dialog. The target is a {id, name} snapshot (not a live row) so the
  // dialog survives the 5s poll removing/replacing the container entry.
  const [logsTarget, setLogsTarget] = useState<{ id: string; name: string } | null>(null);
  const [logs, setLogs] = useState<string | null>(null);
  const [logsError, setLogsError] = useState<string | null>(null);

  const fetchLogs = useCallback((id: string) => {
    setLogsError(null);
    void emitter
      .invoke('sandbox:container-logs', id, LOG_TAIL_LINES)
      .then(({ logs: text }) => setLogs(text))
      .catch((err: unknown) => setLogsError(err instanceof Error ? err.message : String(err)));
  }, []);

  const openLogs = useCallback(
    (container: SandboxContainerSummary) => {
      setLogsTarget({ id: container.id, name: container.name });
      setLogs(null);
      fetchLogs(container.id);
    },
    [fetchLogs]
  );

  const closeLogs = useCallback(() => {
    setLogsTarget(null);
    setLogs(null);
    setLogsError(null);
  }, []);

  const onRefreshLogs = useCallback(() => {
    if (logsTarget) {
      fetchLogs(logsTarget.id);
    }
  }, [logsTarget, fetchLogs]);

  // Poll while visible; the pane unmounts on pane-switch, clearing the timer.
  useEffect(() => {
    void refreshSandboxContainers();
    const interval = setInterval(() => void refreshSandboxContainers(), POLL_MS);
    return () => clearInterval(interval);
  }, []);

  const onRefresh = useCallback(() => {
    void refreshSandboxContainers();
  }, []);

  const closeConfirm = useCallback(() => setPendingRemoveId(null), []);

  const onConfirmRemove = useCallback(() => {
    if (!pendingRemoveId) {
      return;
    }
    setActionError(null);
    void emitter
      .invoke('sandbox:remove-container', pendingRemoveId)
      .then(refreshSandboxContainers)
      .catch((err: unknown) => setActionError(err instanceof Error ? err.message : String(err)));
  }, [pendingRemoveId]);

  const onSweepOrphans = useCallback(() => {
    setSweeping(true);
    setActionError(null);
    void emitter
      .invoke('sandbox:sweep-orphans')
      .then(async ({ removed }) => {
        setSweepResult(`${removed.length} removed`);
        setTimeout(() => setSweepResult(null), 4000);
        await refreshSandboxContainers();
      })
      .catch((err: unknown) => setActionError(err instanceof Error ? err.message : String(err)))
      .finally(() => setSweeping(false));
  }, []);

  const pendingContainer = containers.find((c) => c.id === pendingRemoveId) ?? null;

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Running containers</CardTitle>
          <CardDescription>Active sandbox environments and containers left behind by closed sessions.</CardDescription>
          <CardAction className="flex items-center gap-2">
            <Button size="sm" variant="ghost" onClick={onSweepOrphans} disabled={sweeping}>
              {sweeping ? 'Cleaning…' : 'Clean up orphans'}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Refresh containers"
              onClick={onRefresh}
              title="Refresh"
            >
              <RefreshCw />
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent className="space-y-3">
          {sweepResult && <span className={cn('text-xs text-muted-foreground', 'text-success')}>{sweepResult}</span>}
          <div className="flex flex-col gap-1">
            {containers.length === 0 && (
              <span className={cn('text-xs text-muted-foreground', 'text-muted-foreground')}>
                No sandbox containers.
              </span>
            )}
            {containers.map((container) => {
              const protectedRow = container.ownerKind !== 'orphan';
              return (
                <div key={container.id} className="flex min-w-0 flex-wrap items-center gap-3 p-2 rounded-lg bg-card">
                  <div className="flex-1 min-w-0 flex flex-col gap-0.5">
                    <span className={cn('text-sm', 'overflow-hidden text-ellipsis whitespace-nowrap')}>
                      {container.name}
                    </span>
                    <span
                      className={cn(
                        'text-xs text-muted-foreground',
                        `${'text-muted-foreground'} ${'overflow-hidden text-ellipsis whitespace-nowrap'}`
                      )}
                    >
                      {`${container.image} · created ${relativeCreated(container.createdAt)}`}
                    </span>
                    {container.ownerLabel && (
                      <span className={cn('text-xs text-muted-foreground', 'text-muted-foreground')}>
                        {container.ownerLabel}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Badge variant="secondary">{container.state}</Badge>
                    <Badge variant="secondary">{OWNER_KIND_LABELS[container.ownerKind]}</Badge>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Show container logs"
                    onClick={() => openLogs(container)}
                    title="Logs"
                  >
                    <FileText />
                  </Button>

                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={protectedRow ? `In use by ${container.ownerLabel ?? 'a session'}` : 'Remove container'}
                    disabled={protectedRow}
                    onClick={() => setPendingRemoveId(container.id)}
                    title={protectedRow ? `In use by ${container.ownerLabel ?? 'a session'}` : 'Remove container'}
                  >
                    <Trash2 />
                  </Button>
                </div>
              );
            })}
          </div>
          {actionError && (
            <span className={cn('text-xs text-muted-foreground', 'text-destructive')}>{actionError}</span>
          )}
          {fetchError && <span className={cn('text-xs text-muted-foreground', 'text-destructive')}>{fetchError}</span>}
        </CardContent>
      </Card>

      <AlertDialog open={pendingRemoveId !== null} onOpenChange={(open) => !open && closeConfirm()}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove container?</AlertDialogTitle>
            <AlertDialogDescription>
              Force-remove {pendingContainer?.name ?? 'this container'}. Anything running inside it is lost.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={onConfirmRemove}>
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={logsTarget !== null} onOpenChange={(open) => !open && closeLogs()}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>{`Logs — ${logsTarget?.name ?? ''}`}</DialogTitle>
          </DialogHeader>
          <div className="min-h-0 overflow-y-auto">
            {logsError && <span className={cn('text-xs text-muted-foreground', 'text-destructive')}>{logsError}</span>}
            {logs !== null ? (
              <pre className="font-mono text-xs bg-card rounded-lg p-2 overflow-auto whitespace-pre m-0 max-h-dvh">
                {logs.length > 0 ? logs : 'No log output.'}
              </pre>
            ) : (
              !logsError && (
                <span className={cn('text-xs text-muted-foreground', 'text-muted-foreground')}>Loading logs…</span>
              )
            )}
          </div>
          <DialogFooter>
            <Button size="sm" variant="ghost" onClick={onRefreshLogs}>
              Refresh
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
});
RunningPane.displayName = 'RunningPane';
