/**
 * Unified Browser surface. Used both as:
 *   - a standalone code-deck column (chrome="full")
 *   - the per-session browser app inside the env dock (chrome="full")
 *
 * Owns the tab strip, omnibox, webview, and loading-bar. All mutations go
 * through `browserApi` so main-process is the single source of truth across
 * tabs, history, bookmarks, and profiles.
 */
import { makeStyles, mergeClasses, shorthands, tokens } from '@fluentui/react-components';
import {
  ArrowClockwise20Regular,
  ArrowLeft20Regular,
  ArrowRight20Regular,
  BookOpen20Filled,
  BookOpen20Regular,
  Dismiss20Regular,
  Globe20Regular,
  Star20Filled,
  Star20Regular,
  WindowDevTools20Regular,
} from '@fluentui/react-icons';
import { useStore } from '@nanostores/react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { fallbackTitle, parseOrigin } from '@/lib/url';
import type { ConsoleMessage, ContextMenuParams, FoundInPageResult, WebviewHandle } from '@/renderer/common/Webview';
import { Webview } from '@/renderer/common/Webview';
import { BookmarksBar } from '@/renderer/features/Browser/BookmarksBar';
import { DevtoolsPanel } from '@/renderer/features/Browser/Devtools/DevtoolsPanel';
import { DownloadsTray } from '@/renderer/features/Browser/DownloadsTray';
import { FindBar } from '@/renderer/features/Browser/FindBar';
import { HistoryPanel } from '@/renderer/features/Browser/HistoryPanel';
import { Omnibox, type OmniboxHandle } from '@/renderer/features/Browser/Omnibox';
import { PageContextMenu } from '@/renderer/features/Browser/PageContextMenu';
import { PermissionsBar } from '@/renderer/features/Browser/PermissionsBar';
import { ProfileSwitcher } from '@/renderer/features/Browser/ProfileSwitcher';
import { READER_MODE_CSS } from '@/renderer/features/Browser/reader-mode';
import { $browserState, browserApi, getActiveTab } from '@/renderer/features/Browser/state';
import { TabStrip } from '@/renderer/features/Browser/TabStrip';
import { emitter } from '@/renderer/services/ipc';
import type { AppHandleScope } from '@/shared/app-control-types';
import { makeAppHandleId } from '@/shared/app-control-types';
import type { BrowserProfileId, BrowserTabsetId } from '@/shared/types';

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    width: '100%',
    minHeight: 0,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  rootGlass: {
    backgroundColor: 'transparent',
  },
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    height: '36px',
    paddingLeft: tokens.spacingHorizontalM,
    paddingRight: tokens.spacingHorizontalM,
    ...shorthands.borderBottom('1px', 'solid', tokens.colorNeutralStroke1),
    backgroundColor: tokens.colorNeutralBackground2,
    position: 'relative',
  },
  toolbarGlass: {
    backgroundColor: 'transparent',
    borderBottomColor: 'rgba(255, 255, 255, 0.14)',
  },
  navBtn: {
    display: 'inline-flex',
    width: '26px',
    height: '26px',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: tokens.borderRadiusMedium,
    border: 'none',
    backgroundColor: 'transparent',
    color: tokens.colorNeutralForeground2,
    cursor: 'pointer',
    flexShrink: 0,
    ':hover': { backgroundColor: tokens.colorSubtleBackgroundHover, color: tokens.colorNeutralForeground1 },
    ':disabled': { opacity: 0.4, cursor: 'not-allowed', ':hover': { backgroundColor: 'transparent' } },
  },
  body: {
    position: 'relative',
    flex: '1 1 0',
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
  },
  loadingBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: '2px',
    overflow: 'hidden',
    zIndex: 1,
    pointerEvents: 'none',
    '::before': {
      content: '""',
      position: 'absolute',
      top: 0,
      bottom: 0,
      width: '40%',
      backgroundImage: `linear-gradient(90deg, transparent, ${tokens.colorBrandBackground}, transparent)`,
      animationName: {
        '0%': { transform: 'translateX(-100%)' },
        '100%': { transform: 'translateX(250%)' },
      },
      animationDuration: '1.4s',
      animationTimingFunction: 'linear',
      animationIterationCount: 'infinite',
    },
  },
  errorPane: {
    flex: '1 1 0',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: tokens.spacingVerticalM,
    padding: tokens.spacingHorizontalXL,
    textAlign: 'center',
    color: tokens.colorNeutralForeground2,
  },
  errorTitle: { fontSize: tokens.fontSizeBase400, fontWeight: tokens.fontWeightSemibold, color: tokens.colorNeutralForeground1 },
  errorUrl: { fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground3, wordBreak: 'break-all' },
  errorActions: { display: 'flex', gap: tokens.spacingHorizontalS },
  errorButton: {
    paddingLeft: tokens.spacingHorizontalM,
    paddingRight: tokens.spacingHorizontalM,
    height: '28px',
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorBrandBackground,
    color: tokens.colorNeutralForegroundOnBrand,
    border: 'none',
    cursor: 'pointer',
    ':hover': { backgroundColor: tokens.colorBrandBackgroundHover },
  },
  errorButtonGhost: {
    paddingLeft: tokens.spacingHorizontalM,
    paddingRight: tokens.spacingHorizontalM,
    height: '28px',
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: 'transparent',
    color: tokens.colorNeutralForeground1,
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke1),
    cursor: 'pointer',
    ':hover': { backgroundColor: tokens.colorSubtleBackgroundHover },
  },
});

