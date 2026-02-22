import type { SandboxProcessStatus } from '@/shared/types';

export const STATUS_LABELS: Partial<Record<SandboxProcessStatus['type'], string>> = {
  uninitialized: 'Idle',
  starting: 'Starting',
  running: 'Running',
  stopping: 'Stopping',
  exiting: 'Exiting',
  exited: 'Stopped',
  error: 'Error',
};

export const STATUS_COLORS: Partial<Record<SandboxProcessStatus['type'], string>> = {
  uninitialized: 'bg-fg-muted/30',
  starting: 'bg-yellow-400 animate-pulse',
  running: 'bg-green-400',
  stopping: 'bg-yellow-400',
  exiting: 'bg-yellow-400',
  exited: 'bg-fg-muted/30',
  error: 'bg-red-400',
};
