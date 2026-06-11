/**
 * Bridge between the client tool handler and the React UI for web preview.
 *
 * The handler calls `requestPreviewOpen()` which sets a nanostore atom.
 * The React side (CodeDeck) subscribes and opens the preview overlay.
 * Unlike the plan bridge, this does NOT block — the tool returns immediately.
 *
 * Preview requests always carry the canonical URL. Browser/server iframe
 * transport proxying is handled inside `<Webview>`.
 */
import { atom } from 'nanostores';

/** Legacy compatibility shim; preview URLs are now canonical before storage. */
export function reverseProxyUrl(url: string): string {
  return url;
}

export type PreviewRequest = {
  id: string;
  url: string;
  /** Which code tab triggered this (so the overlay opens on the right column). */
  tabId?: string;
};

let nextId = 0;
const latestRequestByTab = new Map<string, string>();

/** Reactive atom — the most recent preview request, or null. */
export const $previewRequest = atom<PreviewRequest | null>(null);

/**
 * Preview requests stay canonical. Browser/server mode resolves iframe
 * transport internally in `<Webview>` so tab state and PR badges never receive
 * `/proxy/...` paths.
 */
export async function resolvePreviewUrl(url: string, _tabId?: string): Promise<string> {
  return url;
}

/** Called by the client tool handler. Returns immediately (proxy registration is async but non-blocking). */
export function requestPreviewOpen(url: string, tabId?: string): void {
  const id = `preview-${++nextId}`;
  const key = tabId ?? 'default';
  latestRequestByTab.set(key, id);
  // Fire and forget — preserve the async shape used by callers.
  void resolvePreviewUrl(url, tabId).then((resolvedUrl) => {
    if (latestRequestByTab.get(key) !== id) {
      return;
    }
    $previewRequest.set({ id, url: resolvedUrl, tabId });
  });
}

/** Called by the React UI after consuming the request. */
export function clearPreviewRequest(): void {
  $previewRequest.set(null);
}
