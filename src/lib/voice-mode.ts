/**
 * Which voice mode the user configured, as one derivation.
 *
 * Settings → AI → Voice is a tri-state, but it is stored across two keys:
 * `localVoiceEnabled` and `modelsConfig.voice_default`, each cleared when the
 * other is set. A consumer reading only `localVoiceEnabled` cannot tell
 * "hosted" from "off" — which is how Off stopped turning voice off.
 */
import type { ModelsConfig } from '@/shared/types';

export type VoiceMode = 'hosted' | 'local' | 'off';

export function configuredVoiceMode(store: { localVoiceEnabled?: boolean; modelsConfig?: ModelsConfig }): VoiceMode {
  if (store.localVoiceEnabled) {
    return 'local';
  }
  return store.modelsConfig?.voice_default ? 'hosted' : 'off';
}
