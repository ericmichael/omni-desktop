import { $omniInstallProcessStatus } from '@/renderer/features/Omni/state';
import { toast } from '@/renderer/features/Toast/state';
import { $agentStatuses } from '@/renderer/services/agent-process';

/**
 * Subscribe to process status atoms and show toasts for error and notable state changes.
 */

const REHYDRATE_TITLE = 'Sandbox container was replaced';
const REHYDRATE_BODY =
  'Your files were restored from a snapshot, but running processes (dev servers, shells) are gone. Restart anything that was running before.';

// Every agent process gets the tier-2 rehydrate notice on its running
// transition. Hard errors surface in the owning column's own chrome
// (SessionStatusBanner / error view), so there's no per-process error toast.
const prevAgentTypes = new Map<string, string>();
$agentStatuses.listen((statuses) => {
  for (const [processId, status] of Object.entries(statuses)) {
    const prev = prevAgentTypes.get(processId);
    prevAgentTypes.set(processId, status.type);

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
