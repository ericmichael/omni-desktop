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
 * Per-webContents state: attachment bookkeeping + the most recent snapshot's
 * ref → backendNodeId map so follow-up actions (click/fill) can resolve refs.
 */
type AttachmentState = {
  attached: boolean;
  refToBackendNodeId: Map<string, number>;
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
