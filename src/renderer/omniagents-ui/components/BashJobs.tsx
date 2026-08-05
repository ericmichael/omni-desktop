import React, { useCallback, useEffect, useRef, useState } from 'react';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/renderer/ds/ui/alert-dialog';
import { Button } from '@/renderer/ds/ui/button';
import { Card } from '@/renderer/ds/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/renderer/ds/ui/dialog';

export type BashJobSummary = {
  job_id: string;
  pid: number;
  command: string;
  running: boolean;
  exit_code: number | null;
  wall_time_ms: number;
  started_at?: number;
  log_path?: string;
  cwd?: string;
};

export type BashJobsTailResult = {
  ok: boolean;
  text?: string;
  total_lines?: number;
  job?: BashJobSummary;
  error?: string;
  message?: string;
};

export type BashJobsKillResult = {
  ok: boolean;
  signal_sent?: 'none' | 'SIGTERM' | 'SIGKILL';
  job?: BashJobSummary;
  snapshot?: BashJobSummary[];
  error?: string;
};

const MAX_VISIBLE = 5;
const COMMAND_TRUNCATE = 80;
const TAIL_DEFAULT_LINES = 200;

function shortCommand(command: string): string {
  const oneLine = command.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= COMMAND_TRUNCATE) {
    return oneLine;
  }
  return `${oneLine.slice(0, COMMAND_TRUNCATE - 1)}…`;
}

function formatElapsed(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  const seconds = ms / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const rem = Math.floor(seconds - minutes * 60);
  return `${minutes}m${rem.toString().padStart(2, '0')}s`;
}

function liveElapsedMs(job: BashJobSummary, nowMs: number): number {
  if (!job.running || !job.started_at) {
    return job.wall_time_ms;
  }
  const elapsed = nowMs - job.started_at * 1000;
  return Math.max(elapsed, job.wall_time_ms);
}

function dotClass(job: BashJobSummary): string {
  if (job.running) {
    return 'bg-primary animate-pulse';
  }
  return job.exit_code === 0 ? 'bg-success' : 'bg-destructive';
}

type BashJobRowProps = {
  job: BashJobSummary;
  nowMs: number;
  isKilling: boolean;
  onShowLogs?: (jobId: string) => void;
  onKill?: (jobId: string) => void;
  onDismiss?: (jobId: string) => void;
};

// One row of the docked panel. Pulled out of the parent map so the per-row
// callbacks can use `.bind(null, jobId)` instead of inline arrows — keeps
// `react/jsx-no-bind` satisfied without growing the parent component.
function BashJobRow({ job, nowMs, isKilling, onShowLogs, onKill, onDismiss }: BashJobRowProps) {
  const elapsed = formatElapsed(liveElapsedMs(job, nowMs));
  const tail = job.running ? elapsed : `exit ${job.exit_code} · ${elapsed}`;
  return (
    <li className="flex items-center gap-2 text-xs leading-5">
      <span className={['inline-block w-1.5 h-1.5 rounded-full flex-shrink-0', dotClass(job)].join(' ')} aria-hidden />
      <span className="text-muted-foreground font-mono">{job.job_id}</span>
      <span
        className={[
          'min-w-0 truncate font-mono',
          job.running ? 'text-foreground' : 'text-muted-foreground line-through',
        ].join(' ')}
        title={job.command}
      >
        {shortCommand(job.command)}
      </span>
      <span className="ml-auto text-muted-foreground whitespace-nowrap">{tail}</span>
      {onShowLogs ? (
        <Button
          variant="ghost"
          size="xs"
          onClick={onShowLogs.bind(null, job.job_id)}
          className="text-muted-foreground"
          title="View recent log output"
        >
          logs
        </Button>
      ) : null}
      {onKill && job.running ? (
        <Button
          variant="ghost"
          size="icon-xs"
          disabled={isKilling}
          onClick={onKill.bind(null, job.job_id)}
          className="text-muted-foreground hover:text-destructive"
          title={`Terminate ${job.job_id} (SIGTERM, then SIGKILL)`}
          aria-label={`Terminate job ${job.job_id}`}
        >
          {isKilling ? '…' : '✕'}
        </Button>
      ) : null}
      {onDismiss && !job.running ? (
        <Button
          variant="ghost"
          size="xs"
          onClick={onDismiss.bind(null, job.job_id)}
          className="text-muted-foreground"
          title={`Dismiss job ${job.job_id}`}
          aria-label={`Dismiss job ${job.job_id}`}
        >
          dismiss
        </Button>
      ) : null}
    </li>
  );
}

