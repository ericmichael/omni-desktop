import { $chatProcessStatus } from '@/renderer/features/Chat/state';
import { $omniInstallProcessStatus } from '@/renderer/features/Omni/state';
import { toast } from '@/renderer/features/Toast/state';

/**
 * Subscribe to process status atoms and show toasts for error and notable state changes.
 */

let prevChatType: string = $chatProcessStatus.get().type;
$chatProcessStatus.subscribe((status) => {
  const prev = prevChatType;
  prevChatType = status.type;

  if (status.type === 'error' && prev !== 'error') {
    toast.error('Sandbox error', status.error.message);
  }
});

let prevInstallType: string = $omniInstallProcessStatus.get().type;
$omniInstallProcessStatus.subscribe((status) => {
  const prev = prevInstallType;
  prevInstallType = status.type;

  if (status.type === 'error' && prev !== 'error') {
    toast.error('Install error', status.error.message);
  }

  if (status.type === 'completed' && prev !== 'completed') {
    toast.success('Install complete', 'Omni runtime installed successfully.');
  }
});
