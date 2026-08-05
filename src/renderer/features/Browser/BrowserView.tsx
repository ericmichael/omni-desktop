/**
 * Unified Browser surface. Used both as:
 *   - a standalone code-deck column (chrome="full")
 *   - the per-session browser app inside the env dock (chrome="full")
 *
 * Owns the tab strip, omnibox, webview, and loading-bar. All mutations go
 * through `browserApi` so main-process is the single source of truth across
 * tabs, history, bookmarks, and profiles.
 */
import './BrowserView.css';

import { useStore } from '@nanostores/react';
import { ArrowLeft, ArrowRight, Globe, RefreshCw, Star, Wrench, X } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { fallbackTitle, normalizeAddress, parseOrigin } from '@/lib/url';
import type { ConsoleMessage, ContextMenuParams, FoundInPageResult, WebviewHandle } from '@/renderer/common/Webview';
import { Webview } from '@/renderer/common/Webview';
import {
  getWebviewFallbackDiagnostics,
  openInBrowserTab,
  type WebviewLoadError,
} from '@/renderer/common/webview-fallback';
import { cn } from '@/renderer/ds/cn';
import { Button } from '@/renderer/ds/ui/button';
import { ButtonGroup } from '@/renderer/ds/ui/button-group';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/renderer/ds/ui/collapsible';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/renderer/ds/ui/empty';
import { Toggle } from '@/renderer/ds/ui/toggle';
import { BookmarksBar } from '@/renderer/features/Browser/BookmarksBar';
import { DevtoolsPanel } from '@/renderer/features/Browser/Devtools/DevtoolsPanel';
import { DownloadsTray } from '@/renderer/features/Browser/DownloadsTray';
import { FindBar } from '@/renderer/features/Browser/FindBar';
import { HistoryPanel } from '@/renderer/features/Browser/HistoryPanel';
import { Omnibox, type OmniboxHandle } from '@/renderer/features/Browser/Omnibox';
import { PageContextMenu } from '@/renderer/features/Browser/PageContextMenu';
import { PermissionsBar } from '@/renderer/features/Browser/PermissionsBar';
import { $browserState, browserApi, getActiveTab } from '@/renderer/features/Browser/state';
import { TabStrip } from '@/renderer/features/Browser/TabStrip';
import { emitter } from '@/renderer/services/ipc';
import type { AppHandleScope } from '@/shared/app-control-types';
import { makeAppHandleId } from '@/shared/app-control-types';
import type { BrowserProfileId, BrowserTabsetId } from '@/shared/types';

type PreviewState = {
  loading: boolean;
  error: WebviewLoadError | null;
};

/** Cmd (⌘) on macOS, Ctrl elsewhere. Used in button tooltips. */
const IS_MAC = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform);
const MOD = IS_MAC ? '⌘' : 'Ctrl+';

