import type { RpcMethodMap, RpcNotificationMap } from '@/generated/omniagents-gui-v1/gui-v1';

type AccountMethod = Extract<keyof RpcMethodMap, `account_${string}`>;

export interface AccountManagementTransport {
  request<Method extends AccountMethod>(
    method: Method,
    params: RpcMethodMap[Method]['params']
  ): Promise<RpcMethodMap[Method]['result']>;
  on?<Event extends 'account_changed'>(event: Event, handler: (payload: RpcNotificationMap[Event]) => void): () => void;
}

export type AccountSnapshot = Record<string, unknown> & {
  id: string;
  label: string;
  kind: 'oauth' | 'api_key';
  capabilities: Record<string, unknown> & {
    login_modes: string[];
    logout: boolean;
    refresh: boolean;
    usage: boolean;
  };
  state: 'signed_in' | 'signed_out' | 'error';
  source: 'oauth' | 'rpc' | 'env' | null;
  identity: Record<string, unknown> | null;
  error: Record<string, unknown> | null;
  selected: boolean;
};

export type AccountUsageSnapshot = Record<string, unknown> & {
  id: string;
  plan: string | null;
  rate_limits: Array<
    Record<string, unknown> & {
      name: string;
      used_percent?: number;
      window_minutes?: number;
      resets_at?: number;
    }
  >;
  captured_at: number | null;
  notices: unknown[];
};

export type AccountLoginState = Record<string, unknown> & {
  state: 'pending' | 'completed';
  mode: 'device_code' | 'browser' | 'api_key';
  provider: string;
  login_id?: string;
  account?: AccountSnapshot;
};

export class AccountManagementProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AccountManagementProtocolError';
  }
}

const forbiddenSecretKeys = new Set([
  'api_key',
  'access_token',
  'refresh_token',
  'id_token',
  'client_secret',
  'code_verifier',
]);

function assertRedacted(value: unknown, label: string): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertRedacted(entry, `${label}[${index}]`));
  } else if (value && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (forbiddenSecretKeys.has(key.toLowerCase())) {
        throw new AccountManagementProtocolError(`${label} contains forbidden credential field ${key}`);
      }
      assertRedacted(nested, `${label}.${key}`);
    }
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AccountManagementProtocolError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new AccountManagementProtocolError(`${label} must be a non-empty string`);
  }
  return value;
}

function bool(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') {
    throw new AccountManagementProtocolError(`${label} must be a boolean`);
  }
  return value;
}

function number(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new AccountManagementProtocolError(`${label} must be a finite number`);
  }
  return value;
}

function nullableRecord(value: unknown, label: string): Record<string, unknown> | null {
  return value === null ? null : record(value, label);
}

function nullableString(value: unknown, label: string): string | null {
  return value === null ? null : string(value, label);
}

function nullableNumber(value: unknown, label: string): number | null {
  return value === null ? null : number(value, label);
}

function array<T>(value: unknown, parser: (entry: unknown, label: string) => T, label: string): T[] {
  if (!Array.isArray(value)) {
    throw new AccountManagementProtocolError(`${label} must be an array`);
  }
  return value.map((entry, index) => parser(entry, `${label}[${index}]`));
}

const strings = (value: unknown, label: string) => array(value, string, label);

function decodeSnapshot(value: unknown, label: string): AccountSnapshot {
  assertRedacted(value, label);
  const item = record(value, label);
  const capabilities = record(item.capabilities, `${label}.capabilities`);
  const kind = string(item.kind, `${label}.kind`);
  const state = string(item.state, `${label}.state`);
  const source = item.source === null ? null : string(item.source, `${label}.source`);
  if (kind !== 'oauth' && kind !== 'api_key') {
    throw new AccountManagementProtocolError(`${label}.kind is unsupported`);
  }
  if (state !== 'signed_in' && state !== 'signed_out' && state !== 'error') {
    throw new AccountManagementProtocolError(`${label}.state is unsupported`);
  }
  if (source !== null && source !== 'oauth' && source !== 'rpc' && source !== 'env') {
    throw new AccountManagementProtocolError(`${label}.source is unsupported`);
  }
  return {
    ...item,
    id: string(item.id, `${label}.id`),
    label: string(item.label, `${label}.label`),
    kind,
    capabilities: {
      ...capabilities,
      login_modes: strings(capabilities.login_modes, `${label}.capabilities.login_modes`),
      logout: bool(capabilities.logout, `${label}.capabilities.logout`),
      refresh: bool(capabilities.refresh, `${label}.capabilities.refresh`),
      usage: bool(capabilities.usage, `${label}.capabilities.usage`),
    },
    state,
    source,
    identity: nullableRecord(item.identity, `${label}.identity`),
    error: nullableRecord(item.error, `${label}.error`),
    selected: bool(item.selected, `${label}.selected`),
  };
}

function optionalNumber(item: Record<string, unknown>, key: string, label: string): Record<string, number> {
  return item[key] === undefined ? {} : { [key]: number(item[key], `${label}.${key}`) };
}

function decodeUsage(value: unknown, label: string): AccountUsageSnapshot {
  assertRedacted(value, label);
  const item = record(value, label);
  return {
    ...item,
    id: string(item.id, `${label}.id`),
    plan: nullableString(item.plan, `${label}.plan`),
    rate_limits: array(
      item.rate_limits,
      (entry, rateLabel) => {
        const rate = record(entry, rateLabel);
        return {
          ...rate,
          name: string(rate.name, `${rateLabel}.name`),
          ...optionalNumber(rate, 'used_percent', rateLabel),
          ...optionalNumber(rate, 'window_minutes', rateLabel),
          ...optionalNumber(rate, 'resets_at', rateLabel),
        };
      },
      `${label}.rate_limits`
    ),
    captured_at: nullableNumber(item.captured_at, `${label}.captured_at`),
    notices: array(item.notices, (notice) => notice, `${label}.notices`),
  };
}

