import { useStore } from '@nanostores/react';
import { CheckCircle2, ChevronDown, ChevronRight, Folder, Plus, RefreshCw } from 'lucide-react';
import { memo, useCallback, useMemo, useState } from 'react';

import { CATEGORY_LABELS, categoryOf } from '@/lib/pipeline-category';
import { ATTENTION_LABELS, type AttentionReason, groupTasks } from '@/lib/task-attention';
import { cn } from '@/renderer/ds/cn';
import { Badge } from '@/renderer/ds/ui/badge';
import { Button } from '@/renderer/ds/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/renderer/ds/ui/collapsible';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/renderer/ds/ui/dropdown-menu';
import { Input } from '@/renderer/ds/ui/input';
import { $currentPrincipal } from '@/renderer/features/Teams/state';
import { persistedStoreApi } from '@/renderer/services/store';
import { DEFAULT_PIPELINE } from '@/shared/pipeline-defaults';
import { isActivePhase } from '@/shared/ticket-phase';
import type { Pipeline, ProjectId, Ticket } from '@/shared/types';

import { AssigneeFilter } from './AssigneeFilter';
import { ProjectTaskComposer } from './ProjectTaskComposer';
import { $assigneeFilter, ticketApi } from './state';
import { PHASE_LABELS, PRIORITY_DOT_CLASSES, TICKET_PRIORITY_LABELS } from './ticket-constants';

/** Done group shows the last two weeks; older tasks live on project boards. */
const DONE_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

type TaskRowProps = {
  ticket: Ticket;
  projectLabel: string | undefined;
  pipeline: Pipeline | undefined;
  done?: boolean;
  attention?: AttentionReason;
};

const TaskRow = memo(({ ticket, projectLabel, pipeline, done, attention }: TaskRowProps) => {
  const handleOpen = useCallback(() => ticketApi.goToTicket(ticket.id), [ticket.id]);

  const category = categoryOf(pipeline, ticket.columnId);
  const columnLabel = pipeline?.columns.find((c) => c.id === ticket.columnId)?.label;
  const stage = columnLabel ? `${CATEGORY_LABELS[category]} · ${columnLabel}` : CATEGORY_LABELS[category];
  const isRunning = ticket.phase !== undefined && isActivePhase(ticket.phase);

  return (
    <Button
      variant="ghost"
      className={cn(
        'flex items-center gap-2 pl-5 pr-5 pt-2 pb-2 cursor-pointer border-0 bg-transparent w-full text-left text-foreground hover:bg-accent focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-primary focus-visible:-outline-offset-2',
        done && 'text-muted-foreground'
      )}
      onClick={handleOpen}
    >
      {done ? (
        <CheckCircle2 className="size-4 shrink-0" />
      ) : (
        <span
          className={cn('w-2 h-2 rounded-full shrink-0', PRIORITY_DOT_CLASSES[ticket.priority])}
          title={TICKET_PRIORITY_LABELS[ticket.priority]}
        />
      )}

      <span className="flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-sm">{ticket.title}</span>
      {projectLabel && (
        <span
          className="inline-flex items-center gap-1 shrink-0 text-xs text-muted-foreground max-w-40 overflow-hidden whitespace-nowrap text-ellipsis"
          title={projectLabel}
        >
          <Folder />
          {projectLabel}
        </span>
      )}
      {attention && <Badge variant="secondary">{ATTENTION_LABELS[attention]}</Badge>}
      {!attention && !done && (
        <Badge variant="secondary" className="shrink-0 hidden md:inline-flex">
          {stage}
        </Badge>
      )}
      {isRunning && ticket.phase && PHASE_LABELS[ticket.phase] && (
        <Badge variant="secondary">
          <RefreshCw className="size-3" />
          {PHASE_LABELS[ticket.phase]}
        </Badge>
      )}
    </Button>
  );
});
TaskRow.displayName = 'TaskRow';

