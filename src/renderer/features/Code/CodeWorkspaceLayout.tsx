import { makeStyles, mergeClasses, shorthands, tokens } from '@fluentui/react-components';
import { useStore } from '@nanostores/react';
import { AnimatePresence, motion } from 'framer-motion';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';

import type { WebviewRegistryProps } from '@/renderer/common/Webview';
import { Webview } from '@/renderer/common/Webview';
import { BrowserView } from '@/renderer/features/Browser/BrowserView';
import { ConsoleStarted } from '@/renderer/features/Console/ConsoleRunning';
import { OmniAgentsApp } from '@/renderer/omniagents-ui';
import type { ClientToolCallHandler } from '@/renderer/omniagents-ui/App';
import { persistedStoreApi } from '@/renderer/services/store';
import { makeAppHandleId } from '@/shared/app-control-types';
import type { AppDescriptor, AppId } from '@/shared/app-registry';
import { buildAppRegistry } from '@/shared/app-registry';

import { AppIcon } from './AppIcon';
import { EnvironmentDock } from './EnvironmentDock';

type CodeWorkspaceLayoutProps = {
  uiSrc: string;
  sessionId?: string;
  onSessionChange?: (sessionId: string | undefined) => void;
  variables?: Record<string, unknown>;
  codeServerSrc?: string;
  vncSrc?: string;
  previewUrl?: string;
  onPreviewUrlChange?: (url: string) => void;
  activeApp?: AppId;
  onActiveAppChange?: (app: AppId) => void;
  onReady?: () => void;
  headerActionsTargetId?: string;
  headerActionsCompact?: boolean;
  sandboxLabel?: string;
  onClientToolCall?: ClientToolCallHandler;
  pendingPlan?: import('@/shared/chat-types').PlanItem | null;
  onPlanDecision?: (approved: boolean) => void;
  dockTargetId?: string;
  isGlass?: boolean;
  /**
   * When provided, this layout hosts a column-scoped workspace and all its
   * webviews register under `tab-<tabId>:*`. Omit for the global dock.
   */
  tabId?: string;
  /**
   * cwd for terminals opened from this layout's dock. When the tab is bound to
   * a ticket with a worktree, pass the worktree path so shells land there
   * instead of the global project workspace.
   */
  terminalCwd?: string;
  /**
   * When true, the active dock app renders OUTSIDE this layout (as an adjacent
   * deck column). Chat stays visible and no in-column overlay is drawn.
   */
  sidecarMode?: boolean;
};

/** Build a `WebviewRegistryProps` entry from an AppDescriptor + layout scope. */
function makeRegistryProps(app: AppDescriptor, tabId: string | undefined): WebviewRegistryProps {
  const scope = tabId ? 'column' : 'global';
  return {
    handleId: makeAppHandleId(scope, app.id, tabId),
    appId: app.id,
    kind: app.kind,
    scope,
    tabId,
    label: app.label,
  };
}

