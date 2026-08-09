import { useStore } from '@nanostores/react';
import { ActivityIcon, RefreshCwIcon } from 'lucide-react';
import { Fragment, memo, useCallback, useEffect, useMemo, useState } from 'react';

import { formatTimestamp } from '@/lib/format-time';
import { Alert, AlertDescription, AlertTitle } from '@/renderer/ds/ui/alert';
import { Button } from '@/renderer/ds/ui/button';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/renderer/ds/ui/empty';
import { ScrollArea } from '@/renderer/ds/ui/scroll-area';
import {
  ActivityBackButton,
  ActivityDetailLabel,
  ActivityListRow,
  ActivityMetaGrid,
  ActivitySectionLabel,
  ActivityStopButton,
  groupJobs,
  jobDotClass,
  JobElapsed,
  jobLabel,
  JobTail,
  StatusDot,
  type StopController,
  useActivityDetail,
  useStickToBottom,
  useStopController,
} from '@/renderer/omniagents-ui/activity-presentation';
import {
  $activityActionsBySession,
  $activityBySession,
  type ActivityActions,
  type BashJobSummary,
  jobItemId,
} from '@/renderer/omniagents-ui/activity-store';

/**
 * The Jobs sidecar app: the session's background bash jobs as a master
 * list with live log-tail detail pages. Subagents live in the sibling
 * Agents app. Pill popovers deep-link here via ``requestActivityFocus``.
 * Data arrives via the activity store, published by the column's embedded
 * chat app; this surface holds no RPC connection of its own and calls back
 * through the per-session action registry.
 */

/** Detail page for one background bash job: command, meta, live log tail. */
const JobDetail = memo(
  ({
    job,
    actions,
    controller,
    onBack,
  }: {
    job: BashJobSummary;
    actions: ActivityActions | undefined;
    controller: StopController;
    onBack: () => void;
  }) => {
    const [tail, setTail] = useState<{ jobId: string; text: string } | null>(null);
    const [tailError, setTailError] = useState<string | null>(null);

    const refreshTail = useCallback(async () => {
      if (!actions) {
        return;
      }
      try {
        const res = await actions.tailJob(job.job_id, 200);
        if (res.ok) {
          setTail({ jobId: job.job_id, text: res.text ?? '' });
          setTailError(null);
        } else {
          setTailError(res.error ?? res.message ?? 'tail failed');
        }
      } catch (e) {
        setTailError((e as Error).message ?? String(e));
      }
    }, [actions, job.job_id]);

    // Fetch on selection (and when the session's actions register), then
    // follow while the job runs.
    useEffect(() => {
      void refreshTail();
      if (!job.running) {
        return;
      }
      const id = window.setInterval(() => void refreshTail(), 3000);
      return () => window.clearInterval(id);
    }, [refreshTail, job.running]);

    const tailText = tail?.jobId === job.job_id ? tail.text : null;
    const logRef = useStickToBottom<HTMLPreElement>(tailText);

    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex min-h-9 shrink-0 items-center gap-2 border-b border-border px-2">
          <ActivityBackButton onBack={onBack} />
          <StatusDot className={jobDotClass(job)} />
          <span className="font-medium text-foreground">{job.running ? 'running' : `exit ${job.exit_code}`}</span>
          <span className="text-muted-foreground">
            <JobElapsed job={job} />
          </span>
          <span className="flex-auto" />
          {actions && job.running ? (
            <ActivityStopButton
              id={job.job_id}
              label={jobLabel(job)}
              stop={() => actions.killJob(job.job_id)}
              controller={controller}
            />
          ) : null}
        </header>
        <div className="flex min-h-0 flex-1 flex-col gap-4 p-4">
          <section>
            <ActivityDetailLabel>Command</ActivityDetailLabel>
            <pre className="max-h-28 overflow-y-auto whitespace-pre-wrap rounded-md bg-muted/50 p-2.5 font-mono text-xs text-foreground">
              {job.command}
            </pre>
          </section>
          <ActivityMetaGrid
            rows={[
              ['Started', job.started_at ? formatTimestamp(job.started_at * 1000) : null],
              ['PID', job.pid],
              [
                'Directory',
                job.cwd ? (
                  <span key="cwd" className="font-mono">
                    {job.cwd}
                  </span>
                ) : null,
              ],
              [
                'ID',
                <span key="id" className="font-mono">
                  {job.job_id}
                </span>,
              ],
            ]}
          />
          <section className="flex min-h-0 flex-1 flex-col gap-1.5">
            <div className="flex items-center gap-2">
              <ActivityDetailLabel className="mb-0">Log</ActivityDetailLabel>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="text-muted-foreground"
                disabled={!actions}
                onClick={() => void refreshTail()}
                title="Refresh log tail"
                aria-label="Refresh log tail"
              >
                <RefreshCwIcon className="size-3" />
              </Button>
            </div>
            {tailError ? (
              <Alert variant="destructive">
                <AlertTitle>Couldn’t read the log</AlertTitle>
                <AlertDescription>{tailError}</AlertDescription>
              </Alert>
            ) : null}
            {!actions ? (
              <p className="text-xs italic text-muted-foreground">Waiting for the session connection…</p>
            ) : (
              <pre
                ref={logRef}
                className="min-h-24 flex-1 overflow-auto whitespace-pre-wrap rounded-md bg-muted/50 p-2.5 font-mono text-xs text-muted-foreground"
              >
                {tailText ?? 'Loading…'}
              </pre>
            )}
          </section>
        </div>
      </div>
    );
  }
);
JobDetail.displayName = 'JobDetail';

