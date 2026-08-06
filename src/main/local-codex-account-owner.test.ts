import { describe, expect, it, vi } from 'vitest';

import {
  durableLocalCodexAgentHostEnv,
  type LegacyCodexAccount,
  LocalCodexAccountOwner,
  type LocalCodexAccountRuntime,
  type LocalCodexOwnershipStore,
  parseCanonicalCodexAccount,
} from '@/main/local-codex-account-owner';

const canonicalStatus = (options?: {
  state?: 'signed_in' | 'signed_out' | 'error';
  accountId?: string;
  durable?: boolean;
  scope?: 'host' | 'process' | null;
}): Record<string, unknown> => ({
  providers: [
    {
      id: 'openai-chatgpt',
      state: options?.state ?? 'signed_out',
      identity: options?.accountId ? { account_id: options.accountId } : null,
    },
  ],
  mutation_persistence: {
    codex_oauth: {
      durable: options?.durable ?? true,
      scope: options?.scope === undefined ? 'host' : options.scope,
    },
    pending_logins: { durable: false, scope: 'process' },
  },
});

const setup = (options?: {
  owned?: boolean;
  legacyStatus?: { signedIn: boolean; accountId?: string; broken?: boolean };
  runtimeStatus?: Record<string, unknown>;
}) => {
  let ownership: 'omniagents' | undefined = options?.owned ? 'omniagents' : undefined;
  const store: LocalCodexOwnershipStore = {
    get: vi.fn(() => ownership),
    set: vi.fn((_key, value) => {
      ownership = value;
    }),
  };
  const runtime: LocalCodexAccountRuntime = {
    status: vi.fn(async () => options?.runtimeStatus ?? canonicalStatus()),
    mutate: vi.fn(),
  };
  const legacy: LegacyCodexAccount = {
    status: vi.fn(() => options?.legacyStatus ?? { signedIn: false }),
    link: vi.fn(async () => ({ signedIn: true, accountId: 'legacy' })),
    login: vi.fn(async () => ({ signedIn: true, accountId: 'legacy-browser' })),
    logout: vi.fn(),
  };
  return { store, runtime, legacy, ownership: () => ownership };
};

describe('parseCanonicalCodexAccount', () => {
  it('requires an explicit durable host-scoped Codex mutation attestation', () => {
    expect(parseCanonicalCodexAccount(canonicalStatus())?.durableHostMutation).toBe(true);
    expect(parseCanonicalCodexAccount(canonicalStatus({ durable: false }))?.durableHostMutation).toBe(false);
    expect(parseCanonicalCodexAccount(canonicalStatus({ scope: 'process' }))?.durableHostMutation).toBe(false);
  });
});

describe('durableLocalCodexAgentHostEnv', () => {
  it('overrides a user-spoofed durability value', () => {
    expect(
      durableLocalCodexAgentHostEnv({
        OPENAI_API_KEY: 'kept',
        OMNIAGENTS_CODEX_STORE_DURABILITY: 'process',
      })
    ).toEqual({ OPENAI_API_KEY: 'kept', OMNIAGENTS_CODEX_STORE_DURABILITY: 'host' });
  });
});

