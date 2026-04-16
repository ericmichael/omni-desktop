/**
 * Tests for buildMarimoAiToml — translates the launcher's model config
 * into a `.marimo.toml` [ai] section.
 *
 * Pure function: takes ModelsConfig, returns string | null. No I/O.
 */
import { describe, expect, it } from 'vitest';

import { buildMarimoAiToml } from '@/main/extensions/marimo-config';
import type { ModelsConfig, ProviderEntry } from '@/shared/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeConfig = (overrides: Partial<ModelsConfig> = {}): ModelsConfig => ({
  version: 3,
  default: null,
  voice_default: null,
  providers: {},
  ...overrides,
});

const openaiProvider = (overrides: Partial<ProviderEntry> = {}): ProviderEntry => ({
  type: 'openai',
  api_key: 'sk-test-key',
  models: {
    'gpt-4o': { model: 'gpt-4o' },
  },
  ...overrides,
});

const azureProvider = (overrides: Partial<ProviderEntry> = {}): ProviderEntry => ({
  type: 'azure',
  api_key: 'azure-key',
  base_url: 'https://myinstance.openai.azure.com',
  api_version: '2024-02-01',
  models: {
    'gpt-4o': { model: 'gpt-4o' },
  },
  ...overrides,
});

// ---------------------------------------------------------------------------
// Null paths
// ---------------------------------------------------------------------------

describe('buildMarimoAiToml — null cases', () => {
  it('returns null when default is null', () => {
    expect(buildMarimoAiToml(makeConfig())).toBeNull();
  });

  it('returns null when default is empty string', () => {
    expect(buildMarimoAiToml(makeConfig({ default: '' }))).toBeNull();
  });

  it('returns null when default has no slash', () => {
    expect(
      buildMarimoAiToml(
        makeConfig({ default: 'openai', providers: { openai: openaiProvider() } })
      )
    ).toBeNull();
  });

  it('returns null when provider key does not exist', () => {
    expect(
      buildMarimoAiToml(makeConfig({ default: 'missing/gpt-4o', providers: {} }))
    ).toBeNull();
  });

  it('returns null when neither provider nor model has api_key', () => {
    expect(
      buildMarimoAiToml(
        makeConfig({
          default: 'openai/gpt-4o',
          providers: {
            openai: openaiProvider({ api_key: undefined }),
          },
        })
      )
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// OpenAI provider path
// ---------------------------------------------------------------------------

describe('buildMarimoAiToml — OpenAI provider', () => {
  it('generates [ai.open_ai] section with api_key', () => {
    const result = buildMarimoAiToml(
      makeConfig({
        default: 'openai/gpt-4o',
        providers: { openai: openaiProvider() },
      })
    )!;
    expect(result).toContain('[ai.open_ai]');
    expect(result).toContain('api_key = "sk-test-key"');
  });

  it('includes base_url when provider has one', () => {
    const result = buildMarimoAiToml(
      makeConfig({
        default: 'openai/gpt-4o',
        providers: {
          openai: openaiProvider({ base_url: 'http://localhost:11434/v1' }),
        },
      })
    )!;
    expect(result).toContain('base_url = "http://localhost:11434/v1"');
  });

  it('omits base_url when provider does not have one', () => {
    const result = buildMarimoAiToml(
      makeConfig({
        default: 'openai/gpt-4o',
        providers: { openai: openaiProvider() },
      })
    )!;
    expect(result).not.toContain('base_url');
  });

  it('writes the correct qualified model name', () => {
    const result = buildMarimoAiToml(
      makeConfig({
        default: 'openai/gpt-4o',
        providers: { openai: openaiProvider() },
      })
    )!;
    expect(result).toContain('chat_model = "openai/gpt-4o"');
    expect(result).toContain('edit_model = "openai/gpt-4o"');
    expect(result).toContain('autocomplete_model = "openai/gpt-4o"');
  });

  it('starts with the managed marker comment', () => {
    const result = buildMarimoAiToml(
      makeConfig({
        default: 'openai/gpt-4o',
        providers: { openai: openaiProvider() },
      })
    )!;
    expect(result.startsWith('# omni-launcher: managed')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Azure provider path
// ---------------------------------------------------------------------------

describe('buildMarimoAiToml — Azure provider', () => {
  it('generates [ai.azure] section with api_key, base_url, api_version', () => {
    const result = buildMarimoAiToml(
      makeConfig({
        default: 'azure/gpt-4o',
        providers: { azure: azureProvider() },
      })
    )!;
    expect(result).toContain('[ai.azure]');
    expect(result).toContain('api_key = "azure-key"');
    expect(result).toContain('base_url = "https://myinstance.openai.azure.com"');
    expect(result).toContain('api_version = "2024-02-01"');
    expect(result).toContain('chat_model = "azure/gpt-4o"');
  });

  it('omits api_version when not set', () => {
    const result = buildMarimoAiToml(
      makeConfig({
        default: 'azure/gpt-4o',
        providers: { azure: azureProvider({ api_version: undefined }) },
      })
    )!;
    expect(result).not.toContain('api_version');
  });
});

// ---------------------------------------------------------------------------
// Model-level api_key override
// ---------------------------------------------------------------------------

describe('buildMarimoAiToml — model-level api_key', () => {
  it('uses model-level api_key over provider-level', () => {
    const result = buildMarimoAiToml(
      makeConfig({
        default: 'openai/gpt-4o',
        providers: {
          openai: openaiProvider({
            api_key: 'provider-key',
            models: { 'gpt-4o': { model: 'gpt-4o', api_key: 'model-key' } },
          }),
        },
      })
    )!;
    expect(result).toContain('api_key = "model-key"');
    expect(result).not.toContain('provider-key');
  });

  it('falls back to provider api_key when model has none', () => {
    const result = buildMarimoAiToml(
      makeConfig({
        default: 'openai/gpt-4o',
        providers: { openai: openaiProvider({ api_key: 'provider-key' }) },
      })
    )!;
    expect(result).toContain('api_key = "provider-key"');
  });

  it('succeeds when provider has no key but model does', () => {
    const result = buildMarimoAiToml(
      makeConfig({
        default: 'openai/gpt-4o',
        providers: {
          openai: openaiProvider({
            api_key: undefined,
            models: { 'gpt-4o': { model: 'gpt-4o', api_key: 'model-only-key' } },
          }),
        },
      })
    )!;
    expect(result).toContain('api_key = "model-only-key"');
  });
});

// ---------------------------------------------------------------------------
// TOML escaping
// ---------------------------------------------------------------------------

describe('buildMarimoAiToml — TOML escaping', () => {
  it('escapes backslashes in values', () => {
    const result = buildMarimoAiToml(
      makeConfig({
        default: 'openai/gpt-4o',
        providers: {
          openai: openaiProvider({ api_key: 'key\\with\\backslashes' }),
        },
      })
    )!;
    expect(result).toContain('api_key = "key\\\\with\\\\backslashes"');
  });

  it('escapes double quotes in values', () => {
    const result = buildMarimoAiToml(
      makeConfig({
        default: 'openai/gpt-4o',
        providers: {
          openai: openaiProvider({ api_key: 'key"with"quotes' }),
        },
      })
    )!;
    expect(result).toContain('api_key = "key\\"with\\"quotes"');
  });
});
