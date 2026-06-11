import { $omniInstallProcessStatus } from '@/renderer/features/Omni/state';
import { toast } from '@/renderer/features/Toast/state';
import { $agentStatuses } from '@/renderer/services/agent-process';
import { CHAT_TAB_ID } from '@/shared/types';

/**
 * Subscribe to process status atoms and show toasts for error and notable state changes.
 */

const REHYDRATE_TITLE = 'Sandbox container was replaced';
const REHYDRATE_BODY =
  'Your files were restored from a snapshot, but running processes (dev servers, shells) are gone. Restart anything that was running before.';

// Every agent process (the chat record included — it's just the tab with the
// reserved id) gets the tier-2 rehydrate notice on its running transition.
// Chat additionally surfaces hard errors as toasts: it's the ambient surface
// with no column chrome of its own to show them in.
const prevAgentTypes = new Map<string, string>();
$agentStatuses.listen((statuses) => {
  for (const [processId, status] of Object.entries(statuses)) {
    const prev = prevAgentTypes.get(processId);
    prevAgentTypes.set(processId, status.type);

    if (processId === CHAT_TAB_ID && status.type === 'error' && prev !== 'error') {
      const full = status.error.message;
      // Show a short summary in the toast; keep the full error available for Copy.
      const firstLine = full.split('\n').find((l) => l.trim().length > 0) ?? full;
      toast.error('Omni Code error', firstLine, { copyText: full });
    }

    // ``reused`` (tier 1) is silent because nothing changed. ``fresh`` (tier 3)
    // is silent because there was no prior runtime state to mourn.
    if (status.type === 'running' && prev !== 'running' && status.data.resume === 'rehydrated') {
      toast.warning(REHYDRATE_TITLE, REHYDRATE_BODY);
    }
  }
});

let prevInstallType: string = $omniInstallProcessStatus.get().type;
$omniInstallProcessStatus.subscribe((status) => {
  const prev = prevInstallType;
  prevInstallType = status.type;

  if (status.type === 'error' && prev !== 'error') {
    const full = status.error.message;
    const firstLine = full.split('\n').find((l) => l.trim().length > 0) ?? full;
    toast.error('Install error', firstLine, { copyText: full });
  }

  if (status.type === 'completed' && prev !== 'completed') {
    toast.success('Install complete', 'Omni runtime installed successfully.');
  }
});
