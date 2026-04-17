/**
 * Main-process manager for the app-control system.
 *
 * The renderer registers every live `<Webview>` via `app:register` so this
 * manager knows which `WebContents` maps to which `handleId`. Agents then
 * drive those webviews through the rest of the `app:*` IPC surface:
 * navigate, snapshot, click, fill, type, press, screenshot, eval, console,
 * reload, back, forward.
 *
 * Per the Phase-2 design, everything is Electron-only. Screenshot/console
 * use Electron APIs directly; snapshot/click/fill use CDP via `wc.debugger`.
 */
import { ipcMain, webContents as webContentsNS } from 'electron';
import fs from 'fs/promises';
import path from 'path';

import { getArtifactsDir } from '@/lib/artifacts';
import { ensureAttached, fillRef, resolveRefBox, snapshot } from '@/main/app-control-cdp';
import { getOmniConfigDir } from '@/main/util';
import type {
  AppClickButton,
  AppConsoleEntry,
  AppConsoleLevel,
  AppHandleId,
  AppRegistrationPayload,
  AppScreenshotOptions,
  AxNode,
  LiveAppSnapshot,
} from '@/shared/app-control-types';
import { isControllableKind } from '@/shared/app-control-types';
import type { IIpcListener } from '@/shared/ipc-listener';

// ---------------------------------------------------------------------------
// Per-handle bookkeeping
// ---------------------------------------------------------------------------

const MAX_CONSOLE_ENTRIES = 1000;

type AppEntry = {
  handleId: AppHandleId;
  registration: AppRegistrationPayload;
  /** Last-known webContents id from the renderer. May be stale/gone. */
  webContentsId?: number;
  /** Console ring buffer, oldest first. */
  console: AppConsoleEntry[];
  /** Cleanup for `console-message` listener so we don't leak. */
  detachConsole?: () => void;
};

const LEVEL_RANK: Record<AppConsoleLevel, number> = {
  log: 0,
  info: 0,
  warn: 1,
  error: 2,
};

const MOUSE_BUTTON_MAP: Record<AppClickButton, 'left' | 'right' | 'middle'> = {
  left: 'left',
  right: 'right',
  middle: 'middle',
};

export class AppControlManager {
  private entries = new Map<AppHandleId, AppEntry>();

  // -- registry sync -------------------------------------------------------

  register(payload: AppRegistrationPayload): void {
    const existing = this.entries.get(payload.handleId);
    if (existing) {
      existing.detachConsole?.();
    }
    const entry: AppEntry = {
      handleId: payload.handleId,
      registration: { ...payload, controllable: payload.controllable && isControllableKind(payload.kind) },
      webContentsId: payload.webContentsId,
      console: existing?.console ?? [],
    };
    this.entries.set(payload.handleId, entry);
    this.attachConsoleListener(entry);
  }

  update(handleId: AppHandleId, patch: Partial<AppRegistrationPayload>): void {
    const entry = this.entries.get(handleId);
    if (!entry) {
      return;
    }
    entry.registration = { ...entry.registration, ...patch };
    if (patch.webContentsId !== undefined && patch.webContentsId !== entry.webContentsId) {
      entry.webContentsId = patch.webContentsId;
      entry.detachConsole?.();
      this.attachConsoleListener(entry);
    }
  }

  unregister(handleId: AppHandleId): void {
    const entry = this.entries.get(handleId);
    if (!entry) {
      return;
    }
    entry.detachConsole?.();
    this.entries.delete(handleId);
  }

  list(): LiveAppSnapshot[] {
    return [...this.entries.values()].map((e) => ({
      handleId: e.handleId,
      appId: e.registration.appId,
      kind: e.registration.kind,
      scope: e.registration.scope,
      tabId: e.registration.tabId,
      label: e.registration.label,
      url: e.registration.url,
      title: e.registration.title,
      controllable: e.registration.controllable,
    }));
  }

  // -- resolution ---------------------------------------------------------

  private requireWebContents(handleId: AppHandleId) {
    const entry = this.entries.get(handleId);
    if (!entry) {
      throw new Error(`Unknown app handle: ${handleId}`);
    }
    if (!entry.registration.controllable) {
      throw new Error(
        `App "${entry.registration.appId}" (${entry.registration.kind}) is not a web surface — no snapshot/click/nav available.`
      );
    }
    if (entry.webContentsId === undefined) {
      throw new Error(`App "${entry.registration.appId}" has not finished loading yet.`);
    }
    const wc = webContentsNS.fromId(entry.webContentsId);
    if (!wc || wc.isDestroyed()) {
      throw new Error(`App "${entry.registration.appId}" is closed.`);
    }
    return { entry, wc };
  }

