import type { TicketPhase, TicketPriority } from '@/shared/types';

export const TICKET_PRIORITY_LABELS: Record<TicketPriority, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  critical: 'Critical',
};

/** Semantic classes for the priority dot on task rows (lists, board, home). */
export const PRIORITY_DOT_CLASSES: Record<TicketPriority, string> = {
  critical: 'bg-destructive',
  high: 'bg-warning',
  medium: 'bg-primary',
  low: 'bg-muted-foreground',
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
  columnClassName: string;
  badgeClassName: string;
};

const COLUMN_COLOR_DEFS: Record<string, ColumnColorDef> = {
  backlog: {
    columnClassName: 'border-t-muted-foreground bg-muted/50',
    badgeClassName: 'bg-muted text-muted-foreground',
  },
  spec: {
    columnClassName: 'border-t-chart-1 bg-chart-1/5',
    badgeClassName: 'bg-chart-1/10 text-chart-1',
  },
  implementation: {
    columnClassName: 'border-t-chart-2 bg-chart-2/5',
    badgeClassName: 'bg-chart-2/10 text-chart-2',
  },
  review: {
    columnClassName: 'border-t-warning bg-warning/5',
    badgeClassName: 'bg-warning/10 text-warning',
  },
  pr: {
    columnClassName: 'border-t-chart-4 bg-chart-4/5',
    badgeClassName: 'bg-chart-4/10 text-chart-4',
  },
  completed: {
    columnClassName: 'border-t-success bg-success/5',
    badgeClassName: 'bg-success/10 text-success',
  },
};

const FALLBACK_COLORS: ColumnColorDef[] = [
  {
    columnClassName: 'border-t-chart-1 bg-chart-1/5',
    badgeClassName: 'bg-chart-1/10 text-chart-1',
  },
  {
    columnClassName: 'border-t-chart-2 bg-chart-2/5',
    badgeClassName: 'bg-chart-2/10 text-chart-2',
  },
  {
    columnClassName: 'border-t-chart-3 bg-chart-3/5',
    badgeClassName: 'bg-chart-3/10 text-chart-3',
  },
  {
    columnClassName: 'border-t-chart-4 bg-chart-4/5',
    badgeClassName: 'bg-chart-4/10 text-chart-4',
  },
  {
    columnClassName: 'border-t-chart-5 bg-chart-5/5',
    badgeClassName: 'bg-chart-5/10 text-chart-5',
  },
  {
    columnClassName: 'border-t-primary bg-primary/5',
    badgeClassName: 'bg-primary/10 text-primary',
  },
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
  COLUMN_COLOR_DEFS[columnId] ?? FALLBACK_COLORS[stableIndex(columnId, FALLBACK_COLORS.length)]!;

/** Human-readable labels for ticket phases. */
export const PHASE_LABELS: Partial<Record<TicketPhase, string>> = {
  provisioning: 'Preparing workspace…',
  connecting: 'Connecting…',
  session_creating: 'Initializing session…',
  ready: 'Ready',
  running: 'Working…',
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
  error: 'red',
  completed: 'default',
};
