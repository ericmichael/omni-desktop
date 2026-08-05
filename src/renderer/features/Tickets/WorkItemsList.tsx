import { useStore } from '@nanostores/react';
import {
  Archive,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Ellipsis,
  Flag,
  Kanban,
  List,
  Play,
  Plus,
  RefreshCw,
} from 'lucide-react';
import { map } from 'nanostores';
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
import { ToggleGroup, ToggleGroupItem } from '@/renderer/ds/ui/toggle-group';
import { $milestones } from '@/renderer/features/Initiatives/state';
import { AssigneeFilter } from '@/renderer/features/Tickets/AssigneeFilter';
import { isActivePhase } from '@/shared/ticket-phase';
import type { ColumnCategory, Milestone, MilestoneId, Pipeline, ProjectId, Ticket, TicketId } from '@/shared/types';

import { KanbanBoard } from './KanbanBoard';
import { ProjectPageHeader } from './ProjectPageHeader';
import { ProjectTaskComposer } from './ProjectTaskComposer';
import { $activeMilestoneId, $pipeline, $tickets, ticketApi } from './state';
import { PHASE_LABELS, PRIORITY_DOT_CLASSES, TICKET_PRIORITY_LABELS } from './ticket-constants';

type ViewMode = 'list' | 'board';
type VisibilityFilter = 'current' | 'archived';

/**
 * List/board choice per project, session-scoped. A module-level atom instead
 * of component state so navigating away and back doesn't reset the choice.
 */
const $viewModes = map<Record<string, ViewMode>>({});

/** Open the project's Tasks surface in its optional board view. */
export function openProjectBoard(projectId: ProjectId): void {
  $viewModes.setKey(projectId, 'board');
  ticketApi.goToProject(projectId, 'tasks');
}
type TicketRowProps = {
  ticket: Ticket;
  selected: boolean;
  hovered: boolean;
  unresolvedBlockers: number;
  projectMilestones: Milestone[];
  category: ColumnCategory;
  columnLabel?: string;
  milestoneTitle?: string;
  attention?: AttentionReason;
  onSelect: (ticketId: TicketId) => void;
  onHoverChange: (ticketId: TicketId | null) => void;
};

