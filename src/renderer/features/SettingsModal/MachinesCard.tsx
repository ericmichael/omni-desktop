/**
 * Lists every Electron the signed-in principal has registered with the cloud
 * as a "computer-as-sandbox" host. Local Electron (the calling one) shows
 * `isSelf` and lets the user rename its label inline; peers can be renamed
 * or removed.
 *
 * No-op in browser/server mode (cloud is the renderer's runtime, not a
 * remote target) and in standalone-Electron mode (no cloud → no registry).
 */
import { useStore } from '@nanostores/react';
import { Monitor, Trash2 } from 'lucide-react';
import { memo, useCallback, useEffect, useState } from 'react';

import { cn } from '@/renderer/ds/cn';
import { Button } from '@/renderer/ds/ui/button';
import { Card, CardContent } from '@/renderer/ds/ui/card';
import { Input } from '@/renderer/ds/ui/input';
import { isCloudLinked, isElectron } from '@/renderer/services/ipc';
import {
  $machineIdentity,
  $machines,
  removeMachine,
  renameMachineRemote,
  setMachineLabel,
} from '@/renderer/services/machines';
import type { MachineSummary } from '@/shared/types';

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
      <div className="flex items-center gap-4 p-2 rounded-lg bg-card">
        <Monitor />
        <span
          className={`${'w-2 h-2 rounded shrink-0'} ${machine.online ? 'bg-success/20' : 'bg-border'}`}
          title={machine.online ? 'Online' : 'Offline'}
        />

        <div className="flex-1 min-w-0 flex flex-col gap-0.5">
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
            <div className="flex items-center gap-2">
              <span className="text-sm">{machine.label}</span>
              {machine.isSelf && (
                <span className="text-xs font-semibold text-primary uppercase tracking-wide">This device</span>
              )}
            </div>
          )}
          <span className={cn('text-xs text-muted-foreground', 'font-mono text-muted-foreground')}>
            {machine.platform} · {machine.machineId.slice(0, 8)}
          </span>
        </div>
        <div className="flex items-center gap-1">
          {editing ? (
            <>
              <Button size="sm" variant="ghost" onClick={cancelEdit} disabled={busy}>
                Cancel
              </Button>
              <Button size="sm" onClick={() => void submit()} disabled={busy}>
                {busy ? 'Saving…' : 'Save'}
              </Button>
            </>
          ) : (
            <>
              <Button size="sm" variant="ghost" onClick={startEdit}>
                Rename
              </Button>
              {onRemove && (
                <Button size="sm" variant="ghost" onClick={() => void onRemove()}>
                  <Trash2 />
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
      <CardContent className="flex flex-col gap-2">
        <div className="flex justify-between items-center">
          <div>
            <span className="text-sm">My computers</span>
            <span className={cn('text-xs text-muted-foreground', 'text-muted-foreground')}>
              Electrons signed in as you. The cloud can dispatch sandbox sessions to any of these when you pick them in
              the sandbox picker.
            </span>
          </div>
        </div>
        {list.length === 0 ? (
          <div className="py-4 text-muted-foreground italic">No machines registered yet.</div>
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
      </CardContent>
    </Card>
  );
});

MachinesCard.displayName = 'MachinesCard';