const useStyles = makeStyles({
  surfaceCard: {
    position: 'absolute',
    inset: 0,
    zIndex: 40,
    overflow: 'hidden',
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: `0 1px 0 rgba(255,255,255,0.04) inset`,
  },
  surfaceCardGlass: {
    backgroundColor: `color-mix(in srgb, ${tokens.colorNeutralBackground1} 18%, transparent)`,
    backdropFilter: 'blur(36px) saturate(160%)',
    WebkitBackdropFilter: 'blur(36px) saturate(160%)',
    boxShadow: `0 1px 0 rgba(255,255,255,0.10) inset, 0 -1px 0 rgba(255,255,255,0.04) inset`,
  },
  surfaceInner: { display: 'flex', height: '100%', flexDirection: 'column', backgroundColor: 'inherit' },
  surfaceHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    ...shorthands.borderBottom('1px', 'solid', tokens.colorNeutralStroke1),
    backgroundColor: tokens.colorNeutralBackground2,
    minHeight: '44px',
    paddingLeft: tokens.spacingHorizontalM,
    paddingRight: tokens.spacingHorizontalM,
    paddingTop: tokens.spacingVerticalXS,
    paddingBottom: tokens.spacingVerticalXS,
    gap: tokens.spacingHorizontalM,
  },
  surfaceHeaderGlass: {
    backgroundColor: `color-mix(in srgb, ${tokens.colorNeutralBackground2} 14%, transparent)`,
    backdropFilter: 'blur(24px) saturate(160%)',
    WebkitBackdropFilter: 'blur(24px) saturate(160%)',
    borderBottomColor: 'rgba(255, 255, 255, 0.14)',
  },
  surfaceHeaderLeft: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    fontSize: tokens.fontSizeBase300,
    color: tokens.colorNeutralForeground2,
    flex: '1 1 0',
    minWidth: 0,
  },
  surfaceHeaderTitle: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    flexShrink: 0,
  },
  surfaceTitleText: {
    color: tokens.colorNeutralForeground1,
    fontWeight: tokens.fontWeightMedium,
    letterSpacing: '-0.01em',
  },
  surfaceHeaderToolbar: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    flex: '1 1 0',
    minWidth: 0,
  },
  surfaceHeaderActions: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    flexShrink: 0,
  },
  surfaceNavBtn: {
    display: 'inline-flex',
    width: '30px',
    height: '30px',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: tokens.borderRadiusMedium,
    color: tokens.colorNeutralForeground3,
    transitionProperty: 'color, background-color',
    transitionDuration: '150ms',
    border: 'none',
    backgroundColor: 'transparent',
    cursor: 'pointer',
    flexShrink: 0,
    ':hover': { backgroundColor: tokens.colorSubtleBackgroundHover, color: tokens.colorNeutralForeground1 },
  },
  loadingBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: '2px',
    overflow: 'hidden',
    zIndex: 1,
    backgroundColor: 'transparent',
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
  surfaceBody: { minHeight: 0, flex: '1 1 0', position: 'relative', display: 'flex', flexDirection: 'column', backgroundColor: tokens.colorNeutralBackground1 },
  surfaceBodyGlass: {
    backgroundColor: `color-mix(in srgb, ${tokens.colorNeutralBackground1} 10%, transparent)`,
  },
  surfaceContentFill: { flex: '1 1 0', minHeight: 0, minWidth: 0 },
  browserUrlWrap: { minWidth: '240px', flex: '1 1 360px' },
  root: {
    position: 'relative',
    display: 'flex',
    height: '100%',
    width: '100%',
    flexDirection: 'column',
    backgroundColor: tokens.colorNeutralBackground1,
  },
  rootGlass: {
    backgroundColor: 'transparent',
  },
  mainArea: { position: 'relative', minHeight: 0, flex: '1 1 0' },
  mainContent: { height: '100%', width: '100%', minWidth: 0 },
  mainContentHidden: { display: 'none' },
  unavailableState: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    color: tokens.colorNeutralForeground4,
    fontSize: tokens.fontSizeBase300,
  },
  glassChatSurfaces: {
    '& .bg-surface, & .bg-card, & .bg-background, & .bg-bgColumn, & .bg-bgCard, & .bg-bgCardAlt, & .bg-bgMain': {
      backgroundColor: `color-mix(in srgb, ${tokens.colorNeutralBackground1} 22%, transparent)`,
      backdropFilter: 'blur(28px) saturate(160%)',
      WebkitBackdropFilter: 'blur(28px) saturate(160%)',
    },
    '& .bg-secondary': {
      backgroundColor: `color-mix(in srgb, ${tokens.colorNeutralBackground1} 22%, transparent)`,
      backdropFilter: 'blur(20px) saturate(160%)',
      WebkitBackdropFilter: 'blur(20px) saturate(160%)',
      boxShadow: `0 1px 0 0 rgba(255,255,255,0.12) inset, 0 2px 8px -2px rgba(0,0,0,0.15)`,
    },
    '& .bg-primary': {
      backgroundColor: `color-mix(in srgb, ${tokens.colorBrandBackground} 70%, transparent)`,
      backdropFilter: 'blur(20px) saturate(160%)',
      WebkitBackdropFilter: 'blur(20px) saturate(160%)',
      boxShadow: `0 1px 0 0 rgba(255,255,255,0.14) inset, 0 2px 8px -2px rgba(0,0,0,0.15)`,
    },
    '& .chat-input-footer': {
      position: 'relative',
      overflow: 'hidden',
      backgroundColor: 'transparent',
      backdropFilter: 'none',
      WebkitBackdropFilter: 'none',
      borderTop: `1px solid rgba(255, 255, 255, 0.14)`,
    },
    '& .chat-input-footer::before': {
      content: '""',
      position: 'absolute',
      top: '12px',
      right: '12px',
      bottom: '12px',
      left: '12px',
      borderRadius: '24px',
      boxShadow: '0 0 0 9999px rgba(255, 255, 255, 0.06)',
      pointerEvents: 'none',
      zIndex: 0,
    },
    '& .chat-input-footer > *': {
      position: 'relative',
      zIndex: 1,
    },
    '& .chat-input-footer .bg-bgCardAlt': {
      backgroundColor: 'transparent',
      backdropFilter: 'none',
      WebkitBackdropFilter: 'none',
    },
  },
});

