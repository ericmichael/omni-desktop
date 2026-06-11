/**
 * GitHub account linking via the OAuth **device flow** — sanctioned GitHub
 * OAuth (no editor impersonation). Linking serves two purposes at once:
 *
 *   1. Auth — the resulting token is stored as the `github.com` credential
 *      (in the `SecretStore`), so private clone/push "just works" through the
 *      same clone-time injection path local PATs use.
 *   2. Discovery — the token lets the launcher list the user's repos so they
 *      pick a source from a list instead of pasting a URL.
 *
 * Device flow (vs the PKCE-loopback flow in `codex-auth.ts`) needs no client
 * secret and no loopback server — ideal for a desktop app. This module is pure
 * HTTP: the caller injects `fetchFn` and an `onCode` callback (to surface the
 * user code) and owns persistence. The launcher's public OAuth App client id is
 * bundled below; `OMNI_GITHUB_CLIENT_ID` overrides it for forks / GHES.
 *
 * GitHub Enterprise Server is supported via `OMNI_GITHUB_HOST` (defaults to
 * `github.com`); the web and API bases are derived from it.
 */
import type { GithubAccount, GithubDeviceCode, GithubOwner, GithubRepoQuery, RemoteRepo } from '@/shared/types';

// The launcher's GitHub OAuth App (device flow enabled). The client id is
// public — safe to bundle. `OMNI_GITHUB_CLIENT_ID` overrides it for forks or a
// GitHub Enterprise Server app.
const DEFAULT_CLIENT_ID = 'Ov23liJnyBm0kJoiTIia';
const CLIENT_ID = process.env.OMNI_GITHUB_CLIENT_ID || DEFAULT_CLIENT_ID;
const GITHUB_HOST = process.env.OMNI_GITHUB_HOST ?? 'github.com';
const SCOPE = 'repo read:org read:user';
const GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

/** Web base for the OAuth endpoints; API base for the REST calls. GHES nests
 *  its API under `/api/v3`, github.com uses the `api.` subdomain. */
function bases(host: string): { web: string; api: string } {
  if (host === 'github.com') {
    return { web: 'https://github.com', api: 'https://api.github.com' };
  }
  return { web: `https://${host}`, api: `https://${host}/api/v3` };
}

export type FetchFn = typeof globalThis.fetch;

type DeviceCodeResponse = {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
};

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => {
    setTimeout(r, ms);
  });

/** Request a device + user code pair to begin the flow. */
async function requestDeviceCode(fetchFn: FetchFn, web: string): Promise<DeviceCodeResponse> {
  const resp = await fetchFn(`${web}/login/device/code`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: CLIENT_ID, scope: SCOPE }),
  });
  if (!resp.ok) {
    throw new Error(`GitHub device code request failed: ${resp.status}`);
  }
  const data = (await resp.json()) as Partial<DeviceCodeResponse>;
  if (!data.device_code || !data.user_code || !data.verification_uri) {
    throw new Error('GitHub device code response missing required fields');
  }
  return {
    device_code: data.device_code,
    user_code: data.user_code,
    verification_uri: data.verification_uri,
    expires_in: data.expires_in ?? 900,
    interval: data.interval ?? 5,
  };
}

/** Poll the token endpoint until the user authorizes (or the code expires). */
async function pollForToken(fetchFn: FetchFn, web: string, device: DeviceCodeResponse): Promise<string> {
  const deadline = Date.now() + device.expires_in * 1000;
  let intervalMs = device.interval * 1000;
  while (Date.now() < deadline) {
    await sleep(intervalMs);
    const resp = await fetchFn(`${web}/login/oauth/access_token`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: CLIENT_ID, device_code: device.device_code, grant_type: GRANT_TYPE }),
    });
    const data = (await resp.json()) as { access_token?: string; error?: string };
    if (data.access_token) {
      return data.access_token;
    }
    switch (data.error) {
      case 'authorization_pending':
        break; // keep polling at the current interval
      case 'slow_down':
        intervalMs += 5000; // GitHub asks us to back off
        break;
      case 'expired_token':
        throw new Error('GitHub authorization expired — please try again');
      case 'access_denied':
        throw new Error('GitHub authorization was denied');
      default:
        if (data.error) {
          throw new Error(`GitHub authorization failed: ${data.error}`);
        }
    }
  }
  throw new Error('Timed out waiting for GitHub authorization');
}

/** Read the granted scopes from a token response's `X-OAuth-Scopes` header. */
function parseScopes(header: string | null): string[] | undefined {
  if (!header) {
    return undefined;
  }
  const scopes = header
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return scopes.length > 0 ? scopes : undefined;
}

