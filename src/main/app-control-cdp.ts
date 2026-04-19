/**
 * CDP (Chrome DevTools Protocol) helpers for driving a WebContents.
 *
 * We attach `wc.debugger` once per webContents and cache ref → backendNodeId
 * mappings per snapshot. Input events (click, type, press) use native
 * `webContents.sendInputEvent` where possible — it's simpler than CDP Input
 * and works reliably for guest WebContents inside `<webview>`.
 *
 * Snapshot uses `Accessibility.getFullAXTree`. We prune nodes that have no
 * role or no useful content so the returned tree is actionable instead of
 * overwhelming — mirroring how Playwright-CLI emits snapshots.
 */
import type { WebContents } from 'electron';

import type { AxNode } from '@/shared/app-control-types';

const CDP_VERSION = '1.3';

/**
 * Per-webContents state:
 *  - attachment bookkeeping
 *  - ref → backendNodeId map from the most recent snapshot
 *  - optional network log ring buffer (enabled on first agent query)
 *  - optional cached previous snapshot tree for diffs
 */
export type NetworkLogEntry = {
  requestId: string;
  method: string;
  url: string;
  status?: number;
  statusText?: string;
  mimeType?: string;
  errorText?: string;
  /** DOMHighResTimestamp-ish seconds from CDP `timestamp`. */
  startedAt: number;
  endedAt?: number;
  encodedDataLength?: number;
  fromCache?: boolean;
  resourceType?: string;
};

type AttachmentState = {
  attached: boolean;
  refToBackendNodeId: Map<string, number>;
  lastSnapshotTree?: import('@/shared/app-control-types').AxNode;
  network?: {
    enabled: boolean;
    entries: NetworkLogEntry[];
    pending: Map<string, NetworkLogEntry>;
    listener?: (event: unknown, method: string, params: unknown) => void;
  };
};

const state = new WeakMap<WebContents, AttachmentState>();

function getState(wc: WebContents): AttachmentState {
  let s = state.get(wc);
  if (!s) {
    s = { attached: false, refToBackendNodeId: new Map() };
    state.set(wc, s);
  }
  return s;
}

/** Expose the backendNodeId map to callers that persist their own diff state. */
export function getInternalState(wc: WebContents): AttachmentState {
  return getState(wc);
}

/**
 * Attach the debugger to a WebContents exactly once. Safe to call repeatedly.
 * Throws if another client already holds the debugger (e.g. user opened
 * DevTools on that webview) — caller should surface that as a clear error.
 */
