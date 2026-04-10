import type { TicketPriority, TicketResolution, TicketPhase } from '@/shared/types';


export const TICKET_PRIORITY_LABELS: Record<TicketPriority, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  critical: 'Critical',
};

export type BadgeColor = 'default' | 'blue' | 'green' | 'purple' | 'red' | 'yellow' | 'sky' | 'orange';

export const TICKET_PRIORITY_COLORS: Record<TicketPriority, BadgeColor> = {
  low: 'default',
  medium: 'blue',
  high: 'orange',
  critical: 'red',
};

/** Column color definitions — each column maps to a hue used for border-top, background tint, and badge. */
type ColumnColorDef = {
  borderTop: string;
  background: string;
  badgeColor: string;
  badgeBg: string;
};

const COLUMN_COLOR_DEFS: Record<string, ColumnColorDef> = {
  backlog: { borderTop: '#6b7280', background: 'rgba(107, 114, 128, 0.05)', badgeColor: '#9ca3af', badgeBg: 'rgba(156, 163, 175, 0.1)' },
  spec: { borderTop: '#a855f7', background: 'rgba(168, 85, 247, 0.05)', badgeColor: '#c084fc', badgeBg: 'rgba(192, 132, 252, 0.1)' },
  implementation: { borderTop: '#3b82f6', background: 'rgba(59, 130, 246, 0.05)', badgeColor: '#60a5fa', badgeBg: 'rgba(96, 165, 250, 0.1)' },
  review: { borderTop: '#f97316', background: 'rgba(249, 115, 22, 0.05)', badgeColor: '#fb923c', badgeBg: 'rgba(251, 146, 60, 0.1)' },
  pr: { borderTop: '#6366f1', background: 'rgba(99, 102, 241, 0.05)', badgeColor: '#818cf8', badgeBg: 'rgba(129, 140, 248, 0.1)' },
  completed: { borderTop: '#22c55e', background: 'rgba(34, 197, 94, 0.05)', badgeColor: '#4ade80', badgeBg: 'rgba(74, 222, 128, 0.1)' },
};

const FALLBACK_COLORS: ColumnColorDef[] = [
  { borderTop: '#14b8a6', background: 'rgba(20, 184, 166, 0.05)', badgeColor: '#2dd4bf', badgeBg: 'rgba(45, 212, 191, 0.1)' },
  { borderTop: '#f43f5e', background: 'rgba(244, 63, 94, 0.05)', badgeColor: '#fb7185', badgeBg: 'rgba(251, 113, 133, 0.1)' },
  { borderTop: '#f59e0b', background: 'rgba(245, 158, 11, 0.05)', badgeColor: '#fbbf24', badgeBg: 'rgba(251, 191, 36, 0.1)' },
  { borderTop: '#06b6d4', background: 'rgba(6, 182, 212, 0.05)', badgeColor: '#22d3ee', badgeBg: 'rgba(34, 211, 238, 0.1)' },
  { borderTop: '#84cc16', background: 'rgba(132, 204, 22, 0.05)', badgeColor: '#a3e635', badgeBg: 'rgba(163, 230, 53, 0.1)' },
  { borderTop: '#d946ef', background: 'rgba(217, 70, 239, 0.05)', badgeColor: '#e879f9', badgeBg: 'rgba(232, 121, 249, 0.1)' },
];

/** Simple hash to get a stable index from a column ID. */
const stableIndex = (id: string, len: number): number => {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % len;
};

/** Returns the color definition for a column, falling back to a stable hash-based color for custom columns. */
export const getColumnColors = (columnId: string): ColumnColorDef =>
  COLUMN_COLOR_DEFS[columnId] ?? FALLBACK_COLORS[stableIndex(columnId, FALLBACK_COLORS.length)];



/** Human-readable labels for ticket resolutions. */
export const RESOLUTION_LABELS: Record<TicketResolution, string> = {
  completed: 'Completed',
  wont_do: "Won't do",
  duplicate: 'Duplicate',
  cancelled: 'Cancelled',
};

/** Badge colors for ticket resolutions. */
export const RESOLUTION_COLORS: Record<TicketResolution, BadgeColor> = {
  completed: 'green',
  wont_do: 'default',
  duplicate: 'yellow',
  cancelled: 'red',
};

/** Human-readable labels for ticket phases. */
export const PHASE_LABELS: Partial<Record<TicketPhase, string>> = {
  provisioning: 'Preparing workspace…',
  connecting: 'Connecting…',
  session_creating: 'Initializing session…',
  ready: 'Ready',
  running: 'Working…',
  continuing: 'Continuing…',
  awaiting_input: 'Awaiting input',
  retrying: 'Retrying…',
  error: 'Error',
  completed: 'Completed',
};

/** Phase colors for badges. */
export const PHASE_COLORS: Partial<Record<TicketPhase, BadgeColor>> = {
  provisioning: 'yellow',
  connecting: 'yellow',
  session_creating: 'yellow',
  ready: 'default',
  running: 'green',
  continuing: 'green',
  awaiting_input: 'blue',
  retrying: 'yellow',
  error: 'red',
  completed: 'default',
};
