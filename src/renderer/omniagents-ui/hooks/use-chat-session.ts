import { useStore } from '@nanostores/react';
import { useSelector } from '@xstate/react';
import { useCallback, useEffect, useMemo } from 'react';

import type { RPCClient } from '@/renderer/omniagents-ui/rpc/client';
import type { ConversationSession } from '@/renderer/omniagents-ui/session/conversation-session';
import type { SessionPanels, SessionPanelStore } from '@/renderer/omniagents-ui/session/session-panels';
import { getSessionRegistry } from '@/renderer/omniagents-ui/session/session-registry';
import type { Attachment } from '@/shared/chat-types';
import { type ChatSessionPhase, isThinking } from '@/shared/machines/chat-session.machine';

function flattenPhase(value: unknown): ChatSessionPhase {
  if (typeof value === 'string') {
    return value as ChatSessionPhase;
  }
  return (value as { ready: ChatSessionPhase }).ready;
}

/** A view subscription. Changing id selects another owner; it never retargets
 * an actor or a callback that an outstanding operation has captured. */
export function useChatSession(client: RPCClient, id: string) {
  const controller = useMemo(() => getSessionRegistry(client).get(id), [client, id]);
  useEffect(() => getSessionRegistry(client).retainSession(id), [client, id]);
  const actor = controller.actor;
  const snapshot = useSelector(actor, (s) => s);
  const actions = useMemo(
    () => ({
      loadSession: (requestedId = id, options: { authoritativeResync?: boolean; force?: boolean } = {}) => {
        if (requestedId !== id) {
          return Promise.reject(new Error('Session controllers cannot change identity; select another controller'));
        }
        return controller.load(options);
      },
      submit: (
        text: string,
        attachments?: Attachment[],
        stagedContext?: ReadonlyArray<{ source: string; text: string }>
      ) => controller.receive({ type: 'SUBMIT', text, attachments, stagedContext }),
      submitError: (error: string) => controller.receive({ type: 'SUBMIT_ERROR', error }),
      stop: () => controller.receive({ type: 'STOP' }),
      approvalDecided: (request_id: string, value: 'yes' | 'always' | 'no') =>
        controller.receive({ type: 'APPROVAL_DECIDED', request_id, value }),
      appendResponse: (content: string) => controller.receive({ type: 'APPEND_RESPONSE', content }),
      addArtifact: (args: {
        artifact_id?: string;
        title: string;
        content: string;
        mode?: string;
        session_id?: string;
      }) => controller.receive({ type: 'ADD_ARTIFACT', ...args, session_id: id }),
      stageContext: (source: string, text: string) => controller.receive({ type: 'STAGE_CONTEXT', source, text }),
      clearStagedContext: () => controller.receive({ type: 'CLEAR_STAGED_CONTEXT' }),
    }),
    [controller, id]
  );
  const phase = flattenPhase(snapshot.value);
  return { controller, actor, ...snapshot.context, phase, thinking: isThinking(phase), ...actions };
}

export function useSessionField<K extends keyof SessionPanels>(session: ConversationSession, key: K) {
  return useSessionStoreField(session.panels, key);
}

export function useSessionStoreField<K extends keyof SessionPanels>(store: SessionPanelStore, key: K) {
  const state = useStore(store.state);
  const set = useCallback(
    (value: SessionPanels[K] | ((previous: SessionPanels[K]) => SessionPanels[K])) => store.set(key, value),
    [store, key]
  );
  return [state[key], set] as const;
}

export type UseChatSessionReturn = ReturnType<typeof useChatSession>;
