/**
 * Bridges the (deeply-nested) mic recording state to the deck-column border so
 * the column being spoken into can show an animated "AI" glow.
 *
 * `$recordingScope` holds the scope id of the column currently capturing audio
 * (the code tab's id). The mic button (`LocalVoiceButton`) writes it while
 * recording, reading its scope from `VoiceScopeContext` (provided per column by
 * `CodeTabContent`). `CodeDeck` reads the store and glows the matching column.
 */
import { atom } from 'nanostores';
import { createContext } from 'react';

/** Scope id (code tab id) of the column currently recording, or null. */
export const $recordingScope = atom<string | null>(null);

/**
 * Scope id of the deck column the pointer is currently over, so the voice-toggle
 * hotkey knows which column to act on. `null` when over no column. Set by
 * `CodeTabContent` on hover.
 */
export const $hoveredVoiceScope = atom<string | null>(null);

/** Stable scope id for the Chat tab's single voice surface. */
export const CHAT_VOICE_SCOPE = 'chat';

/** Stable scope id for the headless global orchestrator's voice surface. */
export const GLOBAL_VOICE_SCOPE = 'global';

/** Per-column scope id, provided around the agent UI subtree. */
export const VoiceScopeContext = createContext<string | null>(null);

/**
 * Mic controls a `LocalVoiceButton` exposes to the global voice hotkey:
 * `toggle` (start/stop-and-send — same as a click), and discrete `start` / `stop`
 * for push-to-talk (hold to talk, release to send).
 */
export interface VoiceMicControls {
  toggle: () => void;
  start: () => void;
  stop: () => void;
  /** Whether this mic is currently capturing — lets the hotkey tell a "toggle on" tap from a "toggle off" tap. */
  isRecording: () => boolean;
}

/**
 * Registry of per-scope mic controls. Each `LocalVoiceButton` registers under
 * its scope id; the voice hotkey resolves a target scope (hovered column /
 * active chat) and drives that column's mic.
 */
const voiceMics = new Map<string, VoiceMicControls>();

/**
 * Scopes that asked to start recording before their mic existed (e.g. the global
 * agent activated cold by its hotkey — the mic only registers once the panel's
 * agent UI mounts). Consumed when the mic registers.
 */
const pendingArms = new Set<string>();

export function registerVoiceMic(scope: string, controls: VoiceMicControls): () => void {
  voiceMics.set(scope, controls);
  // Honor a start requested before this mic existed (toggle it on).
  if (pendingArms.delete(scope) && !controls.isRecording()) {
    controls.start();
  }
  return () => {
    if (voiceMics.get(scope) === controls) {
      voiceMics.delete(scope);
    }
  };
}

/**
 * Start recording on `scope`'s mic now if present, else arm it to start (as a
 * toggle-on) the moment the mic registers. Returns true if started immediately.
 */
export function startOrArmVoiceMic(scope: string): boolean {
  const mic = voiceMics.get(scope);
  if (mic) {
    if (!mic.isRecording()) {
      mic.start();
    }
    return true;
  }
  pendingArms.add(scope);
  return false;
}

/** Controls for the mic mounted at `scope`, or undefined if none. */
export function getVoiceMic(scope: string): VoiceMicControls | undefined {
  return voiceMics.get(scope);
}

/**
 * Live mic level (0..1), updated by the capture meter every animation frame and
 * read by the glow overlay. A plain mutable holder (not a store) so 60fps
 * updates never trigger React re-renders.
 */
export const voiceLevel = { current: 0 };
