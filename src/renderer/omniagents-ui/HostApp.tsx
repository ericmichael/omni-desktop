import { memo, useCallback, useEffect, useRef, useState } from 'react';

import type { ClientToolCallHandler } from './App';
import { ChatShell, type PendingMessage } from './ChatShell';
import { getGreeting } from './greeting';
import { OmniAgentsApp } from './LauncherApp';

type OmniAgentsHostState =
  | { type: 'ready'; uiUrl: string }
  | { type: 'loading' }
  | { type: 'idle'; onLaunch?: () => void; disabled?: boolean }
  | { type: 'error'; error: string; onRetry?: () => void };

type OmniAgentsHostAppProps = {
  state: OmniAgentsHostState;
  variables?: Record<string, unknown>;
  onClientToolCall?: ClientToolCallHandler;
  sessionId?: string;
  onSessionChange?: (sessionId: string | undefined) => void;
  onReady?: () => void;
  headerActionsTargetId?: string;
  headerActionsCompact?: boolean;
  pendingPlan?: import('@/shared/chat-types').PlanItem | null;
  onPlanDecision?: (approved: boolean) => void;
};

export const OmniAgentsHostApp = memo(
  ({ state, variables, onClientToolCall, sessionId, onSessionChange, onReady, headerActionsTargetId, headerActionsCompact, pendingPlan, onPlanDecision }: OmniAgentsHostAppProps) => {
    const [greeting] = useState(getGreeting);
    const [pendingMessages, setPendingMessages] = useState<PendingMessage[]>([]);
    const pendingRef = useRef(pendingMessages);
    pendingRef.current = pendingMessages;

    // Track whether the App layer has mounted so we can hide the shell underneath
    const [appMounted, setAppMounted] = useState(false);

    const handleShellSubmit = useCallback((msg: PendingMessage) => {
      setPendingMessages((prev) => [...prev, msg]);
    }, []);

    const isReady = state.type === 'ready';

    // Drain pending messages when transitioning to ready
    const drainedRef = useRef(false);
    let pendingForApp: PendingMessage[] | undefined;
    if (isReady && !drainedRef.current) {
      drainedRef.current = true;
      const msgs = pendingRef.current;
      if (msgs.length > 0) {
        pendingForApp = msgs;
        setPendingMessages([]);
      }
    }

    // Once the app is no longer ready (e.g. reconnect), reset
    useEffect(() => {
      if (!isReady) {
        drainedRef.current = false;
        setAppMounted(false);
      }
    }, [isReady]);

    // Signal that the App layer has painted (one frame after mount)
    const handleAppMounted = useCallback(() => {
      requestAnimationFrame(() => setAppMounted(true));
    }, []);

    const shellPhase =
      state.type === 'loading'
        ? 'loading' as const
        : state.type === 'error'
          ? 'error' as const
          : state.type === 'idle'
            ? 'idle' as const
            : 'loading' as const;

    return (
      <div className="w-full h-full relative">
        {/* Shell layer — visible until App has painted */}
        {(!isReady || !appMounted) && (
          <div className="absolute inset-0 z-0">
            <ChatShell
              greeting={greeting}
              phase={shellPhase}
              error={state.type === 'error' ? state.error : undefined}
              onRetry={state.type === 'error' ? state.onRetry : undefined}
              onLaunch={state.type === 'idle' ? state.onLaunch : undefined}
              launchDisabled={state.type === 'idle' ? state.disabled : undefined}
              onSubmit={handleShellSubmit}
              pendingMessages={pendingMessages}
            />
          </div>
        )}

        {/* App layer — mounted on top once ready */}
        {isReady && (
          <div className="absolute inset-0 z-10">
            <OmniAgentsApp
              uiUrl={state.uiUrl}
              variables={variables}
              greeting={greeting}
              sessionId={sessionId}
              onSessionChange={onSessionChange}
              onReady={() => {
                handleAppMounted();
                onReady?.();
              }}
              headerActionsTargetId={headerActionsTargetId}
              headerActionsCompact={headerActionsCompact}
              pendingMessages={pendingForApp}
              onClientToolCall={onClientToolCall}
              pendingPlan={pendingPlan}
              onPlanDecision={onPlanDecision}
            />
          </div>
        )}
      </div>
    );
  }
);
OmniAgentsHostApp.displayName = 'OmniAgentsHostApp';
