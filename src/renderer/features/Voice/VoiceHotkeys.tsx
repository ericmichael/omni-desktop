/**
 * Global voice hotkeys. Mounted once at the app root. Two independent bindings,
 * both gesture-smart — they tell tap from hold by how long the key is held:
 *  - quick tap (< TAP_MS)  → toggle: first tap starts recording and leaves it
 *                            on; next tap stops and sends.
 *  - press and hold        → push-to-talk: recording starts on key-down and is
 *                            sent on release.
 *
 * `voiceToggleHotkey` drives the hovered code-deck column or the active chat.
 * `globalVoiceToggleHotkey` drives the workspace (global) agent and opens its
 * panel. Renders nothing. No-op when local voice is off/unsupported or the combo
 * is unset.
 */

import { useStore } from '@nanostores/react';
import { useCallback, useRef } from 'react';
import { useHotkeys } from 'react-hotkeys-hook';

import { activateGlobalAgent } from '@/renderer/features/GlobalAgent/state';
import { persistedStoreApi } from '@/renderer/services/store';
import { isLocalVoiceCapable } from '@/renderer/services/voice-client';
import {
  $hoveredVoiceScope,
  CHAT_VOICE_SCOPE,
  getVoiceMic,
  GLOBAL_VOICE_SCOPE,
  startOrArmVoiceMic,
} from '@/renderer/services/voice-recording';

// keyup too, so a hold can send on release.
const hotkeyOptions = { enableOnFormTags: true, preventDefault: true, keydown: true, keyup: true } as const;
// Press shorter than this is a tap (toggle); longer is a hold (push-to-talk).
const TAP_MS = 250;

/** Column/chat scope for the primary hotkey, given the current view. */
function resolveColumnScope(): string | null {
  const store = persistedStoreApi.get();
  if (store.layoutMode === 'chat') {
    return CHAT_VOICE_SCOPE;
  }
  if (store.layoutMode === 'spaces') {
    return $hoveredVoiceScope.get() ?? store.activeCodeTabId;
  }
  return null;
}

/** The global agent always resolves to its own scope. */
const resolveGlobalScope = (): string => GLOBAL_VOICE_SCOPE;

/**
 * Activate the orchestrator in the background (mount its session + mic) WITHOUT
 * opening the panel — the app-level ambient glow signals it's listening.
 */
const armGlobalAgent = (): void => activateGlobalAgent();

/**
 * Bind one gesture-smart voice hotkey to a resolved scope.
 * - `onArm` runs on key-down before the mic is resolved (background-activate
 *   the global agent).
 * - `armWhenCold`: if the target mic isn't registered yet (the global agent is
 *   still booting), arm it to start recording as a toggle-on once it appears,
 *   rather than no-op. Hold-to-talk isn't supported on a cold mic.
 */
function useVoiceHotkey(
  hotkey: string | null,
  enabled: boolean,
  resolveScope: () => string | null,
  onArm?: () => void,
  armWhenCold = false
): void {
  // The in-flight press: which scope, when it started, and whether this press is
  // the one that began recording (vs. a tap on an already-recording mic).
  const pressRef = useRef<{ scope: string; downAt: number; startedRecording: boolean } | null>(null);

  const onHotkey = useCallback(
    (e: KeyboardEvent) => {
      if (e.type === 'keydown') {
        if (e.repeat || pressRef.current) {
          return; // ignore OS auto-repeat / re-entrancy
        }
        onArm?.();
        const scope = resolveScope();
        if (!scope) {
          return;
        }
        const mic = getVoiceMic(scope);
        if (!mic) {
          // Cold mic (e.g. global agent still booting): arm a toggle-on so it
          // records the moment the mic registers. No hold tracking.
          if (armWhenCold) {
            startOrArmVoiceMic(scope);
          }
          return;
        }
        const wasRecording = mic.isRecording();
        pressRef.current = { scope, downAt: e.timeStamp, startedRecording: !wasRecording };
        if (!wasRecording) {
          mic.start(); // start now so a hold has zero latency
        }
        return;
      }
      // keyup — decide tap vs hold.
      const press = pressRef.current;
      pressRef.current = null;
      if (!press) {
        return;
      }
      const mic = getVoiceMic(press.scope);
      if (!mic) {
        return;
      }
      const heldMs = e.timeStamp - press.downAt;
      if (press.startedRecording) {
        // This press started recording. A hold means push-to-talk → send on
        // release; a quick tap means "toggle on" → leave it recording.
        if (heldMs >= TAP_MS) {
          mic.stop();
        }
      } else {
        // Mic was already recording (toggled on by an earlier tap) → this press
        // ends it, tap or hold.
        mic.stop();
      }
    },
    [resolveScope, onArm, armWhenCold]
  );

  // `useHotkeys` needs a non-empty key even when disabled; `f13` never fires.
  // Re-bind when the combo or enabled state changes.
  useHotkeys(hotkey || 'f13', onHotkey, { ...hotkeyOptions, enabled }, [enabled, hotkey]);
}

export function VoiceHotkeys(): null {
  const store = useStore(persistedStoreApi.$atom);
  const voiceOn = store.localVoiceEnabled && isLocalVoiceCapable();

  useVoiceHotkey(store.voiceToggleHotkey, Boolean(store.voiceToggleHotkey) && voiceOn, resolveColumnScope);
  useVoiceHotkey(
    store.globalVoiceToggleHotkey,
    Boolean(store.globalVoiceToggleHotkey) && voiceOn,
    resolveGlobalScope,
    armGlobalAgent,
    true // arm a cold mic — the orchestrator may still be booting
  );

  return null;
}
