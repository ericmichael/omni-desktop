/**
 * Voice on the DM surface.
 *
 * In the DM model the agent's reply IS the channel message (the `dm` speech
 * tool), so spoken replies are a property of the SURFACE, not a tool the
 * agent calls: when a DM feed has spoken replies on, agent-authored rows
 * landing in it are read aloud with the active voice persona. The
 * preference is per-DM and renderer-local (localStorage) — which threads
 * talk out loud is a this-machine choice, like notification sounds.
 */
import { atom } from 'nanostores';

import { persistedStoreApi } from '@/renderer/services/store';
import { getVoiceClient } from '@/renderer/services/voice-client';
import { getActivePersona, resolveVoiceArg } from '@/shared/voice-personas';

const STORAGE_KEY = 'omni.dmSpokenReplies';

const load = (): Record<string, true> => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, true>) : {};
  } catch {
    return {};
  }
};

/** DM channel ids with spoken replies on. */
export const $dmSpokenReplies = atom<Record<string, true>>(load());

export function toggleDmSpokenReplies(channel: string): void {
  const current = $dmSpokenReplies.get();
  const next: Record<string, true> = { ...current };
  if (next[channel]) {
    delete next[channel];
  } else {
    next[channel] = true;
  }
  $dmSpokenReplies.set(next);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* ignore */
  }
}

/** Serialized TTS: messages queue rather than talking over each other. */
let speechChain: Promise<void> = Promise.resolve();

export function speakDmMessage(text: string): void {
  const trimmed = text.trim();
  if (!trimmed) {
    return;
  }
  speechChain = speechChain
    .then(() => getVoiceClient().speak(trimmed, resolveVoiceArg(getActivePersona(persistedStoreApi.get()))))
    .catch((e: unknown) => {
      console.warn('[dm-voice] speak failed:', e);
    });
}
