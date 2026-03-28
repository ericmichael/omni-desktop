import { useStore } from '@nanostores/react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { OmniAgentsHostApp } from '@/renderer/omniagents-ui';
import {
  $omniInstallProcessStatus,
  $omniInstallProcessXTerm,
  $omniRuntimeInfo,
  omniInstallApi,
  refreshOmniRuntimeInfo,
} from '@/renderer/features/Omni/state';
import { XTermLogViewer } from '@/renderer/features/XTermLogViewer/XTermLogViewer';
import { emitter } from '@/renderer/services/ipc';
import { $initialized, persistedStoreApi } from '@/renderer/services/store';

import { $chatProcessStatus, $chatProcessXTerm, chatApi } from './state';

type ChatPhase = 'checking' | 'installing' | 'ready' | 'starting' | 'running' | 'error' | 'idle';

const useChatAutoLaunch = () => {
  const initialized = useStore($initialized);
  const installStatus = useStore($omniInstallProcessStatus);
  const chatStatus = useStore($chatProcessStatus);
  const store = useStore(persistedStoreApi.$atom);

  const [phase, setPhase] = useState<ChatPhase>('checking');
  const [error, setError] = useState<string | null>(null);

  const hasAutoLaunched = useRef(false);
  const didTriggerInstall = useRef(false);
  const didTriggerStart = useRef(false);
  const lastStartTimestamp = useRef<number | null>(null);

  // Phase: checking → installing or ready
  useEffect(() => {
    if (!initialized || phase !== 'checking') {
      return;
    }

    let cancelled = false;
    refreshOmniRuntimeInfo().then(() => {
      if (cancelled) {
        return;
      }
      const info = $omniRuntimeInfo.get();
      if (info.isInstalled && !info.isOutdated) {
        setPhase('ready');
      } else {
        didTriggerInstall.current = true;
        omniInstallApi.startInstall(info.isInstalled && info.isOutdated);
        setPhase('installing');
      }
    });
    return () => {
      cancelled = true;
    };
  }, [initialized, phase]);

  // Phase: installing → ready or error
  useEffect(() => {
    if (phase !== 'installing') {
      return;
    }

    if (installStatus.type === 'completed') {
      refreshOmniRuntimeInfo();
      setPhase('ready');
      didTriggerInstall.current = false;
    } else if (installStatus.type === 'error') {
      setError(installStatus.error.message);
      setPhase('error');
      didTriggerInstall.current = false;
    } else if (installStatus.type === 'canceled') {
      setPhase('idle');
      didTriggerInstall.current = false;
    }
  }, [phase, installStatus]);

  // Phase: ready → starting
  useEffect(() => {
    if (phase !== 'ready') {
      return;
    }

    if (!store.workspaceDir) {
      setError('No workspace directory configured.');
      setPhase('error');
      return;
    }

    if (hasAutoLaunched.current) {
      setPhase('idle');
      return;
    }

    let cancelled = false;

    const startChat = async () => {
      try {
        const configDir = await emitter.invoke('config:get-omni-config-dir');
        const modelsConfig = (await emitter.invoke('config:read-json-file', `${configDir}/models.json`)) as {
          providers?: Record<string, unknown>;
        } | null;
        const hasProviders = modelsConfig?.providers && Object.keys(modelsConfig.providers).length > 0;

        if (cancelled) {
          return;
        }

        if (!hasProviders) {
          await persistedStoreApi.setKey('onboardingComplete', false);
          return;
        }
      } catch {
        // proceed anyway
      }

      if (cancelled) {
        return;
      }

      hasAutoLaunched.current = true;
      didTriggerStart.current = true;
      lastStartTimestamp.current = Date.now();
      chatApi.start({ workspaceDir: store.workspaceDir! });
      setPhase('starting');
    };

    void startChat();

    return () => {
      cancelled = true;
    };
  }, [phase, store]);

  // Phase: starting → running or error/idle
  useEffect(() => {
    if (phase !== 'starting') {
      return;
    }

    if (chatStatus.type === 'running' || chatStatus.type === 'connecting') {
      setPhase('running');
      didTriggerStart.current = false;
    } else if (chatStatus.type === 'error') {
      setError(chatStatus.error.message);
      setPhase('error');
      didTriggerStart.current = false;
    } else if (chatStatus.type === 'exited') {
      const startTs = lastStartTimestamp.current;
      if (!startTs || chatStatus.timestamp > startTs) {
        setPhase('idle');
        didTriggerStart.current = false;
      }
    }
  }, [phase, chatStatus]);

  // running → idle when chat stops
  useEffect(() => {
    if (phase !== 'running') {
      return;
    }

    if (chatStatus.type === 'exited' || chatStatus.type === 'error') {
      setPhase('idle');
    }
  }, [phase, chatStatus]);

  const retry = useCallback(() => {
    setError(null);
    setPhase('checking');
  }, []);

  const launch = useCallback(() => {
    if (!store.workspaceDir) {
      return;
    }
    hasAutoLaunched.current = false;
    setPhase('ready');
  }, [store.workspaceDir]);

  return { phase, error, retry, launch };
};

const InstallDetails = memo(() => {
  const omniInstallXTerm = useStore($omniInstallProcessXTerm);
  if (!omniInstallXTerm) return null;
  return <XTermLogViewer $xterm={$omniInstallProcessXTerm} />;
});
InstallDetails.displayName = 'InstallDetails';

const ChatLogDetails = memo(() => {
  const chatXTerm = useStore($chatProcessXTerm);
  if (!chatXTerm) return null;
  return <XTermLogViewer $xterm={$chatProcessXTerm} />;
});
ChatLogDetails.displayName = 'ChatLogDetails';

export const Chat = memo(() => {
  const initialized = useStore($initialized);
  const chatStatus = useStore($chatProcessStatus);
  const store = useStore(persistedStoreApi.$atom);
  const { phase, error, retry, launch } = useChatAutoLaunch();

  const theme = store.theme ?? 'tokyo-night';

  const uiUrl = useMemo(() => {
    if (chatStatus.type !== 'running' && chatStatus.type !== 'connecting') {
      return null;
    }
    const url = new URL(chatStatus.data.uiUrl, window.location.origin);
    if (theme !== 'default') {
      url.searchParams.set('theme', theme);
    }
    return url.toString();
  }, [chatStatus, theme]);

  if (!initialized) {
    return null;
  }

  const startingPhase =
    phase === 'checking' || phase === 'installing' || phase === 'ready' || phase === 'starting'
      ? (phase === 'ready' ? 'starting' : phase)
      : 'starting';

  const details = phase === 'installing' ? <InstallDetails /> : <ChatLogDetails />;

  return (
    <div className="w-full h-full">
      <OmniAgentsHostApp
        state={
          uiUrl
            ? { type: 'ready', uiUrl }
            : phase === 'idle'
              ? { type: 'idle', onLaunch: launch, disabled: !store.workspaceDir }
              : phase === 'error'
                ? { type: 'error', error: error ?? 'An unexpected error occurred.', onRetry: retry, details }
                : { type: 'starting', phase: startingPhase as 'checking' | 'installing' | 'starting', details }
        }
      />
    </div>
  );
});

Chat.displayName = 'Chat';
