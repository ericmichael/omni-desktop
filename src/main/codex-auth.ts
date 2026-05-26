/**
 * ChatGPT (Codex) OAuth — the interactive half.
 *
 * The desktop app owns the browser PKCE flow (only it can open a browser and
 * bind the loopback callback). It writes the resulting tokens to
 * `codex.json` in the omni-code config dir; from there the runtime
 * (`omni_code.codex_auth`) reads them, refreshes them in place, and drives the
 * Codex Responses API. This module never refreshes — refresh is the runtime's
 * job (it can outlive the launcher).
 *
 * The flow mirrors openai/codex + opencode: PKCE S256 against
 * `auth.openai.com`, fixed loopback redirect on :1455.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';

import { getOmniConfigDir } from '@/main/util';

const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const ISSUER = 'https://auth.openai.com';
const OAUTH_PORT = 1455;
const REDIRECT_URI = `http://localhost:${OAUTH_PORT}/auth/callback`;
const CODEX_CRED_FILE = 'codex.json';

/** Stored token shape — matches `omni_code.codex_auth` exactly. */
export type CodexTokens = {
  refresh: string;
  access: string;
  /** ms epoch */
  expires: number;
  account_id?: string;
};

export type CodexStatus = { signedIn: boolean; accountId?: string };

function base64Url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function generatePkce(): { verifier: string; challenge: string } {
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

function parseJwtClaims(token: string): Record<string, unknown> | undefined {
  const payload = token.split('.')[1];
  if (!payload) {
    return undefined;
  }
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString());
  } catch {
    return undefined;
  }
}

/** Pull the ChatGPT account id from id/access token claims. */
function extractAccountId(tokens: { id_token?: string; access_token?: string }): string | undefined {
  const fromClaims = (claims: Record<string, unknown> | undefined): string | undefined => {
    if (!claims) {
      return undefined;
    }
    const authNs = claims['https://api.openai.com/auth'] as { chatgpt_account_id?: string } | undefined;
    const orgs = claims['organizations'] as Array<{ id?: string }> | undefined;
    return (
      (claims['chatgpt_account_id'] as string | undefined) ??
      authNs?.chatgpt_account_id ??
      orgs?.[0]?.id
    );
  };
  if (tokens.id_token) {
    const acct = fromClaims(parseJwtClaims(tokens.id_token));
    if (acct) {
      return acct;
    }
  }
  return tokens.access_token ? fromClaims(parseJwtClaims(tokens.access_token)) : undefined;
}

function tokenStorePath(): string {
  return join(getOmniConfigDir(), CODEX_CRED_FILE);
}

/** Persist tokens where the runtime reads them (owner-only). */
function saveTokens(tokens: CodexTokens): void {
  writeFileSync(tokenStorePath(), `${JSON.stringify(tokens, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
}

/** Current sign-in status, read from the shared token store. */
export function getStatus(): CodexStatus {
  const path = tokenStorePath();
  if (!existsSync(path)) {
    return { signedIn: false };
  }
  try {
    const tokens = JSON.parse(readFileSync(path, 'utf-8')) as CodexTokens;
    return { signedIn: Boolean(tokens.refresh), accountId: tokens.account_id };
  } catch {
    return { signedIn: false };
  }
}

/** Sign out by removing the stored tokens. */
export function logout(): void {
  rmSync(tokenStorePath(), { force: true });
}

const buildAuthorizeUrl = (challenge: string, state: string): string => {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: 'openid profile email offline_access',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
    state,
    originator: 'omni_code',
  });
  return `${ISSUER}/oauth/authorize?${params.toString()}`;
};

async function exchangeCode(code: string, verifier: string): Promise<CodexTokens> {
  const resp = await fetch(`${ISSUER}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      client_id: CLIENT_ID,
      code_verifier: verifier,
    }).toString(),
  });
  if (!resp.ok) {
    throw new Error(`Token exchange failed: ${resp.status}`);
  }
  const data = (await resp.json()) as {
    id_token?: string;
    access_token: string;
    refresh_token: string;
    expires_in?: number;
  };
  const tokens: CodexTokens = {
    refresh: data.refresh_token,
    access: data.access_token,
    expires: Date.now() + (data.expires_in ?? 3600) * 1000,
  };
  const accountId = extractAccountId(data);
  if (accountId) {
    tokens.account_id = accountId;
  }
  return tokens;
}

const SUCCESS_HTML =
  '<!doctype html><meta charset="utf-8"><title>Signed in</title>' +
  '<body style="font-family:system-ui;background:#131010;color:#f1ecec;display:flex;' +
  'align-items:center;justify-content:center;height:100vh;margin:0">' +
  '<div style="text-align:center"><h1>Signed in to ChatGPT</h1>' +
  '<p>You can close this window and return to Omni.</p></div>' +
  '<script>setTimeout(()=>window.close(),2000)</script>';

let activeServer: Server | undefined;

/**
 * Run the PKCE browser flow: open the consent page, wait for the loopback
 * callback, exchange the code, persist tokens. `openUrl` is injected (the
 * caller passes Electron's `shell.openExternal`) to keep this testable. The
 * returned promise resolves once tokens are stored. 5-minute timeout.
 */
export function loginWithBrowser(openUrl: (url: string) => void): Promise<CodexStatus> {
  // Only one flow at a time — tear down any stale server.
  activeServer?.close();
  activeServer = undefined;

  const { verifier, challenge } = generatePkce();
  const state = base64Url(randomBytes(32));

  return new Promise<CodexStatus>((resolve, reject) => {
    const timeout = setTimeout(
      () => {
        cleanup();
        reject(new Error('Codex authorization timed out'));
      },
      5 * 60 * 1000,
    );

    const cleanup = (): void => {
      clearTimeout(timeout);
      activeServer?.close();
      activeServer = undefined;
    };

    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://localhost:${OAUTH_PORT}`);
      if (url.pathname !== '/auth/callback') {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      const err = url.searchParams.get('error');
      const code = url.searchParams.get('code');
      const returnedState = url.searchParams.get('state');
      if (err || !code || returnedState !== state) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Authorization failed');
        cleanup();
        reject(new Error(err ?? (code ? 'State mismatch (possible CSRF)' : 'Missing authorization code')));
        return;
      }
      exchangeCode(code, verifier)
        .then((tokens) => {
          saveTokens(tokens);
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(SUCCESS_HTML);
          cleanup();
          resolve({ signedIn: true, accountId: tokens.account_id });
        })
        .catch((e: unknown) => {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('Token exchange failed');
          cleanup();
          reject(e instanceof Error ? e : new Error(String(e)));
        });
    });

    activeServer = server;
    server.on('error', (e) => {
      cleanup();
      reject(e);
    });
    server.listen(OAUTH_PORT, () => {
      openUrl(buildAuthorizeUrl(challenge, state));
    });
  });
}
