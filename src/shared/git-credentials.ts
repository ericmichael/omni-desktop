/**
 * Pure helpers for git credential resolution, shared by the renderer (inline
 * "needs auth" detection in the source editor + Settings) and the main/server
 * process (resolving which token to inject at clone time). Keeping the host
 * parse in one place guarantees the UI's match check and the runtime's lookup
 * never disagree.
 *
 * Credentials are host-scoped: a `git-remote` source authenticates with the
 * stored credential whose `host` equals the source URL's host. See the
 * [[GitCredential]] type in `types.ts`.
 */
import type { GitCredential } from '@/shared/types';

/**
 * Extract the bare host from a git remote URL. Handles HTTPS
 * (`https://github.com/owner/repo(.git)`) and SCP-style SSH
 * (`git@github.com:owner/repo.git`) forms. Returns the lowercased host with
 * any `user@` prefix and `:port` stripped, or `undefined` if unparseable.
 */
export function gitHostFromUrl(url: string): string | undefined {
  const cleaned = url.trim();
  if (!cleaned) {
    return undefined;
  }
  // HTTPS/HTTP form.
  if (/^https?:\/\//i.test(cleaned)) {
    try {
      return new URL(cleaned).hostname.toLowerCase() || undefined;
    } catch {
      return undefined;
    }
  }
  // SCP-style SSH: [user@]host:path
  const scp = /^(?:[^@/]+@)?([^/:]+):/.exec(cleaned);
  if (scp?.[1]) {
    return scp[1].toLowerCase();
  }
  return undefined;
}

/** True for SCP-style SSH remotes (`git@host:owner/repo`). These can't carry a
 *  token, and the runtime silently rewrites them to HTTPS, so the UI surfaces
 *  the downgrade rather than letting it fail opaquely at clone time. */
export function isSshRemote(url: string): boolean {
  const cleaned = url.trim();
  if (/^https?:\/\//i.test(cleaned)) {
    return false;
  }
  return /^(?:[^@/]+@)?[^/:]+:/.test(cleaned) || cleaned.startsWith('ssh://');
}

/** Find the stored credential that authenticates a given remote URL, by host. */
export function resolveCredentialForUrl(credentials: GitCredential[], url: string): GitCredential | undefined {
  const host = gitHostFromUrl(url);
  if (!host) {
    return undefined;
  }
  return credentials.find((c) => c.host.toLowerCase() === host);
}

/**
 * Conventional HTTPS basic-auth username for a host's token. GitHub PATs go in
 * the password field with `x-access-token` as the username; GitLab uses
 * `oauth2`. Everything else defaults to `git`, which the user can override.
 */
export function defaultUsernameForHost(host: string): string {
  const h = host.toLowerCase();
  if (h === 'github.com' || h.endsWith('.github.com') || h.includes('github')) {
    return 'x-access-token';
  }
  if (h.includes('gitlab')) {
    return 'oauth2';
  }
  if (h.includes('bitbucket')) {
    return 'x-token-auth';
  }
  // Azure DevOps PAT auth ignores the username (only the PAT, as password,
  // matters) but the basic-auth pair needs a non-empty user.
  if (h.includes('azure.com') || h.includes('visualstudio.com')) {
    return 'pat';
  }
  return 'git';
}

/** Last-4 display fragment for a token. Never expose more than this. */
export function tokenLast4(token: string): string {
  return token.slice(-4);
}

/**
 * Deterministic env-var name carrying a credential's token into the agent
 * process. Derived from the credential id (a UUID) so it's stable across
 * launches and matches `[A-Z0-9_]+`. The launcher passes this name to omni
 * serve in the source descriptor's `auth.tokenEnv`; the runtime reads the token
 * from `process.env[name]` — the value itself never travels on disk or argv.
 */
export function gitTokenEnvName(credentialId: string): string {
  return `OMNI_GIT_TOKEN_${credentialId.replace(/[^a-zA-Z0-9]/g, '').toUpperCase()}`;
}
