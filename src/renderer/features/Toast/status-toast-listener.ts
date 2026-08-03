import { $omniInstallProcessStatus } from '@/renderer/features/Omni/state';
import { toast } from '@/renderer/features/Toast/state';

/**
 * Subscribe to process status atoms and show toasts for error and notable state changes.
 */

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
