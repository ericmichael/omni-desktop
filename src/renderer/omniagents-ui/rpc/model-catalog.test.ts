import { describe, expect, it, vi } from 'vitest';

import type { RpcMethodMap } from '@/generated/omniagents-gui-v1/gui-v1';

import { ModelCatalogClient, ModelCatalogProtocolError, type ModelCatalogRpcTransport } from './model-catalog';

type CatalogMethod = Extract<
  keyof RpcMethodMap,
  'list_models' | 'get_model' | 'list_providers' | 'set_session_model' | 'set_session_reasoning'
>;

const model = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'codex/gpt-5',
  model: 'gpt-5',
  label: 'GPT-5',
  description: 'Coding model',
  provider: { name: 'codex', type: 'openai-oauth' },
  modalities: ['text'],
  realtime: false,
  limits: { max_input_tokens: 272_000, max_output_tokens: 128_000 },
  reasoning: { default: 'medium', options: ['low', 'medium', 'high', 'xhigh'] },
  tiers: { service: null, speed: null },
  personality: { supported: false, options: [], default: null },
  availability: { available: true, reasons: [] },
  entitlement: { entitled: true, credential: 'oauth' },
  deprecation: { deprecated: false, message: null, replace_with: null },
  hidden: false,
  is_default: true,
  is_voice_default: false,
  is_user_defined: false,
  ...overrides,
});

const provider = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: 'codex',
  type: 'openai-oauth',
  base_url: null,
  is_default_provider: true,
  is_user_defined: false,
  model_count: 2,
  hidden_model_count: 1,
  capabilities: { realtime: false, reasoning: true, modalities: ['text'] },
  health: { status: 'ok', detail: null },
  ...overrides,
});

class FakeCatalogRpc implements ModelCatalogRpcTransport {
  readonly calls: Array<{ method: CatalogMethod; params: unknown }> = [];
  readonly request = vi.fn(
    async <Method extends CatalogMethod>(
      method: Method,
      params: RpcMethodMap[Method]['params']
    ): Promise<RpcMethodMap[Method]['result']> => {
      this.calls.push({ method, params });
      const result = this.results[method];
      if (result === undefined) {
        throw new Error(`No fake result for ${method}`);
      }
      return result as RpcMethodMap[Method]['result'];
    }
  );

  constructor(private readonly results: Partial<Record<CatalogMethod, unknown>>) {}
}

