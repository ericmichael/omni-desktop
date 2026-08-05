/**
 * Unified ambient column glow — the one "this column is alive" visual system
 * (UI/UX gameplan Phase 2; booting variant added in Phase 7's session-birth
 * choreography). Variants, in priority order:
 *
 *   voice     — the user is recording into this column: the full
 *               Apple-Intelligence spectrum ring (VoiceGlow, mic-level bound).
 *   attention — a tool/MCP approval is waiting on the user: steady amber
 *               inner bloom. Intentionally NOT animated; it should read as a
 *               held state, not activity.
 *   working   — the agent is mid-run: soft brand bloom breathing slowly.
 *   booting   — the sandbox is powering on: the same brand bloom, dimmer and
 *               slower — a warm-up that hands off to `working` at first token.
 *
 * Subscribes to the stores itself (per-key) so host columns don't re-render
 * on every activity tick. Render inside a positioned, rounded container —
 * the bloom rides `borderRadius: inherit`.
 */
import './CodeVisualEffects.css';

import { useStore } from '@nanostores/react';

import { $columnActivity } from '@/renderer/services/column-activity';
import { $recordingScope } from '@/renderer/services/voice-recording';
import type { AutoLaunchPhase } from '@/shared/machines/auto-launch.machine';

import { $codeTabPhases } from './state';
import { VoiceGlow } from './VoiceGlow';

/** Pre-chat sandbox lifecycle states that should read as "powering on". */
const BOOT_PHASES: ReadonlySet<AutoLaunchPhase> = new Set(['checking', 'installing', 'configChecking', 'starting']);

export function ColumnAura({ tabId }: { tabId: string }) {
  const recordingScope = useStore($recordingScope);
  const activity = useStore($columnActivity, { keys: [tabId] })[tabId];
  const bootPhase = useStore($codeTabPhases, { keys: [tabId] })[tabId];

  if (recordingScope === tabId) {
    return <VoiceGlow />;
  }
  if (activity?.pendingApproval) {
    return <div className="omni-column-aura omni-column-aura-attention" aria-hidden="true" />;
  }
  if (activity?.thinking) {
    return <div className="omni-column-aura omni-column-aura-working" aria-hidden="true" />;
  }
  if (bootPhase && BOOT_PHASES.has(bootPhase)) {
    return <div className="omni-column-aura omni-column-aura-booting" aria-hidden="true" />;
  }
  return null;
}
