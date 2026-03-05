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

const COLUMN_COLORS_MAP: Record<string, string> = {
  backlog: 'border-t-gray-500',
  spec: 'border-t-purple-500',
  implementation: 'border-t-blue-500',
  review: 'border-t-orange-500',
  pr: 'border-t-indigo-500',
  completed: 'border-t-green-500',
};

const COLUMN_BG_COLORS_MAP: Record<string, string> = {
  backlog: 'bg-gray-500/5',
  spec: 'bg-purple-500/5',
  implementation: 'bg-blue-500/5',
  review: 'bg-orange-500/5',
  pr: 'bg-indigo-500/5',
  completed: 'bg-green-500/5',
};

const COLUMN_BADGE_COLORS_MAP: Record<string, string> = {
  backlog: 'text-gray-400 bg-gray-400/10',
  spec: 'text-purple-400 bg-purple-400/10',
  implementation: 'text-blue-400 bg-blue-400/10',
  review: 'text-orange-400 bg-orange-400/10',
  pr: 'text-indigo-400 bg-indigo-400/10',
  completed: 'text-green-400 bg-green-400/10',
};

/** Fallback color cycle for custom columns not in the default set. */
const FALLBACK_BORDER_COLORS = [
  'border-t-teal-500',
  'border-t-rose-500',
  'border-t-amber-500',
  'border-t-cyan-500',
  'border-t-lime-500',
  'border-t-fuchsia-500',
];

const FALLBACK_BG_COLORS = [
  'bg-teal-500/5',
  'bg-rose-500/5',
  'bg-amber-500/5',
  'bg-cyan-500/5',
  'bg-lime-500/5',
  'bg-fuchsia-500/5',
];

const FALLBACK_BADGE_COLORS = [
  'text-teal-400 bg-teal-400/10',
  'text-rose-400 bg-rose-400/10',
  'text-amber-400 bg-amber-400/10',
  'text-cyan-400 bg-cyan-400/10',
  'text-lime-400 bg-lime-400/10',
  'text-fuchsia-400 bg-fuchsia-400/10',
];

/** Simple hash to get a stable index from a column ID. */
const stableIndex = (id: string, len: number): number => {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % len;
};

export const COLUMN_COLORS: Record<string, string> = new Proxy(COLUMN_COLORS_MAP, {
  get: (target, prop: string) => target[prop] ?? FALLBACK_BORDER_COLORS[stableIndex(prop, FALLBACK_BORDER_COLORS.length)],
});

export const COLUMN_BG_COLORS: Record<string, string> = new Proxy(COLUMN_BG_COLORS_MAP, {
  get: (target, prop: string) => target[prop] ?? FALLBACK_BG_COLORS[stableIndex(prop, FALLBACK_BG_COLORS.length)],
});

export const COLUMN_BADGE_COLORS: Record<string, string> = new Proxy(COLUMN_BADGE_COLORS_MAP, {
  get: (target, prop: string) =>
    target[prop] ?? FALLBACK_BADGE_COLORS[stableIndex(prop, FALLBACK_BADGE_COLORS.length)],
});

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
