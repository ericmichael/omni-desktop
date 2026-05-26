/**
 * Azure DevOps repository discovery, authenticated by the user's stored
 * `dev.azure.com` Personal Access Token (PAT) — no OAuth: the credential is the
 * link. ADO HTTPS auth is basic with an empty username and the PAT as password.
 *
 * Org-scoped: `listRepos` lists every repo across one org's projects,
 * name-filtered. The org is supplied by the user (typed in the picker) rather
 * than auto-enumerated — enumeration needs broader PAT scopes than repo read
 * and fails for org-scoped PATs.
 */
import type { RemoteRepo } from '@/shared/types';

type FetchFn = typeof globalThis.fetch;

const API = 'api-version=7.1';

/** ADO basic auth: empty username, PAT as password. */
function authHeader(token: string): Record<string, string> {
  return { Authorization: `Basic ${Buffer.from(`:${token}`).toString('base64')}`, Accept: 'application/json' };
}

async function getJson<T>(fetchFn: FetchFn, url: string, token: string): Promise<T> {
  const resp = await fetchFn(url, { headers: authHeader(token) });
  if (!resp.ok) {
    throw new Error(`Azure DevOps request failed: ${resp.status}`);
  }
  return (await resp.json()) as T;
}

type RawAdoRepo = {
  name: string;
  remoteUrl: string;
  defaultBranch?: string;
  project?: { name?: string };
  isDisabled?: boolean;
};

/** Strip the `{org}@` userinfo ADO embeds in `remoteUrl` so host parsing and the
 *  credential helper key on the bare `dev.azure.com` host. */
function cleanCloneUrl(remoteUrl: string): string {
  try {
    const u = new URL(remoteUrl);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return remoteUrl;
  }
}

/**
 * Repos across an org's projects, name-filtered by `query` (case-insensitive
 * substring on `project/repo`). ADO returns the whole org list in one call;
 * we filter client-side here.
 */
export async function listRepos(fetchFn: FetchFn, token: string, org: string, query: string): Promise<RemoteRepo[]> {
  const data = await getJson<{ value: RawAdoRepo[] }>(
    fetchFn,
    `https://dev.azure.com/${encodeURIComponent(org)}/_apis/git/repositories?${API}`,
    token
  );
  const q = query.trim().toLowerCase();
  return data.value
    .filter((r) => !r.isDisabled)
    .map(
      (r): RemoteRepo => ({
        fullName: `${r.project?.name ?? org}/${r.name}`,
        cloneUrl: cleanCloneUrl(r.remoteUrl),
        defaultBranch: r.defaultBranch?.replace(/^refs\/heads\//, '') ?? 'main',
        private: true,
      })
    )
    .filter((r) => (q ? r.fullName.toLowerCase().includes(q) : true))
    .sort((a, b) => a.fullName.localeCompare(b.fullName));
}
