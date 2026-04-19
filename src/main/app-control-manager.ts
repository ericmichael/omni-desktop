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
import {
  clearNetworkLog,
  clearViewportOverride,
  diffSnapshots,
  elementScreenshot,
  enableNetworkLog,
  ensureAttached,
  fillRef,
  fullPageScreenshot,
  type NetworkLogEntry,
  readNetworkLog,
  resolveRefBox,
  scrollRefIntoView,
  setViewportOverride,
  snapshot,
  type SnapshotDiff,
} from '@/main/app-control-cdp';
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
  /** True once we've installed `setWindowOpenHandler` on this webContents. */
  popupHandlerInstalled?: boolean;
};

/** Callback wired by `main/index.ts` to route popups into `BrowserManager`. */
export type OnBrowserPopup = (tabsetId: string, url: string, disposition: string) => void;

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
  private onBrowserPopup?: OnBrowserPopup;

  constructor(options: { onBrowserPopup?: OnBrowserPopup } = {}) {
    this.onBrowserPopup = options.onBrowserPopup;
  }

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
    this.attachPopupHandler(entry);
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
      entry.popupHandlerInstalled = false;
      this.attachConsoleListener(entry);
      this.attachPopupHandler(entry);
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

  // -- popup handler ------------------------------------------------------

  /**
   * Install `setWindowOpenHandler` on a browser-kind webContents so
   * `window.open` and `target="_blank"` create a new tab in the same tabset
   * instead of opening a native OS window. Idempotent per webContents via
   * the `popupHandlerInstalled` flag.
   */
  private attachPopupHandler(entry: AppEntry): void {
    const tabsetId = entry.registration.browserTabsetId;
    if (!tabsetId || entry.popupHandlerInstalled || !this.onBrowserPopup) {
      return;
    }
    if (entry.webContentsId === undefined) {
      return;
    }
    const wc = webContentsNS.fromId(entry.webContentsId);
    if (!wc || wc.isDestroyed()) {
      return;
    }
    const onPopup = this.onBrowserPopup;
    wc.setWindowOpenHandler((details) => {
      onPopup(tabsetId, details.url, details.disposition);
      return { action: 'deny' };
    });
    entry.popupHandlerInstalled = true;
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

  /**
   * Capture a fresh snapshot and return what changed since the previous
   * `snapshot_diff` call. The first call returns everything as `added`.
   * Massively cheaper context-wise than re-sending a full tree each turn.
   */
  async snapshotDiff(handleId: AppHandleId): Promise<SnapshotDiff> {
    const { wc } = this.requireWebContents(handleId);
    ensureAttached(wc);
    const fresh = await snapshot(wc);
    return diffSnapshots(wc, fresh);
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

  // -- browser extensions -------------------------------------------------

  /**
   * Scroll the page. One of `toTop`, `toBottom`, or `dy`/`dx` must be set.
   * Missing / zero deltas behave as a no-op rather than an error.
   */
  async scroll(
    handleId: AppHandleId,
    options: { dx?: number; dy?: number; toTop?: boolean; toBottom?: boolean }
  ): Promise<void> {
    const { wc } = this.requireWebContents(handleId);
    let expr: string;
    if (options.toTop) {
      expr = 'window.scrollTo(0, 0)';
    } else if (options.toBottom) {
      expr = 'window.scrollTo(0, document.documentElement.scrollHeight)';
    } else {
      const dx = Number(options.dx ?? 0) | 0;
      const dy = Number(options.dy ?? 0) | 0;
      if (dx === 0 && dy === 0) {
return;
}
      expr = `window.scrollBy(${dx}, ${dy})`;
    }
    await wc.executeJavaScript(expr, true);
  }

  /** Insert a stylesheet; returns a key usable with removeInsertedCSS. */
  async injectCss(handleId: AppHandleId, css: string): Promise<string> {
    const { wc } = this.requireWebContents(handleId);
    return wc.insertCSS(css);
  }

  async removeInsertedCss(handleId: AppHandleId, key: string): Promise<void> {
    const { wc } = this.requireWebContents(handleId);
    try {
      await wc.removeInsertedCSS(key);
    } catch {
      // key may have been invalidated by a nav — treat as no-op.
    }
  }

  /**
   * Find-in-page. Resolves when the first `found-in-page` final-update event
   * fires. Retries once if the webview emits only a partial update.
   */
  async findInPage(
    handleId: AppHandleId,
    query: string,
    options: { caseSensitive?: boolean; forward?: boolean; findNext?: boolean } = {}
  ): Promise<{ matches: number; activeOrdinal: number }> {
    const { wc } = this.requireWebContents(handleId);
    if (!query) {
      wc.stopFindInPage('clearSelection');
      return { matches: 0, activeOrdinal: 0 };
    }
    return new Promise((resolve) => {
      const handler = (
        _: unknown,
        result: { activeMatchOrdinal: number; matches: number; finalUpdate: boolean }
      ) => {
        if (!result.finalUpdate) {
return;
}
        wc.removeListener('found-in-page', handler);
        resolve({ matches: result.matches, activeOrdinal: result.activeMatchOrdinal });
      };
      wc.on('found-in-page', handler);
      wc.findInPage(query, {
        matchCase: options.caseSensitive ?? false,
        forward: options.forward ?? true,
        findNext: options.findNext ?? false,
      });
      // Guard against a missing final-update event (rare but possible). Resolve
      // with zeroes after 5s so the agent isn't stuck.
      setTimeout(() => {
        wc.removeListener('found-in-page', handler);
        resolve({ matches: 0, activeOrdinal: 0 });
      }, 5000);
    });
  }

  async stopFindInPage(handleId: AppHandleId): Promise<void> {
    const { wc } = this.requireWebContents(handleId);
    wc.stopFindInPage('clearSelection');
  }

  /**
   * Wait for a condition. Supports (in priority order):
   *   - `selector`: poll `document.querySelector(selector)` every 100ms.
   *   - `urlIncludes`: poll `wc.getURL()` for a substring match.
   *   - `networkIdle`: wait for `did-stop-loading` + one drain tick.
   * Rejects with `timeout` after `timeoutMs` (default 10000).
   */
  async scrollToRef(handleId: AppHandleId, ref: string): Promise<void> {
    const { wc } = this.requireWebContents(handleId);
    ensureAttached(wc);
    await scrollRefIntoView(wc, ref);
  }

  async networkLog(
    handleId: AppHandleId,
    options: { limit?: number; since?: number; urlIncludes?: string; statusMin?: number; clear?: boolean } = {}
  ): Promise<NetworkLogEntry[]> {
    const { wc } = this.requireWebContents(handleId);
    // Enable lazily so agents don't pay the CDP overhead when they don't
    // ask for network entries.
    await enableNetworkLog(wc);
    const entries = readNetworkLog(wc, options);
    if (options.clear) {
      clearNetworkLog(wc);
    }
    return entries;
  }

  /** Save the active tab as PDF to the ticket artifacts dir; returns path. */
  async pdf(
    handleId: AppHandleId,
    options: { artifactsSubdir?: string; landscape?: boolean; printBackground?: boolean } = {}
  ): Promise<string> {
    const { entry, wc } = this.requireWebContents(handleId);
    const buffer = await wc.printToPDF({
      landscape: options.landscape ?? false,
      printBackground: options.printBackground ?? true,
    });
    const rootDir = options.artifactsSubdir
      ? getArtifactsDir(getOmniConfigDir(), options.artifactsSubdir)
      : path.join(getOmniConfigDir(), 'app-control-pdfs');
    await fs.mkdir(rootDir, { recursive: true });
    const filename = `${entry.registration.appId}-${Date.now()}.pdf`;
    const filepath = path.join(rootDir, filename);
    await fs.writeFile(filepath, buffer);
    return filepath;
  }

  /** Per-element screenshot. `ref` comes from the most recent snapshot. */
  async elementScreenshot(
    handleId: AppHandleId,
    ref: string,
    options: AppScreenshotOptions = {}
  ): Promise<string> {
    const { entry, wc } = this.requireWebContents(handleId);
    ensureAttached(wc);
    const buffer = await elementScreenshot(wc, ref);
    const rootDir = options.artifactsSubdir
      ? getArtifactsDir(getOmniConfigDir(), options.artifactsSubdir)
      : path.join(getOmniConfigDir(), 'app-control-screenshots');
    await fs.mkdir(rootDir, { recursive: true });
    const filename = `${entry.registration.appId}-element-${Date.now()}.png`;
    const filepath = path.join(rootDir, filename);
    await fs.writeFile(filepath, buffer);
    return filepath;
  }

  /** Full-page (scroll-and-stitch equivalent) screenshot via CDP. */
  async fullPageScreenshot(
    handleId: AppHandleId,
    options: AppScreenshotOptions = {}
  ): Promise<string> {
    const { entry, wc } = this.requireWebContents(handleId);
    const buffer = await fullPageScreenshot(wc);
    const rootDir = options.artifactsSubdir
      ? getArtifactsDir(getOmniConfigDir(), options.artifactsSubdir)
      : path.join(getOmniConfigDir(), 'app-control-screenshots');
    await fs.mkdir(rootDir, { recursive: true });
    const filename = `${entry.registration.appId}-full-${Date.now()}.png`;
    const filepath = path.join(rootDir, filename);
    await fs.writeFile(filepath, buffer);
    return filepath;
  }

  async setViewport(
    handleId: AppHandleId,
    options:
      | { width: number; height: number; deviceScaleFactor?: number; mobile?: boolean }
      | { clear: true }
  ): Promise<void> {
    const { wc } = this.requireWebContents(handleId);
    if ('clear' in options) {
      await clearViewportOverride(wc);
    } else {
      await setViewportOverride(wc, options);
    }
  }

  async setUserAgent(handleId: AppHandleId, userAgent: string): Promise<void> {
    const { wc } = this.requireWebContents(handleId);
    // Empty string resets to the default. `setUserAgent` applies immediately
    // and persists across reloads for the duration of the session.
    wc.setUserAgent(userAgent);
  }

  async setZoom(handleId: AppHandleId, factor: number): Promise<void> {
    const { wc } = this.requireWebContents(handleId);
    // Clamp to Chromium's supported range.
    const clamped = Math.max(0.25, Math.min(5, factor));
    wc.setZoomFactor(clamped);
  }

  // -- cookies ------------------------------------------------------------

  async cookiesGet(
    handleId: AppHandleId,
    filter: { url?: string; name?: string; domain?: string; path?: string } = {}
  ): Promise<unknown[]> {
    const { wc } = this.requireWebContents(handleId);
    return wc.session.cookies.get(filter);
  }

  async cookiesSet(
    handleId: AppHandleId,
    cookie: {
      url: string;
      name: string;
      value: string;
      domain?: string;
      path?: string;
      secure?: boolean;
      httpOnly?: boolean;
      expirationDate?: number;
      sameSite?: 'unspecified' | 'no_restriction' | 'lax' | 'strict';
    }
  ): Promise<void> {
    const { wc } = this.requireWebContents(handleId);
    await wc.session.cookies.set(cookie);
  }

  async cookiesClear(
    handleId: AppHandleId,
    filter: { url?: string; name?: string } = {}
  ): Promise<number> {
    const { wc } = this.requireWebContents(handleId);
    const matches = await wc.session.cookies.get(filter);
    let removed = 0;
    for (const c of matches) {
      // `domain` on a cookie lacks scheme; synthesize a URL if the caller
      // didn't give us one. Prefer HTTPS — cookies.remove matches by URL + name
      // regardless of scheme for host-only cookies.
      const url = filter.url ?? `https://${c.domain?.replace(/^\./, '') ?? ''}${c.path ?? '/'}`;
      try {
        await wc.session.cookies.remove(url, c.name);
        removed += 1;
      } catch {
        // best-effort — some cookies may reject removal due to path mismatch
      }
    }
    return removed;
  }

  // -- storage (localStorage / sessionStorage) ----------------------------

  async storageGet(
    handleId: AppHandleId,
    which: 'local' | 'session'
  ): Promise<Record<string, string>> {
    const { wc } = this.requireWebContents(handleId);
    const expr = `(() => {
      const s = window.${which === 'local' ? 'localStorage' : 'sessionStorage'};
      const out = {};
      for (let i = 0; i < s.length; i++) {
        const k = s.key(i);
        if (k !== null) out[k] = s.getItem(k);
      }
      return out;
    })()`;
    return (await wc.executeJavaScript(expr, true)) as Record<string, string>;
  }

  async storageSet(
    handleId: AppHandleId,
    which: 'local' | 'session',
    entries: Record<string, string>
  ): Promise<void> {
    const { wc } = this.requireWebContents(handleId);
    const expr = `(() => {
      const s = window.${which === 'local' ? 'localStorage' : 'sessionStorage'};
      const entries = ${JSON.stringify(entries)};
      for (const k of Object.keys(entries)) s.setItem(k, entries[k]);
    })()`;
    await wc.executeJavaScript(expr, true);
  }

  async storageClear(handleId: AppHandleId, which: 'local' | 'session'): Promise<void> {
    const { wc } = this.requireWebContents(handleId);
    await wc.executeJavaScript(
      `window.${which === 'local' ? 'localStorage' : 'sessionStorage'}.clear()`,
      true
    );
  }

  async waitFor(
    handleId: AppHandleId,
    options: { selector?: string; urlIncludes?: string; networkIdle?: boolean; timeoutMs?: number }
  ): Promise<{ ok: true; matched: 'selector' | 'url' | 'networkIdle' }> {
    const { wc } = this.requireWebContents(handleId);
    const timeoutMs = options.timeoutMs ?? 10_000;
    const deadline = Date.now() + timeoutMs;

    if (options.networkIdle) {
      if (!wc.isLoading()) {
        return { ok: true, matched: 'networkIdle' };
      }
      return new Promise((resolve, reject) => {
        const onIdle = () => {
          wc.removeListener('did-stop-loading', onIdle);
          resolve({ ok: true, matched: 'networkIdle' });
        };
        wc.on('did-stop-loading', onIdle);
        setTimeout(() => {
          wc.removeListener('did-stop-loading', onIdle);
          reject(new Error(`wait_for: networkIdle did not occur within ${timeoutMs}ms`));
        }, timeoutMs);
      });
    }

    const selectorExpr = options.selector
      ? `!!document.querySelector(${JSON.stringify(options.selector)})`
      : null;

    while (Date.now() < deadline) {
      if (selectorExpr) {
        const hit = await wc.executeJavaScript(selectorExpr);
        if (hit) {
return { ok: true, matched: 'selector' };
}
      }
      if (options.urlIncludes) {
        if (wc.getURL().includes(options.urlIncludes)) {
          return { ok: true, matched: 'url' };
        }
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`wait_for: condition not met within ${timeoutMs}ms`);
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
  onBrowserPopup?: OnBrowserPopup;
}): [AppControlManager, () => void] => {
  const { ipc, onBrowserPopup } = arg;
  const manager = new AppControlManager({ ...(onBrowserPopup ? { onBrowserPopup } : {}) });

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
  ipc.handle('app:snapshot-diff', (_, handleId) => manager.snapshotDiff(handleId));
  ipc.handle('app:click', (_, handleId, ref, options) => manager.click(handleId, ref, options));
  ipc.handle('app:fill', (_, handleId, ref, text) => manager.fill(handleId, ref, text));
  ipc.handle('app:type', (_, handleId, text) => manager.type(handleId, text));
  ipc.handle('app:press', (_, handleId, key) => manager.press(handleId, key));
  ipc.handle('app:scroll', (_, handleId, options) => manager.scroll(handleId, options));
  ipc.handle('app:scroll-to-ref', (_, handleId, ref) => manager.scrollToRef(handleId, ref));
  ipc.handle('app:network-log', (_, handleId, options) => manager.networkLog(handleId, options));
  ipc.handle('app:inject-css', (_, handleId, css) => manager.injectCss(handleId, css));
  ipc.handle('app:remove-inserted-css', (_, handleId, key) => manager.removeInsertedCss(handleId, key));
  ipc.handle('app:find', (_, handleId, query, options) => manager.findInPage(handleId, query, options));
  ipc.handle('app:stop-find', (_, handleId) => manager.stopFindInPage(handleId));
  ipc.handle('app:wait-for', (_, handleId, options) => manager.waitFor(handleId, options));
  ipc.handle('app:pdf', (_, handleId, options) => manager.pdf(handleId, options));
  ipc.handle('app:full-screenshot', (_, handleId, options) => manager.fullPageScreenshot(handleId, options));
  ipc.handle('app:element-screenshot', (_, handleId, ref, options) => manager.elementScreenshot(handleId, ref, options));
  ipc.handle('app:set-viewport', (_, handleId, options) => manager.setViewport(handleId, options));
  ipc.handle('app:set-user-agent', (_, handleId, ua) => manager.setUserAgent(handleId, ua));
  ipc.handle('app:set-zoom', (_, handleId, factor) => manager.setZoom(handleId, factor));
  ipc.handle('app:cookies-get', (_, handleId, filter) => manager.cookiesGet(handleId, filter));
  ipc.handle('app:cookies-set', (_, handleId, cookie) => manager.cookiesSet(handleId, cookie));
  ipc.handle('app:cookies-clear', (_, handleId, filter) => manager.cookiesClear(handleId, filter));
  ipc.handle('app:storage-get', (_, handleId, which) => manager.storageGet(handleId, which));
  ipc.handle('app:storage-set', (_, handleId, which, entries) => manager.storageSet(handleId, which, entries));
  ipc.handle('app:storage-clear', (_, handleId, which) => manager.storageClear(handleId, which));

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
      'app:snapshot-diff',
      'app:click',
      'app:fill',
      'app:type',
      'app:press',
      'app:scroll',
      'app:scroll-to-ref',
      'app:network-log',
      'app:inject-css',
      'app:remove-inserted-css',
      'app:find',
      'app:stop-find',
      'app:wait-for',
      'app:pdf',
      'app:full-screenshot',
      'app:element-screenshot',
      'app:set-viewport',
      'app:set-user-agent',
      'app:set-zoom',
      'app:cookies-get',
      'app:cookies-set',
      'app:cookies-clear',
      'app:storage-get',
      'app:storage-set',
      'app:storage-clear',
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
