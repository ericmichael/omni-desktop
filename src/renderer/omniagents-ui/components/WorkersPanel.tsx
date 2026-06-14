import React, { useCallback, useEffect, useState } from 'react';

// Server payload from omni-code's ``workers.list`` / ``ui.workers.update``.
// Matches ``worker_state_dict`` in ``tools/worker_tools.py``.
export type WorkerSummary = {
  worker_id: string;
  status: 'running' | 'completed' | 'cancelled' | 'error';
  task: string;
  parent_session_id: string | null;
  session_id: string;
  run_id: string;
  result: string | null;
  error: string | null;
  isolation: string | null;
  started_at: number | null;
  finished_at: number | null;
  wall_time_ms: number | null;
};

export type WorkersKillResult = {
  ok: boolean;
  worker?: WorkerSummary;
  status?: string;
  snapshot?: WorkerSummary[];
  error?: string;
  message?: string;
};

const MAX_VISIBLE = 5;
const TASK_TRUNCATE = 80;

function shortTask(task: string): string {
  const oneLine = task.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= TASK_TRUNCATE) {
    return oneLine;
  }
  return `${oneLine.slice(0, TASK_TRUNCATE - 1)}…`;
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

function liveElapsedMs(worker: WorkerSummary, nowMs: number): number {
  if (worker.status === 'running' && worker.started_at) {
    return Math.max(nowMs - worker.started_at * 1000, worker.wall_time_ms ?? 0);
  }
  return worker.wall_time_ms ?? 0;
}

function dotClass(worker: WorkerSummary): string {
  if (worker.status === 'running') {
    return 'bg-primary animate-pulse';
  }
  if (worker.status === 'completed') {
    return 'bg-successGreen';
  }
  return 'bg-errorRed';
}

type RowProps = {
  worker: WorkerSummary;
  nowMs: number;
  isKilling: boolean;
  onKill?: (worker_id: string) => void;
  onDismiss?: (worker_id: string) => void;
};

function WorkerRow({ worker, nowMs, isKilling, onKill, onDismiss }: RowProps) {
  const elapsed = formatElapsed(liveElapsedMs(worker, nowMs));
  const tail = worker.status === 'running' ? elapsed : `${worker.status} · ${elapsed}`;
  return (
    <li className="flex items-center gap-2 text-xs leading-5">
      <span
        className={['inline-block w-1.5 h-1.5 rounded-full flex-shrink-0', dotClass(worker)].join(' ')}
        aria-hidden
      />
      <span className="text-textSubtle font-mono">{worker.worker_id}</span>
      <span
        className={['min-w-0 truncate', worker.status === 'running' ? 'text-textPrimary' : 'text-textSubtle'].join(' ')}
        title={worker.task}
      >
        {shortTask(worker.task)}
      </span>
      <span className="ml-auto text-textSubtle whitespace-nowrap">{tail}</span>
      {onKill && worker.status === 'running' ? (
        <button
          type="button"
          disabled={isKilling}
          onClick={onKill.bind(null, worker.worker_id)}
          className="text-textSubtle hover:text-errorRed transition-colors px-1.5 py-0.5 rounded hover:bg-bgCardAlt disabled:opacity-50 disabled:cursor-not-allowed"
          title={`Stop worker ${worker.worker_id}`}
          aria-label={`Stop worker ${worker.worker_id}`}
        >
          {isKilling ? '…' : '✕'}
        </button>
      ) : null}
      {onDismiss && worker.status !== 'running' ? (
        <button
          type="button"
          onClick={onDismiss.bind(null, worker.worker_id)}
          className="text-textSubtle hover:text-textPrimary transition-colors px-1.5 py-0.5 rounded hover:bg-bgCardAlt"
          title={`Dismiss worker ${worker.worker_id}`}
          aria-label={`Dismiss worker ${worker.worker_id}`}
        >
          dismiss
        </button>
      ) : null}
    </li>
  );
}

type Props = {
  workers: WorkerSummary[];
  onKill?: (worker_id: string) => Promise<WorkersKillResult>;
  onDismiss?: (worker_id: string) => void;
};

// Docked workers panel. Mirrors BashJobs structurally so the two stack
// as a single visual unit. Renders nothing when there are no workers.
export function WorkersPanel({ workers, onKill, onDismiss }: Props) {
  const [, setNowTick] = useState(0);
  const anyRunning = workers.some((w) => w.status === 'running');
  useEffect(() => {
    if (!anyRunning) {
      return;
    }
    const id = window.setInterval(() => setNowTick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, [anyRunning]);

  const [killing, setKilling] = useState<Set<string>>(new Set());
  const [killError, setKillError] = useState<string | null>(null);

  const handleKill = useCallback(
    async (worker_id: string) => {
      if (!onKill) {
        return;
      }
      if (!window.confirm(`Stop worker ${worker_id}?`)) {
        return;
      }
      setKillError(null);
      setKilling((prev) => {
        const next = new Set(prev);
        next.add(worker_id);
        return next;
      });
      try {
        const res = await onKill(worker_id);
        if (!res.ok) {
          setKillError(`Failed to stop ${worker_id}: ${res.error ?? 'unknown error'}`);
        }
      } catch (e) {
        setKillError(`Failed to stop ${worker_id}: ${(e as Error).message ?? String(e)}`);
      } finally {
        setKilling((prev) => {
          const next = new Set(prev);
          next.delete(worker_id);
          return next;
        });
      }
    },
    [onKill]
  );

  if (!workers || workers.length === 0) {
    return null;
  }

  const running = workers.filter((w) => w.status === 'running');
  const exited = workers.filter((w) => w.status !== 'running');
  const succeeded = exited.filter((w) => w.status === 'completed').length;
  const failed = exited.length - succeeded;

  const ordered = [...running, ...exited.slice().sort((a, b) => (b.started_at ?? 0) - (a.started_at ?? 0))];
  const visible = ordered.slice(0, MAX_VISIBLE);
  const overflow = ordered.length - visible.length;
  const nowMs = Date.now();

  return (
    <div className="px-3 pt-2">
      <div className="rounded-md border border-bgCardAlt bg-bgCardAlt/60 p-2.5">
        <div className="flex items-center gap-2 text-xs text-textSubtle">
          <span className="font-medium text-textPrimary">Workers</span>
          <span aria-hidden>·</span>
          <span>
            <span className="text-brand">{running.length}</span> running
          </span>
          <span aria-hidden>·</span>
          <span>
            <span className="text-successGreen">{succeeded}</span> done
          </span>
          {failed > 0 ? (
            <>
              <span aria-hidden>·</span>
              <span>
                <span className="text-errorRed">{failed}</span> failed
              </span>
            </>
          ) : null}
        </div>
        {killError ? <div className="mt-1 text-[11px] text-errorRed">{killError}</div> : null}
        <ul className="mt-1.5 space-y-1">
          {visible.map((w) => (
            <WorkerRow
              key={w.worker_id}
              worker={w}
              nowMs={nowMs}
              isKilling={killing.has(w.worker_id)}
              onKill={onKill ? handleKill : undefined}
              onDismiss={onDismiss}
            />
          ))}
        </ul>
        {overflow > 0 ? <div className="mt-1 text-[11px] text-textSubtle">… +{overflow} more</div> : null}
      </div>
    </div>
  );
}
