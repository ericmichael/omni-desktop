import { useStore } from '@nanostores/react';
import { BotIcon } from 'lucide-react';
import { Fragment, memo, useEffect, useMemo, useState } from 'react';

import { formatTimestamp } from '@/lib/format-time';
import { Alert, AlertDescription, AlertTitle } from '@/renderer/ds/ui/alert';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/renderer/ds/ui/empty';
import { ScrollArea } from '@/renderer/ds/ui/scroll-area';
import { OmniAgentsApp } from '@/renderer/omniagents-ui';
import {
  ActivityBackButton,
  ActivityDetailLabel,
  ActivityListRow,
  ActivityMetaGrid,
  ActivitySectionLabel,
  ActivityStopButton,
  groupSubagents,
  KindBadge,
  PlanTaskRow,
  StatusDot,
  type StopController,
  subagentDotClass,
  SubagentElapsed,
  subagentLabel,
  SubagentTail,
  useActivityDetail,
  useStopController,
} from '@/renderer/omniagents-ui/activity-presentation';
import {
  $activityActionsBySession,
  $activityBySession,
  type ActivityActions,
  subagentItemId,
  type SubagentSummary,
} from '@/renderer/omniagents-ui/activity-store';
import type { TaskSummary } from '@/renderer/omniagents-ui/canonical-plan-tasks';
import { serverOrigin } from '@/renderer/services/ipc';
import { persistedStoreApi } from '@/renderer/services/store';
import type { AgentRuntimeConnection, ExecutionTarget } from '@/shared/types';

/**
 * The Agents sidecar app: the session's subagents — background workers and
 * agent-tool runs — as a list with drill-in detail pages. Background bash
 * jobs live in the sibling Jobs app. Pill popovers deep-link here via
 * ``requestActivityFocus``.
 *
 * A subagent IS a session, so the detail page mounts the real chat
 * transcript (``OmniAgentsApp`` in read-only mode) for
 * ``subagent.session_id`` — full markdown, expandable tool calls, and
 * history backfill — instead of a hand-rolled event feed.
 */

/** The slice of the sandbox runtime the embedded transcript viewer needs
 *  to dial the same `omni serve` the column talks to. */
export type AgentsRuntime = {
  uiUrl?: string;
  authToken?: string;
  workspaceId?: string;
  environmentId?: string;
  environmentGeneration?: number;
};

/** Detail page for one subagent: toolbar, task, facts, live transcript. */
const SubagentDetail = memo(
  ({
    subagent,
    connection,
    executionTarget,
    actions,
    controller,
    onBack,
  }: {
    subagent: SubagentSummary;
    connection: AgentRuntimeConnection | undefined;
    executionTarget: ExecutionTarget | undefined;
    actions: ActivityActions | undefined;
    controller: StopController;
    onBack: () => void;
  }) => {
    const stoppable = actions && subagent.kind === 'worker' && subagent.worker_id && subagent.status === 'running';

    // Worker-plan drill-down: the worker's own plan, read by its session id
    // over the parent session's plan-read RPC. Fetched lazily — only while
    // this detail page is open (never polled from the list), re-fetched when
    // the worker's status transitions and on re-open (the page remounts per
    // navigation). Read-only observability: errors and absent plans render
    // no section at all.
    const [planTasks, setPlanTasks] = useState<TaskSummary[] | null>(null);
    const getWorkerPlan = actions?.getWorkerPlan;
    const planSessionId = subagent.kind === 'worker' ? subagent.session_id : '';
    useEffect(() => {
      if (!planSessionId || !getWorkerPlan) {
        return;
      }
      let cancelled = false;
      getWorkerPlan(planSessionId).then(
        (tasks) => {
          if (!cancelled) {
            setPlanTasks(tasks);
          }
        },
        () => {
          // Unreadable plan (runtime gone, older server) — stay sectionless.
        }
      );
      return () => {
        cancelled = true;
      };
    }, [getWorkerPlan, planSessionId, subagent.status]);

    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex min-h-9 shrink-0 items-center gap-2 border-b border-border px-2">
          <ActivityBackButton onBack={onBack} />
          <StatusDot className={subagentDotClass(subagent.status)} />
          <span className="font-medium text-foreground">{subagent.status}</span>
          <KindBadge subagent={subagent} />
          <span className="text-muted-foreground">
            <SubagentElapsed subagent={subagent} />
          </span>
          <span className="flex-auto" />
          {stoppable ? (
            <ActivityStopButton
              id={subagent.worker_id!}
              label={subagentLabel(subagent)}
              stop={() => actions.killWorker(subagent.worker_id!)}
              controller={controller}
            />
          ) : null}
        </header>
        <div className="flex min-h-0 flex-1 flex-col gap-4 p-4">
          <section>
            <ActivityDetailLabel>Task</ActivityDetailLabel>
            <p className="max-h-28 overflow-y-auto whitespace-pre-wrap text-sm text-foreground">{subagent.task}</p>
          </section>
          <ActivityMetaGrid
            rows={[
              ['Started', subagent.started_at ? formatTimestamp(subagent.started_at * 1000) : null],
              ['Isolation', subagent.isolation],
              [
                'ID',
                <span key="id" className="font-mono">
                  {subagent.subagent_id}
                </span>,
              ],
            ]}
          />
          {subagent.error ? (
            <Alert variant="destructive">
              <AlertTitle>Subagent failed</AlertTitle>
              <AlertDescription>
                <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-xs">{subagent.error}</pre>
              </AlertDescription>
            </Alert>
          ) : null}
          {planTasks && planTasks.length > 0 ? (
            <section data-testid="worker-plan">
              <ActivityDetailLabel>Plan</ActivityDetailLabel>
              <div className="max-h-56 overflow-y-auto rounded-md border border-border p-1 text-xs">
                {planTasks.map((t) => (
                  <PlanTaskRow key={t.id} task={t} />
                ))}
              </div>
            </section>
          ) : null}
          <section className="flex min-h-0 flex-1 flex-col">
            <ActivityDetailLabel>Transcript</ActivityDetailLabel>
            {/* Guard the empty id: agent-tool runs execute inside the
                parent's turn and carry no session of their own — an empty
                sessionId would make the viewer MINT a fresh session. */}
            {!subagent.session_id ? (
              <p className="text-xs italic text-muted-foreground">
                This run executed inside the parent session&rsquo;s turn — read it in the parent transcript.
              </p>
            ) : connection ? (
              <div className="min-h-0 flex-1 overflow-hidden rounded-md border border-border">
                <OmniAgentsApp
                  connection={connection}
                  executionTarget={executionTarget}
                  sessionId={subagent.session_id}
                  readOnly
                />
              </div>
            ) : (
              <p className="text-xs italic text-muted-foreground">
                The transcript is available while the session runtime is up.
              </p>
            )}
          </section>
        </div>
      </div>
    );
  }
);
SubagentDetail.displayName = 'SubagentDetail';

