import type { ReactNode } from 'react';
import { createContext, useContext, useMemo } from 'react';

import { serverOrigin } from '@/renderer/services/ipc';
import type { AgentRuntimeConnection } from '@/shared/types';

export type UiConfig = {
  runtimeBaseUrl: string;
  url: URL;
  searchParams: URLSearchParams;
  token?: string;
  debug: boolean;
  minimal: boolean;
  session?: string;
  wsBaseUrl: string;
  wsRealtimeUrl: string;
  wsOrigin: string;
  httpBaseUrl: string;
  proxyPrefix: string | null;
  resolvePath: (path: string) => string;
};

const UiConfigContext = createContext<UiConfig | null>(null);

const getProxyPrefix = (pathname: string): string | null => {
  if (!pathname.startsWith('/proxy/')) {
    return null;
  }
  const parts = pathname.split('/').filter(Boolean); // ['proxy', <name>, ...]
  if (parts.length < 2) {
    return null;
  }
  // Local-tunnel paths (computer-as-sandbox) carry the machine + session id in
  // the prefix itself: `/proxy/local/<machineId>/<sessionId>/...`. The upstream
  // is served under all four segments and the cloud route is
  // `/proxy/local/:machineId/:sessionId/*`, so the prefix MUST include them —
  // otherwise `resolvePath('/ws')` collapses to `/proxy/local/ws`, which no
  // route matches. Every other proxy is the flat `/proxy/<name>/...` shape.
  if (parts[1] === 'local') {
    if (parts.length < 4) {
      return null;
    }
    return `/proxy/local/${parts[2]}/${parts[3]}`;
  }
  return `/proxy/${parts[1]}`;
};

const buildWsUrl = (url: URL, path: string): string => {
  const proto = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${url.host}${path}`;
};

export const resolveUiConfig = (connection: AgentRuntimeConnection): UiConfig => {
  // Anchor against the launcher's actual origin — same-origin in browser
  // server mode, cloud baseUrl in cloud-linked Electron. Downstream
  // (wsBaseUrl, wsRealtimeUrl, httpBaseUrl, proxyPrefix) all derive from
  // url.host, so fixing this seam cascades everywhere consumers like
  // rpc/client.ts, rpc/realtime.ts, TerminalPanel get URLs from us.
  const url = new URL(connection.baseUrl, serverOrigin());
  const searchParams = url.searchParams;
  // Launcher-owned runtimes pass credentials as typed process data. Keep
  // query-token parsing only for standalone/browser entry points that still
  // receive an authenticated UI handoff URL.
  const token = connection.authToken ?? searchParams.get('token') ?? undefined;
  const debug = /^(1|true|yes)$/i.test(String(searchParams.get('debug') || ''));
  const minimal = searchParams.get('minimal') === 'true';
  const session = searchParams.get('session') || undefined;
  const proxyPrefix = getProxyPrefix(url.pathname);
  const resolvePath = (path: string) => {
    if (!proxyPrefix || path.startsWith('/proxy/')) {
      return path;
    }
    return `${proxyPrefix}${path}`;
  };
  const httpBaseUrl = `${url.protocol}//${url.host}`;
  const wsOrigin = buildWsUrl(url, '');
  const wsBaseUrl = `${wsOrigin}${resolvePath('/ws')}`;
  const wsRealtimeUrl = `${wsOrigin}${resolvePath('/ws/realtime')}`;
  return {
    runtimeBaseUrl: connection.baseUrl,
    url,
    searchParams,
    token,
    debug,
    minimal,
    session,
    wsBaseUrl,
    wsRealtimeUrl,
    wsOrigin,
    httpBaseUrl,
    proxyPrefix,
    resolvePath,
  };
};

export const UiConfigProvider = ({
  connection,
  children,
}: {
  connection: AgentRuntimeConnection;
  children: ReactNode;
}) => {
  const value = useMemo<UiConfig>(() => resolveUiConfig(connection), [connection.authToken, connection.baseUrl]);

  return <UiConfigContext.Provider value={value}>{children}</UiConfigContext.Provider>;
};

export const useUiConfig = (): UiConfig => {
  const ctx = useContext(UiConfigContext);
  if (!ctx) {
    throw new Error('UiConfigProvider is missing');
  }
  return ctx;
};
