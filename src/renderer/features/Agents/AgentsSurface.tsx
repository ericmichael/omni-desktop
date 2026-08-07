import { useStore } from '@nanostores/react';
import { BotIcon, RefreshCwIcon, SquareIcon } from 'lucide-react';
import { memo, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { cn } from '@/renderer/ds/cn';
import { Alert, AlertDescription, AlertTitle } from '@/renderer/ds/ui/alert';
import { Button } from '@/renderer/ds/ui/button';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/renderer/ds/ui/empty';
import { Item, ItemContent, ItemDescription, ItemMedia, ItemTitle } from '@/renderer/ds/ui/item';
import { ScrollArea } from '@/renderer/ds/ui/scroll-area';
import { Separator } from '@/renderer/ds/ui/separator';
import { Spinner } from '@/renderer/ds/ui/spinner';
import {
  jobDotClass,
  JobElapsed,
  jobLabel,
  JobTail,
  KindBadge,
  StatusDot,
  type StopController,
  subagentDotClass,
  SubagentElapsed,
  subagentLabel,
  SubagentTail,
  useStickToBottom,
  useStopController,
} from '@/renderer/omniagents-ui/activity-presentation';
import {
  $activityActionsBySession,
  $activityBySession,
  $activityEventsBySession,
  $activityFocus,
  type ActivityActions,
  type BashJobSummary,
  clearActivityFocus,
  jobItemId,
  type SubagentEvent,
  subagentItemId,
  type SubagentSummary,
} from '@/renderer/omniagents-ui/activity-store';
import { formatArgsPreview } from '@/renderer/omniagents-ui/components/activity-group';
import { Markdown } from '@/renderer/omniagents-ui/components/promptkit/markdown';

/**
 * The Agents sidecar app: every piece of background work one session
 * spawned — subagents (workers, agent-tool runs) and background bash jobs —
 * as a master list with detail pages. Pill popovers deep-link here via
 * ``requestActivityFocus``. Data arrives via the activity store, published
 * by the column's embedded chat app; this surface holds no RPC connection
 * of its own and calls back through the per-session action registry.
 */

type FeedLine = { key: number; tone: 'action' | 'failure' | 'prose'; text: string };

/**
 * The activity transcript, in the transcript's beat language: one row per
 * relayed event — tool calls as present actions, failed results in red,
 * assistant prose in between. Mirrors the ink TUI's ``buildLiveActivity``.
 */
function buildFeed(events: SubagentEvent[]): FeedLine[] {
  const lines: FeedLine[] = [];
  for (const [i, event] of events.entries()) {
    const params = event.params ?? {};
    if (event.method === 'tool_called') {
      const tool = String(params.tool ?? '');
      const preview = formatArgsPreview(String(params.input ?? ''), 100);
      lines.push({ key: i, tone: 'action', text: preview ? `${tool} · ${preview}` : tool });
    } else if (event.method === 'tool_result') {
      const metadata = params.metadata as Record<string, unknown> | undefined;
      if (metadata && metadata.success === false) {
        lines.push({ key: i, tone: 'failure', text: `${String(params.tool ?? 'tool')} failed` });
      }
    } else if (event.method === 'message_output') {
      const content = String(params.content ?? '').trim();
      if (content) {
        lines.push({ key: i, tone: 'prose', text: content });
      }
    }
  }
  return lines;
}

// --- master list -------------------------------------------------------------

function ListRow({
  itemId,
  dotClass,
  badge,
  label,
  mono,
  tail,
  selected,
  onSelect,
  registerRef,
}: {
  itemId: string;
  dotClass: string;
  badge?: ReactNode;
  label: string;
  mono?: boolean;
  tail: ReactNode;
  selected: boolean;
  onSelect: (id: string) => void;
  registerRef: (id: string, el: HTMLButtonElement | null) => void;
}) {
  return (
    <Item asChild size="sm" className={cn('w-full gap-2 px-2 py-1.5', selected ? 'bg-accent' : 'hover:bg-accent/50')}>
      <button
        type="button"
        role="option"
        aria-selected={selected}
        title={label}
        onClick={() => onSelect(itemId)}
        ref={(el) => registerRef(itemId, el)}
      >
        <ItemMedia>
          <StatusDot className={dotClass} />
        </ItemMedia>
        <ItemContent className="gap-0.5">
          <ItemTitle
            className={cn(
              'line-clamp-2 block w-full text-left text-xs font-normal text-foreground',
              mono && 'font-mono'
            )}
          >
            {label}
          </ItemTitle>
          <ItemDescription className="line-clamp-none flex w-full items-center gap-1.5 text-xs">
            {badge}
            <span className="ml-auto whitespace-nowrap">{tail}</span>
          </ItemDescription>
        </ItemContent>
      </button>
    </Item>
  );
}

function SectionLabel({ children }: { children: string }) {
  return (
    <p
      aria-hidden
      className="px-2.5 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground first:pt-1"
    >
      {children}
    </p>
  );
}

// --- detail pages ------------------------------------------------------------

function StopButton({
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

function MetaLine({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 pt-1.5 text-xs text-muted-foreground">{children}</div>
  );
}

/** Detail page for one subagent: task, meta, live beat feed, result/error. */
const SubagentDetail = memo(
  ({
    subagent,
    events,
    actions,
    controller,
  }: {
    subagent: SubagentSummary;
    events: SubagentEvent[];
    actions: ActivityActions | undefined;
    controller: StopController;
  }) => {
    const feed = useMemo(() => buildFeed(events), [events]);
    const scrollRef = useStickToBottom<HTMLDivElement>(feed.length);
    const stoppable = actions && subagent.kind === 'worker' && subagent.worker_id && subagent.status === 'running';
    return (
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="border-b border-border p-4 pb-3">
          <div className="flex items-start gap-3">
            <p className="line-clamp-3 min-w-0 flex-1 font-medium text-foreground" title={subagent.task}>
              {subagent.task}
            </p>
            {stoppable ? (
              <StopButton
                id={subagent.worker_id!}
                label={subagentLabel(subagent)}
                stop={() => actions.killWorker(subagent.worker_id!)}
                controller={controller}
              />
            ) : null}
          </div>
          <MetaLine>
            <StatusDot className={subagentDotClass(subagent.status)} />
            <span>{subagent.status}</span>
            <KindBadge subagent={subagent} />
            {subagent.isolation ? <span>{subagent.isolation}</span> : null}
            <span>
              <SubagentElapsed subagent={subagent} />
            </span>
            <span className="min-w-0 truncate font-mono text-[10px]" title={subagent.subagent_id}>
              {subagent.subagent_id}
            </span>
          </MetaLine>
        </div>
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto p-4">
          {feed.length > 0 ? (
            <div className="flex flex-col gap-1 text-xs">
              {feed.map((line) =>
                line.tone === 'prose' ? (
                  <p key={line.key} className="whitespace-pre-wrap text-muted-foreground">
                    {line.text}
                  </p>
                ) : (
                  <p
                    key={line.key}
                    className={cn(
                      'font-mono',
                      line.tone === 'failure' ? 'text-destructive' : 'text-muted-foreground/80'
                    )}
                  >
                    {line.tone === 'failure' ? '✗ ' : '· '}
                    {line.text}
                  </p>
                )
              )}
            </div>
          ) : subagent.status === 'running' ? (
            <p className="flex items-center gap-2 text-xs italic text-muted-foreground">
              <Spinner className="size-3" />
              Waiting for activity…
            </p>
          ) : null}
          {subagent.result ? (
            <>
              {feed.length > 0 ? <Separator className="my-3" /> : null}
              <Markdown className="text-sm">{subagent.result}</Markdown>
            </>
          ) : null}
          {subagent.error ? (
            <Alert variant="destructive" className="mt-3">
              <AlertTitle>Subagent failed</AlertTitle>
              <AlertDescription>
                <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-xs">{subagent.error}</pre>
              </AlertDescription>
            </Alert>
          ) : null}
        </div>
      </div>
    );
  }
);
SubagentDetail.displayName = 'SubagentDetail';

/** Detail page for one background bash job: command, meta, live log tail. */
const JobDetail = memo(
  ({
    job,
    actions,
    controller,
  }: {
    job: BashJobSummary;
    actions: ActivityActions | undefined;
    controller: StopController;
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
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="border-b border-border p-4 pb-3">
          <div className="flex items-start gap-3">
            <p
              className="line-clamp-3 min-w-0 flex-1 whitespace-pre-wrap font-mono text-sm font-medium text-foreground"
              title={job.command}
            >
              {job.command}
            </p>
            {actions && job.running ? (
              <StopButton
                id={job.job_id}
                label={jobLabel(job)}
                stop={() => actions.killJob(job.job_id)}
                controller={controller}
              />
            ) : null}
          </div>
          <MetaLine>
            <StatusDot className={jobDotClass(job)} />
            <span>{job.running ? 'running' : `exit ${job.exit_code}`}</span>
            <span>pid {job.pid}</span>
            <span>
              <JobElapsed job={job} />
            </span>
            {job.cwd ? (
              <span className="min-w-0 truncate" title={job.cwd}>
                {job.cwd}
              </span>
            ) : null}
            <span className="min-w-0 truncate font-mono text-[10px]" title={job.job_id}>
              {job.job_id}
            </span>
          </MetaLine>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-1.5 p-4">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-muted-foreground">Log tail</span>
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
        </div>
      </div>
    );
  }
);
JobDetail.displayName = 'JobDetail';

// --- surface -----------------------------------------------------------------

export const AgentsSurface = memo(({ sessionId }: { sessionId: string }) => {
  const activityBySession = useStore($activityBySession, { keys: [sessionId] });
  const eventsBySession = useStore($activityEventsBySession, { keys: [sessionId] });
  const actionsBySession = useStore($activityActionsBySession, { keys: [sessionId] });
  const activity = activityBySession[sessionId];
  const subagents = useMemo(() => activity?.subagents ?? [], [activity]);
  const jobs = useMemo(() => activity?.jobs ?? [], [activity]);
  const events = eventsBySession[sessionId] ?? {};
  const actions = actionsBySession[sessionId];

  // Running first, then most recently started — the reading order of "what
  // is my fleet doing right now".
  const orderedSubagents = useMemo(() => {
    const running = subagents.filter((s) => s.status === 'running');
    const exited = subagents
      .filter((s) => s.status !== 'running')
      .sort((a, b) => (b.started_at ?? 0) - (a.started_at ?? 0));
    return [...running, ...exited];
  }, [subagents]);
  const orderedJobs = useMemo(() => {
    const running = jobs.filter((j) => j.running);
    const exited = jobs.filter((j) => !j.running).sort((a, b) => (b.started_at ?? 0) - (a.started_at ?? 0));
    return [...running, ...exited];
  }, [jobs]);
  const orderedIds = useMemo(
    () => [
      ...orderedSubagents.map((s) => subagentItemId(s.subagent_id)),
      ...orderedJobs.map((j) => jobItemId(j.job_id)),
    ],
    [orderedSubagents, orderedJobs]
  );

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const resolved = selectedId !== null && orderedIds.includes(selectedId);
  const firstId = orderedIds[0] ?? null;
  // Latch the default selection instead of deriving it per render, so a
  // newly spawned item reordering the list never silently swaps the open
  // detail page out from under the reader.
  useEffect(() => {
    if (!resolved && firstId) {
      setSelectedId(firstId);
    }
  }, [resolved, firstId]);

  // Deep-link focus from the pill popovers.
  const focus = useStore($activityFocus);
  useEffect(() => {
    if (focus && focus.sessionId === sessionId) {
      setSelectedId(focus.itemId);
      clearActivityFocus();
    }
  }, [focus, sessionId]);

  const shownId = resolved ? selectedId : firstId;
  const shownSubagent = orderedSubagents.find((s) => subagentItemId(s.subagent_id) === shownId);
  const shownJob = shownSubagent ? undefined : orderedJobs.find((j) => jobItemId(j.job_id) === shownId);

  const controller = useStopController();

  const itemRefs = useRef(new Map<string, HTMLButtonElement>());
  const registerRef = useCallback((id: string, el: HTMLButtonElement | null) => {
    if (el) {
      itemRefs.current.set(id, el);
    } else {
      itemRefs.current.delete(id);
    }
  }, []);
  const handleListKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') {
        return;
      }
      e.preventDefault();
      const idx = shownId ? orderedIds.indexOf(shownId) : -1;
      const next = orderedIds[e.key === 'ArrowDown' ? Math.min(idx + 1, orderedIds.length - 1) : Math.max(idx - 1, 0)];
      if (next) {
        setSelectedId(next);
        itemRefs.current.get(next)?.focus();
      }
    },
    [shownId, orderedIds]
  );

  if (orderedSubagents.length === 0 && orderedJobs.length === 0) {
    return (
      <Empty className="h-full rounded-none border-0">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <BotIcon aria-hidden />
          </EmptyMedia>
          <EmptyTitle className="text-base">No background work yet</EmptyTitle>
          <EmptyDescription>
            Subagents and background bash jobs spawned by this session show up here, live.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="flex h-full min-h-0 bg-card text-sm">
      <div className="flex w-[clamp(11rem,35%,16rem)] shrink-0 flex-col border-r border-border">
        <ScrollArea className="min-h-0 flex-1">
          <div
            role="listbox"
            aria-label="Background activity"
            className="flex flex-col gap-0.5 p-1.5"
            onKeyDown={handleListKeyDown}
          >
            {orderedSubagents.length > 0 ? (
              <SectionLabel>{`Subagents · ${orderedSubagents.length}`}</SectionLabel>
            ) : null}
            {orderedSubagents.map((s) => (
              <ListRow
                key={subagentItemId(s.subagent_id)}
                itemId={subagentItemId(s.subagent_id)}
                dotClass={subagentDotClass(s.status)}
                badge={<KindBadge subagent={s} />}
                label={subagentLabel(s)}
                tail={<SubagentTail subagent={s} />}
                selected={shownId === subagentItemId(s.subagent_id)}
                onSelect={setSelectedId}
                registerRef={registerRef}
              />
            ))}
            {orderedJobs.length > 0 ? <SectionLabel>{`Background jobs · ${orderedJobs.length}`}</SectionLabel> : null}
            {orderedJobs.map((j) => (
              <ListRow
                key={jobItemId(j.job_id)}
                itemId={jobItemId(j.job_id)}
                dotClass={jobDotClass(j)}
                label={jobLabel(j)}
                mono
                tail={<JobTail job={j} />}
                selected={shownId === jobItemId(j.job_id)}
                onSelect={setSelectedId}
                registerRef={registerRef}
              />
            ))}
          </div>
        </ScrollArea>
      </div>
      {shownSubagent ? (
        // Keyed by item so switching pages resets scroll pinning and any
        // fetched tail instead of inheriting the previous item's state.
        <SubagentDetail
          key={shownSubagent.subagent_id}
          subagent={shownSubagent}
          events={events[shownSubagent.subagent_id] ?? []}
          actions={actions}
          controller={controller}
        />
      ) : shownJob ? (
        <JobDetail key={shownJob.job_id} job={shownJob} actions={actions} controller={controller} />
      ) : null}
    </div>
  );
});
AgentsSurface.displayName = 'AgentsSurface';