/**
 * The Work tab's landing view: every task across every project, grouped
 * attention-first — Needs you → Doing → To do → Done. Groups key on the
 * column's status category (+ derived attention), never on raw column ids,
 * so custom pipelines all read the same way here.
 */
export const WorkAllView = memo(() => {
  const store = useStore(persistedStoreApi.$atom);
  const assigneeFilter = useStore($assigneeFilter);
  const currentPrincipal = useStore($currentPrincipal);

  const [query, setQuery] = useState('');
  const [projectFilter, setProjectFilter] = useState<ProjectId | 'all'>('all');
  const [doneExpanded, setDoneExpanded] = useState(false);
  const [composerProjectId, setComposerProjectId] = useState<ProjectId | null>(null);

  const pipelines = useMemo(() => {
    const map = new Map<ProjectId, Pipeline>();
    for (const project of store.projects) {
      map.set(project.id, project.pipeline ?? DEFAULT_PIPELINE);
    }
    return map;
  }, [store.projects]);
  const pipelineFor = useCallback((projectId: ProjectId) => pipelines.get(projectId), [pipelines]);

  const projectLabels = useMemo(() => {
    const map: Record<ProjectId, string> = {};
    for (const p of store.projects) {
      map[p.id] = p.label;
    }
    return map;
  }, [store.projects]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return store.tickets.filter((t) => {
      if (t.archivedAt) {
        return false;
      }
      if (projectFilter !== 'all' && t.projectId !== projectFilter) {
        return false;
      }
      if (assigneeFilter === 'me') {
        if (!currentPrincipal || t.assignee !== currentPrincipal) {
          return false;
        }
      } else if (assigneeFilter === 'unassigned') {
        if (t.assignee) {
          return false;
        }
      } else if (assigneeFilter !== 'all' && t.assignee !== assigneeFilter) {
        return false;
      }
      if (q && !t.title.toLowerCase().includes(q) && !t.description.toLowerCase().includes(q)) {
        return false;
      }
      return true;
    });
  }, [store.tickets, query, projectFilter, assigneeFilter, currentPrincipal]);

  const grouped = useMemo(() => groupTasks(filtered, pipelineFor), [filtered, pipelineFor]);

  const doneWindowed = useMemo(() => {
    const cutoff = Date.now() - DONE_WINDOW_MS;
    return grouped.done.filter((t) => (t.completedAt ?? t.updatedAt) >= cutoff);
  }, [grouped.done]);

  const handleQueryChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => setQuery(e.target.value), []);
  const handleProjectFilterChange = useCallback((value: string) => setProjectFilter(value as ProjectId | 'all'), []);

  const handleNewTask = useCallback((projectId: ProjectId) => setComposerProjectId(projectId), []);

  const projectFilterLabel = projectFilter === 'all' ? 'All projects' : (projectLabels[projectFilter] ?? 'Project');
  const isEmpty =
    grouped.needsYou.length === 0 &&
    grouped.doing.length === 0 &&
    grouped.todo.length === 0 &&
    doneWindowed.length === 0;

  return (
    <div className="flex flex-col h-full" data-slot="work-all-view">
      <div role="toolbar" aria-label="Task filters" className="flex items-center gap-2 pl-5 pr-5 pt-4 pb-2 flex-wrap">
        <Input
          aria-label="Search tasks"
          type="text"
          value={query}
          onChange={handleQueryChange}
          placeholder="Search tasks…"
          className="flex-auto basis-56 min-w-40 max-w-sm"
        />

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="ghost">
              <Folder />
              {projectFilterLabel}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuRadioGroup value={projectFilter} onValueChange={handleProjectFilterChange}>
              <DropdownMenuRadioItem value="all">All projects</DropdownMenuRadioItem>
              <DropdownMenuSeparator />
              {store.projects.map((p) => (
                <DropdownMenuRadioItem key={p.id} value={p.id}>
                  {p.label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <AssigneeFilter />
        <div className="flex-1" />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm">
              <Plus />
              New task
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {store.projects.length === 0 ? (
              <DropdownMenuItem disabled>Create a project first</DropdownMenuItem>
            ) : (
              store.projects.map((p) => (
                <DropdownMenuItem key={p.id} onClick={handleNewTask.bind(null, p.id)}>
                  {p.label}
                </DropdownMenuItem>
              ))
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto pb-8">
        {isEmpty && (
          <p className="p-5 text-muted-foreground italic">{query ? 'No tasks match your search.' : 'No tasks yet.'}</p>
        )}

        {grouped.needsYou.length > 0 && (
          <>
            <div className="flex items-center gap-2 pl-5 pr-5 pt-4 pb-1">
              <span
                className={cn(
                  'text-xs font-semibold text-muted-foreground',
                  'uppercase tracking-wider text-muted-foreground'
                )}
              >
                Needs you
              </span>
              <span className="text-xs text-muted-foreground">({grouped.needsYou.length})</span>
            </div>
            {grouped.needsYou.map(({ ticket, reason }) => (
              <TaskRow
                key={ticket.id}
                ticket={ticket}
                projectLabel={projectLabels[ticket.projectId]}
                pipeline={pipelineFor(ticket.projectId)}
                attention={reason}
              />
            ))}
          </>
        )}

        {grouped.doing.length > 0 && (
          <>
            <div className="flex items-center gap-2 pl-5 pr-5 pt-4 pb-1">
              <span
                className={cn(
                  'text-xs font-semibold text-muted-foreground',
                  'uppercase tracking-wider text-muted-foreground'
                )}
              >
                Doing
              </span>
              <span className="text-xs text-muted-foreground">({grouped.doing.length})</span>
            </div>
            {grouped.doing.map((ticket) => (
              <TaskRow
                key={ticket.id}
                ticket={ticket}
                projectLabel={projectLabels[ticket.projectId]}
                pipeline={pipelineFor(ticket.projectId)}
              />
            ))}
          </>
        )}

        {grouped.todo.length > 0 && (
          <>
            <div className="flex items-center gap-2 pl-5 pr-5 pt-4 pb-1">
              <span
                className={cn(
                  'text-xs font-semibold text-muted-foreground',
                  'uppercase tracking-wider text-muted-foreground'
                )}
              >
                To do
              </span>
              <span className="text-xs text-muted-foreground">({grouped.todo.length})</span>
            </div>
            {grouped.todo.map((ticket) => (
              <TaskRow
                key={ticket.id}
                ticket={ticket}
                projectLabel={projectLabels[ticket.projectId]}
                pipeline={pipelineFor(ticket.projectId)}
              />
            ))}
          </>
        )}

        {doneWindowed.length > 0 && (
          <Collapsible open={doneExpanded} onOpenChange={setDoneExpanded}>
            <div className="flex items-center gap-2 pl-5 pr-5 pt-4 pb-1">
              <CollapsibleTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  className="flex items-center gap-1.5 border-0 bg-transparent cursor-pointer p-0 text-muted-foreground"
                >
                  {doneExpanded ? <ChevronDown /> : <ChevronRight />}
                  <span
                    className={cn(
                      'text-xs font-semibold text-muted-foreground',
                      'uppercase tracking-wider text-muted-foreground'
                    )}
                  >
                    Done
                  </span>
                  <span className="text-xs text-muted-foreground">({doneWindowed.length} in the last 14 days)</span>
                </Button>
              </CollapsibleTrigger>
            </div>
            <CollapsibleContent>
              {doneWindowed.map((ticket) => (
                <TaskRow
                  key={ticket.id}
                  ticket={ticket}
                  projectLabel={projectLabels[ticket.projectId]}
                  pipeline={pipelineFor(ticket.projectId)}
                  done
                />
              ))}
            </CollapsibleContent>
          </Collapsible>
        )}
      </div>
      {composerProjectId && (
        <ProjectTaskComposer
          projectId={composerProjectId}
          open
          onOpenChange={(open) => {
            if (!open) {
              setComposerProjectId(null);
            }
          }}
        />
      )}
    </div>
  );
});
WorkAllView.displayName = 'WorkAllView';
