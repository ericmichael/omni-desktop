import { ArrowUpRightIcon, BotIcon, ListChecksIcon, SquareIcon, SquareTerminalIcon, XIcon } from 'lucide-react';
import React from 'react';

import { Button } from '@/renderer/ds/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/renderer/ds/ui/popover';
import {
  jobDotClass,
  jobLabel,
  JobTail,
  KindBadge,
  StatusDot,
  subagentDotClass,
  subagentLabel,
  SubagentTail,
  useStopController,
} from '@/renderer/omniagents-ui/activity-presentation';
import {
  type BashJobsKillResult,
  type BashJobSummary,
  jobItemId,
  requestActivityFocus,
  subagentItemId,
  type SubagentSummary,
  type WorkersKillResult,
} from '@/renderer/omniagents-ui/activity-store';
import type { TaskSummary } from '@/renderer/omniagents-ui/canonical-plan-tasks';

/**
 * The composer's status row: session controls (children) followed by
 * activity pills. Three levels of disclosure: the pill is ambient state
 * (count + tone), its popover is a scannable overview built from rows, and
 * rows with real depth — subagents, bash jobs — deep-link to their detail
 * page in the Agents sidecar app. Tasks have no depth below their row, so
 * the Tasks popover is the whole story. Blocking surfaces (elicitations,
 * escalations) never collapse into this row.
 *
 * All activity presentation (status colors, labels, tails, stop plumbing)
 * comes from ``activity-presentation`` — shared with the Agents surface so
 * the two can only differ in layout.
 */

// --- shared row/popover idiom ---------------------------------------------

function countsLine(parts: Array<[number, string]>): string {
  return parts
    .filter(([n]) => n > 0)
    .map(([n, label]) => `${n} ${label}`)
    .join(' · ');
}

function PopoverHeaderLine({ title, counts }: { title: string; counts: string }) {
  return (
    <div className="flex items-baseline gap-2 border-b border-border px-3 py-2">
      <span className="font-medium text-foreground">{title}</span>
      {counts ? <span className="truncate text-muted-foreground">{counts}</span> : null}
    </div>
  );
}

function OpenAgentsFooter({ onOpen }: { onOpen: () => void }) {
  return (
    <div className="border-t border-border p-1">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 w-full justify-start gap-1.5 px-2 text-xs font-normal text-muted-foreground"
        onClick={onOpen}
      >
        <ArrowUpRightIcon className="size-3.5" />
        Open Agents
      </Button>
    </div>
  );
}

/** One overview row. Clickable (deep link) when `onOpen` is set; inline
 *  actions (stop / dismiss) sit outside the click target. */
function ActivityRow({
  dotClass,
  badge,
  label,
  labelClassName,
  tail,
  onOpen,
  onStop,
  stopping,
  onDismiss,
}: {
  dotClass: string;
  badge?: React.ReactNode;
  label: string;
  labelClassName?: string;
  tail: React.ReactNode;
  onOpen?: () => void;
  onStop?: () => void;
  stopping?: boolean;
  onDismiss?: () => void;
}) {
  const body = (
    <>
      <StatusDot className={dotClass} />
      {badge}
      <span className={`min-w-0 flex-1 truncate text-left ${labelClassName ?? 'text-foreground'}`} title={label}>
        {label}
      </span>
      <span className="shrink-0 whitespace-nowrap text-muted-foreground">{tail}</span>
    </>
  );
  return (
    <div className="flex items-center gap-1 rounded-md pr-1">
      {onOpen ? (
        <button
          type="button"
          onClick={onOpen}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent/60"
        >
          {body}
        </button>
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5">{body}</div>
      )}
      {onStop ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          disabled={stopping}
          onClick={onStop}
          className="shrink-0 text-muted-foreground hover:text-destructive"
          title="Stop"
          aria-label="Stop"
        >
          <SquareIcon className="size-3" />
        </Button>
      ) : null}
      {onDismiss ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          onClick={onDismiss}
          className="shrink-0 text-muted-foreground"
          title="Dismiss"
          aria-label="Dismiss"
        >
          <XIcon className="size-3" />
        </Button>
      ) : null}
    </div>
  );
}

type StatusPillProps = {
  icon: React.ReactNode;
  label: string;
  dotClass?: string;
} & React.ComponentProps<typeof Button>;

