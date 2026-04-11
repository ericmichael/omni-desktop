import { makeStyles, mergeClasses, tokens, shorthands } from '@fluentui/react-components';
import { AnimatePresence, motion } from 'framer-motion';
import { memo, useCallback } from 'react';
import { Code20Regular, Desktop20Regular, Dismiss20Regular } from '@fluentui/react-icons';

import { Webview } from '@/renderer/common/Webview';
import { OmniAgentsApp } from '@/renderer/omniagents-ui';
import type { ClientToolCallHandler } from '@/renderer/omniagents-ui/App';

type OverlayPane = 'none' | 'code' | 'vnc';

type CodeWorkspaceLayoutProps = {
  uiSrc: string;
  sessionId?: string;
  onSessionChange?: (sessionId: string | undefined) => void;
  variables?: Record<string, unknown>;
  codeServerSrc?: string;
  vncSrc?: string;
  overlayPane?: OverlayPane;
  onCloseOverlay?: () => void;
  onReady?: () => void;
  headerActionsTargetId?: string;
  headerActionsCompact?: boolean;
  sandboxLabel?: string;
  onClientToolCall?: ClientToolCallHandler;
};

const useStyles = makeStyles({
  backdrop: { position: 'absolute', inset: 0, zIndex: 30, backgroundColor: 'rgba(0, 0, 0, 0.45)' },
  overlayCard: {
    position: 'absolute',
    inset: '4px',
    zIndex: 40,
    overflow: 'hidden',
    borderRadius: tokens.borderRadiusXLarge,
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke1),
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow64,
    '@media (min-width: 640px)': { inset: '12px' },
  },
  overlayInner: { display: 'flex', height: '100%', flexDirection: 'column' },
  overlayHeader: {
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
  overlayHeaderLeft: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    fontSize: tokens.fontSizeBase300,
    color: tokens.colorNeutralForeground2,
  },
  overlayCloseBtn: {
    display: 'inline-flex',
    width: '36px',
    height: '36px',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: tokens.borderRadiusLarge,
    color: tokens.colorNeutralForeground2,
    transitionProperty: 'color, background-color',
    transitionDuration: '150ms',
    ':hover': { backgroundColor: tokens.colorSubtleBackgroundHover, color: tokens.colorNeutralForeground1 },
  },
  overlayBody: { minHeight: 0, flex: '1 1 0' },
  root: {
    position: 'relative',
    display: 'flex',
    height: '100%',
    width: '100%',
    flexDirection: 'column',
    backgroundColor: tokens.colorNeutralBackground1,
  },
  mainArea: { position: 'relative', minHeight: 0, flex: '1 1 0' },
  mainContent: { height: '100%', width: '100%', minWidth: 0 },
});

const transition = { type: 'spring' as const, duration: 0.28, bounce: 0.08 };

const OverlayPaneView = memo(
  ({ pane, src, onClose }: { pane: Exclude<OverlayPane, 'none'>; src: string; onClose: () => void }) => {
    const styles = useStyles();
    const title = pane === 'code' ? 'VS Code' : "Omni's PC";
    const Icon = pane === 'code' ? Code20Regular : Desktop20Regular;

    return (
      <>
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={transition}
          className={styles.backdrop}
          onClick={onClose}
        />
        <motion.div
          initial={{ opacity: 0, scale: 0.97 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.97 }}
          transition={transition}
          className={styles.overlayCard}
        >
          <div className={styles.overlayInner}>
            <div className={styles.overlayHeader}>
              <div className={styles.overlayHeaderLeft}>
                <Icon style={{ width: 14, height: 14 }} />
                <span>{title}</span>
              </div>
              <button
                type="button"
                onClick={onClose}
                className={styles.overlayCloseBtn}
                aria-label="Close overlay"
              >
                <Dismiss20Regular style={{ width: 14, height: 14 }} />
              </button>
            </div>
            <div className={styles.overlayBody}>
              <Webview src={src} showUnavailable={false} />
            </div>
          </div>
        </motion.div>
      </>
    );
  }
);
OverlayPaneView.displayName = 'OverlayPaneView';

export const CodeWorkspaceLayout = memo(({ uiSrc, sessionId, onSessionChange, variables, codeServerSrc, vncSrc, overlayPane = 'none', onCloseOverlay, onReady, headerActionsTargetId, headerActionsCompact, sandboxLabel, onClientToolCall }: CodeWorkspaceLayoutProps) => {
  const styles = useStyles();
  const overlaySrc = overlayPane === 'code' ? codeServerSrc : overlayPane === 'vnc' ? vncSrc : undefined;

  const handleUiReady = useCallback(() => {
    onReady?.();
  }, [onReady]);

  const closeOverlay = useCallback(() => {
    onCloseOverlay?.();
  }, [onCloseOverlay]);

  return (
    <div className={styles.root}>
      <div className={styles.mainArea}>
        <div className={styles.mainContent}>
          <OmniAgentsApp uiUrl={uiSrc} sessionId={sessionId} onSessionChange={onSessionChange} variables={variables} onReady={handleUiReady} headerActionsTargetId={headerActionsTargetId} headerActionsCompact={headerActionsCompact} sandboxLabel={sandboxLabel} onClientToolCall={onClientToolCall} />
        </div>
      </div>

      <AnimatePresence>
        {overlayPane !== 'none' && overlaySrc && <OverlayPaneView pane={overlayPane} src={overlaySrc} onClose={closeOverlay} />}
      </AnimatePresence>
    </div>
  );
});
CodeWorkspaceLayout.displayName = 'CodeWorkspaceLayout';
