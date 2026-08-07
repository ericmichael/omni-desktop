import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import { formatElapsed } from '@/lib/format-time';
import { oneLine } from '@/lib/text';
import { cn } from '@/renderer/ds/cn';
import { Badge } from '@/renderer/ds/ui/badge';

import type { BashJobSummary, SubagentSummary } from './activity-store';

/**
 * The one presentation vocabulary for background activity — status colors,
 * kind badges, labels, elapsed clocks, stop plumbing — shared by every
 * surface that renders subagents or bash jobs (the composer's pill
 * popovers, the Agents sidecar app). Rendering rules live here so the
 * surfaces can only differ in layout, never in meaning.
 */

// --- status → dot color -----------------------------------------------------

export function subagentDotClass(status: SubagentSummary['status']): string {
  if (status === 'running') {
    return 'bg-primary animate-pulse';
  }
  if (status === 'completed') {
    return 'bg-success';
  }
  // Cancelled is a user-intended stop, not a failure.
  return status === 'cancelled' ? 'bg-muted-foreground' : 'bg-destructive';
}

export function jobDotClass(job: BashJobSummary): string {
  if (job.running) {
    return 'bg-primary animate-pulse';
  }
  return job.exit_code === 0 ? 'bg-success' : 'bg-destructive';
}

export function StatusDot({ className }: { className: string }) {
  return <span className={cn('inline-block size-1.5 shrink-0 rounded-full', className)} aria-hidden />;
}

// --- labels -----------------------------------------------------------------

/** The kind chip's text — the single fallback chain for unnamed runs. */
export function subagentBadgeLabel(s: SubagentSummary): string {
  return s.kind === 'agent_tool' ? (s.agent ?? 'agent') : 'worker';
}

export function KindBadge({ subagent }: { subagent: SubagentSummary }) {
  return (
    <Badge variant="outline" className="shrink-0 px-1 py-0 text-[10px] font-normal">
      {subagentBadgeLabel(subagent)}
    </Badge>
  );
}

export function subagentLabel(s: SubagentSummary): string {
  return s.task || s.subagent_id;
}

export function jobLabel(j: BashJobSummary): string {
  return oneLine(j.command);
}

// --- elapsed clocks ---------------------------------------------------------

export function subagentElapsedMs(s: SubagentSummary, nowMs: number): number {
  if (s.status === 'running' && s.started_at) {
    return Math.max(nowMs - s.started_at * 1000, s.wall_time_ms ?? 0);
  }
  if (s.wall_time_ms != null) {
    return s.wall_time_ms;
  }
  return s.finished_at && s.started_at ? (s.finished_at - s.started_at) * 1000 : 0;
}

export function jobElapsedMs(job: BashJobSummary, nowMs: number): number {
  if (!job.running || !job.started_at) {
    return job.wall_time_ms;
  }
  return Math.max(nowMs - job.started_at * 1000, job.wall_time_ms);
}

/** 1s re-render tick while `ticking`; otherwise a stable "now". */
export function useNowMs(ticking: boolean): number {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!ticking) {
      return;
    }
    const id = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, [ticking]);
  return Date.now();
}

/** Self-ticking elapsed label — hosts don't need their own ticker, so a
 *  running item never forces siblings (or a markdown result) to re-render. */
export function SubagentElapsed({ subagent }: { subagent: SubagentSummary }) {
  const nowMs = useNowMs(subagent.status === 'running');
  return <>{formatElapsed(subagentElapsedMs(subagent, nowMs))}</>;
}

export function JobElapsed({ job }: { job: BashJobSummary }) {
  const nowMs = useNowMs(job.running);
  return <>{formatElapsed(jobElapsedMs(job, nowMs))}</>;
}

/** The row tail: elapsed alone while running, `status · elapsed` after. */
export function SubagentTail({ subagent }: { subagent: SubagentSummary }) {
  return subagent.status === 'running' ? (
    <SubagentElapsed subagent={subagent} />
  ) : (
    <>
      {subagent.status} · <SubagentElapsed subagent={subagent} />
    </>
  );
}

export function JobTail({ job }: { job: BashJobSummary }) {
  return job.running ? (
    <JobElapsed job={job} />
  ) : (
    <>
      exit {job.exit_code} · <JobElapsed job={job} />
    </>
  );
}

// --- stop plumbing ----------------------------------------------------------

export type StopController = {
  stopping: ReadonlySet<string>;
  /** Fire a stop; failures surface as a toast naming `label` (the task or
   *  command the user recognizes, not the machine id). */
  runStop: (id: string, label: string, stop: () => Promise<{ ok: boolean; error?: string }>) => void;
};

export function useStopController(): StopController {
  const [stopping, setStopping] = useState<ReadonlySet<string>>(new Set());
  const runStop = useCallback((id: string, label: string, stop: () => Promise<{ ok: boolean; error?: string }>) => {
    setStopping((prev) => new Set(prev).add(id));
    stop()
      .then((res) => {
        if (!res.ok) {
          toast.error(`Failed to stop “${oneLine(label)}”`, { description: res.error ?? 'unknown error' });
        }
      })
      .catch((e) => {
        toast.error(`Failed to stop “${oneLine(label)}”`, { description: (e as Error).message ?? String(e) });
      })
      .finally(() =>
        setStopping((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        })
      );
  }, []);
  return { stopping, runStop };
}

// --- live scroll ------------------------------------------------------------

/** Pin a scroll container to its bottom as `dep` changes — the terminal
 *  idiom: follow output until the user scrolls up, resume when they return
 *  to the bottom. */
export function useStickToBottom<T extends HTMLElement>(dep: unknown): RefObject<T | null> {
  const ref = useRef<T>(null);
  const pinned = useRef(true);
  useEffect(() => {
    const el = ref.current;
    if (!el) {
      return;
    }
    const onScroll = () => {
      pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && pinned.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [dep]);
  return ref;
}
