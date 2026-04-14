import './styles/index.css';

import type { ReactNode } from 'react';
import { useEffect, useMemo } from 'react';

import type { ClientToolCallHandler } from './App';
import { App as OmniAgentsCore } from './App';
import type { PendingMessage } from './ChatShell';
import { RPCClientProvider } from './rpc-context';
import { UiConfigProvider, useUiConfig } from './ui-config';

type OmniAgentsAppProps = {
  uiUrl: string;
  sessionId?: string;
  onSessionChange?: (sessionId: string | undefined) => void;
  variables?: Record<string, unknown>;
  greeting?: string;
  onReady?: () => void;
  headerActionsTargetId?: string;
  headerActionsCompact?: boolean;
  pendingMessages?: PendingMessage[];
  sandboxLabel?: string;
  onClientToolCall?: ClientToolCallHandler;
  pendingPlan?: import('@/shared/chat-types').PlanItem | null;
  onPlanDecision?: (approved: boolean) => void;
};

const ThemeSync = ({ children }: { children: ReactNode }) => {
  const { theme } = useUiConfig();

  useEffect(() => {
    if (!theme || theme === 'default') {
      document.documentElement.removeAttribute('data-theme');
      return;
    }
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  return <>{children}</>;
};

export const OmniAgentsApp = ({ uiUrl, sessionId, onSessionChange, variables, greeting, onReady, headerActionsTargetId, headerActionsCompact, pendingMessages, sandboxLabel, onClientToolCall, pendingPlan, onPlanDecision }: OmniAgentsAppProps) => {
  const normalizedUrl = useMemo(() => new URL(uiUrl, window.location.origin).toString(), [uiUrl]);

  return (
    <UiConfigProvider uiUrl={normalizedUrl}>
      <RPCClientProvider>
        <ThemeSync>
          <OmniAgentsCore sessionId={sessionId} onSessionChange={onSessionChange} variables={variables} greeting={greeting} onReady={onReady} headerActionsTargetId={headerActionsTargetId} headerActionsCompact={headerActionsCompact} pendingMessages={pendingMessages} sandboxLabel={sandboxLabel} onClientToolCall={onClientToolCall} pendingPlan={pendingPlan} onPlanDecision={onPlanDecision} />
        </ThemeSync>
      </RPCClientProvider>
    </UiConfigProvider>
  );
};