describe('LocalCodexAccountOwner', () => {
  it('marks equivalent signed-in legacy credentials without copying or deleting them', async () => {
    const ctx = setup({
      legacyStatus: { signedIn: true, accountId: 'acct-1' },
      runtimeStatus: canonicalStatus({ state: 'signed_in', accountId: 'acct-1' }),
    });
    const owner = new LocalCodexAccountOwner(ctx);

    await expect(owner.status()).resolves.toEqual({ signedIn: true, accountId: 'acct-1' });
    expect(ctx.ownership()).toBe('omniagents');
    expect(ctx.legacy.link).not.toHaveBeenCalled();
    expect(ctx.legacy.logout).not.toHaveBeenCalled();
  });

  it('marks equivalent signed-out state when durable host persistence is proven', async () => {
    const ctx = setup();
    const owner = new LocalCodexAccountOwner(ctx);

    await expect(owner.status()).resolves.toEqual({ signedIn: false });
    expect(ctx.ownership()).toBe('omniagents');
  });

  it('leaves migration pre-marker and uses the legacy read on account mismatch', async () => {
    const ctx = setup({
      legacyStatus: { signedIn: true, accountId: 'legacy-account' },
      runtimeStatus: canonicalStatus({ state: 'signed_in', accountId: 'different-account' }),
    });
    const owner = new LocalCodexAccountOwner(ctx);

    await expect(owner.status()).resolves.toEqual({ signedIn: true, accountId: 'legacy-account' });
    expect(ctx.ownership()).toBeUndefined();
    expect(ctx.store.set).not.toHaveBeenCalled();
  });

  it('does not mark ownership when the runtime durability attestation is absent', async () => {
    const ctx = setup({ runtimeStatus: canonicalStatus({ durable: false, scope: null }) });
    const owner = new LocalCodexAccountOwner(ctx);

    await expect(owner.status()).resolves.toEqual({ signedIn: false });
    expect(ctx.ownership()).toBeUndefined();
  });

  it('falls back to legacy device login only while migration remains pre-marker', async () => {
    const ctx = setup({ runtimeStatus: canonicalStatus({ durable: false }) });
    const owner = new LocalCodexAccountOwner(ctx);
    const onCode = vi.fn();

    await expect(owner.link(onCode)).resolves.toEqual({ signedIn: true, accountId: 'legacy' });
    expect(ctx.legacy.link).toHaveBeenCalledWith(onCode);
    expect(ctx.runtime.mutate).not.toHaveBeenCalled();
    expect(ctx.ownership()).toBeUndefined();
  });

  it('runs canonical device-code start and completion polling through the broker', async () => {
    const ctx = setup();
    vi.mocked(ctx.runtime.status)
      .mockResolvedValueOnce(canonicalStatus())
      .mockResolvedValue(canonicalStatus({ state: 'signed_in', accountId: 'acct-rpc' }));
    vi.mocked(ctx.runtime.mutate)
      .mockResolvedValueOnce({
        state: 'pending',
        login_id: 'login-1',
        user_code: 'ABCD-EFGH',
        verification_url: 'https://auth.example/device',
        interval: 1,
      })
      .mockResolvedValueOnce({ state: 'pending' })
      .mockResolvedValueOnce({ state: 'completed' });
    const sleep = vi.fn(async () => {});
    const owner = new LocalCodexAccountOwner({ ...ctx, sleep });
    const onCode = vi.fn();

    await expect(owner.link(onCode)).resolves.toEqual({ signedIn: true, accountId: 'acct-rpc' });
    expect(onCode).toHaveBeenCalledWith({
      userCode: 'ABCD-EFGH',
      verificationUri: 'https://auth.example/device',
    });
    expect(ctx.runtime.mutate).toHaveBeenNthCalledWith(1, {
      method: 'account_login_start',
      params: { provider: 'openai-chatgpt', mode: 'device_code' },
    });
    expect(ctx.runtime.mutate).toHaveBeenNthCalledWith(2, {
      method: 'account_login_complete',
      params: { login_id: 'login-1' },
    });
    expect(ctx.runtime.mutate).toHaveBeenNthCalledWith(3, {
      method: 'account_login_complete',
      params: { login_id: 'login-1' },
    });
    expect(ctx.legacy.link).not.toHaveBeenCalled();
  });

  it('uses canonical logout after ownership transfer', async () => {
    const ctx = setup({
      owned: true,
      legacyStatus: { signedIn: true },
      runtimeStatus: canonicalStatus({ state: 'signed_in' }),
    });
    const owner = new LocalCodexAccountOwner(ctx);

    await owner.logout();
    expect(ctx.runtime.mutate).toHaveBeenCalledWith({
      method: 'account_logout',
      params: { provider: 'openai-chatgpt' },
    });
    expect(ctx.legacy.logout).not.toHaveBeenCalled();
  });

  it('fails closed after ownership instead of restoring legacy mutations', async () => {
    const ctx = setup({ owned: true, runtimeStatus: canonicalStatus({ durable: false }) });
    const owner = new LocalCodexAccountOwner(ctx);

    await expect(owner.logout()).rejects.toThrow('durable host-scoped');
    await expect(owner.link(vi.fn())).rejects.toThrow('durable host-scoped');
    await expect(owner.login()).rejects.toThrow('unavailable after Omniagents takes account ownership');
    expect(ctx.legacy.logout).not.toHaveBeenCalled();
    expect(ctx.legacy.link).not.toHaveBeenCalled();
    expect(ctx.legacy.login).not.toHaveBeenCalled();
  });

  it('keeps browser login explicitly legacy only before migration', async () => {
    const ctx = setup();
    const owner = new LocalCodexAccountOwner(ctx);

    await expect(owner.login()).resolves.toEqual({ signedIn: true, accountId: 'legacy-browser' });
    expect(ctx.legacy.login).toHaveBeenCalledOnce();
    expect(ctx.ownership()).toBeUndefined();
  });
});
