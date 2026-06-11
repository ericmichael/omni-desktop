/**
 * Unified ambient column glow — the one "this column is alive" visual system
 * (UI/UX gameplan Phase 2). Variants, in priority order:
 *
 *   voice     — the user is recording into this column: the full
 *               Apple-Intelligence spectrum ring (VoiceGlow, mic-level bound).
 *   attention — a tool/MCP approval is waiting on the user: steady amber
 *               inner bloom. Intentionally NOT animated; it should read as a
 *               held state, not activity.
 *   working   — the agent is mid-run: soft brand bloom breathing slowly.
 *
 * Subscribes to the stores itself (per-key) so host columns don't re-render
 * on every activity tick. Render inside a positioned, rounded container —
 * the bloom rides `borderRadius: inherit`.
 */
import { makeStyles, mergeClasses } from '@fluentui/react-components';
import { useStore } from '@nanostores/react';

import { $columnActivity } from '@/renderer/services/column-activity';
import { $recordingScope } from '@/renderer/services/voice-recording';

import { VoiceGlow } from './VoiceGlow';

const useStyles = makeStyles({
  base: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    borderRadius: 'inherit',
    pointerEvents: 'none',
    zIndex: 5,
  },
  working: {
    boxShadow: 'inset 0 0 16px 2px color-mix(in srgb, #5ac8fa 28%, transparent)',
    animationName: {
      '0%': { opacity: 0.45 },
      '50%': { opacity: 1 },
      '100%': { opacity: 0.45 },
    },
    animationDuration: '3s',
    animationTimingFunction: 'ease-in-out',
    animationIterationCount: 'infinite',
    '@media (prefers-reduced-motion: reduce)': { animationName: 'none', opacity: 0.7 },
  },
  attention: {
    boxShadow: 'inset 0 0 16px 2px color-mix(in srgb, #ffd60a 32%, transparent)',
  },
});

export function ColumnAura({ tabId }: { tabId: string }) {
  const styles = useStyles();
  const recordingScope = useStore($recordingScope);
  const activity = useStore($columnActivity, { keys: [tabId] })[tabId];

  if (recordingScope === tabId) {
    return <VoiceGlow />;
  }
  if (activity?.pendingApproval) {
    return <div className={mergeClasses(styles.base, styles.attention)} aria-hidden="true" />;
  }
  if (activity?.thinking) {
    return <div className={mergeClasses(styles.base, styles.working)} aria-hidden="true" />;
  }
  return null;
}