type Props = {
  jobs: BashJobSummary[];
  onKill?: (job_id: string) => Promise<BashJobsKillResult>;
  onTail?: (job_id: string, lines?: number) => Promise<BashJobsTailResult>;
  onDismiss?: (job_id: string) => void;
  // Optional: fired once on mount when at least one job is running, so the
  // server-side sweeper has a chance to capture a service handle and start
  // pushing ``ui.bash_jobs.update`` broadcasts on natural exits.
  onWarmup?: () => Promise<unknown>;
};

export function BashJobs({ jobs, onKill, onTail, onWarmup, onDismiss }: Props) {
  // 1Hz tick while at least one job is running so elapsed time updates.
  const [, setNowTick] = useState(0);
  const anyRunning = jobs.some((j) => j.running);
  useEffect(() => {
    if (!anyRunning) {
      return;
    }
    const id = window.setInterval(() => setNowTick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, [anyRunning]);

  // One-shot warmup: when running jobs first appear (mount or after spawn),
  // fire onWarmup so the server-side sweeper captures a service handle.
  const warmedUpRef = useRef(false);
  useEffect(() => {
    if (!anyRunning) {
      warmedUpRef.current = false;
      return;
    }
    if (warmedUpRef.current || !onWarmup) {
      return;
    }
    warmedUpRef.current = true;
    onWarmup().catch(() => {
      warmedUpRef.current = false;
    });
  }, [anyRunning, onWarmup]);

  const [killing, setKilling] = useState<Set<string>>(new Set());
  const [pendingKillJobId, setPendingKillJobId] = useState<string | null>(null);
  const [logsModalJobId, setLogsModalJobId] = useState<string | null>(null);
  const [killError, setKillError] = useState<string | null>(null);

  const confirmKill = useCallback(async () => {
    const job_id = pendingKillJobId;
    if (!job_id || !onKill) {
      return;
    }
    setKillError(null);
    setKilling((prev) => {
      const next = new Set(prev);
      next.add(job_id);
      return next;
    });
    try {
      const res = await onKill(job_id);
      if (!res.ok) {
        setKillError(`Failed to kill ${job_id}: ${res.error ?? 'unknown error'}`);
      }
    } catch (e) {
      setKillError(`Failed to kill ${job_id}: ${(e as Error).message ?? String(e)}`);
    } finally {
      setKilling((prev) => {
        const next = new Set(prev);
        next.delete(job_id);
        return next;
      });
    }
  }, [onKill, pendingKillJobId]);

  const handleShowLogs = useCallback((jobId: string) => setLogsModalJobId(jobId), []);
  const handleCloseLogs = useCallback(() => setLogsModalJobId(null), []);

  if (!jobs || jobs.length === 0) {
    return null;
  }

  const running = jobs.filter((j) => j.running);
  const exited = jobs.filter((j) => !j.running);
  const failed = exited.filter((j) => (j.exit_code ?? 0) !== 0);
  const succeeded = exited.length - failed.length;

  const ordered = [...running, ...exited.slice().sort((a, b) => (b.started_at ?? 0) - (a.started_at ?? 0))];
  const visible = ordered.slice(0, MAX_VISIBLE);
  const overflow = ordered.length - visible.length;
  const nowMs = Date.now();

  const rowShowLogs = onTail ? handleShowLogs : undefined;
  const rowKill = onKill ? setPendingKillJobId : undefined;

  return (
    <div className="px-3 pt-2">
      <Card className="gap-0 rounded-md border-accent bg-accent/60 p-2.5 shadow-none">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">Bash jobs</span>
          <span aria-hidden>·</span>
          <span>
            <span className="text-primary">{running.length}</span> running
          </span>
          <span aria-hidden>·</span>
          <span>
            <span className="text-success">{succeeded}</span> done
          </span>
          <span aria-hidden>·</span>
          <span>
            <span className="text-destructive">{failed.length}</span> failed
          </span>
        </div>
        {killError ? <div className="mt-1 text-xs text-destructive">{killError}</div> : null}
        {visible.length > 0 ? (
          <ul className="mt-1.5 space-y-1">
            {visible.map((j) => (
              <BashJobRow
                key={j.job_id}
                job={j}
                nowMs={nowMs}
                isKilling={killing.has(j.job_id)}
                onShowLogs={rowShowLogs}
                onKill={rowKill}
                onDismiss={onDismiss}
              />
            ))}
          </ul>
        ) : null}
        {overflow > 0 ? <div className="mt-1 text-xs text-muted-foreground">… +{overflow} more</div> : null}
      </Card>

      {logsModalJobId && onTail ? (
        <BashJobLogsModal jobId={logsModalJobId} onClose={handleCloseLogs} onTail={onTail} />
      ) : null}
      <AlertDialog open={pendingKillJobId !== null} onOpenChange={(open) => !open && setPendingKillJobId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Terminate background job?</AlertDialogTitle>
            <AlertDialogDescription>
              Terminate background job {pendingKillJobId}? Any in-progress work from this process will stop.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void confirmKill()}>
              Terminate
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

type ModalProps = {
  jobId: string;
  onClose: () => void;
  onTail: (job_id: string, lines?: number) => Promise<BashJobsTailResult>;
};

function BashJobLogsModal({ jobId, onClose, onTail }: ModalProps) {
  const [text, setText] = useState<string>('');
  const [meta, setMeta] = useState<BashJobsTailResult | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await onTail(jobId, TAIL_DEFAULT_LINES);
      setMeta(res);
      if (!res.ok) {
        setError(res.message ?? res.error ?? 'Failed to read logs');
        setText('');
      } else {
        setText(res.text ?? '');
      }
    } catch (e) {
      setError((e as Error).message ?? String(e));
    } finally {
      setLoading(false);
    }
  }, [jobId, onTail]);

  useEffect(() => {
    load();
  }, [load]);

  const job = meta?.job;
  const total = meta?.total_lines ?? 0;
  const shown = text ? text.split('\n').length : 0;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-dialog flex max-w-4xl flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="flex-row items-center gap-3 border-b px-4 py-2.5 pr-12 text-left">
          <div className="min-w-0 flex-1">
            <DialogTitle className="truncate font-mono text-sm">{jobId}</DialogTitle>
            <DialogDescription className="text-xs">
              {job
                ? `${job.running ? 'running' : `exited(${job.exit_code})`} · ${formatElapsed(job.wall_time_ms)}`
                : 'Job logs'}
            </DialogDescription>
          </div>
          <span className="ml-auto text-muted-foreground">
            {shown} of {total} lines
          </span>
          <Button type="button" variant="ghost" size="sm" onClick={load} disabled={loading} title="Refresh">
            Refresh
          </Button>
        </DialogHeader>
        <div className="flex-1 overflow-auto px-4 py-3 font-mono text-xs whitespace-pre text-foreground">
          {loading ? (
            <span className="text-muted-foreground italic">Loading…</span>
          ) : error ? (
            <span className="text-destructive">{error}</span>
          ) : text ? (
            text
          ) : (
            <span className="text-muted-foreground italic">(no log output)</span>
          )}
        </div>
        {job?.log_path ? (
          <div className="truncate border-t border-accent px-4 py-2 font-mono text-xs text-muted-foreground">
            {job.log_path}
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
