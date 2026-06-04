/**
 * Global voice hotkey. Mounted once at the app root. One binding
 * (`voiceToggleHotkey`), gesture-smart — it tells tap from hold by how long the
 * key is held:
 *  - quick tap (< TAP_MS)  → toggle: first tap starts recording and leaves it
 *                            on; next tap stops and sends.
 *  - press and hold        → push-to-talk: recording starts on key-down and is
 *                            sent on release.
 *
 * It always drives the relevant surface — the hovered code-deck column, or the
 * active chat. Renders nothing. No-op when local voice is off/unsupported or no
 * hotkey is set.
 */

import { useStore } from '@nanostores/react';
import { useCallback, useRef } from 'react';
import { useHotkeys } from 'react-hotkeys-hook';

import { persistedStoreApi } from '@/renderer/services/store';
import { isLocalVoiceCapable } from '@/renderer/services/voice-client';
import { $hoveredVoiceScope, CHAT_VOICE_SCOPE, getVoiceMic } from '@/renderer/services/voice-recording';

// keyup too, so a hold can send on release.
const hotkeyOptions = { enableOnFormTags: true, preventDefault: true, keydown: true, keyup: true } as const;
// Press shorter than this is a tap (toggle); longer is a hold (push-to-talk).
const TAP_MS = 250;

/** Resolve which mic the hotkey should drive given the current view. */
function resolveTargetScope(): string | null {
  const store = persistedStoreApi.get();
  if (store.layoutMode === 'chat') {
    return CHAT_VOICE_SCOPE;
  }
  if (store.layoutMode === 'spaces') {
    return $hoveredVoiceScope.get() ?? store.activeCodeTabId;
  }
  return null;
}

export function VoiceHotkeys(): null {
  const store = useStore(persistedStoreApi.$atom);
  const hotkey = store.voiceToggleHotkey;
  const enabled = Boolean(hotkey) && store.localVoiceEnabled && isLocalVoiceCapable();

  // The in-flight press: which scope, when it started, and whether this press is
  // the one that began recording (vs. a tap on an already-recording mic).
  const pressRef = useRef<{ scope: string; downAt: number; startedRecording: boolean } | null>(null);

  const onHotkey = useCallback((e: KeyboardEvent) => {
    if (e.type === 'keydown') {
      if (e.repeat || pressRef.current) {
return;
} // ignore OS auto-repeat / re-entrancy
      const scope = resolveTargetScope();
      const mic = scope ? getVoiceMic(scope) : undefined;
      if (!scope || !mic) {
return;
}
      const wasRecording = mic.isRecording();
      pressRef.current = { scope, downAt: e.timeStamp, startedRecording: !wasRecording };
      if (!wasRecording) {
mic.start();
} // start now so a hold has zero latency
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
  }, []);

  // `useHotkeys` needs a non-empty key even when disabled; `f13` never fires.
  // Re-bind when the combo or enabled state changes.
  useHotkeys(hotkey || 'f13', onHotkey, { ...hotkeyOptions, enabled }, [enabled, hotkey]);

  return null;
}
