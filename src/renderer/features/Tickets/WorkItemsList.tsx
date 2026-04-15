import { makeStyles, mergeClasses, shorthands,tokens } from '@fluentui/react-components';
import {
  Add16Regular,
  Archive20Regular,
  ArrowLeft20Regular,
  ArrowSync20Regular,
  Board20Regular,
  BranchFork16Regular,
  Checkmark16Regular,
  Delete20Regular,
  List20Regular,
  MoreHorizontal20Regular,
  Open20Regular,
  Play20Filled,
} from '@fluentui/react-icons';
import { useStore } from '@nanostores/react';
import { memo, useCallback, useMemo, useState } from 'react';

import { Badge, Caption1, ConfirmDialog, IconButton, Menu, MenuDivider, MenuItem, MenuList, MenuPopover, MenuTrigger, SectionLabel, SegmentedControl, Subtitle2 } from '@/renderer/ds';
import { $milestones } from '@/renderer/features/Initiatives/state';
import { openTicketInCode } from '@/renderer/services/navigation';
import { isActivePhase } from '@/shared/ticket-phase';
import type { MilestoneId, Milestone, ProjectId, Ticket, TicketId } from '@/shared/types';

import { KanbanBoard } from './KanbanBoard';
import { $activeMilestoneId, $pipeline, $tickets, ticketApi } from './state';
import { PHASE_COLORS, PHASE_LABELS, TICKET_PRIORITY_LABELS } from './ticket-constants';

type ViewMode = 'list' | 'board';
type VisibilityFilter = 'active' | 'resolved' | 'archived' | 'all';
type TicketRowProps = {
  ticket: Ticket;
  selected: boolean;
  hovered: boolean;
  milestoneTitle?: string;
  projectMilestones: Milestone[];
  columnLabel: string;
  columnBadgeColor: 'blue' | 'green' | 'default';
  onSelect: (ticketId: TicketId) => void;
  onHoverChange: (ticketId: TicketId | null) => void;
  onRequestDelete: (ticket: Ticket) => void;
};

const PRIORITY_DOT_COLORS: Record<string, string> = {
  critical: tokens.colorPaletteRedForeground1,
  high: tokens.colorPaletteYellowForeground1,
  medium: tokens.colorPaletteBlueForeground2,
  low: tokens.colorNeutralForeground3,
};

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    paddingLeft: tokens.spacingHorizontalL,
    paddingRight: tokens.spacingHorizontalL,
    paddingTop: tokens.spacingVerticalS,
    paddingBottom: tokens.spacingVerticalS,
    ...shorthands.borderBottom('1px', 'solid', tokens.colorNeutralStroke1),
    flexShrink: 0,
  },
  headerTitle: {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    minWidth: 0,
  },
  controls: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
  },
  flex1: {
    flex: '1 1 0',
  },
  /* List view */
  list: {
    flex: '1 1 0',
    minHeight: 0,
    overflowY: 'auto',
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    paddingLeft: tokens.spacingHorizontalL,
    paddingRight: tokens.spacingHorizontalS,
    paddingTop: '8px',
    paddingBottom: '8px',
    cursor: 'pointer',
    border: 'none',
    backgroundColor: 'transparent',
    width: '100%',
    textAlign: 'left',
    color: tokens.colorNeutralForeground1,
    transitionProperty: 'background-color',
    transitionDuration: tokens.durationFaster,
    ':hover': {
      backgroundColor: tokens.colorSubtleBackgroundHover,
    },
  },
  rowSelected: {
    backgroundColor: tokens.colorSubtleBackgroundSelected,
  },
  rowResolved: {
    opacity: 0.5,
  },
  priorityDot: {
    width: '8px',
    height: '8px',
    borderRadius: '50%',
    flexShrink: 0,
  },
  title: {
    flex: '1 1 0',
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: tokens.fontSizeBase300,
  },
  cellColumn: {
    flexShrink: 0,
    minWidth: '72px',
  },
  cellMilestone: {
    flexShrink: 0,
    display: 'none',
    '@media (min-width: 768px)': {
      display: 'block',
    },
  },
  cellPhase: {
    flexShrink: 0,
    display: 'none',
    '@media (min-width: 640px)': {
      display: 'flex',
      alignItems: 'center',
      gap: '4px',
    },
  },
  cellActions: {
    display: 'flex',
    alignItems: 'center',
    gap: '2px',
    flexShrink: 0,
    opacity: 0,
    transitionProperty: 'opacity',
    transitionDuration: tokens.durationFaster,
  },
  cellMenu: {
    display: 'flex',
    alignItems: 'center',
    flexShrink: 0,
    opacity: 1,
    transitionProperty: 'opacity',
    transitionDuration: tokens.durationFaster,
    '@media (min-width: 768px)': {
      opacity: 0,
    },
  },
  cellMenuVisible: {
    opacity: 1,
  },
  branchBadge: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '2px',
    flexShrink: 0,
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
    maxWidth: '140px',
    overflow: 'hidden',
    whiteSpace: 'nowrap',
    textOverflow: 'ellipsis',
  },
  dangerMenuItem: {
    color: tokens.colorPaletteRedForeground1,
  },
  checkmarkSlot: {
    display: 'inline-flex',
    width: '16px',
    justifyContent: 'center',
    marginRight: '4px',
  },
  newBtn: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    width: '100%',
    paddingLeft: tokens.spacingHorizontalL,
    paddingRight: tokens.spacingHorizontalL,
    paddingTop: '8px',
    paddingBottom: '8px',
    border: 'none',
    backgroundColor: 'transparent',
    cursor: 'pointer',
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase300,
    transitionProperty: 'background-color, color',
    transitionDuration: tokens.durationFaster,
    ':hover': {
      backgroundColor: tokens.colorSubtleBackgroundHover,
      color: tokens.colorNeutralForeground1,
    },
  },
  boardWrap: {
    flex: '1 1 0',
    minHeight: 0,
  },
  emptyHint: {
    padding: tokens.spacingHorizontalL,
    color: tokens.colorNeutralForeground3,
    fontStyle: 'italic',
  },
});