/** Fetch the authenticated user's profile (and granted scopes). */
async function fetchAccount(fetchFn: FetchFn, api: string, token: string): Promise<GithubAccount> {
  const resp = await fetchFn(`${api}/user`, {
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) {
    throw new Error(`GitHub user lookup failed: ${resp.status}`);
  }
  const data = (await resp.json()) as { login: string; avatar_url?: string };
  return {
    login: data.login,
    ...(data.avatar_url ? { avatarUrl: data.avatar_url } : {}),
    ...(parseScopes(resp.headers.get('x-oauth-scopes'))
      ? { scopes: parseScopes(resp.headers.get('x-oauth-scopes')) }
      : {}),
    host: GITHUB_HOST,
    connectedAt: Date.now(),
  };
}

/**
 * Run the full device flow: request a code, surface it via `onCode` (and open
 * the verification page), poll until authorized, then resolve the token +
 * account profile. The caller persists the token and metadata.
 */
export async function linkWithDeviceFlow(opts: {
  fetchFn: FetchFn;
  /** Open the verification page in the user's browser. */
  openUrl: (url: string) => void;
  /** Surface the user code + verification URI so the UI can display them. */
  onCode: (code: GithubDeviceCode) => void;
}): Promise<{ token: string; account: GithubAccount }> {
  const { web, api } = bases(GITHUB_HOST);
  const device = await requestDeviceCode(opts.fetchFn, web);
  opts.onCode({ userCode: device.user_code, verificationUri: device.verification_uri, expiresIn: device.expires_in });
  opts.openUrl(device.verification_uri);
  const token = await pollForToken(opts.fetchFn, web, device);
  const account = await fetchAccount(opts.fetchFn, api, token);
  return { token, account };
}

type RawRepo = {
  full_name: string;
  clone_url: string;
  default_branch: string;
  private: boolean;
  pushed_at?: string;
};

function mapRepo(r: RawRepo): RemoteRepo {
  return {
    fullName: r.full_name,
    cloneUrl: r.clone_url,
    defaultBranch: r.default_branch,
    private: r.private,
    ...(r.pushed_at ? { pushedAt: Date.parse(r.pushed_at) } : {}),
  };
}

const ghHeaders = (token: string): Record<string, string> => ({
  Accept: 'application/vnd.github+json',
  Authorization: `Bearer ${token}`,
});

/** List the orgs the linked account belongs to (for the picker's owner scope). */
export async function listOrgs(fetchFn: FetchFn, token: string): Promise<GithubOwner[]> {
  const { api } = bases(GITHUB_HOST);
  const resp = await fetchFn(`${api}/user/orgs?per_page=100`, { headers: ghHeaders(token) });
  if (!resp.ok) {
    throw new Error(`GitHub org listing failed: ${resp.status}`);
  }
  const orgs = (await resp.json()) as Array<{ login: string; avatar_url?: string }>;
  return orgs.map((o) => ({
    login: o.login,
    kind: 'org' as const,
    ...(o.avatar_url ? { avatarUrl: o.avatar_url } : {}),
  }));
}

/**
 * Find repositories within a single owner. Server-side — never enumerates the
 * owner's full repo set — so it scales to orgs with thousands of repos:
 *
 *   - With a query: GitHub's repo search, scoped by `org:`/`user:` qualifier.
 *   - Empty query: the owner's most-recently-pushed repos (first page).
 *
 * Returns at most ~30 results; the user narrows with the query, not by paging.
 */
export async function searchRepos(fetchFn: FetchFn, token: string, q: GithubRepoQuery): Promise<RemoteRepo[]> {
  const { api } = bases(GITHUB_HOST);
  const query = q.query.trim();
  let url: string;
  if (query) {
    const qualifier = q.kind === 'org' ? `org:${q.owner}` : `user:${q.owner}`;
    const search = encodeURIComponent(`${query} ${qualifier} fork:true`);
    url = `${api}/search/repositories?q=${search}&sort=updated&per_page=30`;
  } else if (q.kind === 'org') {
    url = `${api}/orgs/${encodeURIComponent(q.owner)}/repos?sort=pushed&per_page=30`;
  } else {
    url = `${api}/user/repos?affiliation=owner&sort=pushed&per_page=30`;
  }
  const resp = await fetchFn(url, { headers: ghHeaders(token) });
  if (!resp.ok) {
    throw new Error(`GitHub repo search failed: ${resp.status}`);
  }
  const json = (await resp.json()) as RawRepo[] | { items?: RawRepo[] };
  // Search returns `{ items }`; the list endpoints return a bare array.
  const items = Array.isArray(json) ? json : (json.items ?? []);
  return items.map(mapRepo);
}