type PreviewState = {
  loading: boolean;
  error: { code: number; description: string; url: string } | null;
};

export const BrowserView = memo(
  ({
    tabsetId,
    profileId,
    isGlass,
    registryScope = 'global',
    registryTabId,
    src,
    onUrlChange,
  }: {
    tabsetId: BrowserTabsetId;
    profileId?: BrowserProfileId;
    isGlass?: boolean;
    /**
     * App-control scope for the active tab's webview registration. Default is
     * `'global'` (standalone browser column); the per-session dock browser
     * should pass `'column'` + `registryTabId`.
     */
    registryScope?: AppHandleScope;
    registryTabId?: string;
    /**
     * External URL to navigate the active tab to. Used by the dock browser
     * when an agent `open_preview` tool fires — the agent's URL flows through
     * here and overrides whatever the user last typed.
     */
    src?: string;
    /** Called whenever the active tab's URL changes (user nav, agent nav). */
    onUrlChange?: (url: string) => void;
  }) => {
    const styles = useStyles();
    const state = useStore($browserState);
    const tabset = state.tabsets[tabsetId];
    const webviewRef = useRef<WebviewHandle>(null);
    const omniRef = useRef<OmniboxHandle>(null);
    const [previewState, setPreviewState] = useState<PreviewState>({ loading: false, error: null });
    const [findOpen, setFindOpen] = useState(false);
    const [findResult, setFindResult] = useState<{ ordinal: number; matches: number } | null>(null);
    const [historyOpen, setHistoryOpen] = useState(false);
    const [ctxMenu, setCtxMenu] = useState<ContextMenuParams | null>(null);
    const [readerKey, setReaderKey] = useState<string | null>(null);
    const [devtoolsOpen, setDevtoolsOpen] = useState(false);
    const [consoleLog, setConsoleLog] = useState<Array<ConsoleMessage & { timestamp: number }>>([]);

    const handleConsoleMessage = useCallback((msg: ConsoleMessage) => {
      setConsoleLog((prev) => {
        const next = [...prev, { ...msg, timestamp: Date.now() }];
        return next.length > 500 ? next.slice(-500) : next;
      });
    }, []);

    const handleClearConsole = useCallback(() => setConsoleLog([]), []);

    const toggleReader = useCallback(async () => {
      const handle = webviewRef.current;
      if (!handle) {
return;
}
      if (readerKey) {
        await handle.removeInsertedCSS(readerKey);
        setReaderKey(null);
      } else {
        const key = await handle.insertCSS(READER_MODE_CSS);
        setReaderKey(key);
      }
    }, [readerKey]);

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

    // Reset reader state when the active tab changes — the injected CSS is
    // tied to the specific webContents, which is remounted on tab switch.
    useEffect(() => {
      setReaderKey(null);
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
      lastExternalSrcRef.current = src;
      if (activeTab.url !== src) {
        void browserApi.navigateTab(tabsetId, activeTab.id, src);
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

    const handleError = useCallback((error: { code: number; description: string; url: string }) => {
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
void browserApi.createTab(tabsetId, { url: `view-source:${activeTab.url}`, activate: true, profileId: resolvedProfileId });
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
        const handleId = registryScope === 'column' && registryTabId
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
        const isEditable =
          target?.isContentEditable || tag === 'input' || tag === 'textarea' || tag === 'select';
        const mod = event.metaKey || event.ctrlKey;
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
        if (key === 't') {
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
        } else if (key === 'd') {
          event.preventDefault();
          handleBookmarkToggle();
        } else if (key === 'f') {
          event.preventDefault();
          setFindOpen(true);
        } else if (event.shiftKey && key === 'h') {
          event.preventDefault();
          setHistoryOpen(true);
        } else if (event.shiftKey && key === 't') {
          event.preventDefault();
          void browserApi.reopenTab(tabsetId);
        } else if (event.altKey && key === 'r') {
          event.preventDefault();
          void toggleReader();
        } else if (event.altKey && key === 'i') {
          event.preventDefault();
          setDevtoolsOpen((v) => !v);
        } else if (event.key === '=' || event.key === '+') {
          event.preventDefault();
          applyZoom(zoom + 0.1);
        } else if (event.key === '-' || event.key === '_') {
          event.preventDefault();
          applyZoom(zoom - 0.1);
        } else if (event.key === '0') {
          event.preventDefault();
          applyZoom(1);
        } else if (event.key === '[') {
          event.preventDefault();
          webviewRef.current?.goBack();
        } else if (event.key === ']') {
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
    }, [activeTabId, applyZoom, handleBookmarkToggle, handleNewTab, previewState.loading, tabsetId, toggleReader, zoom]);

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
        <div className={mergeClasses(styles.root, isGlass && styles.rootGlass)}>
          <div className={styles.body}>{/* loading */}</div>
        </div>
      );
    }

    const bookmarked = state.bookmarks.some((b) => b.url === activeTab.url);
    const origin = parseOrigin(activeTab.url);

    return (
      <div className={mergeClasses(styles.root, isGlass && styles.rootGlass)}>
        <TabStrip tabset={tabset} isGlass={isGlass} onNewTab={handleNewTab} />
        <div className={mergeClasses(styles.toolbar, isGlass && styles.toolbarGlass)}>
          <button
            type="button"
            className={styles.navBtn}
            aria-label="Back"
            title="Back (Ctrl+[)"
            onClick={() => webviewRef.current?.goBack()}
          >
            <ArrowLeft20Regular style={{ width: 14, height: 14 }} />
          </button>
          <button
            type="button"
            className={styles.navBtn}
            aria-label="Forward"
            title="Forward (Ctrl+])"
            onClick={() => webviewRef.current?.goForward()}
          >
            <ArrowRight20Regular style={{ width: 14, height: 14 }} />
          </button>
          {previewState.loading ? (
            <button
              type="button"
              className={styles.navBtn}
              aria-label="Stop"
              title="Stop (Esc)"
              onClick={() => webviewRef.current?.stop()}
            >
              <Dismiss20Regular style={{ width: 14, height: 14 }} />
            </button>
          ) : (
            <button
              type="button"
              className={styles.navBtn}
              aria-label="Reload"
              title="Reload (Ctrl+R)"
              onClick={() => webviewRef.current?.reload()}
            >
              <ArrowClockwise20Regular style={{ width: 14, height: 14 }} />
            </button>
          )}
          <Omnibox ref={omniRef} value={activeTab.url} onSubmit={handleOmniboxSubmit} />
          <button
            type="button"
            className={styles.navBtn}
            aria-label={readerKey ? 'Exit reader mode' : 'Reader mode'}
            aria-pressed={!!readerKey}
            title={readerKey ? 'Exit reader mode (Alt+R)' : 'Reader mode (Alt+R)'}
            onClick={() => void toggleReader()}
          >
            {readerKey ? (
              <BookOpen20Filled style={{ width: 14, height: 14 }} />
            ) : (
              <BookOpen20Regular style={{ width: 14, height: 14 }} />
            )}
          </button>
          <button
            type="button"
            className={styles.navBtn}
            aria-label={bookmarked ? 'Remove bookmark' : 'Add bookmark'}
            aria-pressed={bookmarked}
            title={bookmarked ? 'Remove bookmark (Ctrl+D)' : 'Add bookmark (Ctrl+D)'}
            onClick={handleBookmarkToggle}
          >
            {bookmarked ? (
              <Star20Filled style={{ width: 14, height: 14, color: 'goldenrod' }} />
            ) : (
              <Star20Regular style={{ width: 14, height: 14 }} />
            )}
          </button>
          <button
            type="button"
            className={styles.navBtn}
            aria-label={devtoolsOpen ? 'Close devtools' : 'Open devtools'}
            aria-pressed={devtoolsOpen}
            title={devtoolsOpen ? 'Close devtools (Alt+I)' : 'Open devtools (Alt+I)'}
            onClick={() => setDevtoolsOpen((v) => !v)}
          >
            <WindowDevTools20Regular style={{ width: 14, height: 14 }} />
          </button>
          <DownloadsTray />
          <ProfileSwitcher tabsetId={tabsetId} profiles={state.profiles} currentProfileId={resolvedProfileId} />
        </div>
        <BookmarksBar bookmarks={state.bookmarks} isGlass={isGlass} onOpen={navigateActive} />
        <PermissionsBar partition={partition} />
        <div className={styles.body}>
          {previewState.loading && <div className={styles.loadingBar} />}
          {previewState.error ? (
            <div className={styles.errorPane}>
              <Globe20Regular style={{ width: 40, height: 40, opacity: 0.5 }} />
              <div className={styles.errorTitle}>This page didn’t load</div>
              <div>{previewState.error.description || 'Something went wrong.'}</div>
              <div className={styles.errorUrl}>{previewState.error.url || activeTab.url}</div>
              <div className={styles.errorActions}>
                <button
                  type="button"
                  className={styles.errorButton}
                  onClick={() => {
                    setPreviewState({ loading: false, error: null });
                    webviewRef.current?.reload();
                  }}
                >
                  Retry
                </button>
                <button
                  type="button"
                  className={styles.errorButtonGhost}
                  onClick={() => {
                    void navigator.clipboard.writeText(activeTab.url).catch(() => {});
                  }}
                >
                  Copy URL
                </button>
              </div>
            </div>
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
          {historyOpen && (
            <HistoryPanel
              profileId={resolvedProfileId}
              onOpen={navigateActive}
              onClose={() => setHistoryOpen(false)}
            />
          )}
          {origin && false /* hidden placeholder; kept for future origin badge */}
        </div>
      </div>
    );
  }
);
BrowserView.displayName = 'BrowserView';