const TicketRow = memo(
  ({
    ticket,
    selected,
    hovered,
    unresolvedBlockers,
    projectMilestones,
    category,
    columnLabel,
    milestoneTitle,
    attention,
    onSelect,
    onHoverChange,
  }: TicketRowProps) => {
    const phase = ticket.phase;

    const handleClick = useCallback(() => {
      onSelect(ticket.id);
    }, [onSelect, ticket.id]);

    const handleMouseEnter = useCallback(() => {
      onHoverChange(ticket.id);
    }, [onHoverChange, ticket.id]);

    const handleMouseLeave = useCallback(() => {
      onHoverChange(null);
    }, [onHoverChange]);

    const handleAutopilot = useCallback(() => {
      ticketApi.requestStartSupervisor(ticket.id);
    }, [ticket.id]);

    const handleStopPropagation = useCallback((e: React.MouseEvent) => {
      e.stopPropagation();
    }, []);

    const handleToggleArchive = useCallback(() => {
      if (ticket.archivedAt) {
        void ticketApi.unarchiveTicket(ticket.id);
      } else {
        void ticketApi.archiveTicket(ticket.id);
      }
    }, [ticket.id, ticket.archivedAt]);

    const handleMoveToMilestone = useCallback(
      (milestoneId: MilestoneId | undefined) => {
        void ticketApi.moveTicketToMilestone(ticket.id, milestoneId);
      },
      [ticket.id]
    );

    const completed = !ticket.archivedAt && category === 'done';
    const isRunning = phase !== undefined && isActivePhase(phase);
    const stage = columnLabel ? `${CATEGORY_LABELS[category]} · ${columnLabel}` : CATEGORY_LABELS[category];

    const handleKeyDown = useCallback(
      (e: React.KeyboardEvent) => {
        if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          onSelect(ticket.id);
        }
      },
      [onSelect, ticket.id]
    );

    return (
      // div+role rather than <button>: the row hosts real buttons (actions,
      // overflow menu), and nesting them inside a button is invalid markup.
      <div
        role="button"
        tabIndex={0}
        className={`${'flex items-center gap-2 pl-5 pr-2 pt-2 pb-2 cursor-pointer border-0 bg-transparent w-full text-left text-foreground transition-colors duration-100 hover:bg-accent focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-primary focus-visible:-outline-offset-2'} ${selected ? 'bg-accent' : ''}`}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        {completed ? (
          <CheckCircle2 className="size-4 shrink-0 text-muted-foreground" />
        ) : ticket.archivedAt ? (
          <Archive className="size-4 shrink-0 text-muted-foreground" />
        ) : (
          <span
            className={cn('w-2 h-2 rounded-full shrink-0', PRIORITY_DOT_CLASSES[ticket.priority])}
            title={TICKET_PRIORITY_LABELS[ticket.priority]}
          />
        )}
        <span
          className={cn(
            'flex-1 min-w-20 overflow-hidden text-ellipsis whitespace-nowrap text-sm',
            completed && 'text-muted-foreground'
          )}
        >
          {ticket.title}
        </span>
        {!hovered && (
          <span className="flex items-center gap-1.5 min-w-0 max-w-1/2 flex-initial overflow-hidden">
            {milestoneTitle && (
              <span
                className="inline-flex items-center gap-1 min-w-0 max-w-60 text-muted-foreground text-xs"
                title={milestoneTitle}
              >
                <Flag className="size-3 shrink-0" />
                <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{milestoneTitle}</span>
              </span>
            )}
            {attention && <Badge variant="secondary">{ATTENTION_LABELS[attention]}</Badge>}
            {!attention && unresolvedBlockers > 0 && <Badge variant="secondary">Blocked</Badge>}
            {!attention && !completed && !ticket.archivedAt && (
              <Badge
                variant="secondary"
                className="hidden md:inline-flex md:max-w-40 md:overflow-hidden md:text-ellipsis md:whitespace-nowrap"
                title={stage}
              >
                {stage}
              </Badge>
            )}
            {isRunning && phase && PHASE_LABELS[phase] && (
              <Badge variant="secondary">
                <RefreshCw className="size-3" />
                {PHASE_LABELS[phase]}
              </Badge>
            )}
            {ticket.archivedAt && <span className="text-xs text-muted-foreground">Archived</span>}
          </span>
        )}
        {hovered && !completed && !ticket.archivedAt && (
          <span
            className="flex items-center gap-0.5 shrink-0 transition-opacity duration-100"
            onClick={handleStopPropagation}
          >
            <Button type="button" variant="ghost" size="icon-sm" aria-label="Ask Omni" onClick={handleAutopilot}>
              <Play />
            </Button>
          </span>
        )}
        <span
          className={cn(
            'flex items-center shrink-0 opacity-100 transition-opacity duration-100 md:opacity-0',
            hovered && 'opacity-100'
          )}
          onClick={handleStopPropagation}
        >
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="ghost" size="icon-sm" aria-label="Task actions">
                <Ellipsis />
              </Button>
            </DropdownMenuTrigger>
            <>
              <DropdownMenuContent>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <DropdownMenuItem>Move to milestone…</DropdownMenuItem>
                  </DropdownMenuTrigger>
                  <>
                    <DropdownMenuContent>
                      <DropdownMenuItem onClick={() => handleMoveToMilestone(undefined)}>
                        <span className="inline-flex w-4 justify-center mr-1">{!ticket.milestoneId && <Check />}</span>
                        No milestone
                      </DropdownMenuItem>
                      {projectMilestones.length > 0 && <DropdownMenuSeparator />}
                      {projectMilestones.map((m) => (
                        <DropdownMenuItem key={m.id} onClick={() => handleMoveToMilestone(m.id)}>
                          <span className="inline-flex w-4 justify-center mr-1">
                            {ticket.milestoneId === m.id && <Check />}
                          </span>
                          {m.title || 'Untitled milestone'}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </>
                </DropdownMenu>
                <DropdownMenuItem onClick={handleToggleArchive}>
                  <Archive />
                  {ticket.archivedAt ? 'Unarchive' : 'Archive'}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </>
          </DropdownMenu>
        </span>
      </div>
    );
  }
);
TicketRow.displayName = 'TicketRow';

type TaskGroupProps = {
  title?: string;
  hideHeader?: boolean;
  tickets?: Ticket[];
  attentionTickets?: { ticket: Ticket; reason: AttentionReason }[];
  ticketMap: Record<string, Ticket>;
  pipeline: Pipeline | null;
  milestones: Record<string, Milestone>;
  projectMilestones: Milestone[];
  selectedTicketId?: TicketId | null;
  hoveredId: TicketId | null;
  onSelect: (ticketId: TicketId) => void;
  onHoverChange: (ticketId: TicketId | null) => void;
};

const TaskGroup = memo(
  ({
    title,
    hideHeader,
    tickets = [],
    attentionTickets = [],
    ticketMap,
    pipeline,
    milestones,
    projectMilestones,
    selectedTicketId,
    hoveredId,
    onSelect,
    onHoverChange,
  }: TaskGroupProps) => {
    const entries =
      attentionTickets.length > 0
        ? attentionTickets
        : tickets.map((ticket) => ({ ticket, reason: undefined as AttentionReason | undefined }));

    if (entries.length === 0) {
      return null;
    }

    return (
      <>
        {!hideHeader && title && (
          <div className="flex items-center gap-2 pl-5 pr-5 pt-4 pb-1">
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{title}</span>
            <span className="text-xs text-muted-foreground">({entries.length})</span>
          </div>
        )}
        {entries.map(({ ticket, reason }) => {
          const unresolvedBlockers = ticket.blockedBy.filter((id) => {
            const blocker = ticketMap[id];
            return blocker && !blocker.archivedAt && categoryOf(pipeline, blocker.columnId) !== 'done';
          }).length;
          return (
            <TicketRow
              key={ticket.id}
              ticket={ticket}
              selected={selectedTicketId === ticket.id}
              hovered={hoveredId === ticket.id}
              unresolvedBlockers={unresolvedBlockers}
              projectMilestones={projectMilestones}
              category={categoryOf(pipeline, ticket.columnId)}
              columnLabel={pipeline?.columns.find((column) => column.id === ticket.columnId)?.label}
              milestoneTitle={ticket.milestoneId ? milestones[ticket.milestoneId]?.title : undefined}
              attention={reason}
              onSelect={onSelect}
              onHoverChange={onHoverChange}
            />
          );
        })}
      </>
    );
  }
);
TaskGroup.displayName = 'TaskGroup';

type WorkItemsListProps = {
  projectId: ProjectId;
  selectedTicketId?: TicketId | null;
  onSelectTicket?: (ticketId: TicketId) => void;
  /** The page title ("Tasks", or a milestone's name). */
  pageTitle: string;
  /** Caption line under the title (e.g. milestone metadata). */
  contextLabel?: React.ReactNode;
  /** Optional actions rendered at the right edge of the title row (after
   *  the filter / view-mode toggle), e.g. a milestone overflow menu. */
  rightActions?: React.ReactNode;
  /** Mobile: the TopAppBar already shows back + title, so render only the
   *  count + filter controls in the header row. */
  hideChrome?: boolean;
};

export const WorkItemsList = memo(
  ({
    projectId,
    selectedTicketId,
    onSelectTicket,
    pageTitle,
    contextLabel,
    rightActions,
    hideChrome,
  }: WorkItemsListProps) => {
    const ticketMap = useStore($tickets);
    const pipeline = useStore($pipeline);
    const milestones = useStore($milestones);
    const activeMilestoneId = useStore($activeMilestoneId);
    const viewModes = useStore($viewModes);
    const viewMode: ViewMode = viewModes[projectId] ?? 'list';
    const [visibilityFilter, setVisibilityFilter] = useState<VisibilityFilter>('current');
    const [taskComposerOpen, setTaskComposerOpen] = useState(false);
    const [hoveredId, setHoveredId] = useState<TicketId | null>(null);
    const [completedExpanded, setCompletedExpanded] = useState(false);
    const [query, setQuery] = useState('');
    const projectMilestones = useMemo(
      () => Object.values(milestones).filter((m) => m.projectId === projectId),
      [milestones, projectId]
    );

    const scopedTickets = useMemo(
      () =>
        Object.values(ticketMap).filter(
          (t) => t.projectId === projectId && (activeMilestoneId === 'all' || t.milestoneId === activeMilestoneId)
        ),
      [ticketMap, projectId, activeMilestoneId]
    );

    const archivedCount = useMemo(() => scopedTickets.filter((t) => t.archivedAt).length, [scopedTickets]);

    const visibleTickets = useMemo(() => {
      const normalizedQuery = query.trim().toLowerCase();
      const all = scopedTickets.filter((t) => {
        if (visibilityFilter === 'current') {
          if (t.archivedAt) {
            return false;
          }
        } else if (visibilityFilter === 'archived') {
          if (!t.archivedAt) {
            return false;
          }
        }
        return (
          !normalizedQuery ||
          t.title.toLowerCase().includes(normalizedQuery) ||
          t.description.toLowerCase().includes(normalizedQuery)
        );
      });
      return all.sort((a, b) => a.createdAt - b.createdAt);
    }, [query, scopedTickets, visibilityFilter]);

    const grouped = useMemo(() => groupTasks(visibleTickets, () => pipeline), [pipeline, visibleTickets]);
    const archivedTickets = useMemo(
      () => visibleTickets.filter((ticket) => ticket.archivedAt).sort((a, b) => b.updatedAt - a.updatedAt),
      [visibleTickets]
    );

    const handleNewTicket = useCallback(() => setTaskComposerOpen(true), []);

    const handleTicketClick = useCallback(
      (ticketId: TicketId) => {
        if (onSelectTicket) {
          onSelectTicket(ticketId);
        } else {
          ticketApi.goToTicket(ticketId);
        }
      },
      [onSelectTicket]
    );

    const handleViewModeChange = useCallback(
      (value: string) => {
        if (value === 'list' || value === 'board') {
          $viewModes.setKey(projectId, value);
        }
      },
      [projectId]
    );

    const filterOptions = [
      { value: 'current', label: 'Tasks' },
      { value: 'archived', label: `Archived${archivedCount ? ` (${archivedCount})` : ''}` },
    ] as const;
    const filterControl = (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm">
            {visibilityFilter === 'archived' ? <Archive /> : <List />}
            {visibilityFilter === 'archived' ? 'Archived' : 'Current'}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuRadioGroup
            value={visibilityFilter}
            onValueChange={(value) => setVisibilityFilter(value as VisibilityFilter)}
          >
            {filterOptions.map((option) => (
              <DropdownMenuRadioItem key={option.value} value={option.value}>
                {option.label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    );

    const viewControl = (
      <ToggleGroup
        type="single"
        variant="outline"
        spacing={0}
        value={viewMode}
        onValueChange={handleViewModeChange}
        aria-label="Task layout"
      >
        <ToggleGroupItem value="list" aria-label="List view" className="gap-1.5">
          <List />
          List
        </ToggleGroupItem>
        <ToggleGroupItem value="board" aria-label="Board view" className="gap-1.5">
          <Kanban />
          Board
        </ToggleGroupItem>
      </ToggleGroup>
    );

    return (
      <div className="flex flex-col h-full min-w-0 min-h-0 overflow-hidden">
        {!hideChrome && (
          <ProjectPageHeader
            title={pageTitle}
            actions={rightActions}
            meta={contextLabel ? <span className="text-xs text-muted-foreground">{contextLabel}</span> : undefined}
          />
        )}

        <div
          role="toolbar"
          aria-label="Task filters"
          className="flex flex-wrap items-center gap-2 pl-5 pr-5 pt-2 pb-2 shrink-0"
        >
          <Input
            aria-label="Search tasks"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search tasks…"
            className="flex-auto basis-56 min-w-40 max-w-sm"
          />
          <div className="flex-1" />
          {viewControl}
          {filterControl}
          {viewMode === 'board' && <AssigneeFilter />}
          {hideChrome && rightActions}
          <Button type="button" size="sm" onClick={handleNewTicket}>
            <Plus />
            New task
          </Button>
        </div>

        {viewMode === 'list' ? (
          <div className="flex-1 min-h-0 overflow-y-auto">
            {visibleTickets.length === 0 && (
              <p className="p-5 text-muted-foreground italic">
                {query ? 'No tasks match your search.' : 'No tasks yet.'}
              </p>
            )}

            {visibilityFilter === 'archived' ? (
              <TaskGroup
                title="Archived"
                tickets={archivedTickets}
                ticketMap={ticketMap}
                pipeline={pipeline}
                milestones={milestones}
                projectMilestones={projectMilestones}
                selectedTicketId={selectedTicketId}
                hoveredId={hoveredId}
                onSelect={handleTicketClick}
                onHoverChange={setHoveredId}
              />
            ) : (
              <>
                <TaskGroup
                  title="Needs you"
                  attentionTickets={grouped.needsYou}
                  ticketMap={ticketMap}
                  pipeline={pipeline}
                  milestones={milestones}
                  projectMilestones={projectMilestones}
                  selectedTicketId={selectedTicketId}
                  hoveredId={hoveredId}
                  onSelect={handleTicketClick}
                  onHoverChange={setHoveredId}
                />
                <TaskGroup
                  title="Doing"
                  tickets={grouped.doing}
                  ticketMap={ticketMap}
                  pipeline={pipeline}
                  milestones={milestones}
                  projectMilestones={projectMilestones}
                  selectedTicketId={selectedTicketId}
                  hoveredId={hoveredId}
                  onSelect={handleTicketClick}
                  onHoverChange={setHoveredId}
                />
                <TaskGroup
                  title="To do"
                  tickets={grouped.todo}
                  ticketMap={ticketMap}
                  pipeline={pipeline}
                  milestones={milestones}
                  projectMilestones={projectMilestones}
                  selectedTicketId={selectedTicketId}
                  hoveredId={hoveredId}
                  onSelect={handleTicketClick}
                  onHoverChange={setHoveredId}
                />
              </>
            )}

            {visibilityFilter === 'current' && grouped.done.length > 0 && (
              <Collapsible open={completedExpanded} onOpenChange={setCompletedExpanded}>
                <div className="flex items-center gap-2 pl-5 pr-5 pt-4 pb-1">
                  <CollapsibleTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      className="h-auto gap-1.5 px-0 py-1 text-muted-foreground hover:bg-transparent hover:text-foreground"
                    >
                      {completedExpanded ? <ChevronDown /> : <ChevronRight />}
                      <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Done</span>
                      <span className="text-xs text-muted-foreground">({grouped.done.length})</span>
                    </Button>
                  </CollapsibleTrigger>
                </div>
                <CollapsibleContent>
                  <TaskGroup
                    tickets={grouped.done}
                    hideHeader
                    ticketMap={ticketMap}
                    pipeline={pipeline}
                    milestones={milestones}
                    projectMilestones={projectMilestones}
                    selectedTicketId={selectedTicketId}
                    hoveredId={hoveredId}
                    onSelect={handleTicketClick}
                    onHoverChange={setHoveredId}
                  />
                </CollapsibleContent>
              </Collapsible>
            )}
          </div>
        ) : (
          <div className="flex-1 min-w-0 min-h-0 overflow-hidden">
            <KanbanBoard projectId={projectId} visibilityFilter={visibilityFilter} query={query} />
          </div>
        )}
        <ProjectTaskComposer
          projectId={projectId}
          milestoneId={activeMilestoneId !== 'all' ? activeMilestoneId : undefined}
          open={taskComposerOpen}
          onOpenChange={setTaskComposerOpen}
        />
      </div>
    );
  }
);
WorkItemsList.displayName = 'WorkItemsList';