  // -- console ring buffer ------------------------------------------------

  private attachConsoleListener(entry: AppEntry): void {
    if (entry.webContentsId === undefined) {
      return;
    }
    const wc = webContentsNS.fromId(entry.webContentsId);
    if (!wc || wc.isDestroyed()) {
      return;
    }
    const handler = (
      _event: unknown,
      level: number,
      message: string,
      _line: number,
      _sourceId: string
    ) => {
      // Electron emits level 0=log/info, 1=warning, 2=error. Treat warnings
      // and errors accordingly; everything else is `log`.
      const mapped: AppConsoleLevel = level === 2 ? 'error' : level === 1 ? 'warn' : 'log';
      entry.console.push({ level: mapped, message, timestamp: Date.now() });
      if (entry.console.length > MAX_CONSOLE_ENTRIES) {
        entry.console.splice(0, entry.console.length - MAX_CONSOLE_ENTRIES);
      }
    };
    wc.on('console-message', handler);
    entry.detachConsole = () => {
      try {
        wc.removeListener('console-message', handler);
      } catch {
        // wc may be destroyed — nothing to remove.
      }
    };
  }

  // -- primitives ---------------------------------------------------------

  async navigate(handleId: AppHandleId, url: string): Promise<void> {
    const { wc } = this.requireWebContents(handleId);
    await wc.loadURL(url);
  }

  async reload(handleId: AppHandleId): Promise<void> {
    const { wc } = this.requireWebContents(handleId);
    wc.reload();
  }

  async back(handleId: AppHandleId): Promise<void> {
    const { wc } = this.requireWebContents(handleId);
    const nav = wc.navigationHistory;
    if (nav && typeof nav.canGoBack === 'function' && nav.canGoBack()) {
      nav.goBack();
    } else if (typeof (wc as unknown as { canGoBack?: () => boolean }).canGoBack === 'function') {
      // Electron <28 fallback.
      const legacy = wc as unknown as { canGoBack(): boolean; goBack(): void };
      if (legacy.canGoBack()) {
        legacy.goBack();
      }
    }
  }

  async forward(handleId: AppHandleId): Promise<void> {
    const { wc } = this.requireWebContents(handleId);
    const nav = wc.navigationHistory;
    if (nav && typeof nav.canGoForward === 'function' && nav.canGoForward()) {
      nav.goForward();
    } else if (typeof (wc as unknown as { canGoForward?: () => boolean }).canGoForward === 'function') {
      const legacy = wc as unknown as { canGoForward(): boolean; goForward(): void };
      if (legacy.canGoForward()) {
        legacy.goForward();
      }
    }
  }

  async eval(handleId: AppHandleId, code: string): Promise<unknown> {
    const { wc } = this.requireWebContents(handleId);
    // `userGesture = true` so scripts that require it (e.g. focus()) work.
    return wc.executeJavaScript(code, true);
  }

  async screenshot(
    handleId: AppHandleId,
    options: AppScreenshotOptions = {}
  ): Promise<string> {
    const { entry, wc } = this.requireWebContents(handleId);
    // `capturePage()` with no rect grabs the full visible viewport. For
    // `fullPage: true` we'd need to scroll-and-stitch via CDP; skip for v1.
    const image = await wc.capturePage();
    const buffer = image.toPNG();

    const rootDir = options.artifactsSubdir
      ? getArtifactsDir(getOmniConfigDir(), options.artifactsSubdir)
      : path.join(getOmniConfigDir(), 'app-control-screenshots');
    await fs.mkdir(rootDir, { recursive: true });
    const filename = `${entry.registration.appId}-${Date.now()}.png`;
    const filepath = path.join(rootDir, filename);
    await fs.writeFile(filepath, buffer);
    return filepath;
  }

  async console(
    handleId: AppHandleId,
    options: { minLevel?: AppConsoleLevel; clear?: boolean } = {}
  ): Promise<AppConsoleEntry[]> {
    const entry = this.entries.get(handleId);
    if (!entry) {
      throw new Error(`Unknown app handle: ${handleId}`);
    }
    const threshold = LEVEL_RANK[options.minLevel ?? 'log'];
    const filtered = entry.console.filter((e) => LEVEL_RANK[e.level] >= threshold);
    if (options.clear) {
      entry.console.length = 0;
    }
    return filtered;
  }

