/**
 * Sandboxes → Running: containers carrying the omni-code label, with the
 * session/tab that owns each. Actions are conservative (sandboxes-tab-plan.md
 * Decision 7): per-row remove for orphans only — protected rows show WHY
 * they're protected — plus the orphan sweep made visible.
 */

import { makeStyles, tokens } from '@fluentui/react-components';
import { ArrowClockwise16Regular, Delete16Regular } from '@fluentui/react-icons';
import { useStore } from '@nanostores/react';
import { memo, useCallback, useEffect, useState } from 'react';

import { Badge, Body1, Button, Caption1, Card, ConfirmDialog, IconButton, SectionLabel } from '@/renderer/ds';
import { $sandboxContainers, $sandboxesError, refreshSandboxContainers } from '@/renderer/features/Sandboxes/state';
import { formatRelativeTime } from '@/renderer/omniagents-ui/lib/utils';
import { emitter } from '@/renderer/services/ipc';
import type { SandboxContainerSummary } from '@/shared/types';

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
  ok: { color: tokens.colorPaletteGreenForeground1 },
  mono: { fontFamily: tokens.fontFamilyMonospace },
  truncated: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
});

const POLL_MS = 5000;

const OWNER_KIND_LABELS: Record<SandboxContainerSummary['ownerKind'], string> = {
  process: 'live session',
  'warm-reattach': 'warm reattach',
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
  const styles = useStyles();
  const containers = useStore($sandboxContainers);
  const fetchError = useStore($sandboxesError);

  const [pendingRemoveId, setPendingRemoveId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [sweeping, setSweeping] = useState(false);
  const [sweepResult, setSweepResult] = useState<string | null>(null);

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
    <div className={styles.root}>
      <SectionLabel>Running containers</SectionLabel>
      <div className={styles.toolbar}>
        <Button size="sm" variant="ghost" onClick={onSweepOrphans} isDisabled={sweeping}>
          {sweeping ? 'Sweeping…' : 'Sweep orphans'}
        </Button>
        <IconButton
          aria-label="Refresh containers"
          icon={<ArrowClockwise16Regular />}
          size="sm"
          tooltip="Refresh"
          onClick={onRefresh}
        />
        {sweepResult && <Caption1 className={styles.ok}>{sweepResult}</Caption1>}
      </div>
      <Card>
        <div className={styles.list}>
          {containers.length === 0 && <Caption1 className={styles.summary}>No sandbox containers.</Caption1>}
          {containers.map((container) => {
            const protectedRow = container.ownerKind !== 'orphan';
            return (
              <div key={container.id} className={styles.row}>
                <div className={styles.main}>
                  <Body1 className={styles.truncated}>{container.name}</Body1>
                  <Caption1 className={`${styles.summary} ${styles.truncated}`}>
                    {`${container.image} · created ${relativeCreated(container.createdAt)}`}
                  </Caption1>
                  {container.ownerLabel && <Caption1 className={styles.summary}>{container.ownerLabel}</Caption1>}
                </div>
                <div className={styles.chips}>
                  <Badge color={container.state === 'running' ? 'green' : 'default'}>{container.state}</Badge>
                  <Badge color={container.ownerKind === 'orphan' ? 'yellow' : 'blue'}>
                    {OWNER_KIND_LABELS[container.ownerKind]}
                  </Badge>
                </div>
                <IconButton
                  aria-label={protectedRow ? `In use by ${container.ownerLabel ?? 'a session'}` : 'Remove container'}
                  icon={<Delete16Regular />}
                  size="sm"
                  isDisabled={protectedRow}
                  tooltip={protectedRow ? `In use by ${container.ownerLabel ?? 'a session'}` : 'Remove container'}
                  onClick={() => setPendingRemoveId(container.id)}
                />
              </div>
            );
          })}
        </div>
        {actionError && <Caption1 className={styles.error}>{actionError}</Caption1>}
        {fetchError && <Caption1 className={styles.error}>{fetchError}</Caption1>}
      </Card>

      <ConfirmDialog
        open={pendingRemoveId !== null}
        onClose={closeConfirm}
        onConfirm={onConfirmRemove}
        title="Remove container?"
        description={`Force-remove ${pendingContainer?.name ?? 'this container'}. Anything running inside it is lost.`}
        confirmLabel="Remove"
        destructive
      />
    </div>
  );
});
RunningPane.displayName = 'RunningPane';
