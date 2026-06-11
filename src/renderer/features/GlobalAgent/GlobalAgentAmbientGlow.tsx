import { makeStyles } from '@fluentui/react-components';
import { useStore } from '@nanostores/react';
import { memo } from 'react';

import { VoiceGlow } from '@/renderer/features/Code/VoiceGlow';
import { $recordingScope, GLOBAL_VOICE_SCOPE } from '@/renderer/services/voice-recording';

import { $globalAgentOpen } from './state';

const useStyles = makeStyles({
  // Full-viewport overlay so the orchestrator's voice glow rings the whole app
  // when it's listening in the background (panel closed).
  root: { position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 1200 },
});

/**
 * App-wide voice glow for the global agent. When the orchestrator is recording
 * but its panel is closed, it's working in the background — so the glow rings
 * the entire app UI instead of the (hidden) panel. When the panel is open, its
 * own panel-local glow takes over and this stays off.
 */
export const GlobalAgentAmbientGlow = memo(() => {
  const styles = useStyles();
  const recordingScope = useStore($recordingScope);
  const open = useStore($globalAgentOpen);

  if (recordingScope !== GLOBAL_VOICE_SCOPE || open) {
    return null;
  }
  return (
    <div className={styles.root} aria-hidden="true">
      <VoiceGlow />
    </div>
  );
});
GlobalAgentAmbientGlow.displayName = 'GlobalAgentAmbientGlow';
