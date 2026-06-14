import { describe, expect, it } from 'vitest';

import {
  buildCodexConfig,
  buildProviderConfig,
  classifyAgentError,
  maskApiKey,
  normalizeCompatibleBaseUrl,
  probeForProvider,
} from '@/lib/provider-config';
import type { ModelsConfig } from '@/shared/types';

const empty = (): ModelsConfig => ({ version: 3, default: null, voice_default: null, providers: {} });

const model = { id: 'claude-fable-5', label: 'Claude Fable 5', maxInput: 200000, maxOutput: 64000 };

describe('buildProviderConfig', () => {
  it('openai: native provider with Responses API model_settings', () => {
    const { config, modelRef } = buildProviderConfig(empty(), {
      kind: 'openai',
      apiKey: 'sk-test',
      model: { id: 'gpt-5.5', label: 'GPT-5.5', maxInput: 272000, maxOutput: 128000 },
      makeDefault: 'always',
    });
    expect(modelRef).toBe('openai/gpt-5.5');
    expect(config.default).toBe('openai/gpt-5.5');
    expect(config.providers['openai']).toMatchObject({
      type: 'openai',
      api_key: 'sk-test',
      models: {
        'gpt-5.5': {
          model: 'gpt-5.5',
          label: 'GPT-5.5',
          max_input_tokens: 272000,
          max_output_tokens: 128000,
          model_settings: { store: false, extra_body: { include: ['reasoning.encrypted_content'] } },
        },
      },
    });
  });

  it('anthropic: litellm provider with prefixed model ref and NO Responses settings', () => {
    const { config, modelRef } = buildProviderConfig(empty(), {
      kind: 'anthropic',
      apiKey: 'sk-ant-test',
      model,
      makeDefault: 'always',
    });
    expect(modelRef).toBe('anthropic/claude-fable-5');
    const provider = config.providers['anthropic'];
    expect(provider?.type).toBe('litellm');
    const entry = provider?.models['claude-fable-5'];
    expect(entry?.model).toBe('anthropic/claude-fable-5');
    expect(entry?.model_settings).toBeUndefined();
  });

  it('ollama: openai-compatible "local" provider with /v1 suffix and no key required', () => {
    const { config, modelRef } = buildProviderConfig(empty(), {
      kind: 'ollama',
      baseUrl: 'http://localhost:11434',
      model: { id: 'llama3.1:8b', label: 'llama3.1:8b', maxInput: 272000, maxOutput: 128000 },
      makeDefault: 'always',
    });
    expect(modelRef).toBe('local/llama3.1:8b');
    expect(config.providers['local']).toMatchObject({
      type: 'openai-compatible',
      base_url: 'http://localhost:11434/v1',
    });
    expect(config.providers['local']?.api_key).toBeUndefined();
  });

  it('if-unset keeps an existing default; merging preserves other models on the provider', () => {
    const current = empty();
    current.default = 'openai/gpt-5.5';
    current.providers['anthropic'] = {
      type: 'litellm',
      api_key: 'sk-old',
      models: { 'claude-sonnet-4-6': { model: 'anthropic/claude-sonnet-4-6' } },
    };
    const { config } = buildProviderConfig(current, {
      kind: 'anthropic',
      apiKey: 'sk-new',
      model,
      makeDefault: 'if-unset',
    });
    expect(config.default).toBe('openai/gpt-5.5');
    expect(Object.keys(config.providers['anthropic']?.models ?? {})).toEqual(['claude-sonnet-4-6', 'claude-fable-5']);
    expect(config.providers['anthropic']?.api_key).toBe('sk-new');
  });
});

