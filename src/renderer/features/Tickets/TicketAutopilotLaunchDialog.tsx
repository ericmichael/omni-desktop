import { useStore } from '@nanostores/react';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';

import { AnimatedDialog, Button, DialogBody, DialogContent, DialogFooter, DialogHeader } from '@/renderer/ds';
import { SandboxPicker } from '@/renderer/features/SandboxProfile/SandboxPicker';
import { emitter } from '@/renderer/services/ipc';
import { persistedStoreApi } from '@/renderer/services/store';

import { $autopilotLaunchTicketId, ticketApi } from './state';

export const TicketAutopilotLaunchDialog = memo(() => {
  const ticketId = useStore($autopilotLaunchTicketId);
  const store = useStore(persistedStoreApi.$atom);
  const [isEnterprise, setIsEnterprise] = useState(false);
  const ticket = useMemo(() => store.tickets.find((item) => item.id === ticketId), [store.tickets, ticketId]);
  const project = useMemo(
    () => store.projects.find((item) => item.id === ticket?.projectId),
    [store.projects, ticket?.projectId]
  );
  const defaultProfileName = project?.sandboxProfile ?? store.defaultProfileName ?? 'host';
  const [profileName, setProfileName] = useState(defaultProfileName);

  useEffect(() => {
    emitter.invoke('platform:is-enterprise').then(setIsEnterprise);
  }, []);

  useEffect(() => {
    if (ticketId) {
      setProfileName(defaultProfileName);
    }
  }, [ticketId, defaultProfileName]);

  const handleClose = useCallback(() => {
    $autopilotLaunchTicketId.set(null);
  }, []);

  const handleStart = useCallback(() => {
    if (!ticketId) {
      return;
    }
    $autopilotLaunchTicketId.set(null);
    void ticketApi.startSupervisor(ticketId, { profileName });
  }, [profileName, ticketId]);

  if (!ticketId || !ticket) {
    return null;
  }

  return (
    <AnimatedDialog open onClose={handleClose}>
      <DialogContent className="max-w-md">
        <DialogHeader>Start autopilot</DialogHeader>
        <DialogBody className="flex flex-col gap-3">
          <div className="text-sm text-fg-muted">
            Choose the sandbox profile for this autopilot run.
          </div>
          <div className="flex items-center justify-between gap-3 rounded-lg border border-stroke-1 bg-bgCard p-3">
            <div className="min-w-0">
              <div className="truncate text-sm font-medium text-fg">{ticket.title || 'Untitled ticket'}</div>
              <div className="text-xs text-fg-subtle">Defaults to the project or global sandbox setting.</div>
            </div>
            <SandboxPicker
              value={profileName}
              onChange={setProfileName}
              context={{ isEnterprise, available: store.availableSandboxProfiles }}
            />
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={handleClose}>Cancel</Button>
          <Button onClick={handleStart}>Start autopilot</Button>
        </DialogFooter>
      </DialogContent>
    </AnimatedDialog>
  );
});

TicketAutopilotLaunchDialog.displayName = 'TicketAutopilotLaunchDialog';
