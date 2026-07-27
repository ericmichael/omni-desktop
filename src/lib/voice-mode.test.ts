import { describe, expect, it } from 'vitest';

import { configuredVoiceMode } from '@/lib/voice-mode';
import type { ModelsConfig } from '@/shared/types';

const models = (voiceDefault: string | null): ModelsConfig => ({
  version: 3,
  default: null,
  voice_default: voiceDefault,
  providers: {},
});

describe('configuredVoiceMode', () => {
  it('is off when neither key is set', () => {
    expect(configuredVoiceMode({})).toBe('off');
    expect(configuredVoiceMode({ localVoiceEnabled: false, modelsConfig: models(null) })).toBe('off');
  });

  it('is hosted when a voice model is configured', () => {
    expect(configuredVoiceMode({ localVoiceEnabled: false, modelsConfig: models('codex/gpt-realtime-1.5') })).toBe(
      'hosted'
    );
  });

  it('is local when local voice is on', () => {
    expect(configuredVoiceMode({ localVoiceEnabled: true, modelsConfig: models(null) })).toBe('local');
  });

  it('prefers local if both somehow got set — the settings UI clears one when setting the other', () => {
    expect(configuredVoiceMode({ localVoiceEnabled: true, modelsConfig: models('codex/gpt-realtime') })).toBe('local');
  });

  it('distinguishes hosted from off, which reading localVoiceEnabled alone cannot', () => {
    const hosted = { localVoiceEnabled: false, modelsConfig: models('codex/gpt-realtime') };
    const off = { localVoiceEnabled: false, modelsConfig: models(null) };
    expect(configuredVoiceMode(hosted)).not.toBe(configuredVoiceMode(off));
  });
});
