import { memo, useCallback, useEffect, useRef } from 'react';
import { ArrowMaximize20Regular, Dismiss20Regular } from '@fluentui/react-icons';
import { makeStyles, tokens, shorthands } from '@fluentui/react-components';

import { IconButton } from '@/renderer/ds';
import type { TicketId } from '@/shared/types';

import { TicketDetail } from './TicketDetail';
import { ticketApi } from './state';

const PANEL_WIDTH = '480px';

const useStyles = makeStyles({
  backdrop: {
    position: 'absolute',
    inset: 0,
    zIndex: 10,
    display: 'flex',
    justifyContent: 'flex-end',
  },
  scrim: {
    position: 'absolute',
    inset: 0,
    backgroundColor: 'rgba(0, 0, 0, 0.2)',
  },
  panel: {
    position: 'relative',
    zIndex: 1,
    width: PANEL_WIDTH,
    maxWidth: '100%',
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
    backgroundColor: tokens.colorNeutralBackground1,
    ...shorthands.borderLeft('1px', 'solid', tokens.colorNeutralStroke1),
    boxShadow: tokens.shadow64,
    animationName: {
      from: { transform: 'translateX(100%)' },
      to: { transform: 'translateX(0)' },
    },
    animationDuration: '200ms',
    animationTimingFunction: tokens.curveDecelerateMin,
    animationFillMode: 'both',
  },
  panelHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: tokens.spacingHorizontalXS,
    paddingLeft: tokens.spacingHorizontalS,
    paddingRight: tokens.spacingHorizontalS,
    paddingTop: tokens.spacingVerticalXS,
    paddingBottom: tokens.spacingVerticalXS,
    ...shorthands.borderBottom('1px', 'solid', tokens.colorNeutralStroke1),
    flexShrink: 0,
  },
  panelBody: {
    flex: '1 1 0',
    minHeight: 0,
    overflow: 'hidden',
  },
});

type TicketSidePanelProps = {
  ticketId: TicketId;
  onClose: () => void;
};

export const TicketSidePanel = memo(({ ticketId, onClose }: TicketSidePanelProps) => {
  const styles = useStyles();
  const panelRef = useRef<HTMLDivElement>(null);

  // Close on Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const handleOpenFullPage = useCallback(() => {
    ticketApi.goToTicket(ticketId);
  }, [ticketId]);

  return (
    <div className={styles.backdrop}>
      <div className={styles.scrim} onClick={onClose} />
      <div ref={panelRef} className={styles.panel}>
        <div className={styles.panelHeader}>
          <IconButton
            aria-label="Open full page"
            icon={<ArrowMaximize20Regular />}
            size="sm"
            onClick={handleOpenFullPage}
          />
          <IconButton aria-label="Close panel" icon={<Dismiss20Regular />} size="sm" onClick={onClose} />
        </div>
        <div className={styles.panelBody}>
          <TicketDetail ticketId={ticketId} compact onClose={onClose} />
        </div>
      </div>
    </div>
  );
});
TicketSidePanel.displayName = 'TicketSidePanel';