const TicketRow = memo(({ ticket, selected, hovered, milestoneTitle, projectMilestones, columnLabel, columnBadgeColor, onSelect, onHoverChange, onRequestDelete }: TicketRowProps) => {
  const styles = useStyles();
  const phase = ticket.phase;
  const isRunning = phase !== undefined && phase !== null && isActivePhase(phase);

  const handleClick = useCallback(() => {
    onSelect(ticket.id);
  }, [onSelect, ticket.id]);

  const handleMouseEnter = useCallback(() => {
    onHoverChange(ticket.id);
  }, [onHoverChange, ticket.id]);

  const handleMouseLeave = useCallback(() => {
    onHoverChange(null);
  }, [onHoverChange]);

  const handleOpenInCode = useCallback(() => {
    void openTicketInCode(ticket.id);
  }, [ticket.id]);

  const handleAutopilot = useCallback(() => {
    void openTicketInCode(ticket.id);
    void ticketApi.startSupervisor(ticket.id);
  }, [ticket.id]);

  const handleStopPropagation = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
  }, []);

  const handleDelete = useCallback(() => {
    onRequestDelete(ticket);
  }, [onRequestDelete, ticket]);

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

  const truncatedBranch = ticket.branch && ticket.branch.length > 18 ? `${ticket.branch.slice(0, 17)}…` : ticket.branch;

  return (
    <button
      type="button"
      className={`${styles.row} ${selected ? styles.rowSelected : ''} ${ticket.resolution ? styles.rowResolved : ''}`}
      onClick={handleClick}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <span
        className={styles.priorityDot}
        style={{ backgroundColor: PRIORITY_DOT_COLORS[ticket.priority] ?? tokens.colorNeutralForeground3 }}
        title={TICKET_PRIORITY_LABELS[ticket.priority]}
      />
      <span className={styles.title}>{ticket.title}</span>
      {ticket.branch && (
        <span className={styles.branchBadge} title={ticket.branch}>
          <BranchFork16Regular />
          {truncatedBranch}
        </span>
      )}
      <span className={styles.cellColumn}>
        <Badge color={columnBadgeColor}>{columnLabel}</Badge>
      </span>
      {milestoneTitle && (
        <span className={styles.cellMilestone}>
          <Badge color="purple" truncate maxWidth={160}>{milestoneTitle}</Badge>
        </span>
      )}
      {phase && phase !== 'idle' && !ticket.resolution && (
        <span className={styles.cellPhase}>
          <Badge color={PHASE_COLORS[phase] ?? 'default'}>
            {isRunning && <ArrowSync20Regular style={{ width: 12, height: 12 }} />}
            {PHASE_LABELS[phase] ?? phase}
          </Badge>
        </span>
      )}
      {hovered && !ticket.resolution && !isRunning && (
        <span className={styles.cellActions} style={{ opacity: 1 }} onClick={handleStopPropagation}>
          <IconButton icon={<Open20Regular />} size="sm" aria-label="Open in Code" onClick={handleOpenInCode} />
          <IconButton icon={<Play20Filled />} size="sm" aria-label="Autopilot" onClick={handleAutopilot} />
        </span>
      )}
      <span
        className={mergeClasses(styles.cellMenu, hovered && styles.cellMenuVisible)}
        onClick={handleStopPropagation}
      >
        <Menu positioning={{ position: 'below', align: 'end' }}>
          <MenuTrigger disableButtonEnhancement>
            <IconButton icon={<MoreHorizontal20Regular />} size="sm" aria-label="Ticket actions" />
          </MenuTrigger>
          <MenuPopover>
            <MenuList>
              <Menu positioning={{ position: 'before', align: 'top' }}>
                <MenuTrigger disableButtonEnhancement>
                  <MenuItem>Move to milestone…</MenuItem>
                </MenuTrigger>
                <MenuPopover>
                  <MenuList>
                    <MenuItem onClick={() => handleMoveToMilestone(undefined)}>
                      <span className={styles.checkmarkSlot}>
                        {!ticket.milestoneId && <Checkmark16Regular />}
                      </span>
                      No milestone
                    </MenuItem>
                    {projectMilestones.length > 0 && <MenuDivider />}
                    {projectMilestones.map((m) => (
                      <MenuItem key={m.id} onClick={() => handleMoveToMilestone(m.id)}>
                        <span className={styles.checkmarkSlot}>
                          {ticket.milestoneId === m.id && <Checkmark16Regular />}
                        </span>
                        {m.title || 'Untitled milestone'}
                      </MenuItem>
                    ))}
                  </MenuList>
                </MenuPopover>
              </Menu>
              <MenuItem icon={<Archive20Regular />} onClick={handleToggleArchive}>
                {ticket.archivedAt ? 'Unarchive' : 'Archive'}
              </MenuItem>
              <MenuDivider />
              <MenuItem
                icon={<Delete20Regular />}
                onClick={handleDelete}
                className={styles.dangerMenuItem}
              >
                Delete
              </MenuItem>
            </MenuList>
          </MenuPopover>
        </Menu>
      </span>
    </button>
  );
});
TicketRow.displayName = 'TicketRow';

