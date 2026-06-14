/**
 * Lists every Electron the signed-in principal has registered with the cloud
 * as a "computer-as-sandbox" host. Local Electron (the calling one) shows
 * `isSelf` and lets the user rename its label inline; peers can be renamed
 * or removed.
 *
 * No-op in browser/server mode (cloud is the renderer's runtime, not a
 * remote target) and in standalone-Electron mode (no cloud → no registry).
 */
import { makeStyles, tokens } from '@fluentui/react-components';
import { Delete16Regular, Desktop16Regular } from '@fluentui/react-icons';
import { useStore } from '@nanostores/react';
import { memo, useCallback, useEffect, useState } from 'react';

import { Body1, Button, Caption1, Card, Input } from '@/renderer/ds';
import { isCloudLinked, isElectron } from '@/renderer/services/ipc';
import {
  $machineIdentity,
  $machines,
  removeMachine,
  renameMachineRemote,
  setMachineLabel,
} from '@/renderer/services/machines';
import type { MachineSummary } from '@/shared/types';

const useStyles = makeStyles({
  card: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  summary: { color: tokens.colorNeutralForeground2 },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalM,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalS}`,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  meta: { flex: '1 1 0', minWidth: 0, display: 'flex', flexDirection: 'column', gap: '2px' },
  dot: {
    width: '8px',
    height: '8px',
    borderRadius: '4px',
    flexShrink: 0,
  },
  dotOnline: { backgroundColor: tokens.colorPaletteGreenBackground3 },
  dotOffline: { backgroundColor: tokens.colorNeutralStroke2 },
  labelRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  selfTag: {
    fontSize: tokens.fontSizeBase100,
    fontWeight: tokens.fontWeightSemibold,
    color: tokens.colorBrandForeground1,
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
  },
  id: {
    fontFamily: tokens.fontFamilyMonospace,
    color: tokens.colorNeutralForeground3,
  },
  actions: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS },
  empty: {
    padding: `${tokens.spacingVerticalM} 0`,
    color: tokens.colorNeutralForeground3,
    fontStyle: 'italic',
  },
});

const MachineRow = memo(
  ({
    machine,
    onSave,
    onRemove,
  }: {
    machine: MachineSummary;
    onSave: (label: string) => Promise<void>;
    onRemove?: () => Promise<void>;
  }) => {
    const styles = useStyles();
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState(machine.label);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
      // Keep the input in sync when an external change lands (e.g. another
      // device renamed the same machine).
      if (!editing) {
        setDraft(machine.label);
      }
    }, [machine.label, editing]);

    const startEdit = useCallback(() => {
      setDraft(machine.label);
      setEditing(true);
    }, [machine.label]);

    const cancelEdit = useCallback(() => {
      setDraft(machine.label);
      setEditing(false);
    }, [machine.label]);

    const submit = useCallback(async () => {
      const next = draft.trim();
      if (!next || next === machine.label) {
        cancelEdit();
        return;
      }
      setBusy(true);
      try {
        await onSave(next);
        setEditing(false);
      } finally {
        setBusy(false);
      }
    }, [draft, machine.label, onSave, cancelEdit]);

    return (
      <div className={styles.row}>
        <Desktop16Regular />
        <span
          className={`${styles.dot} ${machine.online ? styles.dotOnline : styles.dotOffline}`}
          title={machine.online ? 'Online' : 'Offline'}
        />
        <div className={styles.meta}>
          {editing ? (
            <Input
              autoFocus
              value={draft}
              disabled={busy}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  void submit();
                } else if (e.key === 'Escape') {
                  cancelEdit();
                }
              }}
            />
          ) : (
            <div className={styles.labelRow}>
              <Body1>{machine.label}</Body1>
              {machine.isSelf && <span className={styles.selfTag}>This device</span>}
            </div>
          )}
          <Caption1 className={styles.id}>
            {machine.platform} · {machine.machineId.slice(0, 8)}
          </Caption1>
        </div>
        <div className={styles.actions}>
          {editing ? (
            <>
              <Button size="sm" variant="ghost" onClick={cancelEdit} isDisabled={busy}>
                Cancel
              </Button>
              <Button size="sm" onClick={() => void submit()} isDisabled={busy}>
                {busy ? 'Saving…' : 'Save'}
              </Button>
            </>
          ) : (
            <>
              <Button size="sm" variant="ghost" onClick={startEdit}>
                Rename
              </Button>
              {onRemove && (
                <Button size="sm" variant="ghost" onClick={() => void onRemove()} leftIcon={<Delete16Regular />}>
                  Remove
                </Button>
              )}
            </>
          )}
        </div>
      </div>
    );
  }
);
MachineRow.displayName = 'MachineRow';

export const MachinesCard = memo(() => {
  const styles = useStyles();
  const identity = useStore($machineIdentity);
  const machines = useStore($machines);

  if (!isElectron || !isCloudLinked) {
    return null;
  }

  // The cloud might not have echoed back our own row yet (race on first
  // boot); merge a placeholder in so the user still sees their local
  // identity in the list.
  const list: MachineSummary[] = [...machines];
  if (identity && !list.some((m) => m.machineId === identity.machineId)) {
    list.unshift({
      machineId: identity.machineId,
      label: identity.label,
      platform: identity.platform,
      online: true,
      isSelf: true,
      registeredAt: '',
      lastSeenAt: '',
    });
  }

  return (
    <Card>
      <div className={styles.card}>
        <div className={styles.header}>
          <div>
            <Body1>My computers</Body1>
            <Caption1 className={styles.summary}>
              Electrons signed in as you. The cloud can dispatch sandbox sessions to any of these when you pick them in
              the sandbox picker.
            </Caption1>
          </div>
        </div>
        {list.length === 0 ? (
          <div className={styles.empty}>No machines registered yet.</div>
        ) : (
          list.map((m) => (
            <MachineRow
              key={m.machineId}
              machine={m}
              onSave={async (label) => {
                if (m.isSelf) {
                  // Local edit → main rewrites the file → re-registers,
                  // which the cloud will broadcast back.
                  await setMachineLabel(label);
                } else {
                  await renameMachineRemote(m.machineId, label);
                }
              }}
              onRemove={
                m.isSelf
                  ? undefined
                  : async () => {
                      await removeMachine(m.machineId);
                    }
              }
            />
          ))
        )}
      </div>
    </Card>
  );
});

MachinesCard.displayName = 'MachinesCard';