describe('ModelCatalogClient', () => {
  it('sends all list_models filters and preserves additive descriptor records', async () => {
    const rpc = new FakeCatalogRpc({
      list_models: {
        models: [
          model({
            future_model_field: 7,
            reasoning: { default: 'medium', options: ['medium'], future_reasoning_field: true },
            availability: { available: false, reasons: [{ code: 'future_block', message: 'Blocked' }], retry_at: 3 },
          }),
        ],
        default_model: 'codex/gpt-5',
        voice_default_model: null,
        errors: [],
        reasons: [],
        session: {
          session_id: 'session-1',
          active_model: 'codex/gpt-5',
          reasoning_effort: 'medium',
          future_session_field: 'kept',
        },
        future_catalog_field: { version: 2 },
      },
    });
    const client = new ModelCatalogClient(rpc);

    const result = await client.listModels({ sessionId: 'session-1', includeHidden: false, modality: 'text' });

    expect(rpc.calls).toEqual([
      {
        method: 'list_models',
        params: { session_id: 'session-1', include_hidden: false, modality: 'text' },
      },
    ]);
    expect(result.models[0]).toMatchObject({
      id: 'codex/gpt-5',
      future_model_field: 7,
      reasoning: { future_reasoning_field: true },
      availability: { reasons: [{ code: 'future_block' }], retry_at: 3 },
    });
    expect(result.session).toMatchObject({ future_session_field: 'kept' });
    expect(result.future_catalog_field).toEqual({ version: 2 });
  });

  it('accepts a catalog-level failure without session selection', async () => {
    const client = new ModelCatalogClient(
      new FakeCatalogRpc({
        list_models: {
          models: [],
          default_model: null,
          voice_default_model: null,
          errors: [],
          reasons: [{ code: 'no_model_store', message: 'Unavailable', action: 'Configure models' }],
        },
      })
    );

    await expect(client.listModels({ sessionId: 'session-1' })).resolves.toMatchObject({
      models: [],
      reasons: [{ code: 'no_model_store' }],
    });
  });

  it('validates availability and reasoning descriptors', async () => {
    const badAvailability = new ModelCatalogClient(
      new FakeCatalogRpc({
        get_model: {
          found: true,
          model: model({ availability: { available: 'yes', reasons: [] } }),
          reasons: [],
        },
      })
    );
    await expect(badAvailability.getModel('gpt-5')).rejects.toThrow(/availability.available must be a boolean/);

    const badReasoning = new ModelCatalogClient(
      new FakeCatalogRpc({
        get_model: {
          found: true,
          model: model({ reasoning: { default: 'medium', options: [false] } }),
          reasons: [],
        },
      })
    );
    await expect(badReasoning.getModel('gpt-5')).rejects.toThrow(/reasoning.options\[0\] must be a string/);
  });

  it('decodes found and not-found model reads consistently', async () => {
    const foundRpc = new FakeCatalogRpc({
      get_model: { found: true, model: model(), reasons: [], future_result_field: true },
    });
    await expect(new ModelCatalogClient(foundRpc).getModel('gpt-5')).resolves.toMatchObject({
      found: true,
      model: { id: 'codex/gpt-5' },
      future_result_field: true,
    });
    expect(foundRpc.calls).toEqual([{ method: 'get_model', params: { model: 'gpt-5' } }]);

    const missing = new ModelCatalogClient(
      new FakeCatalogRpc({
        get_model: {
          found: false,
          model: null,
          reasons: [{ code: 'unknown_model', message: 'Unknown', future_reason_field: 1 }],
        },
      })
    );
    await expect(missing.getModel('missing')).resolves.toMatchObject({ found: false, model: null });
  });

  it('rejects inconsistent get_model presence', async () => {
    const client = new ModelCatalogClient(
      new FakeCatalogRpc({ get_model: { found: false, model: model(), reasons: [] } })
    );
    await expect(client.getModel('gpt-5')).rejects.toThrow(/found flag does not match model presence/);
  });

  it('lists providers with validated identity, capability, and health fields', async () => {
    const rpc = new FakeCatalogRpc({
      list_providers: {
        providers: [provider({ future_provider_field: 'kept' })],
        errors: [{ provider: 'broken', code: 'provider_error', message: 'Discovery failed', trace_id: 't1' }],
        reasons: [],
      },
    });
    const result = await new ModelCatalogClient(rpc).listProviders();

    expect(rpc.calls).toEqual([{ method: 'list_providers', params: {} }]);
    expect(result.providers[0]).toMatchObject({
      name: 'codex',
      health: { status: 'ok' },
      capabilities: { reasoning: true, modalities: ['text'] },
      future_provider_field: 'kept',
    });
    expect(result.errors[0]).toMatchObject({ trace_id: 't1' });
  });

  it('rejects malformed provider health and counts', async () => {
    const health = new ModelCatalogClient(
      new FakeCatalogRpc({
        list_providers: {
          providers: [provider({ health: { status: 'offline', detail: null } })],
          errors: [],
          reasons: [],
        },
      })
    );
    await expect(health.listProviders()).rejects.toThrow(/health.status has unsupported value/);

    const count = new ModelCatalogClient(
      new FakeCatalogRpc({
        list_providers: { providers: [provider({ model_count: -1 })], errors: [], reasons: [] },
      })
    );
    await expect(count.listProviders()).rejects.toThrow(/model_count must be a non-negative/);
  });

  it('sets a session model and validates the correlated result', async () => {
    const rpc = new FakeCatalogRpc({
      set_session_model: {
        ok: true,
        session_id: 'session-1',
        model: 'codex/gpt-5',
        label: 'GPT-5',
        provider: 'openai-oauth',
        max_input_tokens: 272_000,
        max_output_tokens: 128_000,
        reasoning_effort: 'medium',
        warnings: [{ code: 'future_warning', message: 'Heads up' }],
        future_selection_field: true,
      },
    });
    const result = await new ModelCatalogClient(rpc).setSessionModel('session-1', 'codex/gpt-5');

    expect(rpc.calls).toEqual([
      { method: 'set_session_model', params: { session_id: 'session-1', model: 'codex/gpt-5' } },
    ]);
    expect(result).toMatchObject({ ok: true, session_id: 'session-1', future_selection_field: true });
  });

  it('preserves typed model-selection refusals without requiring success fields', async () => {
    const client = new ModelCatalogClient(
      new FakeCatalogRpc({
        set_session_model: {
          ok: false,
          session_id: 'session-1',
          reasons: [{ code: 'unknown_model', message: 'Unknown model', action: 'Choose another' }],
        },
      })
    );
    await expect(client.setSessionModel('session-1', 'missing')).resolves.toMatchObject({
      ok: false,
      reasons: [{ code: 'unknown_model' }],
    });
  });

  it('sets a session reasoning effort and validates the returned vocabulary', async () => {
    const rpc = new FakeCatalogRpc({
      set_session_reasoning: {
        ok: true,
        session_id: 'session-1',
        reasoning_effort: 'high',
        model: 'codex/gpt-5',
      },
    });
    await expect(new ModelCatalogClient(rpc).setSessionReasoning('session-1', 'high')).resolves.toMatchObject({
      ok: true,
      reasoning_effort: 'high',
    });
    expect(rpc.calls).toEqual([
      { method: 'set_session_reasoning', params: { session_id: 'session-1', effort: 'high' } },
    ]);
  });

  it('rejects mismatched mutation identities and unsupported reasoning values', async () => {
    const wrongSession = new ModelCatalogClient(
      new FakeCatalogRpc({ set_session_model: { ok: false, session_id: 'session-2', reasons: [] } })
    );
    await expect(wrongSession.setSessionModel('session-1', 'gpt-5')).rejects.toThrow(/different session_id/);

    const badResult = new ModelCatalogClient(
      new FakeCatalogRpc({
        set_session_reasoning: {
          ok: true,
          session_id: 'session-1',
          reasoning_effort: 'extreme',
          model: null,
        },
      })
    );
    await expect(badResult.setSessionReasoning('session-1', 'medium')).rejects.toThrow(/unsupported reasoning effort/);
  });

  it('requires complete success and refusal mutation envelopes', async () => {
    const incompleteSuccess = new ModelCatalogClient(
      new FakeCatalogRpc({ set_session_model: { ok: true, session_id: 'session-1' } })
    );
    await expect(incompleteSuccess.setSessionModel('session-1', 'gpt-5')).rejects.toThrow(
      /model is required on success/
    );

    const incompleteRefusal = new ModelCatalogClient(
      new FakeCatalogRpc({ set_session_reasoning: { ok: false, session_id: 'session-1' } })
    );
    await expect(incompleteRefusal.setSessionReasoning('session-1', 'medium')).rejects.toThrow(
      /reasons is required on refusal/
    );
  });

  it('validates inputs before making requests', async () => {
    const rpc = new FakeCatalogRpc({});
    const client = new ModelCatalogClient(rpc);

    await expect(client.listModels({ modality: '' })).rejects.toThrow(/modality must be a non-empty string/);
    await expect(client.getModel('')).rejects.toThrow(/model must be a non-empty string/);
    await expect(client.setSessionModel('', 'gpt-5')).rejects.toThrow(/sessionId must be a non-empty string/);
    await expect(client.setSessionReasoning('session-1', 'extreme' as 'medium')).rejects.toThrow(/effort must be/);
    expect(rpc.request).not.toHaveBeenCalled();
  });

  it('uses protocol errors for malformed server boundaries', async () => {
    const client = new ModelCatalogClient(new FakeCatalogRpc({ list_providers: { providers: 'invalid' } }));
    await expect(client.listProviders()).rejects.toBeInstanceOf(ModelCatalogProtocolError);
  });
});
