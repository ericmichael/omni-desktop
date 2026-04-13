import { useDroppable } from '@dnd-kit/core';
import { memo, useCallback, useMemo } from 'react';
import { Add16Regular } from '@fluentui/react-icons';
import { makeStyles, mergeClasses, tokens, shorthands } from '@fluentui/react-components';

import { Body1 } from '@/renderer/ds';
import type { Column, ColumnId, Ticket } from '@/shared/types';

import { getColumnColors } from './ticket-constants';
import { KanbanCard } from './KanbanCard';

const useStyles = makeStyles({
  column: {
    display: 'flex',
    flexDirection: 'column',
    width: '224px',
    flexShrink: 0,
    height: '100%',
    borderRadius: tokens.borderRadiusMedium,
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke1),
    borderTopWidth: '2px',
    transitionProperty: 'background-color',
    transitionDuration: '150ms',
    '@media (min-width: 640px)': {
      width: '264px',
    },
  },
  dropHighlight: {
    backgroundColor: tokens.colorBrandBackground2,
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingLeft: tokens.spacingHorizontalM,
    paddingRight: tokens.spacingHorizontalM,
    paddingTop: tokens.spacingVerticalS,
    paddingBottom: tokens.spacingVerticalS,
    flexShrink: 0,
  },
  headerLabel: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
  },
  gateIcon: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground2,
  },
  countBadge: {
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightMedium,
    paddingLeft: tokens.spacingHorizontalSNudge,
    paddingRight: tokens.spacingHorizontalSNudge,
    paddingTop: '2px',
    paddingBottom: '2px',
    borderRadius: '9999px',
  },
  cards: {
    flex: '1 1 0',
    overflowY: 'auto',
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
    paddingLeft: tokens.spacingHorizontalS,
    paddingRight: tokens.spacingHorizontalS,
    paddingBottom: tokens.spacingVerticalS,
  },
  newBtn: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    width: '100%',
    paddingLeft: tokens.spacingHorizontalM,
    paddingRight: tokens.spacingHorizontalM,
    paddingTop: '6px',
    paddingBottom: '6px',
    border: 'none',
    backgroundColor: 'transparent',
    borderRadius: tokens.borderRadiusMedium,
    cursor: 'pointer',
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
    transitionProperty: 'background-color, color',
    transitionDuration: tokens.durationFaster,
    ':hover': {
      backgroundColor: tokens.colorSubtleBackgroundHover,
      color: tokens.colorNeutralForeground1,
    },
  },
});

type KanbanColumnProps = {
  column: Column;
  tickets: Ticket[];
  onNewTicket?: (columnId: ColumnId) => void;
};

export const KanbanColumn = memo(({ column, tickets, onNewTicket }: KanbanColumnProps) => {
  const styles = useStyles();
  const { isOver, setNodeRef } = useDroppable({
    id: column.id,
  });

  const colors = useMemo(() => getColumnColors(column.id), [column.id]);

  const handleNew = useCallback(() => {
    onNewTicket?.(column.id);
  }, [onNewTicket, column.id]);

  return (
    <div
      ref={setNodeRef}
      className={mergeClasses(styles.column, isOver && styles.dropHighlight)}
      style={{
        borderTopColor: colors.borderTop,
        backgroundColor: isOver ? undefined : colors.background,
      }}
    >
      {/* Column header */}
      <div className={styles.header}>
        <div className={styles.headerLabel}>
          <Body1>{column.label}</Body1>
          {column.gate && (
            <span className={styles.gateIcon} title="Gated — only a human can advance tickets past this column">
              &#x1F512;
            </span>
          )}
        </div>
        <span
          className={styles.countBadge}
          style={{ color: colors.badgeColor, backgroundColor: colors.badgeBg }}
        >
          {tickets.length}
        </span>
      </div>

      {/* Cards */}
      <div className={styles.cards}>
        {tickets.map((ticket) => (
          <KanbanCard key={ticket.id} ticket={ticket} />
        ))}
      </div>

      {/* + New */}
      {onNewTicket && (
        <button type="button" className={styles.newBtn} onClick={handleNew}>
          <Add16Regular />
          New
        </button>
      )}
    </div>
  );
});
KanbanColumn.displayName = 'KanbanColumn';
