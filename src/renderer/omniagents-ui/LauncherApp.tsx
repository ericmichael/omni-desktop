import type { ReactNode } from 'react';
import { useMemo } from 'react';

import { serverOrigin } from '@/renderer/services/ipc';
import type { SessionController } from '@/renderer/services/session-control';
import type { PlanItem } from '@/shared/chat-types';
import type { AgentRuntimeConnection, TicketId } from '@/shared/types';

import type { ClientToolCallHandler } from './App';
import { App as OmniAgentsCore } from './App';
import type { PendingMessage } from './ChatShell';
import { RPCClientProvider } from './rpc-context';
import { UiConfigProvider } from './ui-config';

type OmniAgentsAppProps = {
  /** RPC server connection for the directly embedded React client. */
  connection: AgentRuntimeConnection;
  sessionId?: string;
  /** Execution environment used by workspace, process, and terminal RPCs. */
  environmentId?: string;
  onSessionChange?: (sessionId: string | undefined) => void;
  variables?: Record<string, unknown>;
  voiceVariables?: Record<string, unknown>;
  greeting?: string;
  /** One-tap example tasks shown on the empty conversation. */
  suggestions?: ReadonlyArray<{ label: string; prompt: string }>;
  onReady?: () => void;
  headerActionsTargetId?: string;
  headerActionsCompact?: boolean;
  pendingMessages?: PendingMessage[];
  onPendingMessagesFlushed?: () => void;
  sandboxLabel?: string;
  /** Options shown in the in-composer sandbox picker. Omit to render a read-only chip. */
  sandboxOptions?: { value: string; label: string }[];
  /** Currently-selected profile name (used to mark the active entry in the menu). */
  currentSandboxProfile?: string;
  /** Called when the user picks a different profile from the in-composer menu. */
  onSandboxChange?: (value: string) => void;
  onClientToolCall?: ClientToolCallHandler;
  /** Hands an imperative controller up so the global orchestrator can drive this column. */
  onController?: (controller: SessionController | null) => void;
  /** Fires when a run in this session ends — used to push column-done wakeups. */
  onRunEnd?: (info: { runId?: string; reason?: string }) => void;
  /** Fires when a run starts — used to pin a dispatched run id for the wakeup. */
  onRunStarted?: (runId: string) => void;
  pendingPlan?: PlanItem | null;
  onPlanDecision?: (approved: boolean) => void;
  /** Ticket bound to this column. When set, the app registers a supervisor bridge actor. */
  ticketId?: TicketId;
  /** Routine (scheduled task) bound to this column. When set, the app registers a routine bridge actor. */
  routineId?: string;
  /** Project workspace directory the launcher already knows about. Used to
   *  pre-fill the workspace chip so it doesn't flash "Select workspace" while
   *  the chat-boot RPC resolves. */
  workspaceDir?: string;
  /** Additional column UI that must share this exact RPC connection. */
  providerChildren?: ReactNode;
};

export const OmniAgentsApp = ({
  connection,
  sessionId,
  environmentId,
  onSessionChange,
  variables,
  voiceVariables,
  greeting,
  suggestions,
  onReady,
  headerActionsTargetId,
  headerActionsCompact,
  pendingMessages,
  onPendingMessagesFlushed,
  sandboxLabel,
  sandboxOptions,
  currentSandboxProfile,
  onSandboxChange,
  onClientToolCall,
  onController,
  onRunEnd,
  onRunStarted,
  pendingPlan,
  onPlanDecision,
  ticketId,
  routineId,
  workspaceDir,
  providerChildren,
}: OmniAgentsAppProps) => {
  // Resolve relative ``/proxy/...`` payloads against the launcher's actual
  // origin — same-origin in browser server mode, cloud baseUrl in
  // cloud-linked Electron. An absolute connection base ignores the fallback.
  const normalizedConnection = useMemo<AgentRuntimeConnection>(
    () => ({ ...connection, baseUrl: new URL(connection.baseUrl, serverOrigin()).toString() }),
    [connection.authToken, connection.baseUrl]
  );

  return (
    <UiConfigProvider connection={normalizedConnection}>
      <RPCClientProvider>
        <OmniAgentsCore
          sessionId={sessionId}
          environmentId={environmentId}
          onSessionChange={onSessionChange}
          variables={variables}
          voiceVariables={voiceVariables}
          greeting={greeting}
          suggestions={suggestions}
          onReady={onReady}
          headerActionsTargetId={headerActionsTargetId}
          headerActionsCompact={headerActionsCompact}
          pendingMessages={pendingMessages}
          onPendingMessagesFlushed={onPendingMessagesFlushed}
          sandboxLabel={sandboxLabel}
          sandboxOptions={sandboxOptions}
          currentSandboxProfile={currentSandboxProfile}
          onSandboxChange={onSandboxChange}
          onClientToolCall={onClientToolCall}
          onController={onController}
          onRunEnd={onRunEnd}
          onRunStarted={onRunStarted}
          pendingPlan={pendingPlan}
          onPlanDecision={onPlanDecision}
          ticketId={ticketId}
          routineId={routineId}
          workspaceDir={workspaceDir}
        />
        {providerChildren}
      </RPCClientProvider>
    </UiConfigProvider>
  );
};