// Spreads rest props (incl. ref — React 19) so it works as a Radix
// `asChild` trigger.
function StatusPill({ icon, label, dotClass, ...rest }: StatusPillProps) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="h-7 min-w-0 gap-1.5 px-2 text-xs font-normal text-muted-foreground"
      {...rest}
    >
      {icon}
      <span className="max-w-40 truncate">{label}</span>
      {dotClass ? <StatusDot className={dotClass} /> : null}
    </Button>
  );
}

function PillPopover({ pill, children }: { pill: React.ReactNode; children: React.ReactNode }) {
  return (
    <Popover>
      <PopoverTrigger asChild>{pill}</PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-96 max-w-[90vw] p-0 text-xs">
        {children}
      </PopoverContent>
    </Popover>
  );
}

const TASK_DOT: Record<TaskSummary['status'], string> = {
  pending: 'bg-muted-foreground/50',
  in_progress: 'bg-primary animate-pulse',
  completed: 'bg-success',
  blocked: 'bg-warning',
};

// ---------------------------------------------------------------------------

export function PillStrip({
  sessionId,
  subagents,
  tasks,
  jobs,
  onOpenAgents,
  onWorkerKill,
  onWorkerDismiss,
  onJobKill,
  onJobDismiss,
  children,
}: {
  sessionId?: string;
  /** Unified subagent list (workers + agent-tool runs), dismissal-filtered. */
  subagents: SubagentSummary[];
  tasks: TaskSummary[];
  jobs: BashJobSummary[];
  /** Opens the Agents sidecar app. Absent on hosts without a deck column
   *  (e.g. Residents) — popovers stay, deep links disappear. */
  onOpenAgents?: () => void;
  onWorkerKill?: (workerId: string) => Promise<WorkersKillResult>;
  onWorkerDismiss?: (workerId: string) => void;
  onJobKill?: (jobId: string) => Promise<BashJobsKillResult>;
  onJobDismiss?: (jobId: string) => void;
  /** Session controls (model / effort / approvals) leading the row. */
  children?: React.ReactNode;
}) {
  const agentsRunning = subagents.filter((s) => s.status === 'running').length;
  const agentsFailed = subagents.filter((s) => s.status === 'error' || s.status === 'cancelled').length;
  const agentsDone = subagents.length - agentsRunning - agentsFailed;
  const tasksActive = tasks.filter((t) => t.status === 'in_progress');
  const tasksBlocked = tasks.filter((t) => t.status === 'blocked').length;
  const tasksPending = tasks.filter((t) => t.status === 'pending').length;
  const tasksDone = tasks.filter((t) => t.status === 'completed').length;
  const jobsRunning = jobs.filter((j) => j.running).length;
  const jobsFailed = jobs.filter((j) => !j.running && j.exit_code !== 0).length;
  const jobsDone = jobs.length - jobsRunning - jobsFailed;

  const { stopping, runStop } = useStopController();

  // Deep link: focus the item, then open the app.
  const openItem =
    onOpenAgents && sessionId
      ? (itemId: string) => {
          requestActivityFocus(sessionId, itemId);
          onOpenAgents();
        }
      : undefined;

  const showAgents = subagents.length > 0;
  const showTasks = tasks.length > 0;
  const showJobs = jobs.length > 0;

  if (children == null && !showAgents && !showTasks && !showJobs) {
    return null;
  }

  return (
    <div className="flex min-h-8 flex-wrap items-center gap-1 px-3 pb-1">
      {children}
      {showAgents && (
        <PillPopover
          pill={
            <StatusPill
              icon={<BotIcon className="size-3.5 shrink-0" />}
              label={
                agentsRunning > 0
                  ? `${agentsRunning} running`
                  : `${subagents.length} agent${subagents.length === 1 ? '' : 's'}`
              }
              title="Subagents"
              dotClass={
                agentsRunning > 0 ? 'bg-primary animate-pulse' : agentsFailed > 0 ? 'bg-destructive' : 'bg-success'
              }
            />
          }
        >
          <PopoverHeaderLine
            title="Subagents"
            counts={countsLine([
              [agentsRunning, 'running'],
              [agentsDone, 'done'],
              [agentsFailed, 'failed'],
            ])}
          />
          <div className="max-h-72 overflow-y-auto p-1">
            {subagents.map((s) => (
              <ActivityRow
                key={s.subagent_id}
                dotClass={subagentDotClass(s.status)}
                badge={<KindBadge subagent={s} />}
                label={subagentLabel(s)}
                tail={<SubagentTail subagent={s} />}
                onOpen={openItem ? () => openItem(subagentItemId(s.subagent_id)) : undefined}
                onStop={
                  onWorkerKill && s.kind === 'worker' && s.worker_id && s.status === 'running'
                    ? () => runStop(s.worker_id!, subagentLabel(s), () => onWorkerKill(s.worker_id!))
                    : undefined
                }
                stopping={s.worker_id ? stopping.has(s.worker_id) : false}
                onDismiss={
                  onWorkerDismiss && s.kind === 'worker' && s.worker_id && s.status !== 'running'
                    ? () => onWorkerDismiss(s.worker_id!)
                    : undefined
                }
              />
            ))}
          </div>
          {onOpenAgents ? <OpenAgentsFooter onOpen={onOpenAgents} /> : null}
        </PillPopover>
      )}
      {showTasks && (
        <PillPopover
          pill={
            <StatusPill
              icon={<ListChecksIcon className="size-3.5 shrink-0" />}
              label={`${tasksDone}/${tasks.length}`}
              title="Tasks"
              dotClass={tasksActive.length > 0 ? 'bg-primary animate-pulse' : undefined}
            />
          }
        >
          <PopoverHeaderLine
            title="Tasks"
            counts={countsLine([
              [tasksActive.length, 'active'],
              [tasksPending, 'pending'],
              [tasksBlocked, 'blocked'],
              [tasksDone, 'done'],
            ])}
          />
          {tasksActive[0] ? (
            <p className="flex items-center gap-2 px-3 pt-2 text-primary">
              <StatusDot className="bg-primary animate-pulse" />
              <span className="text-shimmer truncate italic">
                {tasksActive[0].activeForm || tasksActive[0].subject}
              </span>
            </p>
          ) : null}
          <div className="max-h-72 overflow-y-auto p-1">
            {tasks.map((t) => {
              const blockers = t.blockedBy ?? [];
              return (
                <div key={t.id} className="flex items-center gap-2 px-2 py-1.5">
                  <StatusDot className={TASK_DOT[t.status]} />
                  <span className="shrink-0 font-mono text-muted-foreground">#{t.id}</span>
                  <span
                    className={`min-w-0 flex-1 truncate ${
                      t.status === 'completed' ? 'text-muted-foreground line-through' : 'text-foreground'
                    }`}
                    title={t.subject}
                  >
                    {t.subject}
                  </span>
                  {blockers.length > 0 ? (
                    <span className="shrink-0 whitespace-nowrap text-warning">blocked by #{blockers.join(', #')}</span>
                  ) : null}
                </div>
              );
            })}
          </div>
        </PillPopover>
      )}
      {showJobs && (
        <PillPopover
          pill={
            <StatusPill
              icon={<SquareTerminalIcon className="size-3.5 shrink-0" />}
              label={
                jobsRunning > 0
                  ? `${jobsRunning} job${jobsRunning === 1 ? '' : 's'}`
                  : `${jobs.length} job${jobs.length === 1 ? '' : 's'}`
              }
              title="Background bash jobs"
              dotClass={jobsRunning > 0 ? 'bg-primary animate-pulse' : jobsFailed > 0 ? 'bg-destructive' : 'bg-success'}
            />
          }
        >
          <PopoverHeaderLine
            title="Background jobs"
            counts={countsLine([
              [jobsRunning, 'running'],
              [jobsDone, 'done'],
              [jobsFailed, 'failed'],
            ])}
          />
          <div className="max-h-72 overflow-y-auto p-1">
            {jobs.map((j) => (
              <ActivityRow
                key={j.job_id}
                dotClass={jobDotClass(j)}
                label={jobLabel(j)}
                labelClassName={j.running ? 'font-mono text-foreground' : 'font-mono text-muted-foreground'}
                tail={<JobTail job={j} />}
                onOpen={openItem ? () => openItem(jobItemId(j.job_id)) : undefined}
                onStop={
                  onJobKill && j.running ? () => runStop(j.job_id, jobLabel(j), () => onJobKill(j.job_id)) : undefined
                }
                stopping={stopping.has(j.job_id)}
                onDismiss={onJobDismiss && !j.running ? () => onJobDismiss(j.job_id) : undefined}
              />
            ))}
          </div>
          {onOpenAgents ? <OpenAgentsFooter onOpen={onOpenAgents} /> : null}
        </PillPopover>
      )}
    </div>
  );
}
