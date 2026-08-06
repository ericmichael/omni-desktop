/**
 * Local-Electron migration from Desktop-owned `codex.json` mutations to the
 * canonical Omniagents account RPCs.
 *
 * The legacy and canonical implementations intentionally point at the same
 * product config file during migration. Ownership is recorded only after the
 * runtime proves both that it sees equivalent account state and that its Codex
 * OAuth store is durable at host scope. No credential bytes are copied or
 * deleted by the migration itself.
 */
import type { RpcMethodMap } from '@/generated/omniagents-gui-v1/gui-v1';
import type { ManagementAdminRequest } from '@/shared/management-admin';
import type { CodexAuthStatus, CodexDeviceCode } from '@/shared/types';

const CHATGPT_PROVIDER_ID = 'openai-chatgpt';
const OWNERSHIP = 'omniagents' as const;
const DEFAULT_LOGIN_TIMEOUT_MS = 15 * 60_000;

export const durableLocalCodexAgentHostEnv = (env: Record<string, string>): Record<string, string> => ({
  ...env,
  // Always override a user-authored value. This is a trusted topology claim,
  // not a configurable runtime preference.
  OMNIAGENTS_CODEX_STORE_DURABILITY: 'host',
});

type AccountStatusResult = RpcMethodMap['account_status']['result'];

export type LocalCodexOwnershipStore = {
  get(key: 'codexAccountOwnership'): 'omniagents' | undefined;
  set(key: 'codexAccountOwnership', value: 'omniagents'): void;
};

export type LocalCodexAccountRuntime = {
  status(): Promise<AccountStatusResult>;
  mutate(request: ManagementAdminRequest): Promise<unknown>;
};

export type LegacyCodexAccount = {
  status(): CodexAuthStatus;
  link(onCode: (code: CodexDeviceCode) => void): Promise<CodexAuthStatus>;
  login(): Promise<CodexAuthStatus>;
  logout(): void;
};

type CanonicalAccount = CodexAuthStatus & {
  durableHostMutation: boolean;
};

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

/** Parse only the redacted fields needed by the legacy IPC compatibility API. */
export const parseCanonicalCodexAccount = (value: unknown): CanonicalAccount | undefined => {
  const root = record(value);
  const providers = root?.['providers'];
  if (!Array.isArray(providers)) {
    return undefined;
  }
  const provider = providers.map(record).find((candidate) => candidate?.['id'] === CHATGPT_PROVIDER_ID);
  if (!provider) {
    return undefined;
  }

  const state = provider['state'];
  if (state !== 'signed_in' && state !== 'signed_out' && state !== 'error') {
    return undefined;
  }
  const identity = record(provider['identity']);
  const accountId = typeof identity?.['account_id'] === 'string' ? identity['account_id'] : undefined;
  const persistence = record(root?.['mutation_persistence']);
  const codexPersistence = record(persistence?.['codex_oauth']);
  const durableHostMutation = codexPersistence?.['durable'] === true && codexPersistence['scope'] === 'host';

  return {
    signedIn: state === 'signed_in' || state === 'error',
    ...(accountId ? { accountId } : {}),
    ...(state === 'error' ? { broken: true } : {}),
    durableHostMutation,
  };
};

/** Runtime half of the durable-mutation gate. ProcessManager combines this
 * attestation with its trusted Electron-only topology flag. */
export const hasDurableHostCodexMutation = (value: unknown): boolean =>
  parseCanonicalCodexAccount(value)?.durableHostMutation === true;

/** This migration owns only Codex OAuth credentials. API-key accounts and
 * provider selection require a separate durability contract. */
export const isDurableCodexAccountRequest = (request: ManagementAdminRequest): boolean => {
  switch (request.method) {
    case 'account_login_start':
      return (
        request.params.provider === CHATGPT_PROVIDER_ID &&
        (request.params.mode === 'device_code' || request.params.mode === 'browser')
      );
    case 'account_login_complete':
    case 'account_login_cancel':
      return true;
    case 'account_logout':
    case 'account_refresh':
      return request.params.provider === CHATGPT_PROVIDER_ID;
    case 'account_select':
      return false;
    default:
      return false;
  }
};

export const equivalentCodexAccount = (legacy: CodexAuthStatus, canonical: CodexAuthStatus): boolean => {
  if (legacy.signedIn !== canonical.signedIn) {
    return false;
  }
  if (legacy.accountId && canonical.accountId && legacy.accountId !== canonical.accountId) {
    return false;
  }
  return true;
};

type LocalCodexAccountOwnerOptions = {
  store: LocalCodexOwnershipStore;
  runtime: LocalCodexAccountRuntime;
  legacy: LegacyCodexAccount;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  loginTimeoutMs?: number;
};