const transition = { type: 'spring' as const, duration: 0.28, bounce: 0.08 };

const BUILTIN_TITLES: Record<string, string> = {
  code: 'VS Code',
  desktop: "Omni's PC",
  browser: 'Browser',
  terminal: 'Terminal',
};

const SurfaceFrame = memo(({ app, isGlass, children }: { app: AppDescriptor; isGlass?: boolean; children: React.ReactNode }) => {
  const styles = useStyles();
  const title = BUILTIN_TITLES[app.id] ?? app.label;

  return (
    <div className={mergeClasses(styles.surfaceInner)}>
      <div className={mergeClasses(styles.surfaceHeader, isGlass && styles.surfaceHeaderGlass)}>
        <div className={styles.surfaceHeaderTitle}>
          <AppIcon icon={app.icon} size={14} />
          <span className={styles.surfaceTitleText}>{title}</span>
        </div>
        <div className={styles.surfaceHeaderActions} />
      </div>
      <div className={mergeClasses(styles.surfaceBody, isGlass && styles.surfaceBodyGlass)}>
        <div className={styles.surfaceContentFill}>{children}</div>
      </div>
    </div>
  );
});
SurfaceFrame.displayName = 'SurfaceFrame';

const AppSurfaceView = memo(({ app, src, onUrlChange, isGlass, tabId, terminalCwd }: { app: AppDescriptor; src?: string; onUrlChange?: (url: string) => void; isGlass?: boolean; tabId?: string; terminalCwd?: string }) => {
  const styles = useStyles();
  const registryProps = useMemo(() => makeRegistryProps(app, tabId), [app, tabId]);

  if (app.kind === 'builtin-browser') {
    return (
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={transition} className={mergeClasses(styles.surfaceCard, isGlass && styles.surfaceCardGlass)}>
        <BrowserView
          tabsetId={tabId ? `dock:${tabId}` : 'dock:global'}
          isGlass={isGlass}
          registryScope={tabId ? 'column' : 'global'}
          registryTabId={tabId}
          src={src}
          onUrlChange={onUrlChange}
        />
      </motion.div>
    );
  }

  if (app.kind === 'builtin-terminal') {
    if (!tabId) {
      return (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={transition} className={mergeClasses(styles.surfaceCard, isGlass && styles.surfaceCardGlass)}>
          <SurfaceFrame app={app} isGlass={isGlass}>
            <div className={styles.unavailableState}>Terminal requires a workspace column.</div>
          </SurfaceFrame>
        </motion.div>
      );
    }
    return (
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={transition} className={mergeClasses(styles.surfaceCard, isGlass && styles.surfaceCardGlass)}>
        <SurfaceFrame app={app} isGlass={isGlass}>
          <ConsoleStarted tabId={tabId} cwd={terminalCwd} />
        </SurfaceFrame>
      </motion.div>
    );
  }

  if (app.kind === 'webview') {
    return (
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={transition} className={mergeClasses(styles.surfaceCard, isGlass && styles.surfaceCardGlass)}>
        <SurfaceFrame app={app} isGlass={isGlass}>
          {app.url ? <Webview src={app.url} showUnavailable={false} registry={registryProps} /> : <div className={styles.unavailableState}>No URL configured.</div>}
        </SurfaceFrame>
      </motion.div>
    );
  }

  // builtin-code, builtin-desktop
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={transition} className={mergeClasses(styles.surfaceCard, isGlass && styles.surfaceCardGlass)}>
      <SurfaceFrame app={app} isGlass={isGlass}>
        {src ? <Webview src={src} showUnavailable={false} registry={registryProps} /> : <div className={styles.unavailableState}>{app.label} is unavailable for this workspace.</div>}
      </SurfaceFrame>
    </motion.div>
  );
});
AppSurfaceView.displayName = 'AppSurfaceView';

