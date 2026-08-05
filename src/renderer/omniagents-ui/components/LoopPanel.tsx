import React from 'react';

import { Button } from '@/renderer/ds/ui/button';
import { Card } from '@/renderer/ds/ui/card';

export type LoopTaskSnapshot = {
  id: string;
  prompt: string;
  mode: 'dynamic' | 'fixed_interval' | 'fixed_cron';
  cron: string | null;
  interval_seconds: number | null;
  recurring: boolean;
  created_at: number;
  expires_at: number | null;
  next_fire_at: number | null;
  fires: number;
  status: 'active' | 'cancelled' | 'expired' | 'completed';
  last_fire_at: number | null;
  last_reason: string | null;
  jitter_seconds: number;
};

const PROMPT_TRUNCATE = 100;

function shortPrompt(prompt: string, max: number): string {
  const oneLine = prompt.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= max) {
    return oneLine;
  }
  return `${oneLine.slice(0, max - 1)}…`;
}

function formatInterval(seconds: number): string {
  if (seconds < 60) {
    return `${Math.round(seconds)}s`;
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const rem = minutes - hours * 60;
  return rem === 0 ? `${hours}h` : `${hours}h${rem}m`;
}

function formatTimeRemaining(unixTimestamp: number): string {
  const remaining = Math.max(0, unixTimestamp - Date.now() / 1000);
  return formatInterval(remaining);
}

export function LoopPanel({ tasks, onDismiss }: { tasks: LoopTaskSnapshot[]; onDismiss?: () => void }) {
  const active = tasks.filter((task) => task.status === 'active');
  if (active.length === 0) {
    return null;
  }

  const next = [...active].sort(
    (a, b) => (a.next_fire_at ?? Number.MAX_SAFE_INTEGER) - (b.next_fire_at ?? Number.MAX_SAFE_INTEGER)
  )[0];
  if (!next) {
    return null;
  }
  const cadence =
    next.mode === 'dynamic'
      ? 'dynamic'
      : next.interval_seconds
        ? `every ${formatInterval(next.interval_seconds)}`
        : `cron ${next.cron}`;
  const tail = [cadence, `id ${next.id}`];
  if (next.next_fire_at) {
    tail.unshift(`in ${formatTimeRemaining(next.next_fire_at)}`);
  }
  if (active.length > 1) {
    tail.push(`${active.length} loops`);
  }

  return (
    <div className="px-3 pt-2">
      <Card className="gap-0 rounded-md border-accent bg-accent/60 px-2.5 py-1.5 shadow-none">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="inline-block w-1.5 h-1.5 rounded-full flex-shrink-0 bg-primary animate-pulse" aria-hidden />
          <span className="font-medium text-foreground">loop</span>
          <span aria-hidden>·</span>
          <span className="truncate min-w-0 text-foreground" title={next.prompt}>
            {shortPrompt(next.prompt, PROMPT_TRUNCATE)}
          </span>
          {tail.map((part, idx) => (
            <React.Fragment key={idx}>
              <span aria-hidden>·</span>
              <span className="whitespace-nowrap">{part}</span>
            </React.Fragment>
          ))}
          {onDismiss ? (
            <Button
              variant="ghost"
              size="xs"
              onClick={onDismiss}
              className="ml-auto"
              title="Dismiss loop status"
              aria-label="Dismiss loop status"
            >
              dismiss
            </Button>
          ) : null}
        </div>
      </Card>
    </div>
  );
}