/**
 * Preserves the old IPC contract while moving its durable mutations behind the
 * framework-owned account service. This class is wired only by Electron main;
 * server/multi-user managers keep their per-principal secret stores.
 */
export class LocalCodexAccountOwner {
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly loginTimeoutMs: number;

  constructor(private readonly options: LocalCodexAccountOwnerOptions) {
    this.sleep =
      options.sleep ??
      ((ms) =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, ms);
        }));
    this.now = options.now ?? Date.now;
    this.loginTimeoutMs = options.loginTimeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS;
  }

  private isOwned(): boolean {
    return this.options.store.get('codexAccountOwnership') === OWNERSHIP;
  }

  /**
   * Return canonical state only when mutations are durably host-backed. Before
   * ownership, also require parity with the legacy file view. Any failure leaves
   * the migration marker absent.
   */
  private async requireCanonicalOwnership(): Promise<CanonicalAccount> {
    const canonical = parseCanonicalCodexAccount(await this.options.runtime.status());
    if (!canonical) {
      throw new Error('Omniagents returned an invalid ChatGPT account status');
    }
    if (!canonical.durableHostMutation) {
      throw new Error('Omniagents does not report durable host-scoped ChatGPT account mutations');
    }
    if (!this.isOwned()) {
      const legacy = this.options.legacy.status();
      if (!equivalentCodexAccount(legacy, canonical)) {
        throw new Error('Desktop and Omniagents disagree about the current ChatGPT account');
      }
      this.options.store.set('codexAccountOwnership', OWNERSHIP);
    }
    return canonical;
  }

  async status(): Promise<CodexAuthStatus> {
    try {
      const canonical = await this.requireCanonicalOwnership();
      const { durableHostMutation: _durableHostMutation, ...status } = canonical;
      return status;
    } catch {
      // Status is a read. Keeping the legacy file view available cannot create
      // split ownership and prevents a transient runtime failure from making a
      // signed-in user appear logged out during migration.
      return this.options.legacy.status();
    }
  }

  async link(onCode: (code: CodexDeviceCode) => void): Promise<CodexAuthStatus> {
    const ownedBeforeAttempt = this.isOwned();
    try {
      await this.requireCanonicalOwnership();
      const started = record(
        await this.options.runtime.mutate({
          method: 'account_login_start',
          params: { provider: CHATGPT_PROVIDER_ID, mode: 'device_code' },
        })
      );
      if (!started) {
        throw new Error('Omniagents returned an invalid ChatGPT login response');
      }
      if (started['state'] === 'completed') {
        return this.status();
      }
      const loginId = typeof started['login_id'] === 'string' ? started['login_id'] : undefined;
      const userCode = typeof started['user_code'] === 'string' ? started['user_code'] : undefined;
      const verificationUri = typeof started['verification_url'] === 'string' ? started['verification_url'] : undefined;
      if (!loginId || !userCode || !verificationUri) {
        throw new Error('Omniagents returned an incomplete ChatGPT device-code response');
      }
      onCode({ userCode, verificationUri });

      const intervalMs = Math.max(Number(started['interval'] ?? 5), 1) * 1000;
      const deadline = this.now() + this.loginTimeoutMs;
      while (this.now() < deadline) {
        await this.sleep(intervalMs);
        const completed = record(
          await this.options.runtime.mutate({
            method: 'account_login_complete',
            params: { login_id: loginId },
          })
        );
        if (completed?.['state'] === 'completed') {
          return this.status();
        }
        if (completed?.['state'] !== 'pending') {
          throw new Error('Omniagents returned an invalid ChatGPT login completion response');
        }
      }
      await this.options.runtime
        .mutate({ method: 'account_login_cancel', params: { login_id: loginId } })
        .catch(() => undefined);
      throw new Error('ChatGPT device authorization timed out');
    } catch (error) {
      if (!ownedBeforeAttempt && !this.isOwned()) {
        return this.options.legacy.link(onCode);
      }
      throw error;
    }
  }

  async logout(): Promise<void> {
    const ownedBeforeAttempt = this.isOwned();
    try {
      await this.requireCanonicalOwnership();
      await this.options.runtime.mutate({
        method: 'account_logout',
        params: { provider: CHATGPT_PROVIDER_ID },
      });
    } catch (error) {
      if (!ownedBeforeAttempt && !this.isOwned()) {
        this.options.legacy.logout();
        return;
      }
      throw error;
    }
  }

  /**
   * Browser PKCE remains legacy only during migration. The renderer uses the
   * device-code `link` path; once ownership transfers, this unused compatibility
   * entry fails closed rather than restoring a Desktop writer.
   */
  async login(): Promise<CodexAuthStatus> {
    if (this.isOwned()) {
      throw new Error('Browser ChatGPT login is unavailable after Omniagents takes account ownership; use link');
    }
    return this.options.legacy.login();
  }
}
