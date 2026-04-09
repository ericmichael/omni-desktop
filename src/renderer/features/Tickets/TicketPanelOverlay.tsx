import { AnimatePresence, motion } from 'framer-motion';
import { memo } from 'react';
import { useStore } from '@nanostores/react';
import { PiFilesBold, PiGitPullRequestBold, PiInfoBold, PiXBold } from 'react-icons/pi';

import type { TicketId } from '@/shared/types';

import { $tickets } from './state';
import { TicketArtifactsTab } from './TicketArtifactsTab';
import { TicketOverviewTab } from './TicketOverviewTab';
import { TicketPRTab } from './TicketPRTab';

export type TicketPanel = 'overview' | 'pr' | 'artifacts';

const PANEL_META: Record<TicketPanel, { label: string; icon: typeof PiInfoBold }> = {
  overview: { label: 'Overview', icon: PiInfoBold },
  pr: { label: 'PR', icon: PiGitPullRequestBold },
  artifacts: { label: 'Artifacts', icon: PiFilesBold },
};

const transition = { type: 'spring' as const, duration: 0.28, bounce: 0.08 };

const PanelContent = memo(({ panel, ticketId }: { panel: TicketPanel; ticketId: TicketId }) => {
  const tickets = useStore($tickets);
  const ticket = tickets[ticketId];

  if (panel === 'overview') {
    if (!ticket) return null;
    return (
      <div className="p-6 overflow-y-auto h-full">
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
              className="absolute inset-0 z-30 bg-black/45"
              onClick={onClose}
            />
            <motion.div
              key="panel"
              initial={{ opacity: 0, scale: 0.97 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.97 }}
              transition={transition}
              className="absolute inset-3 z-40 overflow-hidden rounded-xl border border-surface-border bg-surface shadow-2xl"
            >
              <div className="flex h-full flex-col">
                <div className="flex items-center justify-between border-b border-surface-border bg-surface-raised px-3 py-2">
                  <div className="flex items-center gap-2 text-sm text-fg-muted">
                    {(() => {
                      const Icon = PANEL_META[panel].icon;
                      return <Icon size={14} />;
                    })()}
                    <span>{PANEL_META[panel].label}</span>
                  </div>
                  <button
                    type="button"
                    onClick={onClose}
                    className="inline-flex size-9 items-center justify-center rounded-lg text-fg-muted transition-colors hover:bg-surface-overlay hover:text-fg"
                    aria-label="Close panel"
                  >
                    <PiXBold size={14} />
                  </button>
                </div>
                <div className="min-h-0 flex-1">
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