type WorkItemsListProps = {
  projectId: ProjectId;
  selectedTicketId?: TicketId | null;
  onSelectTicket?: (ticketId: TicketId) => void;
  title?: string;
  contextLabel?: string;
  onBack?: () => void;
};

export const WorkItemsList = memo(({ projectId, selectedTicketId, onSelectTicket, title = 'Items', contextLabel, onBack }: WorkItemsListProps) => {
  const styles = useStyles();
  const ticketMap = useStore($tickets);
  const pipeline = useStore($pipeline);
  const milestones = useStore($milestones);
  const activeMilestoneId = useStore($activeMilestoneId);
  const [viewMode, setViewMode] = useState<ViewMode>('list');
  const [visibilityFilter, setVisibilityFilter] = useState<VisibilityFilter>('active');
  const [hoveredId, setHoveredId] = useState<TicketId | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Ticket | null>(null);

  const handleRequestDelete = useCallback((ticket: Ticket) => {
    setPendingDelete(ticket);
  }, []);

  const handleCancelDelete = useCallback(() => {
    setPendingDelete(null);
  }, []);

  const handleConfirmDelete = useCallback(() => {
    if (pendingDelete) {
      ticketApi.removeTicket(pendingDelete.id);
    }
  }, [pendingDelete]);

  const pendingIsUntitled = !pendingDelete?.title || pendingDelete.title === 'Untitled';
  const deleteTitle = pendingIsUntitled
    ? 'Delete this untitled ticket?'
    : `Delete ticket "${pendingDelete?.title}"?`;

  const projectMilestones = useMemo(
    () => Object.values(milestones).filter((m) => m.projectId === projectId),
    [milestones, projectId]
  );

  const columnLabels = useMemo(() => {
    const map: Record<string, string> = {};
    if (pipeline) {
      for (const col of pipeline.columns) {
        map[col.id] = col.label;
      }
    }
    return map;
  }, [pipeline]);

  const sortedTickets = useMemo(() => {
    const all = Object.values(ticketMap).filter((t) => {
      if (t.projectId !== projectId) {
        return false;
      }
      if (activeMilestoneId !== 'all' && t.milestoneId !== activeMilestoneId) {
        return false;
      }
      if (visibilityFilter === 'active') {
        return !t.resolution && !t.archivedAt;
      }
      if (visibilityFilter === 'resolved') {
        return !!t.resolution && !t.archivedAt;
      }
      if (visibilityFilter === 'archived') {
        return !!t.archivedAt;
      }
      return true;
    });
    return all.sort((a, b) => a.createdAt - b.createdAt);
  }, [ticketMap, projectId, activeMilestoneId, visibilityFilter]);

  const handleNewTicket = useCallback(async () => {
    const ticket = await ticketApi.addTicket({
      projectId,
      milestoneId: activeMilestoneId !== 'all' ? activeMilestoneId : undefined,
      title: 'Untitled',
      description: '',
      priority: 'medium',
      blockedBy: [],
    });
    ticketApi.goToTicket(ticket.id);
  }, [projectId, activeMilestoneId]);

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

  const toggleView = useCallback(() => {
    setViewMode((m) => (m === 'list' ? 'board' : 'list'));
  }, []);

  const getColumnBadgeColor = (ticket: Ticket): 'blue' | 'green' | 'default' => {
    if (!pipeline) {
      return 'default';
    }
    const lastCol = pipeline.columns[pipeline.columns.length - 1];
    if (ticket.columnId === lastCol?.id) {
      return 'green';
    }
    const firstCol = pipeline.columns[0];
    if (ticket.columnId === firstCol?.id || !ticket.columnId) {
      return 'default';
    }
    return 'blue';
  };

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        {onBack ? <IconButton aria-label="Back" icon={<ArrowLeft20Regular />} size="sm" onClick={onBack} /> : null}
        {contextLabel || title !== 'Items' ? (
          <div className={styles.headerTitle}>
            {contextLabel ? <Caption1>{contextLabel}</Caption1> : null}
            <Subtitle2>{title}</Subtitle2>
          </div>
        ) : (
          <SectionLabel>{title}</SectionLabel>
        )}
        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>({sortedTickets.length})</Caption1>
        <div className={styles.flex1} />
        <div className={styles.controls}>
          <SegmentedControl
            value={visibilityFilter}
            options={[
              { value: 'active', label: 'Active' },
              { value: 'resolved', label: 'Resolved' },
              { value: 'archived', label: 'Archived' },
              { value: 'all', label: 'All' },
            ]}
            onChange={setVisibilityFilter}
          />
          <IconButton
            aria-label={viewMode === 'list' ? 'Board view' : 'List view'}
            icon={viewMode === 'list' ? <Board20Regular /> : <List20Regular />}
            size="sm"
            onClick={toggleView}
          />
        </div>
      </div>

      {viewMode === 'list' ? (
        <div className={styles.list}>
          {sortedTickets.length === 0 && (
            <p className={styles.emptyHint}>No items yet</p>
          )}
          {sortedTickets.map((ticket) => {
            const isHovered = hoveredId === ticket.id;
            const milestone = ticket.milestoneId ? milestones[ticket.milestoneId] : undefined;

            return (
              <TicketRow
                key={ticket.id}
                ticket={ticket}
                selected={selectedTicketId === ticket.id}
                hovered={isHovered}
                milestoneTitle={milestone?.title}
                projectMilestones={projectMilestones}
                columnLabel={columnLabels[ticket.columnId] ?? 'Backlog'}
                columnBadgeColor={getColumnBadgeColor(ticket)}
                onSelect={handleTicketClick}
                onHoverChange={setHoveredId}
                onRequestDelete={handleRequestDelete}
              />
            );
          })}

          {/* + New at bottom */}
          <button type="button" className={styles.newBtn} onClick={handleNewTicket}>
            <Add16Regular />
            New
          </button>
        </div>
      ) : (
        <div className={styles.boardWrap}>
          <KanbanBoard projectId={projectId} visibilityFilter={visibilityFilter} />
        </div>
      )}
      <ConfirmDialog
        open={pendingDelete !== null}
        onClose={handleCancelDelete}
        onConfirm={handleConfirmDelete}
        title={deleteTitle}
        description="This action cannot be undone."
        confirmLabel="Delete"
        destructive
      />
    </div>
  );
});
WorkItemsList.displayName = 'WorkItemsList';