describe('buildCodexConfig', () => {
  it('adds the codex provider and promotes the preferred model when nothing else is configured', () => {
    const { config, madeDefault } = buildCodexConfig(empty(), {
      models: [
        { name: 'codex/gpt-5.5-codex', provider: 'openai-oauth' },
        { name: 'codex/gpt-5.5', provider: 'openai-oauth' },
      ],
      default: null,
      voice_default: null,
    });
    expect(config.providers['codex']).toEqual({ type: 'openai-oauth', models: {} });
    expect(madeDefault).toBe('codex/gpt-5.5');
    expect(config.default).toBe('codex/gpt-5.5');
  });

  it('leaves the default alone when other providers exist', () => {
    const current = empty();
    current.default = 'openai/gpt-5.5';
    current.providers['openai'] = { type: 'openai', models: {} };
    const { config, madeDefault } = buildCodexConfig(current, {
      models: [{ name: 'codex/gpt-5.5', provider: 'openai-oauth' }],
      default: null,
      voice_default: null,
    });
    expect(madeDefault).toBeUndefined();
    expect(config.default).toBe('openai/gpt-5.5');
    expect(config.providers['codex']).toBeDefined();
  });
});

describe('normalizeCompatibleBaseUrl', () => {
  it('appends /v1 and trims trailing slashes, idempotently', () => {
    expect(normalizeCompatibleBaseUrl('http://localhost:11434')).toBe('http://localhost:11434/v1');
    expect(normalizeCompatibleBaseUrl('http://localhost:8000/v1/')).toBe('http://localhost:8000/v1');
    expect(normalizeCompatibleBaseUrl(' http://h:1/v1 ')).toBe('http://h:1/v1');
  });
});

describe('maskApiKey', () => {
  it('keeps a short prefix and the last 4', () => {
    expect(maskApiKey('sk-abcdefghijklmnop1234')).toBe('sk-…1234');
  });
  it('fully masks short keys', () => {
    expect(maskApiKey('short')).toBe('••••');
  });
});

describe('classifyAgentError', () => {
  it.each([
    'Error code: 401 - {"error": "invalid_api_key"}',
    'AuthenticationError: invalid x-api-key',
    'Unauthorized',
    'Incorrect API key provided',
  ])('flags auth failures: %s', (msg) => {
    expect(classifyAgentError(msg)).toBe('auth');
  });

  it.each(['ECONNREFUSED 127.0.0.1:11434', 'Rate limit exceeded (429)', 'Internal server error'])(
    'ignores non-auth failures: %s',
    (msg) => {
      expect(classifyAgentError(msg)).toBeNull();
    }
  );
});

describe('probeForProvider', () => {
  it('maps openai entries with a key', () => {
    expect(probeForProvider('openai', { type: 'openai', api_key: 'sk-x', models: {} })).toEqual({
      kind: 'openai',
      apiKey: 'sk-x',
    });
  });

  it('recognizes anthropic-shaped litellm providers by name or model prefix', () => {
    expect(probeForProvider('anthropic', { type: 'litellm', api_key: 'sk-ant', models: {} })).toEqual({
      kind: 'anthropic',
      apiKey: 'sk-ant',
    });
    expect(
      probeForProvider('litellm', {
        type: 'litellm',
        api_key: 'sk-ant',
        models: { x: { model: 'anthropic/claude-fable-5' } },
      })
    ).toEqual({ kind: 'anthropic', apiKey: 'sk-ant' });
  });

  it('returns null for mixed litellm, azure, oauth, and keyless entries', () => {
    expect(
      probeForProvider('litellm', {
        type: 'litellm',
        api_key: 'sk-x',
        models: { a: { model: 'anthropic/claude-fable-5' }, g: { model: 'gemini/gemini-2.5-pro' } },
      })
    ).toBeNull();
    expect(probeForProvider('azure', { type: 'azure', api_key: 'k', models: {} })).toBeNull();
    expect(probeForProvider('codex', { type: 'openai-oauth', models: {} })).toBeNull();
    expect(probeForProvider('openai', { type: 'openai', models: {} })).toBeNull();
  });

  it('maps compatible servers with their base URL and optional key', () => {
    expect(
      probeForProvider('local', { type: 'openai-compatible', base_url: 'http://localhost:11434/v1', models: {} })
    ).toEqual({ kind: 'openai-compatible', baseUrl: 'http://localhost:11434/v1' });
  });
});