export const CodeWorkspaceLayout = memo(({ uiSrc, sessionId, onSessionChange, variables, codeServerSrc, vncSrc, previewUrl, onPreviewUrlChange, activeApp = 'chat', onActiveAppChange, onReady, headerActionsTargetId, headerActionsCompact, sandboxLabel, onClientToolCall, pendingPlan, onPlanDecision, dockTargetId, isGlass, tabId, terminalCwd, sidecarMode }: CodeWorkspaceLayoutProps) => {
  const styles = useStyles();
  const store = useStore(persistedStoreApi.$atom);
  const registry = useMemo(() => buildAppRegistry(store.customApps ?? []), [store.customApps]);
  // The dock only surfaces apps marked column-scoped. Global-only custom
  // apps are opened via the app launcher as their own deck column instead.
  const dockApps = useMemo(() => registry.filter((a) => a.columnScoped), [registry]);
  const activeDescriptor = useMemo(() => registry.find((a) => a.id === activeApp) ?? null, [registry, activeApp]);

  const sandboxUrls = useMemo(
    () => ({ codeServerUrl: codeServerSrc, noVncUrl: vncSrc }),
    [codeServerSrc, vncSrc]
  );

  const surfaceSrc = activeDescriptor
    ? activeDescriptor.kind === 'builtin-code'
      ? codeServerSrc
      : activeDescriptor.kind === 'builtin-desktop'
        ? vncSrc
        : activeDescriptor.kind === 'builtin-browser'
          ? previewUrl
          : undefined
    : undefined;

  useEffect(() => {
    if ((activeApp === 'code' && !codeServerSrc) || (activeApp === 'desktop' && !vncSrc)) {
      onActiveAppChange?.('chat');
    }
  }, [activeApp, codeServerSrc, vncSrc, onActiveAppChange]);

  const [dockTarget, setDockTarget] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (!dockTargetId) {
      setDockTarget(null);
      return;
    }
    setDockTarget(document.getElementById(dockTargetId));
  }, [dockTargetId]);

  const handleUiReady = useCallback(() => {
    onReady?.();
  }, [onReady]);

  const handleDockSelect = useCallback(
    (id: AppId) => {
      onActiveAppChange?.(id);
    },
    [onActiveAppChange]
  );

  return (
    <div className={mergeClasses(styles.root, isGlass && styles.rootGlass, isGlass && styles.glassChatSurfaces)}>
      <div className={styles.mainArea}>
        <div className={mergeClasses(styles.mainContent, !sidecarMode && activeApp !== 'chat' && styles.mainContentHidden)}>
          <OmniAgentsApp uiUrl={uiSrc} sessionId={sessionId} onSessionChange={onSessionChange} variables={variables} onReady={handleUiReady} headerActionsTargetId={headerActionsTargetId} headerActionsCompact={headerActionsCompact} sandboxLabel={sandboxLabel} onClientToolCall={onClientToolCall} pendingPlan={pendingPlan} onPlanDecision={onPlanDecision} />
        </div>
        {!sidecarMode && (
          <AnimatePresence>
            {activeApp !== 'chat' && activeDescriptor && (
              <AppSurfaceView
                app={activeDescriptor}
                src={surfaceSrc}
                onUrlChange={activeDescriptor.kind === 'builtin-browser' ? onPreviewUrlChange : undefined}
                isGlass={isGlass}
                tabId={tabId}
                terminalCwd={terminalCwd}
              />
            )}
          </AnimatePresence>
        )}
      </div>
      {(() => {
        const dock = (
          <EnvironmentDock
            apps={dockApps}
            activeAppId={activeApp}
            onSelect={handleDockSelect}
            sandboxUrls={sandboxUrls}
            isGlass={isGlass}
          />
        );
        if (dockTargetId && dockTarget) {
          return createPortal(dock, dockTarget);
        }
        return dock;
      })()}
    </div>
  );
});
CodeWorkspaceLayout.displayName = 'CodeWorkspaceLayout';
