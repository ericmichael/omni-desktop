/**
 * WebSocket dial options for authenticating against an omniagents server
 * from Node (main process / server shell). The bearer token travels as an
 * `Authorization` upgrade header — never in the dial URL: the server
 * rejects query-string tokens by default (omniagents rpc/protocol.md,
 * Authentication).
 *
 * Returns a plain object assignable to Node `ws` `ClientOptions`.
 */
export const wsAuthOptions = (authToken?: string): { headers?: Record<string, string> } =>
  authToken ? { headers: { Authorization: `Bearer ${authToken}` } } : {};
