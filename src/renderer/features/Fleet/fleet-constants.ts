import type { FleetPhaseStatus, FleetTicketPriority, FleetTicketStatus, SandboxProcessStatus } from '@/shared/types';

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

export const STATUS_TEXT_COLORS: Partial<Record<SandboxProcessStatus['type'], string>> = {
  uninitialized: 'text-fg-subtle',
  starting: 'text-yellow-500 animate-pulse',
  running: 'text-green-500',
  stopping: 'text-yellow-500',
  exiting: 'text-yellow-500',
  exited: 'text-fg-subtle',
  error: 'text-red-500',
};

export const STATUS_BOX_COLORS: Partial<Record<SandboxProcessStatus['type'], string>> = {
  uninitialized: 'bg-surface-overlay/50 border-surface-border text-fg-subtle',
  starting: 'bg-yellow-500/10 border-yellow-500/30 text-yellow-500 animate-pulse',
  running: 'bg-green-500/10 border-green-500/30 text-green-500',
  stopping: 'bg-yellow-500/10 border-yellow-500/30 text-yellow-500',
  exiting: 'bg-yellow-500/10 border-yellow-500/30 text-yellow-500',
  exited: 'bg-surface-overlay/50 border-surface-border text-fg-subtle',
  error: 'bg-red-500/10 border-red-500/30 text-red-500',
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

export const COLUMN_COLORS: Record<string, string> = {
  backlog: 'border-t-gray-500',
  spec: 'border-t-purple-500',
  implementation: 'border-t-blue-500',
  review: 'border-t-orange-500',
  pr: 'border-t-indigo-500',
  completed: 'border-t-green-500',
};

export const COLUMN_BG_COLORS: Record<string, string> = {
  backlog: 'bg-gray-500/5',
  spec: 'bg-purple-500/5',
  implementation: 'bg-blue-500/5',
  review: 'bg-orange-500/5',
  pr: 'bg-indigo-500/5',
  completed: 'bg-green-500/5',
};

export const COLUMN_BADGE_COLORS: Record<string, string> = {
  backlog: 'text-gray-400 bg-gray-400/10',
  spec: 'text-purple-400 bg-purple-400/10',
  implementation: 'text-blue-400 bg-blue-400/10',
  review: 'text-orange-400 bg-orange-400/10',
  pr: 'text-indigo-400 bg-indigo-400/10',
  completed: 'text-green-400 bg-green-400/10',
};

export const PHASE_STATUS_LABELS: Record<FleetPhaseStatus, string> = {
  pending: 'Pending',
  running: 'Running',
  completed: 'Completed',
  blocked: 'Blocked',
  rejected: 'Rejected',
  skipped: 'Skipped',
};

export const COLUMN_SHORT_LABELS: Record<string, string> = {
  backlog: 'Backlog',
  spec: 'Spec',
  implementation: 'Impl',
  review: 'Rev',
  pr: 'PR',
  completed: 'Done',
};

export const PHASE_STATUS_COLORS: Record<FleetPhaseStatus, string> = {
  pending: 'text-fg-muted bg-fg-muted/10',
  running: 'text-green-400 bg-green-400/10',
  completed: 'text-blue-400 bg-blue-400/10',
  blocked: 'text-orange-400 bg-orange-400/10',
  rejected: 'text-red-400 bg-red-400/10',
  skipped: 'text-fg-subtle bg-fg-subtle/10',
};
