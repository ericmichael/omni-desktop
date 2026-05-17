import { useStore } from '@nanostores/react';
import { nanoid } from 'nanoid';
import { useMemo } from 'react';

import { type AutoLaunchPhase,useAutoLaunch } from '@/renderer/hooks/use-auto-launch';
import { persistedStoreApi } from '@/renderer/services/store';

export type ChatAutoLaunchPhase = AutoLaunchPhase;

export const useChatAutoLaunch = (opts?: { profileNameOverride?: string }) => {
  const store = useStore(persistedStoreApi.$atom);

  // Ensure chatSessionId is set before launching — the SAME id is used by
  // the conversation (via OmniAgentsApp's sessionIdProp) and as the
  // snapshot key. Minted once on first ever launch; persisted thereafter.
  const sessionId = useMemo(() => {
    const existing = persistedStoreApi.getKey('chatSessionId');
    if (existing) return existing;
    const fresh = nanoid();
    persistedStoreApi.setKey('chatSessionId', fresh);
    return fresh;
  }, []);

  const { phase, error, retry, launch } = useAutoLaunch({
    processId: 'chat',
    workspaceDir: store.workspaceDir ?? null,
    sessionId,
    ...(opts?.profileNameOverride ? { profileNameOverride: opts.profileNameOverride } : {}),
    logLabel: 'autoLaunch:chat',
  });

  // Effective profile = override > user-default. (No per-project layer
  // for the chat process — chat is the singleton, not bound to a project.)
  const effectiveProfile = opts?.profileNameOverride ?? store.defaultProfileName ?? 'host';
  return { phase, error, retry, launch, profileName: effectiveProfile };
};
