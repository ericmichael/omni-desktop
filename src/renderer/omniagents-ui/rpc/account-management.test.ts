import { describe, expect, it, vi } from 'vitest';

import type { RpcMethodMap, RpcNotificationMap } from '@/generated/omniagents-gui-v1/gui-v1';

import {
  AccountManagementClient,
  AccountManagementProtocolError,
  type AccountManagementTransport,
} from './account-management';
type Method = Extract<keyof RpcMethodMap, `account_${string}`>;
const account = (overrides: Record<string, unknown> = {}) => ({
  id: 'openai',
  label: 'OpenAI',
  kind: 'api_key',
  capabilities: { login_modes: ['api_key'], logout: true, refresh: false, usage: false },
  state: 'signed_in',
  source: 'rpc',
  identity: null,
  error: null,
  selected: false,
  ...overrides,
});
class Rpc implements AccountManagementTransport {
  calls: Array<{ method: Method; params: unknown }> = [];
  handler?: (payload: RpcNotificationMap['account_changed']) => void;
  request = vi.fn(
    async <M extends Method>(method: M, params: RpcMethodMap[M]['params']): Promise<RpcMethodMap[M]['result']> => {
      this.calls.push({ method, params });
      return this.results[method] as RpcMethodMap[M]['result'];
    }
  );
  on = vi.fn((_event: 'account_changed', handler: (payload: RpcNotificationMap['account_changed']) => void) => {
    this.handler = handler;
    return () => {
      this.handler = undefined;
    };
  });
  constructor(private results: Partial<Record<Method, unknown>>) {}
}
describe('AccountManagementClient', () => {
  it('reads redacted status/usage and preserves additive fields', async () => {
    const rpc = new Rpc({
      account_status: { providers: [account({ future: true })], selected_provider: 'openai' },
      account_usage: {
        providers: [{ id: 'openai', plan: null, rate_limits: [], captured_at: null, notices: [], future: 1 }],
      },
    });
    const client = new AccountManagementClient(rpc);
    await expect(client.status()).resolves.toMatchObject({ providers: [{ future: true }] });
    await expect(client.usage('openai')).resolves.toMatchObject({ providers: [{ future: 1 }] });
    expect(rpc.calls).toEqual([
      { method: 'account_status', params: {} },
      { method: 'account_usage', params: { provider: 'openai' } },
    ]);
  });
  it('covers login lifecycle without accepting echoed credentials', async () => {
    const rpc = new Rpc({
      account_login_start: {
        state: 'pending',
        mode: 'browser',
        provider: 'openai-chatgpt',
        login_id: 'login-1',
        auth_url: 'https://auth',
      },
      account_login_complete: {
        state: 'completed',
        mode: 'browser',
        provider: 'openai-chatgpt',
        account: account({ id: 'openai-chatgpt', kind: 'oauth' }),
      },
      account_login_cancel: true,
    });
    const client = new AccountManagementClient(rpc);
    await client.startLogin('openai-chatgpt', 'browser', { redirectUri: 'http://callback' });
    await client.completeLogin('login-1', 'code');
    await expect(client.cancelLogin('login-1')).resolves.toBe(true);
    expect(rpc.calls.map(({ method }) => method)).toEqual([
      'account_login_start',
      'account_login_complete',
      'account_login_cancel',
    ]);
    const leaking = new AccountManagementClient(
      new Rpc({
        account_login_start: {
          state: 'completed',
          mode: 'api_key',
          provider: 'openai',
          api_key: 'secret',
          account: account(),
        },
      })
    );
    await expect(leaking.startLogin('openai', 'api_key', { apiKey: 'secret' })).rejects.toThrow(/forbidden credential/);
  });
  it('validates account mutations and event snapshots', async () => {
    const rpc = new Rpc({
      account_logout: { ok: true, account: account({ state: 'signed_out', source: null }) },
      account_refresh: { ok: true, account: account() },
      account_select: { selected_provider: 'openai', account: account({ selected: true }) },
    });
    const client = new AccountManagementClient(rpc);
    await client.logout('openai');
    await client.refresh('openai');
    await client.select('openai');
    const events: unknown[] = [];
    client.onChanged((event) => events.push(event));
    rpc.handler?.({ provider: 'openai', reason: 'select', account: account({ selected: true }) });
    expect(events).toHaveLength(1);
  });
  it('rejects malformed snapshots and secret-bearing results', async () => {
    const malformed = new AccountManagementClient(
      new Rpc({ account_status: { providers: [account({ state: 'unknown' })], selected_provider: null } })
    );
    await expect(malformed.status()).rejects.toBeInstanceOf(AccountManagementProtocolError);
    const secret = new AccountManagementClient(
      new Rpc({
        account_status: { providers: [account({ identity: { access_token: 'nope' } })], selected_provider: null },
      })
    );
    await expect(secret.status()).rejects.toThrow(/forbidden credential/);
  });
});
