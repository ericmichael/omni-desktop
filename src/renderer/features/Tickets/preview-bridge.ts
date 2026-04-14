/**
 * Bridge between the client tool handler and the React UI for web preview.
 *
 * The handler calls `requestPreviewOpen()` which sets a nanostore atom.
 * The React side (CodeDeck) subscribes and opens the preview overlay.
 * Unlike the plan bridge, this does NOT block — the tool returns immediately.
 *
 * In browser/server mode, URLs are routed through the proxy so the browser
 * can reach localhost services on the server machine.
 */
import { atom } from 'nanostores';

const isElectron = typeof window !== 'undefined' && 'electron' in window;

/** Map from proxy name to upstream origin for reverse-mapping proxy URLs back to original URLs. */
const proxyToUpstream = new Map<string, string>();

/**
 * Convert a proxy URL (e.g. `/proxy/preview-default/search?q=foo`) back to
 * the original upstream URL (e.g. `https://www.google.com/search?q=foo`).
 * Returns the input unchanged if it's not a recognized proxy path.
 */
export function reverseProxyUrl(url: string): string {
  try {
    const parsed = new URL(url, window.location.origin);
    const pathMatch = parsed.pathname.match(/^\/proxy\/([^/]+)(\/.*)?$/);
    if (!pathMatch) {
return url;
}

    const proxyName = pathMatch[1] as string;
    const remainder = pathMatch[2] ?? '/';
    const upstream = proxyToUpstream.get(proxyName);
    if (!upstream) {
return url;
}

    return upstream + remainder + parsed.search + parsed.hash;
  } catch {
    return url;
  }
}

export type PreviewRequest = {
  id: string;
  url: string;
  /** Which code tab triggered this (so the overlay opens on the right column). */
  tabId?: string;
};

let nextId = 0;

/** Reactive atom — the most recent preview request, or null. */
export const $previewRequest = atom<PreviewRequest | null>(null);

/**
 * In browser mode, register the URL with the proxy and return the proxied path.
 * In Electron mode, return the URL as-is (webview can reach localhost directly).
 */
export async function resolvePreviewUrl(url: string, tabId?: string): Promise<string> {
  if (isElectron) {
return url;
}

  try {
    const proxyName = `preview-${tabId ?? 'default'}`;
    const res = await fetch('/proxy/_register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: proxyName, upstream: url }),
    });
    if (res.ok) {
      const data = (await res.json()) as { proxyPath?: string };
      if (data.proxyPath) {
        // Store the reverse mapping so we can convert proxy URLs back to upstream URLs
        try {
          const parsed = new URL(url);
          proxyToUpstream.set(proxyName, `${parsed.protocol}//${parsed.host}`);
        } catch { /* ignore */ }
        return data.proxyPath;
      }
    }
  } catch {
    // Fall through to raw URL
  }
  return url;
}

/** Called by the client tool handler. Returns immediately (proxy registration is async but non-blocking). */
export function requestPreviewOpen(url: string, tabId?: string): void {
  const id = `preview-${++nextId}`;
  // Fire and forget — resolve the proxy URL, then set the atom
  void resolvePreviewUrl(url, tabId).then((resolvedUrl) => {
    $previewRequest.set({ id, url: resolvedUrl, tabId });
  });
}

/** Called by the React UI after consuming the request. */
export function clearPreviewRequest(): void {
  $previewRequest.set(null);
}
