import { useStore } from '@nanostores/react';
import { memo, useCallback, useMemo, useState } from 'react';
import {
  Add16Regular,
  ArrowLeft20Regular,
  ArrowSync20Regular,
  Board20Regular,
  List20Regular,
  Open20Regular,
  Play20Filled,
} from '@fluentui/react-icons';
import { makeStyles, tokens, shorthands } from '@fluentui/react-components';

import { Badge, Caption1, IconButton, SectionLabel, Subtitle2 } from '@/renderer/ds';
import { $milestones } from '@/renderer/features/Initiatives/state';
import { openTicketInCode } from '@/renderer/services/navigation';
import { isActivePhase } from '@/shared/ticket-phase';
import type { ProjectId, Ticket, TicketId } from '@/shared/types';

import { PHASE_COLORS, PHASE_LABELS, RESOLUTION_LABELS, TICKET_PRIORITY_COLORS, TICKET_PRIORITY_LABELS } from './ticket-constants';
import { KanbanBoard } from './KanbanBoard';
import { $activeMilestoneId, $pipeline, $tickets, ticketApi } from './state';

type ViewMode = 'list' | 'board';

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
  const [hoveredId, setHoveredId] = useState<TicketId | null>(null);

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
      if (t.projectId !== projectId) return false;
      if (activeMilestoneId !== 'all' && t.milestoneId !== activeMilestoneId) return false;
      return true;
    });
    return all.sort((a, b) => a.createdAt - b.createdAt);
  }, [ticketMap, projectId, activeMilestoneId]);

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
    if (!pipeline) return 'default';
    const lastCol = pipeline.columns[pipeline.columns.length - 1];
    if (ticket.columnId === lastCol?.id) return 'green';
    const firstCol = pipeline.columns[0];
    if (ticket.columnId === firstCol?.id || !ticket.columnId) return 'default';
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
        <IconButton
          aria-label={viewMode === 'list' ? 'Board view' : 'List view'}
          icon={viewMode === 'list' ? <Board20Regular /> : <List20Regular />}
          size="sm"
          onClick={toggleView}
        />
      </div>

      {viewMode === 'list' ? (
        <div className={styles.list}>
          {sortedTickets.length === 0 && (
            <p className={styles.emptyHint}>No items yet</p>
          )}
          {sortedTickets.map((ticket) => {
            const phase = ticket.phase;
            const isRunning = phase != null && isActivePhase(phase);
            const isHovered = hoveredId === ticket.id;
            const milestone = ticket.milestoneId ? milestones[ticket.milestoneId] : undefined;

            return (
              <button
                key={ticket.id}
                type="button"
                className={`${styles.row} ${selectedTicketId === ticket.id ? styles.rowSelected : ''} ${ticket.resolution ? styles.rowResolved : ''}`}
                onClick={() => handleTicketClick(ticket.id)}
                onMouseEnter={() => setHoveredId(ticket.id)}
                onMouseLeave={() => setHoveredId(null)}
              >
                {/* Priority dot */}
                <span
                  className={styles.priorityDot}
                  style={{
                    backgroundColor: PRIORITY_DOT_COLORS[ticket.priority] ?? tokens.colorNeutralForeground3,
                  }}
                  title={TICKET_PRIORITY_LABELS[ticket.priority]}
                />

                {/* Title */}
                <span className={styles.title}>{ticket.title}</span>

                {/* Column badge */}
                <span className={styles.cellColumn}>
                  <Badge color={getColumnBadgeColor(ticket)}>
                    {columnLabels[ticket.columnId] ?? 'Backlog'}
                  </Badge>
                </span>

                {/* Milestone badge */}
                {milestone && (
                  <span className={styles.cellMilestone}>
                    <Badge color="purple" truncate maxWidth={160}>{milestone.title}</Badge>
                  </span>
                )}

                {/* Phase indicator */}
                {phase && phase !== 'idle' && !ticket.resolution && (
                  <span className={styles.cellPhase}>
                    <Badge color={PHASE_COLORS[phase] ?? 'default'}>
                      {isRunning && <ArrowSync20Regular style={{ width: 12, height: 12 }} />}
                      {PHASE_LABELS[phase] ?? phase}
                    </Badge>
                  </span>
                )}

                {/* Resolution — omitted; column badge already conveys resolved status
                   and the row is dimmed via rowResolved. */}

                {/* Hover actions */}
                {isHovered && !ticket.resolution && !isRunning && (
                  <span
                    className={styles.cellActions}
                    style={{ opacity: 1 }}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <IconButton
                      icon={<Open20Regular />}
                      size="sm"
                      aria-label="Open in Code"
                      onClick={() => void openTicketInCode(ticket.id)}
                    />
                    <IconButton
                      icon={<Play20Filled />}
                      size="sm"
                      aria-label="Autopilot"
                      onClick={() => {
                        void openTicketInCode(ticket.id);
                        void ticketApi.startSupervisor(ticket.id);
                      }}
                    />
                  </span>
                )}
              </button>
            );
          })}

          {/* + New at bottom */}
          <button type="button" className={styles.newBtn} onClick={() => void handleNewTicket()}>
            <Add16Regular />
            New
          </button>
        </div>
      ) : (
        <div className={styles.boardWrap}>
          <KanbanBoard projectId={projectId} />
        </div>
      )}
    </div>
  );
});
WorkItemsList.displayName = 'WorkItemsList';