export const JobsSurface = memo(({ sessionId }: { sessionId: string }) => {
  const activityBySession = useStore($activityBySession, { keys: [sessionId] });
  const actionsBySession = useStore($activityActionsBySession, { keys: [sessionId] });
  const jobs = useMemo(() => activityBySession[sessionId]?.jobs ?? [], [activityBySession, sessionId]);
  const actions = actionsBySession[sessionId];

  // State sections in the pill popovers' vocabulary: running (live),
  // failed (the needs-attention shelf, above successes), completed.
  const groups = useMemo(() => groupJobs(jobs), [jobs]);
  const orderedJobs = useMemo(() => [...groups.running, ...groups.failed, ...groups.completed], [groups]);
  const { openId, open, back } = useActivityDetail(sessionId, 'job:');
  const openJob = orderedJobs.find((j) => jobItemId(j.job_id) === openId);
  // An opened job that leaves the snapshot falls back to the list rather
  // than a dead detail page.
  useEffect(() => {
    if (openId && !openJob) {
      back();
    }
  }, [openId, openJob, back]);

  const controller = useStopController();

  if (orderedJobs.length === 0) {
    return (
      <Empty className="h-full rounded-none border-0">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <ActivityIcon aria-hidden />
          </EmptyMedia>
          <EmptyTitle className="text-base">No background jobs yet</EmptyTitle>
          <EmptyDescription>Background bash jobs started by this session show up here, live.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  if (openJob) {
    return (
      <div className="flex h-full min-h-0 flex-col bg-card text-sm">
        {/* Keyed by item so navigating between items resets the fetched
            tail and scroll pinning. */}
        <JobDetail key={openJob.job_id} job={openJob} actions={actions} controller={controller} onBack={back} />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-card text-sm">
      <ScrollArea className="min-h-0 flex-1">
        <nav aria-label="Background jobs" className="flex flex-col gap-0.5 p-1.5">
          {(
            [
              ['Running', groups.running],
              ['Failed', groups.failed],
              ['Completed', groups.completed],
            ] as const
          ).map(([label, items]) =>
            items.length > 0 ? (
              <Fragment key={label}>
                <ActivitySectionLabel>{`${label} · ${items.length}`}</ActivitySectionLabel>
                {items.map((j) => (
                  <ActivityListRow
                    key={jobItemId(j.job_id)}
                    itemId={jobItemId(j.job_id)}
                    dotClass={jobDotClass(j)}
                    label={jobLabel(j)}
                    mono
                    tail={<JobTail job={j} />}
                    onOpen={open}
                  />
                ))}
              </Fragment>
            ) : null
          )}
        </nav>
      </ScrollArea>
    </div>
  );
});
JobsSurface.displayName = 'JobsSurface';
