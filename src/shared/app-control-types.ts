/**
 * Types for the app-control system: a registry of drivable webviews (built-in
 * browser, code-server, VNC desktop, and custom webview apps) that AI agents
 * can list and interact with via client tools.
 *
 * Each live webview in the renderer registers itself with a stable `handleId`
 * so the main process can look up its `WebContents` and drive it via Electron
 * APIs + CDP.
 */
import type { AppId, AppKind, AppScope } from '@/shared/app-registry';

/**
 * Stable identifier for a live webview instance.
 *
 * - `global:<appId>` — the always-visible dock app (e.g. `global:browser`)
 * - `tab-<tabId>:<appId>` — an app belonging to a specific Code tab column
 */
export type AppHandleId = string;

/** Scope of a live app handle — determines agent access rules. */
export type AppHandleScope = 'global' | 'column';

/**
 * Build a canonical `AppHandleId` from its parts. Keep all construction
 * centralized so scope parsing below is never ambiguous.
 */
export function makeAppHandleId(scope: AppHandleScope, appId: AppId, tabId?: string): AppHandleId {
  if (scope === 'global') {
    return `global:${appId}`;
  }
  if (!tabId) {
    throw new Error('tabId is required for column-scoped app handles');
  }
  return `tab-${tabId}:${appId}`;
}

/** Parse a handle id back into its parts. Returns null for unrecognized ids. */
export function parseAppHandleId(
  handleId: AppHandleId
): { scope: AppHandleScope; appId: AppId; tabId?: string } | null {
  if (handleId.startsWith('global:')) {
    return { scope: 'global', appId: handleId.slice('global:'.length) };
  }
  if (handleId.startsWith('tab-')) {
    const rest = handleId.slice('tab-'.length);
    const sep = rest.indexOf(':');
    if (sep === -1) {
      return null;
    }
    return { scope: 'column', tabId: rest.slice(0, sep), appId: rest.slice(sep + 1) };
  }
  return null;
}

/**
 * Snapshot of a live app as seen by clients (list_apps output shape).
 * The `controllable` flag distinguishes web surfaces from terminal/chat apps
 * that show up in the dock but can't be driven via snapshot/click/eval.
 */
export type LiveAppSnapshot = {
  handleId: AppHandleId;
  appId: AppId;
  kind: AppKind;
  scope: AppHandleScope;
  tabId?: string;
  label: string;
  url?: string;
  title?: string;
  controllable: boolean;
};

/**
 * Accessibility-tree node returned by app_snapshot. Refs are stable within a
 * single snapshot; callers must re-snapshot after navigation.
 */
export type AxNode = {
  ref: string;
  role: string;
  name?: string;
  value?: string;
  children?: AxNode[];
};

/** Console-message severity mirrored from Chromium. */
export type AppConsoleLevel = 'log' | 'info' | 'warn' | 'error';

export type AppConsoleEntry = {
  level: AppConsoleLevel;
  message: string;
  timestamp: number;
};

/** Payload for `app:register` / `app:update` sent from renderer → main. */
export type AppRegistrationPayload = {
  handleId: AppHandleId;
  appId: AppId;
  kind: AppKind;
  scope: AppHandleScope;
  tabId?: string;
  label: string;
  url?: string;
  title?: string;
  webContentsId?: number;
  /**
   * For non-webview kinds (chat, terminal) the agent can still see the app
   * in list_apps but can't drive it. Surfaces set this based on their kind.
   */
  controllable: boolean;
};

/**
 * Builtin kinds that are always considered controllable. Terminal + chat are
 * excluded because they have no web surface to snapshot or click on.
 */
export const CONTROLLABLE_APP_KINDS: ReadonlySet<AppKind> = new Set<AppKind>([
  'builtin-browser',
  'builtin-code',
  'builtin-desktop',
  'webview',
]);

export function isControllableKind(kind: AppKind): boolean {
  return CONTROLLABLE_APP_KINDS.has(kind);
}

/** Options accepted by `app:screenshot`. */
export type AppScreenshotOptions = {
  fullPage?: boolean;
  /** Optional subdirectory under the artifacts root — usually a ticketId. */
  artifactsSubdir?: string;
};

/** Mouse button accepted by app_click. */
export type AppClickButton = 'left' | 'right' | 'middle';

// Convenience export used by unit tests and the variables-builder scope logic.
export type AppScopeFilter = {
  tabId?: string;
  allowGlobal: boolean;
};

// Re-export so downstream files don't need a second import path.
export type { AppId, AppKind, AppScope };
