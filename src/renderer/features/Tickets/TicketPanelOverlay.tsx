import { AnimatePresence, motion } from 'framer-motion';
import { memo } from 'react';
import { useStore } from '@nanostores/react';
import { DocumentMultiple20Regular, BranchRequest20Regular, Info20Regular, Dismiss20Regular } from '@fluentui/react-icons';
import { makeStyles, mergeClasses, tokens, shorthands } from '@fluentui/react-components';

import type { TicketId } from '@/shared/types';

import { $tickets } from './state';
import { TicketArtifactsTab } from './TicketArtifactsTab';
import { TicketOverviewTab } from './TicketOverviewTab';
import { TicketPRTab } from './TicketPRTab';

export type TicketPanel = 'overview' | 'pr' | 'artifacts';

const PANEL_META: Record<TicketPanel, { label: string; icon: typeof Info20Regular }> = {
  overview: { label: 'Overview', icon: Info20Regular },
  pr: { label: 'PR', icon: BranchRequest20Regular },
  artifacts: { label: 'Artifacts', icon: DocumentMultiple20Regular },
};

const transition = { type: 'spring' as const, duration: 0.28, bounce: 0.08 };

const useStyles = makeStyles({
  overviewScroll: {
    padding: tokens.spacingVerticalXXL,
    overflowY: 'auto',
    height: '100%',
  },
  backdrop: {
    position: 'absolute',
    inset: 0,
    zIndex: 30,
    backgroundColor: 'rgba(0, 0, 0, 0.45)',
  },
  panel: {
    position: 'absolute',
    inset: tokens.spacingVerticalM,
    zIndex: 40,
    overflow: 'hidden',
    borderRadius: tokens.borderRadiusXLarge,
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke1),
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow64,
  },
  panelInner: {
    display: 'flex',
    height: '100%',
    flexDirection: 'column',
  },
  panelHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    ...shorthands.borderBottom('1px', 'solid', tokens.colorNeutralStroke1),
    backgroundColor: tokens.colorNeutralBackground2,
    paddingLeft: tokens.spacingHorizontalM,
    paddingRight: tokens.spacingHorizontalM,
    paddingTop: tokens.spacingVerticalS,
    paddingBottom: tokens.spacingVerticalS,
  },
  panelLabel: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    fontSize: tokens.fontSizeBase300,
    color: tokens.colorNeutralForeground2,
  },
  closeBtn: {
    display: 'inline-flex',
    width: '36px',
    height: '36px',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: tokens.borderRadiusMedium,
    color: tokens.colorNeutralForeground2,
    transitionProperty: 'color, background-color',
    transitionDuration: '150ms',
    border: 'none',
    backgroundColor: 'transparent',
    cursor: 'pointer',
    ':hover': {
      backgroundColor: tokens.colorNeutralBackground1Hover,
      color: tokens.colorNeutralForeground1,
    },
  },
  panelBody: {
    minHeight: 0,
    flex: '1 1 0',
  },
});

const PanelContent = memo(({ panel, ticketId }: { panel: TicketPanel; ticketId: TicketId }) => {
  const styles = useStyles();
  const tickets = useStore($tickets);
  const ticket = tickets[ticketId];

  if (panel === 'overview') {
    if (!ticket) return null;
    return (
      <div className={styles.overviewScroll}>
        <TicketOverviewTab ticket={ticket} />
      </div>
    );
  }
  if (panel === 'pr') {
    return <TicketPRTab ticketId={ticketId} />;
  }
  return <TicketArtifactsTab ticketId={ticketId} />;
});
PanelContent.displayName = 'PanelContent';

export const TicketPanelOverlay = memo(
  ({ panel, ticketId, onClose }: { panel: TicketPanel | null; ticketId: TicketId; onClose: () => void }) => {
    const styles = useStyles();
    return (
      <AnimatePresence>
        {panel && (
          <>
            <motion.div
              key="backdrop"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={transition}
              className={styles.backdrop}
              onClick={onClose}
            />
            <motion.div
              key="panel"
              initial={{ opacity: 0, scale: 0.97 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.97 }}
              transition={transition}
              className={styles.panel}
            >
              <div className={styles.panelInner}>
                <div className={styles.panelHeader}>
                  <div className={styles.panelLabel}>
                    {(() => {
                      const Icon = PANEL_META[panel].icon;
                      return <Icon style={{ width: 14, height: 14 }} />;
                    })()}
                    <span>{PANEL_META[panel].label}</span>
                  </div>
                  <button
                    type="button"
                    onClick={onClose}
                    className={styles.closeBtn}
                    aria-label="Close panel"
                  >
                    <Dismiss20Regular style={{ width: 14, height: 14 }} />
                  </button>
                </div>
                <div className={styles.panelBody}>
                  <PanelContent panel={panel} ticketId={ticketId} />
                </div>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    );
  }
);
TicketPanelOverlay.displayName = 'TicketPanelOverlay';
