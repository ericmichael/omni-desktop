/**
 * Global voice hotkeys. Mounted once at the app root. Two independent bindings,
 * both gesture-smart — they tell tap from hold by how long the key is held:
 *  - quick tap (< TAP_MS)  → toggle: first tap starts recording and leaves it
 *                            on; next tap stops and sends.
 *  - press and hold        → push-to-talk: recording starts on key-down and is
 *                            sent on release.
 *
 * `voiceToggleHotkey` drives the hovered code-deck column or the active chat.
 * `globalVoiceToggleHotkey` opens the superuser resident's DM and drives its
 * mic — talk to your orchestrator from anywhere. Renders nothing. No-op when
 * local voice is off/unsupported, the combo is unset, or (for the global
 * binding) no enabled superuser resident exists.
 */

import { useStore } from '@nanostores/react';
import { useCallback, useRef } from 'react';
import { useHotkeys } from 'react-hotkeys-hook';

import { dmChannelId, USER_PARTICIPANT } from '@/lib/resident-agent';
import { configuredVoiceMode } from '@/lib/voice-mode';
import { goToResidentChannel } from '@/renderer/features/Residents/state';
import { persistedStoreApi } from '@/renderer/services/store';
import { isLocalVoiceCapable } from '@/renderer/services/voice-client';
import { $hoveredVoiceScope, getVoiceMic, startOrArmVoiceMic } from '@/renderer/services/voice-recording';

// keyup too, so a hold can send on release.
const hotkeyOptions = { enableOnFormTags: true, preventDefault: true, keydown: true, keyup: true } as const;
// Press shorter than this is a tap (toggle); longer is a hold (push-to-talk).
const TAP_MS = 250;

/** Column scope for the primary hotkey, given the current view. */
function resolveColumnScope(): string | null {
  const store = persistedStoreApi.get();
  if (store.layoutMode === 'chat') {
    return $hoveredVoiceScope.get() ?? store.activeCodeTabId;
  }
  return null;
}

/** The first enabled superuser resident — the workspace orchestrator. */
const superuserAgentId = (): string | null =>
  persistedStoreApi.get().residentAgents.find((a) => a.enabled && a.superuser)?.id ?? null;

/** The orchestrator's voice surface is its user-DM composer mic. */
const resolveGlobalScope = (): string | null => {
  const agentId = superuserAgentId();
  return agentId ? dmChannelId(USER_PARTICIPANT, agentId) : null;
};

/**
 * Open the orchestrator's DM so its composer (and mic) mounts — the DM is the
 * conversation surface, so the hotkey lands you where the reply will appear.
 */
const openSuperuserDm = (): void => {
  const agentId = superuserAgentId();
  if (agentId) {
    goToResidentChannel(dmChannelId(USER_PARTICIPANT, agentId));
  }
};

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
  // Matches the DM mic these hotkeys drive — local only until DM gets hosted.
  const voiceOn = configuredVoiceMode(store) === 'local' && isLocalVoiceCapable();

  useVoiceHotkey(store.voiceToggleHotkey, Boolean(store.voiceToggleHotkey) && voiceOn, resolveColumnScope);
  useVoiceHotkey(
    store.globalVoiceToggleHotkey,
    Boolean(store.globalVoiceToggleHotkey) && voiceOn,
    resolveGlobalScope,
    openSuperuserDm,
    true // arm a cold mic — the DM composer may still be mounting
  );

  return null;
}
