/**
 * URL helpers for the browser surface. Kept pure and free of DOM/Electron
 * imports so it's shared by the renderer, the main-process BrowserManager,
 * and unit tests.
 */

export const BROWSER_START_URL = 'https://duckduckgo.com';
const DEFAULT_SEARCH = 'https://duckduckgo.com/?q=';

const SCHEME_PATTERNS = [/^https?:\/\//i, /^file:\/\//i, /^about:/i, /^view-source:/i, /^data:/i, /^blob:/i];

const LOCALHOST_PATTERN = /^localhost(:\d+)?(\/.*)?$/i;
const IPV4_PATTERN = /^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/.*)?$/;
const IPV6_BRACKETED_PATTERN = /^\[[0-9a-fA-F:]+\](:\d+)?(\/.*)?$/;
const HOST_PORT_PATTERN = /^[\w-]+(\.[\w-]+)*:\d+(\/.*)?$/;
const DOTTED_HOST_PATTERN = /^[\w-]+(\.[\w-]+)+(\/.*)?$/;

/**
 * Coerce a typed address into a loadable URL.
 *
 * Rules, in order:
 * - empty → {@link BROWSER_START_URL}
 * - already has a scheme (`http(s)://`, `file://`, `about:`, `view-source:`,
 *   `data:`, `blob:`) → pass through unchanged
 * - contains whitespace → search query
 * - `localhost[:port][/path]` → `http://…`
 * - IPv4 (optional port/path) → `http://…`
 * - bracketed IPv6 (`[::1]:port/path`) → `http://…`
 * - `host:port[/path]` → `http://…`
 * - dotted hostname (at least one `.`) → `https://…`
 * - anything else → search query
 */
export function normalizeAddress(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
return BROWSER_START_URL;
}

  if (SCHEME_PATTERNS.some((re) => re.test(trimmed))) {
return trimmed;
}

  // Any whitespace → query. Runs before host heuristics so "foo bar.com" is a
  // search, not an attempt at "bar.com".
  if (/\s/.test(trimmed)) {
return `${DEFAULT_SEARCH}${encodeURIComponent(trimmed)}`;
}

  if (LOCALHOST_PATTERN.test(trimmed)) {
return `http://${trimmed}`;
}
  if (IPV4_PATTERN.test(trimmed)) {
return `http://${trimmed}`;
}
  if (IPV6_BRACKETED_PATTERN.test(trimmed)) {
return `http://${trimmed}`;
}
  if (HOST_PORT_PATTERN.test(trimmed)) {
return `http://${trimmed}`;
}
  if (DOTTED_HOST_PATTERN.test(trimmed)) {
return `https://${trimmed}`;
}

  return `${DEFAULT_SEARCH}${encodeURIComponent(trimmed)}`;
}

/**
 * Best-effort hostname + scheme for UI badges (security lock, origin pill).
 * Returns null for invalid URLs or non-network schemes.
 */
export function parseOrigin(url: string): { scheme: string; host: string; secure: boolean } | null {
  try {
    const u = new URL(url);
    return {
      scheme: u.protocol.replace(/:$/, ''),
      host: u.host,
      secure: u.protocol === 'https:' || u.protocol === 'file:' || u.protocol === 'about:',
    };
  } catch {
    return null;
  }
}

/** Short, non-empty string derived from a URL for tab titles. */
export function fallbackTitle(url: string): string {
  const origin = parseOrigin(url);
  if (origin) {
return origin.host || url;
}
  return url;
}
