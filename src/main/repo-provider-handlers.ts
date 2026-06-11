import { listRepos as azureListRepos } from '@/main/azure-repos';
import {
  linkWithDeviceFlow as githubLink,
  listOrgs as githubListOrgs,
  searchRepos as githubSearchRepos,
} from '@/main/github-auth';
import { tokenLast4 } from '@/shared/git-credentials';
import type { IIpcListener } from '@/shared/ipc-listener';
import type { SecretStore } from '@/shared/secret-store';
import type {
  GitCredential,
  GithubOwner,
  GithubRepoQuery,
  GithubStatus,
  IpcRendererEvents,
  RemoteRepo,
  StoreData,
} from '@/shared/types';

/* eslint-disable @typescript-eslint/no-explicit-any */

const GITHUB_CRED_ID = 'github-oauth';
const AZURE_HOST = 'dev.azure.com';

type StoreLike = {
  get<K extends keyof StoreData>(key: K): StoreData[K] | undefined;
  set<K extends keyof StoreData>(key: K, value: StoreData[K]): void;
  delete(key: keyof StoreData): void;
};

type ContextDeps = {
  store: StoreLike;
  secretStore: SecretStore;
  broadcastStore: () => void;
  sendToWindow: (channel: 'github:device-code', ...args: IpcRendererEvents['github:device-code']) => void;
};

type ProviderHandlerDeps = {
  fetchFn: typeof globalThis.fetch;
  openUrl: (url: string) => void;
  resolve: (event: unknown) => ContextDeps;
};

const githubStatus = (store: StoreLike): GithubStatus => {
  const account = store.get('githubAccount');
  return account ? { connected: true, account } : { connected: false };
};

const requireGithubToken = async (secretStore: SecretStore): Promise<string> => {
  const token = await secretStore.getGitToken(GITHUB_CRED_ID);
  if (!token) {
    throw new Error('No GitHub account linked');
  }
  return token;
};

const requireAzureToken = async (store: StoreLike, secretStore: SecretStore): Promise<string> => {
  const cred = (store.get('gitCredentials') ?? []).find((c) => c.host === AZURE_HOST);
  const token = cred ? await secretStore.getGitToken(cred.id) : undefined;
  if (!token) {
    throw new Error('No Azure DevOps token — add a dev.azure.com credential first');
  }
  return token;
};

export function registerRepoProviderHandlers(ipc: IIpcListener, deps: ProviderHandlerDeps): string[] {
  const channels: string[] = [];
  const h = (channel: string, handler: (event: unknown, ...args: any[]) => unknown): void => {
    ipc.handle(channel, handler);
    channels.push(channel);
  };

  h('github:status', (event) => {
    const { store } = deps.resolve(event);
    return githubStatus(store);
  });

  h('github:link', async (event) => {
    const { store, secretStore, broadcastStore, sendToWindow } = deps.resolve(event);
    const { token, account } = await githubLink({
      fetchFn: deps.fetchFn,
      openUrl: deps.openUrl,
      onCode: (code) => sendToWindow('github:device-code', code),
    });
    await secretStore.setGitToken(GITHUB_CRED_ID, token);
    const creds = (store.get('gitCredentials') ?? []).filter((c) => c.id !== GITHUB_CRED_ID && c.host !== account.host);
    const cred: GitCredential = {
      id: GITHUB_CRED_ID,
      host: account.host,
      username: 'x-access-token',
      last4: tokenLast4(token),
      label: `@${account.login} (GitHub)`,
      createdAt: Date.now(),
    };
    store.set('gitCredentials', [...creds, cred]);
    store.set('githubAccount', account);
    broadcastStore();
    return githubStatus(store);
  });

  h('github:unlink', async (event) => {
    const { store, secretStore, broadcastStore } = deps.resolve(event);
    await secretStore.deleteGitToken(GITHUB_CRED_ID);
    store.set(
      'gitCredentials',
      (store.get('gitCredentials') ?? []).filter((c) => c.id !== GITHUB_CRED_ID)
    );
    store.delete('githubAccount');
    broadcastStore();
  });

  h('github:list-owners', async (event): Promise<GithubOwner[]> => {
    const { store, secretStore } = deps.resolve(event);
    const token = await requireGithubToken(secretStore);
    const account = store.get('githubAccount');
    const self: GithubOwner[] = account
      ? [{ login: account.login, kind: 'user', ...(account.avatarUrl ? { avatarUrl: account.avatarUrl } : {}) }]
      : [];
    return [...self, ...(await githubListOrgs(deps.fetchFn, token))];
  });

  h('github:search-repos', async (event, query: GithubRepoQuery): Promise<RemoteRepo[]> => {
    const { secretStore } = deps.resolve(event);
    return githubSearchRepos(deps.fetchFn, await requireGithubToken(secretStore), query);
  });

  h('azure:list-repos', async (event, input: { org: string; query: string }): Promise<RemoteRepo[]> => {
    const { store, secretStore } = deps.resolve(event);
    return azureListRepos(deps.fetchFn, await requireAzureToken(store, secretStore), input.org, input.query);
  });

  return channels;
}