export const AgentsSurface = memo(({ sessionId, runtime }: { sessionId: string; runtime?: AgentsRuntime }) => {
  const activityBySession = useStore($activityBySession, { keys: [sessionId] });
  const actionsBySession = useStore($activityActionsBySession, { keys: [sessionId] });
  const subagents = useMemo(() => activityBySession[sessionId]?.subagents ?? [], [activityBySession, sessionId]);
  const actions = actionsBySession[sessionId];

  const store = useStore(persistedStoreApi.$atom);
  const theme = store.theme ?? 'teams-light';
  // Same construction as the column's own chat connection (CodeTabContent):
  // the viewer dials the identical `omni serve`, minimal chrome.
  const connection = useMemo(() => {
    if (!runtime?.uiUrl) {
      return undefined;
    }
    const url = new URL(runtime.uiUrl, serverOrigin());
    if (theme !== 'default') {
      url.searchParams.set('theme', theme);
    }
    url.searchParams.set('minimal', 'true');
    return { baseUrl: url.toString(), authToken: runtime.authToken };
  }, [runtime?.uiUrl, runtime?.authToken, theme]);
  const executionTarget = useMemo(
    () =>
      runtime?.workspaceId && runtime.environmentId && runtime.environmentGeneration !== undefined
        ? {
            workspaceId: runtime.workspaceId,
            environmentId: runtime.environmentId,
            environmentGeneration: runtime.environmentGeneration,
          }
        : undefined,
    [runtime?.workspaceId, runtime?.environmentId, runtime?.environmentGeneration]
  );

  // State sections in the pill popovers' vocabulary: running (live),
  // failed (the needs-attention shelf, above successes), completed.
  const groups = useMemo(() => groupSubagents(subagents), [subagents]);
  const orderedSubagents = useMemo(() => [...groups.running, ...groups.failed, ...groups.completed], [groups]);

  const { openId, open, back } = useActivityDetail(sessionId, 'subagent:');
  const openSubagent = orderedSubagents.find((s) => subagentItemId(s.subagent_id) === openId);
  // An opened item that leaves the snapshot (an agent-tool tail aging out)
  // falls back to the list rather than a dead detail page.
  useEffect(() => {
    if (openId && !openSubagent) {
      back();
    }
  }, [openId, openSubagent, back]);

  const controller = useStopController();

  if (orderedSubagents.length === 0) {
    return (
      <Empty className="h-full rounded-none border-0">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <BotIcon aria-hidden />
          </EmptyMedia>
          <EmptyTitle className="text-base">No subagents yet</EmptyTitle>
          <EmptyDescription>Workers and agent-tool runs spawned by this session show up here, live.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  if (openSubagent) {
    return (
      <div className="flex h-full min-h-0 flex-col bg-card text-sm">
        {/* Keyed by item so navigating between items remounts the viewer. */}
        <SubagentDetail
          key={openSubagent.subagent_id}
          subagent={openSubagent}
          connection={connection}
          executionTarget={executionTarget}
          actions={actions}
          controller={controller}
          onBack={back}
        />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-card text-sm">
      <ScrollArea className="min-h-0 flex-1">
        <nav aria-label="Subagents" className="flex flex-col gap-0.5 p-1.5">
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
                {items.map((s) => (
                  <ActivityListRow
                    key={subagentItemId(s.subagent_id)}
                    itemId={subagentItemId(s.subagent_id)}
                    dotClass={subagentDotClass(s.status)}
                    badge={<KindBadge subagent={s} />}
                    label={subagentLabel(s)}
                    tail={<SubagentTail subagent={s} />}
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
AgentsSurface.displayName = 'AgentsSurface';
