import { useStore } from '@nanostores/react';
import { useEffect, useMemo } from 'react';

import { uuidv4 } from '@/lib/uuid';
import { type AutoLaunchPhase,useAutoLaunch } from '@/renderer/hooks/use-auto-launch';
import { useSessionWorkspaceDir } from '@/renderer/hooks/use-session-workspace-dir';
import { persistedStoreApi } from '@/renderer/services/store';

import { $chatProcessStatus } from './state';

export type ChatAutoLaunchPhase = AutoLaunchPhase;

export const useChatAutoLaunch = () => {
  const store = useStore(persistedStoreApi.$atom);
  const chatStatus = useStore($chatProcessStatus);

  // Ensure chatSessionId is set before launching — the SAME id is used by
  // the conversation (via OmniAgentsApp's sessionIdProp) and as the
  // snapshot key. Minted once on first ever launch; persisted thereafter.
  const sessionId = useMemo(() => {
    const existing = persistedStoreApi.getKey('chatSessionId');
    if (existing) return existing;
    const fresh = uuidv4();
    persistedStoreApi.setKey('chatSessionId', fresh);
    return fresh;
  }, []);

  // Sticky chat profile binding. The migration seeds this for existing
  // installs; here we cover fresh installs by minting from the global
  // default on first render. Picker writes mutate this through
  // ``setKey('chatProfileName', …)``, and ``useStore`` re-renders us.
  const persistedProfile = store.chatProfileName;
  useEffect(() => {
    if (persistedProfile != null) return;
    const seed = persistedStoreApi.getKey('defaultProfileName') ?? 'host';
    void persistedStoreApi.setKey('chatProfileName', seed);
  }, [persistedProfile]);
  const profileName = persistedProfile ?? store.defaultProfileName ?? 'host';

  // Chat is an ambient surface, not a project — give it an isolated per-session
  // scratch dir instead of mounting the whole workspace tree.
  const workspaceDir = useSessionWorkspaceDir(store.workspaceDir, sessionId);

  const { phase, error, retry, launch } = useAutoLaunch({
    processId: 'chat',
    workspaceDir,
    sessionId,
    profileNameOverride: profileName,
    ...(store.chatContainerId ? { containerId: store.chatContainerId } : {}),
    logLabel: 'autoLaunch:chat',
  });

  // Capture the readiness payload's container_id whenever omni serve reports
  // ``running``. Note: in the rehydrate / fresh tiers, the SDK minted a new
  // container id (the old one was unreachable), so the value here may differ
  // from what we sent on this launch — that's the new id we want to use next
  // time. Storing it is a no-op when value matches what's persisted; nano-
  // store does shallow equality and short-circuits.
  useEffect(() => {
    if (chatStatus.type !== 'running') return;
    const next = chatStatus.data.containerId ?? null;
    if (persistedStoreApi.getKey('chatContainerId') === next) return;
    void persistedStoreApi.setKey('chatContainerId', next);
  }, [chatStatus]);

  return {
    phase,
    error,
    retry,
    launch,
    profileName,
    /** Resolved per-session scratch dir actually mounted (for the workspace chip). */
    workspaceDir,
    resumeTier: chatStatus.type === 'running' ? chatStatus.data.resume : undefined,
  };
};