export function ensureAttached(wc: WebContents): void {
  const s = getState(wc);
  if (s.attached) {
    return;
  }
  try {
    wc.debugger.attach(CDP_VERSION);
    s.attached = true;
    wc.once('destroyed', () => {
      s.attached = false;
      s.refToBackendNodeId.clear();
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Could not attach debugger to webview — another client may be connected (e.g. DevTools). Underlying: ${msg}`
    );
  }
}

/** Thin wrapper that normalises `debugger.sendCommand` into a typed Promise. */
async function send<T = unknown>(wc: WebContents, method: string, params?: Record<string, unknown>): Promise<T> {
  ensureAttached(wc);
  return (await wc.debugger.sendCommand(method, params)) as T;
}

// ---------------------------------------------------------------------------
// Snapshot: AX tree → trimmed, ref-tagged `AxNode` tree
// ---------------------------------------------------------------------------

type AxValue = { value?: unknown } | undefined;
type RawAxNode = {
  nodeId: string;
  parentId?: string;
  backendDOMNodeId?: number;
  role?: AxValue;
  name?: AxValue;
  value?: AxValue;
  ignored?: boolean;
  childIds?: string[];
};

type GetFullAXTreeResult = { nodes: RawAxNode[] };

/** Unwrap `{ value: x }` AX property shape. */
function unwrap(v: AxValue): string | undefined {
  if (!v || v.value === undefined || v.value === null) {
    return undefined;
  }
  return String(v.value);
}

/**
 * Walk the AX tree and produce a Playwright-flavoured serialisable tree with
 * stable refs. Also populates the ref → backendNodeId map so subsequent
 * actions can resolve the node.
 *
 * Ignored-by-accessibility nodes are pruned unless they have interesting
 * children; this keeps the snapshot scan-friendly without losing structure.
 */
export async function snapshot(wc: WebContents): Promise<AxNode> {
  const s = getState(wc);
  s.refToBackendNodeId.clear();

  const { nodes } = await send<GetFullAXTreeResult>(wc, 'Accessibility.getFullAXTree');
  const byId = new Map<string, RawAxNode>();
  for (const n of nodes) {
    byId.set(n.nodeId, n);
  }
  const root = nodes.find((n) => !n.parentId) ?? nodes[0];
  if (!root) {
    return { ref: 'e1', role: 'empty' };
  }

  let nextRef = 1;
  const visit = (node: RawAxNode): AxNode | null => {
    const role = unwrap(node.role);
    const name = unwrap(node.name);
    const value = unwrap(node.value);
    const children = (node.childIds ?? [])
      .map((id) => byId.get(id))
      .filter((c): c is RawAxNode => !!c)
      .map(visit)
      .filter((c): c is AxNode => c !== null);

    // Prune ignored nodes that contribute nothing.
    if (node.ignored && children.length === 0 && !name && !value) {
      return null;
    }
    // Flatten ignored container: surface its children to the parent level.
    if (node.ignored && !name && !value) {
      if (children.length === 1) {
        return children[0]!;
      }
    }

    const ref = `e${nextRef++}`;
    if (typeof node.backendDOMNodeId === 'number') {
      s.refToBackendNodeId.set(ref, node.backendDOMNodeId);
    }
    const out: AxNode = { ref, role: role ?? 'node' };
    if (name) {
      out.name = name;
    }
    if (value) {
      out.value = value;
    }
    if (children.length > 0) {
      out.children = children;
    }
    return out;
  };

  return visit(root) ?? { ref: 'e1', role: 'empty' };
}

// ---------------------------------------------------------------------------
// Ref resolution + element interaction
// ---------------------------------------------------------------------------

/**
 * Resolve a snapshot-assigned ref to a center coordinate (in CSS pixels,
 * relative to the WebContents viewport). The caller passes these directly
 * to `wc.sendInputEvent`.
 */
export async function resolveRefBox(
  wc: WebContents,
  ref: string
): Promise<{ cx: number; cy: number }> {
  const s = getState(wc);
  const backendNodeId = s.refToBackendNodeId.get(ref);
  if (backendNodeId === undefined) {
    throw new Error(
      `Unknown ref "${ref}" — snapshots are invalidated on navigation, re-snapshot the app and try again.`
    );
  }

  const { object } = await send<{ object: { objectId: string } }>(wc, 'DOM.resolveNode', {
    backendNodeId,
  });

  // getBoxModel returns `content` as an 8-length array [x1,y1,x2,y2,x3,y3,x4,y4]
  // in device-independent pixels. We take the bounding-rect center.
  const { model } = await send<{ model: { content: number[] } }>(wc, 'DOM.getBoxModel', {
    objectId: object.objectId,
  });
  const pts = model.content;
  const xs = [pts[0]!, pts[2]!, pts[4]!, pts[6]!];
  const ys = [pts[1]!, pts[3]!, pts[5]!, pts[7]!];
  const cx = Math.round((Math.min(...xs) + Math.max(...xs)) / 2);
  const cy = Math.round((Math.min(...ys) + Math.max(...ys)) / 2);
  return { cx, cy };
}

/** Focus a ref (moves caret/focus to the resolved element). */
export async function focusRef(wc: WebContents, ref: string): Promise<void> {
  const s = getState(wc);
  const backendNodeId = s.refToBackendNodeId.get(ref);
  if (backendNodeId === undefined) {
    throw new Error(`Unknown ref "${ref}"`);
  }
  await send(wc, 'DOM.focus', { backendNodeId });
}

/** Scroll the element identified by `ref` into the viewport. */
export async function scrollRefIntoView(wc: WebContents, ref: string): Promise<void> {
  const s = getState(wc);
  const backendNodeId = s.refToBackendNodeId.get(ref);
  if (backendNodeId === undefined) {
    throw new Error(
      `Unknown ref "${ref}" — snapshots are invalidated on navigation, re-snapshot the app and try again.`
    );
  }
  await send(wc, 'DOM.scrollIntoViewIfNeeded', { backendNodeId });
}

/**
 * Full-page screenshot via `Page.captureScreenshot` with
 * `captureBeyondViewport`. Returns a raw PNG buffer in base64.
 */
export async function fullPageScreenshot(wc: WebContents): Promise<Buffer> {
  ensureAttached(wc);
  const metrics = await send<{
    cssContentSize: { width: number; height: number };
    cssLayoutViewport?: { clientWidth: number; clientHeight: number };
    devicePixelRatio?: number;
  }>(wc, 'Page.getLayoutMetrics');
  const { width, height } = metrics.cssContentSize;
  const result = await send<{ data: string }>(wc, 'Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true,
    clip: { x: 0, y: 0, width, height, scale: 1 },
  });
  return Buffer.from(result.data, 'base64');
}

/**
 * Thin wrapper around `Emulation.setDeviceMetricsOverride`. Pass
 * `disable: true` to clear an active override (restores the real viewport).
 */
export async function setViewportOverride(
  wc: WebContents,
  options: { width: number; height: number; deviceScaleFactor?: number; mobile?: boolean }
): Promise<void> {
  await send(wc, 'Emulation.setDeviceMetricsOverride', {
    width: options.width,
    height: options.height,
    deviceScaleFactor: options.deviceScaleFactor ?? 1,
    mobile: options.mobile ?? false,
  });
}

export async function clearViewportOverride(wc: WebContents): Promise<void> {
  await send(wc, 'Emulation.clearDeviceMetricsOverride');
}

// ---------------------------------------------------------------------------
// Network log — enable CDP Network, buffer request/response events
// ---------------------------------------------------------------------------

const NETWORK_LOG_CAP = 500;

/**
 * Enable network logging on the webContents. Idempotent — subsequent calls
 * just ensure the debugger listener is in place without double-enabling.
 */
export async function enableNetworkLog(wc: WebContents): Promise<void> {
  ensureAttached(wc);
  const s = getState(wc);
  if (!s.network) {
    s.network = { enabled: false, entries: [], pending: new Map() };
  }
  if (s.network.enabled) {
return;
}

  const listener = (_event: unknown, method: string, params: unknown) => {
    const net = getState(wc).network;
    if (!net) {
return;
}
    try {
      if (method === 'Network.requestWillBeSent') {
        const p = params as {
          requestId: string;
          request: { method: string; url: string };
          timestamp: number;
          type?: string;
        };
        net.pending.set(p.requestId, {
          requestId: p.requestId,
          method: p.request.method,
          url: p.request.url,
          startedAt: p.timestamp,
          resourceType: p.type,
        });
      } else if (method === 'Network.responseReceived') {
        const p = params as {
          requestId: string;
          response: { status: number; statusText: string; mimeType: string; fromDiskCache?: boolean };
        };
        const entry = net.pending.get(p.requestId);
        if (entry) {
          entry.status = p.response.status;
          entry.statusText = p.response.statusText;
          entry.mimeType = p.response.mimeType;
          entry.fromCache = p.response.fromDiskCache;
        }
      } else if (method === 'Network.loadingFinished') {
        const p = params as { requestId: string; timestamp: number; encodedDataLength: number };
        const entry = net.pending.get(p.requestId);
        if (entry) {
          entry.endedAt = p.timestamp;
          entry.encodedDataLength = p.encodedDataLength;
          pushEntry(net, entry);
        }
      } else if (method === 'Network.loadingFailed') {
        const p = params as { requestId: string; timestamp: number; errorText: string };
        const entry = net.pending.get(p.requestId);
        if (entry) {
          entry.endedAt = p.timestamp;
          entry.errorText = p.errorText;
          pushEntry(net, entry);
        }
      }
    } catch {
      // debugger events are best-effort — don't crash the main process.
    }
  };

  wc.debugger.on('message', listener);
  s.network.listener = listener;
  s.network.enabled = true;
  await send(wc, 'Network.enable');

  // Drop our listener on destroy so a recreated wc (same pointer unlikely but
  // safe) doesn't inherit stale state.
  wc.once('destroyed', () => {
    const cur = state.get(wc);
    if (cur?.network?.listener) {
      try {
        wc.debugger.removeListener?.('message', cur.network.listener);
      } catch {
        // ignore
      }
    }
  });
}

function pushEntry(
  net: NonNullable<AttachmentState['network']>,
  entry: NetworkLogEntry
): void {
  net.pending.delete(entry.requestId);
  net.entries.push(entry);
  if (net.entries.length > NETWORK_LOG_CAP) {
    net.entries.splice(0, net.entries.length - NETWORK_LOG_CAP);
  }
}

export function readNetworkLog(
  wc: WebContents,
  options: { limit?: number; since?: number; urlIncludes?: string; statusMin?: number } = {}
): NetworkLogEntry[] {
  const s = getState(wc);
  const entries = s.network?.entries ?? [];
  const limit = options.limit ?? 100;
  let filtered = entries;
  if (options.since !== undefined) {
    filtered = filtered.filter((e) => e.startedAt >= options.since!);
  }
  if (options.urlIncludes) {
    filtered = filtered.filter((e) => e.url.includes(options.urlIncludes!));
  }
  if (options.statusMin !== undefined) {
    filtered = filtered.filter((e) => (e.status ?? 0) >= options.statusMin!);
  }
  // Newest last; callers usually want the tail.
  return filtered.slice(-limit);
}

export function clearNetworkLog(wc: WebContents): void {
  const s = getState(wc);
  if (s.network) {
    s.network.entries.length = 0;
    s.network.pending.clear();
  }
}

// ---------------------------------------------------------------------------
// Snapshot diff — compare current vs cached previous tree
// ---------------------------------------------------------------------------

export type SnapshotDiffEntry = { role: string; name?: string; value?: string; ref?: string };
export type SnapshotDiff = {
  added: SnapshotDiffEntry[];
  removed: SnapshotDiffEntry[];
  unchanged: number;
};

function flatten(node: import('@/shared/app-control-types').AxNode, out: SnapshotDiffEntry[]): void {
  out.push({
    role: node.role,
    ...(node.name ? { name: node.name } : {}),
    ...(node.value ? { value: node.value } : {}),
    ref: node.ref,
  });
  for (const c of node.children ?? []) {
flatten(c, out);
}
}

/**
 * Diff a fresh snapshot against the one we cached on the last `snapshot()`
 * call. Matching key is `role::name::value` — stable enough to catch "a
 * toast appeared" or "a row went away" without being sensitive to layout
 * changes. Updates the cache so the next diff is against this snapshot.
 */
export function diffSnapshots(
  wc: WebContents,
  current: import('@/shared/app-control-types').AxNode
): SnapshotDiff {
  const s = getState(wc);
  const prev = s.lastSnapshotTree;
  s.lastSnapshotTree = current;

  if (!prev) {
    const all: SnapshotDiffEntry[] = [];
    flatten(current, all);
    return { added: all, removed: [], unchanged: 0 };
  }

  const keyOf = (e: SnapshotDiffEntry) => `${e.role}::${e.name ?? ''}::${e.value ?? ''}`;
  const prevCounts = new Map<string, number>();
  const prevFlat: SnapshotDiffEntry[] = [];
  flatten(prev, prevFlat);
  for (const e of prevFlat) {
    const k = keyOf(e);
    prevCounts.set(k, (prevCounts.get(k) ?? 0) + 1);
  }

  const currFlat: SnapshotDiffEntry[] = [];
  flatten(current, currFlat);

  const added: SnapshotDiffEntry[] = [];
  let unchanged = 0;
  for (const e of currFlat) {
    const k = keyOf(e);
    const left = prevCounts.get(k) ?? 0;
    if (left > 0) {
      prevCounts.set(k, left - 1);
      unchanged += 1;
    } else {
      added.push(e);
    }
  }

  const removed: SnapshotDiffEntry[] = [];
  for (const e of prevFlat) {
    const k = keyOf(e);
    const left = prevCounts.get(k) ?? 0;
    if (left > 0) {
      prevCounts.set(k, left - 1);
      removed.push({ ...e, ref: undefined });
    }
  }

  return { added, removed, unchanged };
}

/**
 * Replace a field's value: focus, select all, delete, then insert text.
 * `Input.insertText` respects IME and character composition better than
 * synthesised keyboard events.
 */
export async function fillRef(wc: WebContents, ref: string, text: string): Promise<void> {
  await focusRef(wc, ref);
  // Select all then delete — covers most input/textarea cases.
  wc.sendInputEvent({ type: 'keyDown', keyCode: 'a', modifiers: ['control'] });
  wc.sendInputEvent({ type: 'keyUp', keyCode: 'a', modifiers: ['control'] });
  wc.sendInputEvent({ type: 'keyDown', keyCode: 'Delete' });
  wc.sendInputEvent({ type: 'keyUp', keyCode: 'Delete' });
  if (text.length > 0) {
    await send(wc, 'Input.insertText', { text });
  }
}
