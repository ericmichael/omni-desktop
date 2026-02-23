import type { FleetTicketPriority, FleetTicketStatus, SandboxProcessStatus } from '@/shared/types';

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

export const TICKET_STATUS_LABELS: Record<FleetTicketStatus, string> = {
  open: 'Open',
  in_progress: 'In Progress',
  completed: 'Completed',
  closed: 'Closed',
};

export const TICKET_STATUS_COLORS: Record<FleetTicketStatus, string> = {
  open: 'bg-blue-400',
  in_progress: 'bg-yellow-400 animate-pulse',
  completed: 'bg-green-400',
  closed: 'bg-fg-muted/30',
};

export const TICKET_PRIORITY_LABELS: Record<FleetTicketPriority, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  critical: 'Critical',
};

export const TICKET_PRIORITY_COLORS: Record<FleetTicketPriority, string> = {
  low: 'text-fg-muted bg-fg-muted/10',
  medium: 'text-blue-400 bg-blue-400/10',
  high: 'text-orange-400 bg-orange-400/10',
  critical: 'text-red-400 bg-red-400/10',
};