function decodeLogin(value: unknown, label: string): AccountLoginState {
  assertRedacted(value, label);
  const item = record(value, label);
  const state = string(item.state, `${label}.state`);
  const mode = string(item.mode, `${label}.mode`);
  if (state !== 'pending' && state !== 'completed') {
    throw new AccountManagementProtocolError(`${label}.state is unsupported`);
  }
  if (mode !== 'device_code' && mode !== 'browser' && mode !== 'api_key') {
    throw new AccountManagementProtocolError(`${label}.mode is unsupported`);
  }
  if (state === 'pending' && item.login_id === undefined) {
    throw new AccountManagementProtocolError(`${label}.login_id is required while pending`);
  }
  if (state === 'completed' && item.account === undefined) {
    throw new AccountManagementProtocolError(`${label}.account is required when completed`);
  }
  return {
    ...item,
    state,
    mode,
    provider: string(item.provider, `${label}.provider`),
    ...(item.login_id === undefined ? {} : { login_id: string(item.login_id, `${label}.login_id`) }),
    ...(item.account === undefined ? {} : { account: decodeSnapshot(item.account, `${label}.account`) }),
  };
}

function input(value: string, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

export class AccountManagementClient {
  constructor(private readonly rpc: AccountManagementTransport) {}

  onChanged(
    handler: (event: Record<string, unknown> & { provider: string; reason: string; account?: AccountSnapshot }) => void
  ): () => void {
    if (!this.rpc.on) {
      throw new TypeError('Account transport does not support notifications');
    }
    return this.rpc.on('account_changed', (payload) => {
      assertRedacted(payload, 'account_changed');
      const item = record(payload, 'account_changed');
      handler({
        ...item,
        provider: string(item.provider, 'account_changed.provider'),
        reason: string(item.reason, 'account_changed.reason'),
        ...(item.account === undefined ? {} : { account: decodeSnapshot(item.account, 'account_changed.account') }),
      });
    });
  }

  async status(): Promise<
    Record<string, unknown> & { providers: AccountSnapshot[]; selected_provider: string | null }
  > {
    const raw = await this.read('account_status', {}, 'account_status');
    return {
      ...raw,
      providers: array(raw.providers, decodeSnapshot, 'account_status.providers'),
      selected_provider: nullableString(raw.selected_provider, 'account_status.selected_provider'),
    };
  }

  async usage(provider?: string): Promise<Record<string, unknown> & { providers: AccountUsageSnapshot[] }> {
    const raw = await this.read(
      'account_usage',
      provider === undefined ? {} : { provider: input(provider, 'provider') },
      'account_usage'
    );
    return { ...raw, providers: array(raw.providers, decodeUsage, 'account_usage.providers') };
  }

  async startLogin(
    provider: string,
    mode: 'device_code' | 'browser' | 'api_key',
    options: { apiKey?: string; redirectUri?: string } = {}
  ): Promise<AccountLoginState> {
    return decodeLogin(
      await this.rpc.request('account_login_start', {
        provider: input(provider, 'provider'),
        mode,
        ...(options.apiKey === undefined ? {} : { api_key: input(options.apiKey, 'apiKey') }),
        ...(options.redirectUri === undefined ? {} : { redirect_uri: input(options.redirectUri, 'redirectUri') }),
      }),
      'account_login_start'
    );
  }

  async completeLogin(loginId: string, code?: string): Promise<AccountLoginState> {
    return decodeLogin(
      await this.rpc.request('account_login_complete', {
        login_id: input(loginId, 'loginId'),
        ...(code === undefined ? {} : { code: input(code, 'code') }),
      }),
      'account_login_complete'
    );
  }

  async cancelLogin(loginId: string): Promise<boolean> {
    return bool(
      await this.rpc.request('account_login_cancel', { login_id: input(loginId, 'loginId') }),
      'account_login_cancel result'
    );
  }

  async logout(provider: string): Promise<AccountSnapshot> {
    return this.accountMutation('account_logout', provider);
  }

  async refresh(provider: string): Promise<AccountSnapshot> {
    return this.accountMutation('account_refresh', provider);
  }

  async select(provider: string): Promise<AccountSnapshot> {
    const expected = input(provider, 'provider');
    const raw = await this.read('account_select', { provider: expected }, 'account_select');
    if (string(raw.selected_provider, 'account_select.selected_provider') !== expected) {
      throw new AccountManagementProtocolError('account_select returned another provider');
    }
    const account = decodeSnapshot(raw.account, 'account_select.account');
    if (account.id !== expected) {
      throw new AccountManagementProtocolError('account_select returned another account');
    }
    return account;
  }

  private async accountMutation(
    method: 'account_logout' | 'account_refresh',
    provider: string
  ): Promise<AccountSnapshot> {
    const expected = input(provider, 'provider');
    const raw = await this.read(method, { provider: expected }, method);
    if (!bool(raw.ok, `${method}.ok`)) {
      throw new AccountManagementProtocolError(`${method} failed`);
    }
    const account = decodeSnapshot(raw.account, `${method}.account`);
    if (account.id !== expected) {
      throw new AccountManagementProtocolError(`${method} returned another account`);
    }
    return account;
  }

  private async read<Method extends AccountMethod>(
    method: Method,
    params: RpcMethodMap[Method]['params'],
    label: string
  ): Promise<Record<string, unknown>> {
    const result = await this.rpc.request(method, params);
    assertRedacted(result, label);
    return record(result, label);
  }
}
