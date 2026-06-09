export type WebviewLoadError = {
  code: number;
  description: string;
  url: string;
  transportUrl?: string;
};

export type WebviewFallbackDiagnostics = {
  title: string;
  reason: string;
  canonicalUrl: string;
  displayUrl: string;
  transportUrl?: string;
  instructions: string;
  debugDescription?: string;
};

const SENSITIVE_QUERY_KEYS =
  /(?:^|_)(?:access_token|auth|authorization|code|credential|id_token|key|password|secret|session|sig|signature|token)(?:_|$)/i;

const normalizeUrlForParsing = (url: string): URL | null => {
  try {
    return new URL(url, typeof window !== 'undefined' ? window.location.origin : 'http://localhost');
  } catch {
    return null;
  }
};

export const isProxyTransportUrl = (url: string): boolean => {
  const parsed = normalizeUrlForParsing(url);
  return Boolean(parsed?.pathname.startsWith('/proxy/'));
};

export const redactUrlForDiagnostics = (url: string): string => {
  const parsed = normalizeUrlForParsing(url);
  if (!parsed) {
    return url;
  }

  let changed = false;
  for (const key of Array.from(parsed.searchParams.keys())) {
    if (SENSITIVE_QUERY_KEYS.test(key)) {
      parsed.searchParams.set(key, '[redacted]');
      changed = true;
    }
  }

  if (
    /access_token|auth|authorization|code|credential|id_token|key|password|secret|session|sig|signature|token/i.test(
      parsed.hash
    )
  ) {
    parsed.hash = '#[redacted]';
    changed = true;
  }

  if (!changed) {
    return url;
  }

  if (/^[a-z][a-z\d+.-]*:/i.test(url)) {
    return parsed.href;
  }
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
};

const normalizeDescription = (description: string): string => description.toLowerCase();

export const getWebviewFallbackDiagnostics = (
  error: WebviewLoadError,
  fallbackUrl: string
): WebviewFallbackDiagnostics => {
  const rawUrl = error.url || fallbackUrl;
  const transportUrl = error.transportUrl || (isProxyTransportUrl(rawUrl) ? rawUrl : undefined);
  const canonicalUrl = transportUrl && rawUrl === transportUrl ? fallbackUrl : rawUrl;
  const hasDisplayableCanonicalUrl = Boolean(canonicalUrl && !isProxyTransportUrl(canonicalUrl));
  const description = error.description || '';
  const lowerDescription = normalizeDescription(description);
  const status = error.code;

  let title = 'This page didn’t load';
  let reason = 'The embedded browser could not load this page through Omni.';

  if (status === 401 || status === 403 || /forbidden|unauthorized|not allowed|trusted network/.test(lowerDescription)) {
    title = 'Proxy registration was blocked';
    reason = 'Omni was not allowed to register this site with the browser/server proxy.';
  } else if (
    status === 400 ||
    status === 422 ||
    /denied|invalid upstream|expected http\(s\)|private network|link-local|metadata|ssrf/.test(lowerDescription)
  ) {
    title = 'This address cannot be proxied';
    reason = 'Omni only proxies allowed http(s) sites and blocked this upstream.';
  } else if (
    /dns|enotfound|getaddrinfo|name_not_resolved|err_name_not_resolved/.test(lowerDescription) ||
    status === -105
  ) {
    title = 'DNS lookup failed';
    reason = 'The proxy could not resolve the site’s hostname.';
  } else if (
    /tls|ssl|certificate|cert_|err_cert|err_ssl/.test(lowerDescription) ||
    (status <= -200 && status >= -299)
  ) {
    title = 'Secure connection failed';
    reason = 'The proxy could not establish a trusted TLS connection to this site.';
  } else if (/timeout|timed out|etimedout|err_timed_out/.test(lowerDescription) || status === -7 || status === -118) {
    title = 'The site took too long to respond';
    reason = 'The proxy timed out while waiting for the page.';
  } else if (/redirect loop|too many redirects|err_too_many_redirects/.test(lowerDescription) || status === -310) {
    title = 'Redirect loop detected';
    reason = 'The page redirected too many times before Omni could embed it.';
  } else if (/unsupported|service worker|webauthn|passkey|drm|protected media|browser feature/.test(lowerDescription)) {
    title = 'Browser feature not supported here';
    reason = 'This page needs a browser feature that the server-mode embedded browser does not support.';
  } else if (
    /proxy request failed|bad gateway|no upstream/.test(lowerDescription) ||
    status === 502 ||
    status === 503 ||
    status === 504
  ) {
    title = 'The proxy could not reach this site';
    reason = 'Omni’s browser/server proxy failed while contacting the upstream page.';
  } else if (/proxy registration failed|registration response/.test(lowerDescription)) {
    title = 'Proxy registration failed';
    reason = 'Omni could not prepare this site for embedding in browser/server mode.';
  }

  return {
    title,
    reason,
    canonicalUrl,
    displayUrl: hasDisplayableCanonicalUrl ? redactUrlForDiagnostics(canonicalUrl) : 'Original page URL unavailable',
    ...(transportUrl && transportUrl !== canonicalUrl ? { transportUrl: redactUrlForDiagnostics(transportUrl) } : {}),
    instructions:
      'Open the URL in a regular browser tab, or copy it and paste it into your browser if embedding keeps failing.',
    ...(description ? { debugDescription: description } : {}),
  };
};

export const openInBrowserTab = (url: string): void => {
  const opened = window.open(url, '_blank', 'noopener,noreferrer');
  if (opened) {
    opened.opener = null;
  }
};
