/**
 * Bearer-token → one-time connect ticket exchange for browser WebSocket
 * dials against an omniagents server.
 *
 * Browsers cannot set WebSocket upgrade headers, so the access token goes
 * over an authenticated HTTP POST to `/auth/ws-ticket` and only the
 * short-lived single-use ticket ever appears in a dial URL (`?ticket=`).
 * Access tokens themselves must never land in URLs — the server rejects
 * query-string tokens by default (omniagents rpc/protocol.md,
 * Authentication).
 *
 * Mirrors `omniagents/backends/web/ui/src/rpc/client.ts`, adapted for the
 * launcher's proxy-prefixed paths: the ws endpoint may live under
 * `/proxy/<name>/ws[...]`, so the ticket path is derived by rewriting the
 * trailing ws segment rather than resetting the whole pathname.
 */

/** Map a ws dial pathname (`/ws`, `/ws/realtime`, `/ws/terminal`, possibly
 *  under a `/proxy/<name>` prefix) to its server's ticket endpoint. */
export function ticketPathFor(wsPathname: string): string {
  return wsPathname.replace(/\/ws(?:\/(?:realtime|terminal))?$/, '/auth/ws-ticket');
}

/** Exchange a bearer token for a short-lived single-use connect ticket. */
export async function fetchWsTicket(wsUrl: string, token: string): Promise<string> {
  const httpUrl = new URL(wsUrl);
  httpUrl.protocol = httpUrl.protocol === 'wss:' ? 'https:' : 'http:';
  httpUrl.pathname = ticketPathFor(httpUrl.pathname);
  httpUrl.search = '';
  const res = await fetch(httpUrl.toString(), {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`Authentication failed (${res.status})`);
  }
  const body = (await res.json()) as { ticket?: string };
  if (!body.ticket) {
    throw new Error('Authentication failed (no ticket issued)');
  }
  return body.ticket;
}

/** Append a freshly minted connect ticket to a WebSocket URL when a token
 *  is configured; otherwise return the URL unchanged. */
export async function withConnectTicket(wsUrl: string, token?: string): Promise<string> {
  if (!token) {
    return wsUrl;
  }
  const ticket = await fetchWsTicket(wsUrl, token);
  const url = new URL(wsUrl);
  url.searchParams.set('ticket', ticket);
  return url.toString();
}
