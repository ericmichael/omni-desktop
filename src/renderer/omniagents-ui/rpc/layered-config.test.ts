import { describe, expect, it, vi } from 'vitest';

import type { RpcMethodMap } from '@/generated/omniagents-gui-v1/gui-v1';

import { LayeredConfigClient, LayeredConfigProtocolError, type LayeredConfigTransport } from './layered-config';
type Method = 'get_config' | 'validate_config' | 'write_config';
const field = (overrides: Record<string, unknown> = {}) => ({
  key: 'security.mode',
  type: 'string',
  label: 'Mode',
  description: '',
  secret: false,
  reload: 'session',
  read_only: false,
  read_only_reason: null,
  is_set: true,
  effective_layer: 'user',
  layers: [{ layer: 'user', source: '/config/90-gui.yml', is_set: true, value: 'safe' }],
  value: 'safe',
  ...overrides,
});
const reload = { hot: [], session: ['security.mode'], restart: [] };
class Rpc implements LayeredConfigTransport {
  calls: Array<{ method: Method; params: unknown }> = [];
  request = vi.fn(
    async <M extends Method>(method: M, params: RpcMethodMap[M]['params']): Promise<RpcMethodMap[M]['result']> => {
      this.calls.push({ method, params });
      return this.results[method] as RpcMethodMap[M]['result'];
    }
  );
  constructor(private results: Partial<Record<Method, unknown>>) {}
}
describe('LayeredConfigClient', () => {
  it('decodes provenance, writable targets, reload semantics, and additive fields', async () => {
    const rpc = new Rpc({
      get_config: {
        layers: [
          {
            name: 'user',
            writable: true,
            sources: ['/config/hand.yml'],
            write_target: '/config/90-gui.yml',
            future: true,
          },
        ],
        fields: [
          field({
            future_field: true,
            allowed_values: ['safe', 'strict'],
            layers: [{ layer: 'defaults', source: null, is_set: true, value: 'safe' }],
          }),
          field({ key: 'retention', type: 'integer', label: 'Retention', minimum: 0, maximum: 365 }),
        ],
        future_document: 1,
      },
    });
    const result = await new LayeredConfigClient(rpc).getConfig();
    expect(result).toMatchObject({
      layers: [{ write_target: '/config/90-gui.yml', future: true }],
      fields: [
        {
          reload: 'session',
          future_field: true,
          allowed_values: ['safe', 'strict'],
          layers: [{ layer: 'defaults', source: null }],
        },
        { key: 'retention', type: 'integer', minimum: 0, maximum: 365 },
      ],
      future_document: 1,
    });
  });
  it('validates and writes atomic batches with exact request shapes', async () => {
    const rpc = new Rpc({
      validate_config: { valid: true, errors: [], reload },
      write_config: {
        ok: true,
        errors: [],
        written: ['security.mode'],
        cleared: [],
        reload,
        restart_required: false,
        fields: [field()],
      },
    });
    const client = new LayeredConfigClient(rpc);
    await client.validate({ 'security.mode': 'safe' });
    await client.write({ 'security.mode': 'safe' });
    expect(rpc.calls).toEqual([
      { method: 'validate_config', params: { updates: { 'security.mode': 'safe' } } },
      { method: 'write_config', params: { updates: { 'security.mode': 'safe' } } },
    ]);
  });
  it('preserves structured errors without allowing submitted values', async () => {
    const client = new LayeredConfigClient(
      new Rpc({
        validate_config: {
          valid: false,
          errors: [{ key: 'x', code: 'unknown_key', message: 'Unknown', reason: 'structural' }],
          reload: { hot: [], session: [], restart: [] },
        },
      })
    );
    await expect(client.validate({ x: 1 })).resolves.toMatchObject({ valid: false, errors: [{ code: 'unknown_key' }] });
    const echo = new LayeredConfigClient(
      new Rpc({
        validate_config: {
          valid: false,
          errors: [{ key: 'secret', code: 'invalid', message: 'bad', value: 'leak' }],
          reload: { hot: [], session: [], restart: [] },
        },
      })
    );
    await expect(echo.validate({ secret: 'leak' })).rejects.toThrow(/echoes a submitted value/);
  });
  it('rejects secret descriptors that expose effective or layer values', async () => {
    const effective = new LayeredConfigClient(
      new Rpc({ get_config: { layers: [], fields: [field({ secret: true })] } })
    );
    await expect(effective.getConfig()).rejects.toThrow(/exposes a secret value/);
    const { value: _secretValue, ...secretLayerField } = field({
      secret: true,
      layers: [{ layer: 'user', source: '/x', is_set: true, value: 'leak' }],
    });
    const layer = new LayeredConfigClient(
      new Rpc({
        get_config: {
          layers: [],
          fields: [secretLayerField],
        },
      })
    );
    await expect(layer.getConfig()).rejects.toThrow(/exposes a secret value/);
  });
  it('rejects status/error inconsistency and unknown reload modes', async () => {
    const invalid = new LayeredConfigClient(
      new Rpc({
        validate_config: {
          valid: true,
          errors: [{ key: 'x', code: 'bad', message: 'bad' }],
          reload: { hot: [], session: [], restart: [] },
        },
      })
    );
    await expect(invalid.validate({})).rejects.toBeInstanceOf(LayeredConfigProtocolError);
    const mode = new LayeredConfigClient(new Rpc({ get_config: { layers: [], fields: [field({ reload: 'later' })] } }));
    await expect(mode.getConfig()).rejects.toThrow(/reload is unsupported/);
    const type = new LayeredConfigClient(new Rpc({ get_config: { layers: [], fields: [field({ type: 'json' })] } }));
    await expect(type.getConfig()).rejects.toThrow(/type is unsupported/);
    const restart = new LayeredConfigClient(
      new Rpc({
        write_config: {
          ok: true,
          errors: [],
          written: ['security.mode'],
          cleared: [],
          reload: { hot: [], session: [], restart: ['security.mode'] },
          restart_required: false,
          fields: [field({ reload: 'restart' })],
        },
      })
    );
    await expect(restart.write({ 'security.mode': 'safe' })).rejects.toThrow(/restart_required disagrees/);
  });
});
