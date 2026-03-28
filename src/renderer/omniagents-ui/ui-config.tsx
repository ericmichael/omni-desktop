import type { ReactNode } from 'react';
import { createContext, useContext, useMemo } from 'react';

type UiConfig = {
  uiUrl: string;
  url: URL;
  searchParams: URLSearchParams;
  token?: string;
  theme?: string;
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
  const parts = pathname.split('/').filter(Boolean);
  if (parts.length < 2) {
    return null;
  }
  return `/proxy/${parts[1]}`;
};

const buildWsUrl = (url: URL, path: string): string => {
  const proto = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${url.host}${path}`;
};

export const UiConfigProvider = ({ uiUrl, children }: { uiUrl: string; children: ReactNode }) => {
  const value = useMemo<UiConfig>(() => {
    const url = new URL(uiUrl, window.location.origin);
    const searchParams = url.searchParams;
    const token = searchParams.get('token') || undefined;
    const theme = searchParams.get('theme') || undefined;
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
      uiUrl,
      url,
      searchParams,
      token,
      theme,
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
  }, [uiUrl]);

  return <UiConfigContext.Provider value={value}>{children}</UiConfigContext.Provider>;
};

export const useUiConfig = (): UiConfig => {
  const ctx = useContext(UiConfigContext);
  if (!ctx) {
    throw new Error('UiConfigProvider is missing');
  }
  return ctx;
};