  async snapshot(handleId: AppHandleId): Promise<AxNode> {
    const { wc } = this.requireWebContents(handleId);
    ensureAttached(wc);
    return snapshot(wc);
  }

  async click(
    handleId: AppHandleId,
    ref: string,
    options: { button?: AppClickButton } = {}
  ): Promise<void> {
    const { wc } = this.requireWebContents(handleId);
    const { cx, cy } = await resolveRefBox(wc, ref);
    const button = MOUSE_BUTTON_MAP[options.button ?? 'left'];
    wc.sendInputEvent({ type: 'mouseMove', x: cx, y: cy });
    wc.sendInputEvent({ type: 'mouseDown', x: cx, y: cy, button, clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseUp', x: cx, y: cy, button, clickCount: 1 });
  }

  async fill(handleId: AppHandleId, ref: string, text: string): Promise<void> {
    const { wc } = this.requireWebContents(handleId);
    ensureAttached(wc);
    await fillRef(wc, ref, text);
  }

  async type(handleId: AppHandleId, text: string): Promise<void> {
    const { wc } = this.requireWebContents(handleId);
    ensureAttached(wc);
    // `Input.insertText` goes to whatever has focus — same semantics as
    // Playwright's keyboard.type without per-ref targeting.
    await wc.debugger.sendCommand('Input.insertText', { text });
  }

  async press(handleId: AppHandleId, key: string): Promise<void> {
    const { wc } = this.requireWebContents(handleId);
    wc.sendInputEvent({ type: 'keyDown', keyCode: key });
    wc.sendInputEvent({ type: 'keyUp', keyCode: key });
  }

  // -- lifecycle ----------------------------------------------------------

  disposeAll(): void {
    for (const entry of this.entries.values()) {
      entry.detachConsole?.();
    }
    this.entries.clear();
  }
}

// ---------------------------------------------------------------------------
// Factory + IPC wiring
// ---------------------------------------------------------------------------

export const createAppControlManager = (arg: {
  ipc: IIpcListener;
}): [AppControlManager, () => void] => {
  const { ipc } = arg;
  const manager = new AppControlManager();

  ipc.handle('app:register', (_, payload) => manager.register(payload));
  ipc.handle('app:update', (_, handleId, patch) => manager.update(handleId, patch));
  ipc.handle('app:unregister', (_, handleId) => manager.unregister(handleId));
  ipc.handle('app:list', () => manager.list());

  ipc.handle('app:navigate', (_, handleId, url) => manager.navigate(handleId, url));
  ipc.handle('app:reload', (_, handleId) => manager.reload(handleId));
  ipc.handle('app:back', (_, handleId) => manager.back(handleId));
  ipc.handle('app:forward', (_, handleId) => manager.forward(handleId));
  ipc.handle('app:eval', (_, handleId, code) => manager.eval(handleId, code));
  ipc.handle('app:screenshot', (_, handleId, options) => manager.screenshot(handleId, options));
  ipc.handle('app:console', (_, handleId, options) => manager.console(handleId, options));
  ipc.handle('app:snapshot', (_, handleId) => manager.snapshot(handleId));
  ipc.handle('app:click', (_, handleId, ref, options) => manager.click(handleId, ref, options));
  ipc.handle('app:fill', (_, handleId, ref, text) => manager.fill(handleId, ref, text));
  ipc.handle('app:type', (_, handleId, text) => manager.type(handleId, text));
  ipc.handle('app:press', (_, handleId, key) => manager.press(handleId, key));

  const cleanup = () => {
    manager.disposeAll();
    for (const channel of [
      'app:register',
      'app:update',
      'app:unregister',
      'app:list',
      'app:navigate',
      'app:reload',
      'app:back',
      'app:forward',
      'app:eval',
      'app:screenshot',
      'app:console',
      'app:snapshot',
      'app:click',
      'app:fill',
      'app:type',
      'app:press',
    ]) {
      try {
        ipcMain.removeHandler(channel);
      } catch {
        // handler wasn't registered (e.g. server mode) — ignore.
      }
    }
  };

  return [manager, cleanup];
};