export const BrowserView = memo(
  ({
    tabsetId,
    profileId,
    registryScope = 'global',
    registryTabId,
    src,
    onUrlChange,
  }: {
    tabsetId: BrowserTabsetId;
    profileId?: BrowserProfileId;
    /**
     * App-control scope for the active tab's webview registration. Default is
     * `'global'` (standalone browser column); the per-session dock browser
     * should pass `'column'` + `registryTabId`.
     */
    registryScope?: AppHandleScope;
    registryTabId?: string;
    /**
     * External URL to navigate the active tab to. Used by the dock browser
     * when an agent `browser_open` tool fires — the agent's URL flows through
     * here and overrides whatever the user last typed.
     */
    src?: string;
    /** Called whenever the active tab's URL changes (user nav, agent nav). */
    onUrlChange?: (url: string) => void;
  }) => {
    const state = useStore($browserState);
    const tabset = state.tabsets[tabsetId];
    // Per-session dock browsers are transient and scoped to a workspace column,
    // so general-purpose-browser affordances (bookmarks, history) are only
    // surfaced in the global standalone column.
    const isGlobal = registryScope === 'global';
    const webviewRef = useRef<WebviewHandle>(null);
    const omniRef = useRef<OmniboxHandle>(null);
    const [previewState, setPreviewState] = useState<PreviewState>({ loading: false, error: null });
    const [findOpen, setFindOpen] = useState(false);
    const [findResult, setFindResult] = useState<{ ordinal: number; matches: number } | null>(null);
    const [historyOpen, setHistoryOpen] = useState(false);
    const [ctxMenu, setCtxMenu] = useState<ContextMenuParams | null>(null);
    const [devtoolsOpen, setDevtoolsOpen] = useState(false);
    const [consoleLog, setConsoleLog] = useState<Array<ConsoleMessage & { timestamp: number }>>([]);

    const handleConsoleMessage = useCallback((msg: ConsoleMessage) => {
      setConsoleLog((prev) => {
        const next = [...prev, { ...msg, timestamp: Date.now() }];
        return next.length > 500 ? next.slice(-500) : next;
      });
    }, []);

    const handleClearConsole = useCallback(() => setConsoleLog([]), []);

    // Resolve the active profile & partition.
    const resolvedProfileId = profileId ?? tabset?.profileId ?? 'default';
    const profile = state.profiles.find((p) => p.id === resolvedProfileId);
    const partition = profile?.partition ?? 'persist:browser-default';

    // Lazily create the tabset on first mount.
    useEffect(() => {
      if (!tabset) {
        void browserApi.ensureTabset(tabsetId, { profileId: resolvedProfileId });
      }
    }, [tabset, tabsetId, resolvedProfileId]);

    // Ask main to start watching `will-download` and permission requests on
    // this partition so the tray + prompt banner pick up items from it.
    useEffect(() => {
      if (!partition) {
        return;
      }
      void emitter.invoke('browser:downloads-watch-partition', partition).catch(() => {});
      void emitter.invoke('browser:permissions-watch-partition', partition).catch(() => {});
    }, [partition]);

    const activeTab = useMemo(() => getActiveTab(tabset), [tabset]);
    const activeTabId = activeTab?.id;

    // Clear the captured console log when the active tab changes — entries
    // are tied to the specific webContents, which is remounted on tab switch.
    useEffect(() => {
      setConsoleLog([]);
    }, [activeTabId]);

    // Reset preview state on tab switch so stale errors/loading don't leak.
    useEffect(() => {
      setPreviewState({ loading: false, error: null });
    }, [activeTabId]);

    // Sync active tab URL back up to the parent (if listening).
    const activeUrl = activeTab?.url;
    useEffect(() => {
      if (activeUrl) {
        onUrlChange?.(activeUrl);
      }
    }, [activeUrl, onUrlChange]);

    // External navigation: if parent passes a new `src`, nav the active tab.
    // Guarded by a ref so we only navigate on actual src changes, not on every
    // render where activeTab.url happens to match.
    const lastExternalSrcRef = useRef<string | undefined>(undefined);
    useEffect(() => {
      if (!src || !activeTab) {
        return;
      }
      if (src === lastExternalSrcRef.current) {
        return;
      }
      const normalizedSrc = normalizeAddress(src);
      lastExternalSrcRef.current = src;
      if (activeTab.url !== normalizedSrc) {
        void browserApi.navigateTab(tabsetId, activeTab.id, normalizedSrc);
      }
    }, [src, activeTab, tabsetId]);

    // --- Navigation callbacks --------------------------------------------------

    const handleNavigate = useCallback(
      (url: string) => {
        if (!activeTab) {
          return;
        }
        void browserApi.updateTabMeta(tabsetId, activeTab.id, { url });
        void browserApi.recordHistory({
          url,
          profileId: resolvedProfileId,
          ...(activeTab.title ? { title: activeTab.title } : {}),
        });
      },
      [activeTab, resolvedProfileId, tabsetId]
    );

    const handleTitle = useCallback(
      (title: string) => {
        if (!activeTab) {
          return;
        }
        void browserApi.updateTabMeta(tabsetId, activeTab.id, { title });
      },
      [activeTab, tabsetId]
    );

    const handleFavicon = useCallback(
      (favicon: string) => {
        if (!activeTab) {
          return;
        }
        void browserApi.updateTabMeta(tabsetId, activeTab.id, { favicon });
      },
      [activeTab, tabsetId]
    );

    const handleLoadingChange = useCallback((loading: boolean) => {
      setPreviewState((s) => ({ ...s, loading, error: loading ? null : s.error }));
    }, []);

    const handleError = useCallback((error: WebviewLoadError) => {
      setPreviewState({ loading: false, error });
    }, []);

    const handleFoundInPage = useCallback((r: FoundInPageResult) => {
      setFindResult({ ordinal: r.activeMatchOrdinal, matches: r.matches });
    }, []);

    const handleContextMenu = useCallback((params: ContextMenuParams) => {
      setCtxMenu(params);
    }, []);

    const contextMenuActions = useMemo(
      () => ({
        back: () => webviewRef.current?.goBack(),
        forward: () => webviewRef.current?.goForward(),
        reload: () => webviewRef.current?.reload(),
        navigate: (url: string) => {
          if (activeTab) {
            void browserApi.navigateTab(tabsetId, activeTab.id, url);
          }
        },
        openInNewTab: (url: string) => {
          void browserApi.createTab(tabsetId, { url, activate: true, profileId: resolvedProfileId });
        },
        openExternal: (url: string) => {
          void emitter.invoke('util:open-external', url).catch(() => {});
        },
        copyText: (text: string) => {
          void navigator.clipboard.writeText(text).catch(() => {});
        },
        viewSource: () => {
          if (activeTab) {
            void browserApi.createTab(tabsetId, {
              url: `view-source:${activeTab.url}`,
              activate: true,
              profileId: resolvedProfileId,
            });
          }
        },
        inspect: (_x: number, _y: number) => {
          webviewRef.current?.openDevTools();
        },
      }),
      [activeTab, resolvedProfileId, tabsetId]
    );

    const closeFind = useCallback(() => {
      setFindOpen(false);
      setFindResult(null);
    }, []);

    // Close find on tab switch / error — stale results are worse than empty.
    useEffect(() => {
      if (findOpen) {
        closeFind();
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeTabId]);

    // Shared "open this URL in the active tab" — used by the omnibox,
    // bookmarks bar, and history panel so user intent consistently lands on
    // the current tab.
    const navigateActive = useCallback(
      (url: string) => {
        if (!activeTab) {
          return;
        }
        void browserApi.navigateTab(tabsetId, activeTab.id, url);
      },
      [activeTab, tabsetId]
    );

    const handleOmniboxSubmit = useCallback(
      (url: string) => {
        if (!activeTab) {
          return;
        }
        void browserApi.navigateTab(tabsetId, activeTab.id, url);
      },
      [activeTab, tabsetId]
    );

    const handleNewTab = useCallback(() => {
      void browserApi.createTab(tabsetId, { profileId: resolvedProfileId, activate: true });
    }, [resolvedProfileId, tabsetId]);

    const [zoom, setZoom] = useState(1);

    const applyZoom = useCallback(
      (next: number) => {
        const clamped = Math.max(0.25, Math.min(5, next));
        setZoom(clamped);
        const handleId =
          registryScope === 'column' && registryTabId
            ? makeAppHandleId('column', 'browser', registryTabId)
            : makeAppHandleId('global', 'browser');
        // Tolerate races: if the webview hasn't registered yet we silently
        // skip — zoom will apply on next keystroke once it has.
        void emitter.invoke('app:set-zoom', handleId, clamped).catch(() => {});
      },
      [registryScope, registryTabId]
    );

    // Reset zoom when the active tab changes so each tab starts at 100%.
    useEffect(() => {
      setZoom(1);
    }, [activeTabId]);

    const handleBookmarkToggle = useCallback(() => {
      if (!activeTab) {
        return;
      }
      const existing = state.bookmarks.find((b) => b.url === activeTab.url);
      if (existing) {
        void browserApi.removeBookmark(existing.id);
      } else {
        void browserApi.addBookmark({ url: activeTab.url, title: activeTab.title ?? fallbackTitle(activeTab.url) });
      }
    }, [activeTab, state.bookmarks]);

    // --- Keyboard shortcuts ----------------------------------------------------

    useEffect(() => {
      const handler = (event: KeyboardEvent) => {
        const target = event.target as HTMLElement | null;
        const tag = target?.tagName?.toLowerCase();
        const isEditable = target?.isContentEditable || tag === 'input' || tag === 'textarea' || tag === 'select';
        const mod = event.metaKey || event.ctrlKey;

        // F12 toggles our devtools panel — no modifier, but we still want
        // it to work globally. Check it before the mod gate.
        if (event.key === 'F12') {
          event.preventDefault();
          setDevtoolsOpen((v) => !v);
          return;
        }

        if (!mod && event.key !== 'Escape') {
          return;
        }
        // Escape is always allowed (to stop a load); other shortcuts skip
        // when focus is in an editable element except for Cmd+L which is
        // specifically about re-focusing the omnibox.
        if (isEditable && event.key !== 'Escape' && event.key.toLowerCase() !== 'l') {
          return;
        }

        const key = event.key.toLowerCase();
        if (key === 't' && !event.shiftKey) {
          event.preventDefault();
          handleNewTab();
        } else if (key === 'w') {
          event.preventDefault();
          if (activeTabId) {
            void browserApi.closeTab(tabsetId, activeTabId);
          }
        } else if (key === 'l') {
          event.preventDefault();
          omniRef.current?.focus();
          omniRef.current?.select();
        } else if (key === 'r') {
          event.preventDefault();
          webviewRef.current?.reload();
        } else if (key === 'd' && isGlobal) {
          event.preventDefault();
          handleBookmarkToggle();
        } else if (key === 'f') {
          event.preventDefault();
          setFindOpen(true);
        } else if (event.shiftKey && key === 'h' && isGlobal) {
          event.preventDefault();
          setHistoryOpen(true);
        } else if (event.shiftKey && key === 't') {
          event.preventDefault();
          void browserApi.reopenTab(tabsetId);
        } else if (event.key === '=' || event.key === '+') {
          event.preventDefault();
          applyZoom(zoom + 0.1);
        } else if (event.key === '-' || event.key === '_') {
          event.preventDefault();
          applyZoom(zoom - 0.1);
        } else if (event.key === '0') {
          event.preventDefault();
          applyZoom(1);
        } else if (event.key === 'ArrowLeft' || event.key === '[') {
          event.preventDefault();
          webviewRef.current?.goBack();
        } else if (event.key === 'ArrowRight' || event.key === ']') {
          event.preventDefault();
          webviewRef.current?.goForward();
        } else if (event.key === 'Escape') {
          if (previewState.loading) {
            webviewRef.current?.stop();
          }
        }
      };
      window.addEventListener('keydown', handler);
      return () => window.removeEventListener('keydown', handler);
    }, [activeTabId, applyZoom, handleBookmarkToggle, handleNewTab, isGlobal, previewState.loading, tabsetId, zoom]);

    // --- Registry --------------------------------------------------------------

    const registryProps = useMemo(() => {
      if (!activeTab) {
        return undefined;
      }
      return {
        handleId: makeAppHandleId(registryScope, 'browser', registryScope === 'column' ? registryTabId : undefined),
        appId: 'browser' as const,
        kind: 'builtin-browser' as const,
        scope: registryScope,
        ...(registryScope === 'column' && registryTabId ? { tabId: registryTabId } : {}),
        label: 'Browser',
        browserTabsetId: tabsetId,
      };
    }, [activeTab, registryScope, registryTabId, tabsetId]);

    if (!tabset || !activeTab) {
      return (
        <div className="flex flex-col h-full w-full min-h-0 bg-card">
          <div className="relative flex-1 min-h-0 flex flex-col">{/* loading */}</div>
        </div>
      );
    }

    const bookmarked = state.bookmarks.some((b) => b.url === activeTab.url);
    const origin = parseOrigin(activeTab.url);
    const fallbackDiagnostics = previewState.error
      ? getWebviewFallbackDiagnostics(previewState.error, activeTab.url)
      : null;

    return (
      <div className="flex flex-col h-full w-full min-h-0 bg-card">
        <TabStrip tabset={tabset} onNewTab={handleNewTab} />
        <div className="flex items-center gap-1.5 h-9 pl-4 pr-4 border-b border-border bg-card relative">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Back"
            title={`Back (${MOD}←)`}
            onClick={() => webviewRef.current?.goBack()}
          >
            <ArrowLeft className="size-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Forward"
            title={`Forward (${MOD}→)`}
            onClick={() => webviewRef.current?.goForward()}
          >
            <ArrowRight className="size-4" />
          </Button>
          {previewState.loading ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Stop"
              title="Stop (Esc)"
              onClick={() => webviewRef.current?.stop()}
            >
              <X className="size-4" />
            </Button>
          ) : (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Reload"
              title={`Reload (${MOD}R)`}
              onClick={() => webviewRef.current?.reload()}
            >
              <RefreshCw className="size-4" />
            </Button>
          )}
          <Omnibox ref={omniRef} value={activeTab.url} onSubmit={handleOmniboxSubmit} />
          {isGlobal && (
            <Toggle
              size="sm"
              pressed={bookmarked}
              aria-label={bookmarked ? 'Remove bookmark' : 'Add bookmark'}
              title={bookmarked ? `Remove bookmark (${MOD}D)` : `Add bookmark (${MOD}D)`}
              onPressedChange={handleBookmarkToggle}
            >
              {bookmarked ? <Star className="size-4 text-warning" /> : <Star className="size-4" />}
            </Toggle>
          )}
          <Toggle
            size="sm"
            pressed={devtoolsOpen}
            aria-label={devtoolsOpen ? 'Close devtools' : 'Open devtools'}
            title={devtoolsOpen ? 'Close devtools (F12)' : 'Open devtools (F12)'}
            onPressedChange={setDevtoolsOpen}
          >
            <Wrench className={cn('size-3.5', devtoolsOpen && 'text-primary')} />
          </Toggle>
          <DownloadsTray />
        </div>
        {isGlobal && <BookmarksBar bookmarks={state.bookmarks} onOpen={navigateActive} />}
        <PermissionsBar partition={partition} />
        <div className="relative flex-1 min-h-0 flex flex-col">
          {previewState.loading && <div className="omni-browser-loading-bar" />}
          {fallbackDiagnostics ? (
            <Empty className="border-0">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Globe />
                </EmptyMedia>
                <EmptyTitle>{fallbackDiagnostics.title}</EmptyTitle>
                <EmptyDescription>{fallbackDiagnostics.reason}</EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <div className="text-xs text-muted-foreground">
                  <div className="mb-1 font-semibold">Canonical URL</div>
                  <div className="break-all">{fallbackDiagnostics.displayUrl}</div>
                </div>
                <p className="max-w-140 text-xs text-muted-foreground">{fallbackDiagnostics.instructions}</p>
                <ButtonGroup className="flex-wrap justify-center">
                  <Button
                    type="button"
                    onClick={() => {
                      setPreviewState({ loading: false, error: null });
                      webviewRef.current?.reload();
                    }}
                  >
                    Retry
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      void navigator.clipboard.writeText(fallbackDiagnostics.canonicalUrl).catch(() => {});
                    }}
                  >
                    Copy URL
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => openInBrowserTab(fallbackDiagnostics.canonicalUrl)}
                  >
                    Open in Browser
                  </Button>
                </ButtonGroup>
                {(fallbackDiagnostics.transportUrl || fallbackDiagnostics.debugDescription) && (
                  <Collapsible className="max-w-160 text-xs text-muted-foreground text-left">
                    <CollapsibleTrigger asChild>
                      <Button variant="ghost" size="sm" className="cursor-pointer text-center">
                        Details
                      </Button>
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                      {fallbackDiagnostics.debugDescription && (
                        <div>Reason: {fallbackDiagnostics.debugDescription}</div>
                      )}
                      {fallbackDiagnostics.transportUrl && (
                        <div>Proxy transport: {fallbackDiagnostics.transportUrl}</div>
                      )}
                    </CollapsibleContent>
                  </Collapsible>
                )}
              </EmptyContent>
            </Empty>
          ) : (
            <Webview
              ref={webviewRef}
              key={activeTab.id}
              src={activeTab.url}
              partition={partition}
              showUnavailable={false}
              onNavigate={handleNavigate}
              onLoadingChange={handleLoadingChange}
              onTitleChange={handleTitle}
              onFaviconChange={handleFavicon}
              onFoundInPage={handleFoundInPage}
              onContextMenu={handleContextMenu}
              onConsoleMessage={handleConsoleMessage}
              onError={handleError}
              registry={registryProps}
            />
          )}
          {ctxMenu && (
            <PageContextMenu params={ctxMenu} actions={contextMenuActions} onClose={() => setCtxMenu(null)} />
          )}
          {findOpen && <FindBar webviewRef={webviewRef} onClose={closeFind} result={findResult} />}
          {devtoolsOpen && registryProps && (
            <DevtoolsPanel
              handleId={registryProps.handleId}
              activeOrigin={origin ? `${origin.scheme}://${origin.host}` : null}
              consoleLog={consoleLog}
              onClear={handleClearConsole}
              onClose={() => setDevtoolsOpen(false)}
            />
          )}
          {isGlobal && historyOpen && (
            <HistoryPanel profileId={resolvedProfileId} onOpen={navigateActive} onClose={() => setHistoryOpen(false)} />
          )}
          {origin && false /* hidden placeholder; kept for future origin badge */}
        </div>
      </div>
    );
  }
);
BrowserView.displayName = 'BrowserView';
