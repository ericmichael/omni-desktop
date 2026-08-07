import React from 'react';

import { truncateOneLine } from '@/lib/text';
import { Button } from '@/renderer/ds/ui/button';
import { Card } from '@/renderer/ds/ui/card';

// Server payload from omni-code's /goal autopilot loop (server_functions/goal.py).
// snapshot=null means no goal is set on this session (panel renders nothing).
// "paused" is a non-terminal hold state — the periodic tick is off but
// the goal can be resumed via /goal.resume.
export type GoalSnapshot = {
  goal: string;
  turn: number;
  max_turns: number;
  tick_interval?: number;
  last_reason: string | null;
  status: 'active' | 'completed' | 'cancelled' | 'paused';
  started_at: number;
  completion_reason: string | null;
  // Auditable artifact attached on terminal states (achieved/blocked).
  evidence?: string | null;
};

const GOAL_TRUNCATE = 100;

function dotClass(status: GoalSnapshot['status']): string {
  if (status === 'active') {
    return 'bg-primary animate-pulse';
  }
  if (status === 'completed') {
    return 'bg-success';
  }
  if (status === 'paused') {
    return 'bg-warning';
  }
  return 'bg-destructive';
}

// Compact single-line docked panel for the /goal autopilot loop. Mirrors
// the ink TUI's Goal.tsx contract:
//   Active:    ● goal · <text>
//   Completed: ● goal · <text> · completed
//   Cancelled: ● goal · <text> · cancelled
export function GoalPanel({ snapshot, onDismiss }: { snapshot: GoalSnapshot | null; onDismiss?: () => void }) {
  if (!snapshot) {
    return null;
  }
  const terminal = snapshot.status === 'completed' || snapshot.status === 'cancelled';
  return (
    <div className="px-3 pt-2">
      <Card className="gap-0 rounded-md border-accent bg-accent/60 px-2.5 py-1.5 shadow-none">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span
            className={['inline-block w-1.5 h-1.5 rounded-full flex-shrink-0', dotClass(snapshot.status)].join(' ')}
            aria-hidden
          />
          <span className="font-medium text-foreground">goal</span>
          <span aria-hidden>·</span>
          <span className="truncate min-w-0 text-foreground" title={snapshot.goal}>
            {truncateOneLine(snapshot.goal, GOAL_TRUNCATE)}
          </span>
          {snapshot.status !== 'active' && (
            <span
              className={[
                'ml-auto whitespace-nowrap',
                snapshot.status === 'completed'
                  ? 'text-success'
                  : snapshot.status === 'paused'
                    ? 'text-warning'
                    : 'text-destructive',
              ].join(' ')}
            >
              {snapshot.status}
            </span>
          )}
          {terminal && onDismiss ? (
            <Button
              variant="ghost"
              size="xs"
              onClick={onDismiss}
              className="ml-1"
              title="Dismiss goal status"
              aria-label="Dismiss goal status"
            >
              dismiss
            </Button>
          ) : null}
        </div>
      </Card>
    </div>
  );
}
