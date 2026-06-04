import type { ReactNode } from 'react';
import { useEffect, useMemo } from 'react';

import { serverOrigin } from '@/renderer/services/ipc';
import type { PlanItem } from '@/shared/chat-types';
import type { TicketId } from '@/shared/types';

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
  voiceVariables?: Record<string, unknown>;
  greeting?: string;
  onReady?: () => void;
  headerActionsTargetId?: string;
  headerActionsCompact?: boolean;
  pendingMessages?: PendingMessage[];
  sandboxLabel?: string;
  /** Options shown in the in-composer sandbox picker. Omit to render a read-only chip. */
  sandboxOptions?: { value: string; label: string }[];
  /** Currently-selected profile name (used to mark the active entry in the menu). */
  currentSandboxProfile?: string;
  /** Called when the user picks a different profile from the in-composer menu. */
  onSandboxChange?: (value: string) => void;
  onClientToolCall?: ClientToolCallHandler;
  pendingPlan?: PlanItem | null;
  onPlanDecision?: (approved: boolean) => void;
  /** Ticket bound to this column. When set, the app registers a supervisor bridge actor. */
  ticketId?: TicketId;
  /** Project workspace directory the launcher already knows about. Used to
   *  pre-fill the workspace chip so it doesn't flash "Select workspace" while
   *  the chat-boot RPC resolves. */
  workspaceDir?: string;
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

export const OmniAgentsApp = ({ uiUrl, sessionId, onSessionChange, variables, voiceVariables, greeting, onReady, headerActionsTargetId, headerActionsCompact, pendingMessages, sandboxLabel, sandboxOptions, currentSandboxProfile, onSandboxChange, onClientToolCall, pendingPlan, onPlanDecision, ticketId, workspaceDir }: OmniAgentsAppProps) => {
  // Resolve relative ``/proxy/...`` payloads against the launcher's actual
  // origin — same-origin in browser server mode, cloud baseUrl in
  // cloud-linked Electron. If uiUrl is already absolute, the base is ignored.
  const normalizedUrl = useMemo(() => new URL(uiUrl, serverOrigin()).toString(), [uiUrl]);

  return (
    <UiConfigProvider uiUrl={normalizedUrl}>
      <RPCClientProvider>
        <ThemeSync>
          <OmniAgentsCore sessionId={sessionId} onSessionChange={onSessionChange} variables={variables} voiceVariables={voiceVariables} greeting={greeting} onReady={onReady} headerActionsTargetId={headerActionsTargetId} headerActionsCompact={headerActionsCompact} pendingMessages={pendingMessages} sandboxLabel={sandboxLabel} sandboxOptions={sandboxOptions} currentSandboxProfile={currentSandboxProfile} onSandboxChange={onSandboxChange} onClientToolCall={onClientToolCall} pendingPlan={pendingPlan} onPlanDecision={onPlanDecision} ticketId={ticketId} workspaceDir={workspaceDir} />
        </ThemeSync>
      </RPCClientProvider>
    </UiConfigProvider>
  );
};
