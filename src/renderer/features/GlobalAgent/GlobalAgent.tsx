import { makeStyles, mergeClasses, tokens, Tooltip } from '@fluentui/react-components';
import { Compose20Regular, Dismiss20Regular } from '@fluentui/react-icons';
import { useStore } from '@nanostores/react';
import { memo, useCallback } from 'react';

import { VoiceGlow } from '@/renderer/features/Code/VoiceGlow';
import { persistedStoreApi } from '@/renderer/services/store';
import { $recordingScope, GLOBAL_VOICE_SCOPE } from '@/renderer/services/voice-recording';

import { GlobalAgentPanel } from './GlobalAgentPanel';
import { getOrchestratorController } from './orchestrator-watch';
import { $globalAgentActive, $globalAgentOpen, toggleGlobalAgent } from './state';

const PANEL_WIDTH = 440;

const useStyles = makeStyles({
  panel: {
    position: 'fixed',
    top: 0,
    right: 0,
    bottom: 0,
    // Mobile: full-bleed sheet. Desktop (≥640px) narrows to a side panel.
    width: '100%',
    zIndex: 1090,
    display: 'flex',
    flexDirection: 'column',
    // Match the tinted omniagents surface inside (the `.omni-global-agent`
    // override), so the chrome (header strip) and chat read as one surface.
    backgroundColor: 'rgb(var(--omni-bgMain))',
    boxShadow: '-8px 0 32px -12px rgba(0,0,0,0.45)',
    borderLeft: `1px solid ${tokens.colorNeutralStroke1}`,
    transform: 'translateX(0)',
    transitionProperty: 'transform',
    transitionDuration: '220ms',
    transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
    // Contain the recording glow at the panel edge (matches the deck column).
    overflow: 'hidden',
    // Fixed to the viewport, so the app shell's safe-area padding (App.tsx)
    // doesn't reach this panel — pad the notch / home-indicator bands itself.
    // Bottom reads the managed var first (use-app-height zeroes it in the
    // iOS-standalone short-viewport state).
    paddingTop: 'env(safe-area-inset-top, 0px)',
    paddingLeft: 'env(safe-area-inset-left, 0px)',
    paddingRight: 'env(safe-area-inset-right, 0px)',
    paddingBottom: 'var(--safe-area-bottom, env(safe-area-inset-bottom, 0px))',
    '@media (min-width: 640px)': {
      width: `${PANEL_WIDTH}px`,
      maxWidth: '90vw',
    },
  },
  panelHidden: { transform: 'translateX(105%)', pointerEvents: 'none' },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: tokens.spacingHorizontalXXS,
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`,
    flexShrink: 0,
  },
  close: {
    border: 'none',
    background: 'none',
    cursor: 'pointer',
    color: tokens.colorNeutralForeground3,
    display: 'flex',
    padding: tokens.spacingHorizontalXXS,
    ':hover': { color: tokens.colorNeutralForeground1 },
  },
  body: { flex: '1 1 0', position: 'relative', minHeight: 0 },
});

/**
 * Slide-out panel for the headless global orchestrator. Mounted once at the app
 * shell; opened/closed by the `GlobalAgentToggle` button in the Tile deck
 * header (`$globalAgentOpen`). Only present in Tile (`spaces`) mode. The panel
 * mounts lazily on first open and stays mounted so the session persists across
 * open/close.
 */
export const GlobalAgent = memo(() => {
  const styles = useStyles();
  const open = useStore($globalAgentOpen);
  const active = useStore($globalAgentActive);
  const store = useStore(persistedStoreApi.$atom);
  const recordingScope = useStore($recordingScope);

  const handleNewSession = useCallback(() => {
    getOrchestratorController()?.newSession();
  }, []);

  // Mount once active (opened or background-activated by the global voice
  // hotkey); stays mounted so the session + mic persist. `open` only toggles
  // visibility. Only in Tile mode.
  if (store.layoutMode !== 'spaces' || !active) {
    return null;
  }

  return (
    <div className={mergeClasses(styles.panel, 'omni-global-agent', !open && styles.panelHidden)}>
      <div className={styles.header}>
        <Tooltip content="New session" relationship="label" positioning="below">
          <button type="button" className={styles.close} onClick={handleNewSession} aria-label="New session">
            <Compose20Regular />
          </button>
        </Tooltip>
        <button type="button" className={styles.close} onClick={toggleGlobalAgent} aria-label="Close workspace agent">
          <Dismiss20Regular />
        </button>
      </div>
      <div className={styles.body}>
        <GlobalAgentPanel />
      </div>
      {/* Panel-local glow only when visible; when closed, the app-level
          ambient glow takes over (see GlobalAgentAmbientGlow). */}
      {open && recordingScope === GLOBAL_VOICE_SCOPE && <VoiceGlow />}
    </div>
  );
});
GlobalAgent.displayName = 'GlobalAgent';
