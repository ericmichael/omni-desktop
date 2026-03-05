import type { FleetRunPhase, FleetTicketPriority, SandboxProcessStatus } from '@/shared/types';

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

export const COLUMN_SHORT_LABELS: Record<string, string> = {
  backlog: 'Backlog',
  spec: 'Spec',
  implementation: 'Impl',
  review: 'Rev',
  pr: 'PR',
  completed: 'Done',
};

/** Human-readable labels for granular run phases (shown when supervisor is running). */
export const RUN_PHASE_LABELS: Partial<Record<FleetRunPhase, string>> = {
  validating: 'Validating…',
  loading_workflow: 'Loading workflow…',
  preparing_workspace: 'Preparing workspace…',
  initializing_session: 'Initializing session…',
  building_prompt: 'Building prompt…',
  starting_run: 'Starting run…',
  streaming: 'Working…',
  continuing: 'Continuing…',
  finishing: 'Finishing…',
};
