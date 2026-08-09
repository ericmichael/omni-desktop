import { useStore } from '@nanostores/react';
import { ArrowLeftIcon, ChevronRightIcon, SquareIcon } from 'lucide-react';
import {
  Fragment,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { toast } from 'sonner';

import { formatElapsed } from '@/lib/format-time';
import { oneLine } from '@/lib/text';
import { cn } from '@/renderer/ds/cn';
import { Badge } from '@/renderer/ds/ui/badge';
import { Button } from '@/renderer/ds/ui/button';
import { Item, ItemContent, ItemDescription, ItemMedia, ItemTitle } from '@/renderer/ds/ui/item';
import { Spinner } from '@/renderer/ds/ui/spinner';

import { $activityFocus, type BashJobSummary, clearActivityFocus, type SubagentSummary } from './activity-store';

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

// --- state grouping ----------------------------------------------------------

const byRecency = <T extends { started_at?: number | null }>(a: T, b: T): number =>
  (b.started_at ?? 0) - (a.started_at ?? 0);

/** The list sections, in the pill popovers' counting vocabulary: running
 *  (live, snapshot order), failed (errors plus cancellations — the
 *  needs-attention shelf), completed (successes, recent first). */
export function groupSubagents(subagents: SubagentSummary[]): {
  running: SubagentSummary[];
  failed: SubagentSummary[];
  completed: SubagentSummary[];
} {
  return {
    running: subagents.filter((s) => s.status === 'running'),
    failed: subagents.filter((s) => s.status === 'error' || s.status === 'cancelled').sort(byRecency),
    completed: subagents.filter((s) => s.status === 'completed').sort(byRecency),
  };
}

/** Jobs grouped the same way; a null exit code (killed) counts as failed. */
export function groupJobs(jobs: BashJobSummary[]): {
  running: BashJobSummary[];
  failed: BashJobSummary[];
  completed: BashJobSummary[];
} {
  return {
    running: jobs.filter((j) => j.running),
    failed: jobs.filter((j) => !j.running && j.exit_code !== 0).sort(byRecency),
    completed: jobs.filter((j) => !j.running && j.exit_code === 0).sort(byRecency),
  };
}

// --- master-list scaffolding -------------------------------------------------

/** One list row: status dot, two-line label, badge + tail line, and a
 *  chevron signalling navigation into the detail view. */
export function ActivityListRow({
  itemId,
  dotClass,
  badge,
  label,
  mono,
  tail,
  onOpen,
}: {
  itemId: string;
  dotClass: string;
  badge?: ReactNode;
  label: string;
  mono?: boolean;
  tail: ReactNode;
  onOpen: (id: string) => void;
}) {
  // flex-nowrap + min-w-0 down the chain — Item defaults to flex-wrap and
  // ItemContent to min-width:auto, either of which defeats the title's
  // single-line truncation.
  return (
    <Item asChild size="sm" className="w-full flex-nowrap gap-2 px-2 py-1.5 hover:bg-accent/50">
      <button type="button" title={label} onClick={() => onOpen(itemId)}>
        <ItemMedia>
          <StatusDot className={dotClass} />
        </ItemMedia>
        <ItemContent className="min-w-0 gap-0.5">
          <ItemTitle
            className={cn('block w-full truncate text-left text-xs font-normal text-foreground', mono && 'font-mono')}
          >
            {label}
          </ItemTitle>
          <ItemDescription className="line-clamp-none flex w-full items-center gap-1.5 text-xs">
            {badge}
            <span className="ml-auto whitespace-nowrap">{tail}</span>
          </ItemDescription>
        </ItemContent>
        <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      </button>
    </Item>
  );
}

export function ActivitySectionLabel({ children }: { children: string }) {
  return (
    <p
      aria-hidden
      className="px-2.5 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground first:pt-1"
    >
      {children}
    </p>
  );
}

/**
 * List → detail navigation for one activity surface: null means the list
 * view; an item id means its full-surface detail view (with a back
 * affordance). Pill-popover deep links open the detail directly, scoped by
 * item-id prefix so the Agents and Jobs apps each take only their own
 * links.
 */
export function useActivityDetail(
  sessionId: string,
  focusPrefix: string
): { openId: string | null; open: (id: string) => void; back: () => void } {
  const [openId, setOpenId] = useState<string | null>(null);
  const focus = useStore($activityFocus);
  useEffect(() => {
    if (focus && focus.sessionId === sessionId && focus.itemId.startsWith(focusPrefix)) {
      setOpenId(focus.itemId);
      clearActivityFocus();
    }
  }, [focus, sessionId, focusPrefix]);
  const back = useCallback(() => setOpenId(null), []);
  return { openId, open: setOpenId, back };
}

/** The detail view's back affordance, leading its header row. */
export function ActivityBackButton({ onBack }: { onBack: () => void }) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      className="shrink-0"
      aria-label="Back to list"
      title="Back to list"
      onClick={onBack}
    >
      <ArrowLeftIcon className="size-4" />
    </Button>
  );
}

// --- detail-page shared pieces ----------------------------------------------

export function ActivityStopButton({
  id,
  label,
  stop,
  controller,
}: {
  id: string;
  label: string;
  stop: () => Promise<{ ok: boolean; error?: string }>;
  controller: StopController;
}) {
  const busy = controller.stopping.has(id);
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="shrink-0"
      disabled={busy}
      onClick={() => controller.runStop(id, label, stop)}
    >
      {busy ? <Spinner className="size-3.5" /> : <SquareIcon className="size-3.5" />}
      Stop
    </Button>
  );
}

/** Overline heading for one detail-page section (Task, Activity, Result, Log). */
export function ActivityDetailLabel({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <p className={cn('mb-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground', className)}>
      {children}
    </p>
  );
}

/** Labeled key/value facts — replaces the old unlabeled meta token soup.
 *  Rows with empty values are dropped. */
export function ActivityMetaGrid({ rows }: { rows: ReadonlyArray<readonly [string, ReactNode]> }) {
  const shown = rows.filter(([, value]) => value !== null && value !== undefined && value !== '');
  if (shown.length === 0) {
    return null;
  }
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-xs">
      {shown.map(([label, value]) => (
        <Fragment key={label}>
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="min-w-0 break-all text-foreground">{value}</dd>
        </Fragment>
      ))}
    </dl>
  );
}
