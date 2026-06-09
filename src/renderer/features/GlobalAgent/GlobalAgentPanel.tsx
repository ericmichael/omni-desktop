import { makeStyles, Spinner, tokens } from '@fluentui/react-components';
import { useStore } from '@nanostores/react';
import { memo, useEffect, useMemo } from 'react';

import { buildSessionVariables } from '@/lib/client-tools';
import { buildClientToolHandler } from '@/renderer/features/Tickets/client-tool-handler';
import { OmniAgentsApp } from '@/renderer/omniagents-ui';
import { serverOrigin } from '@/renderer/services/ipc';
import { persistedStoreApi } from '@/renderer/services/store';
import { isLocalVoiceCapable } from '@/renderer/services/voice-client';
import { GLOBAL_VOICE_SCOPE, VoiceScopeContext } from '@/renderer/services/voice-recording';
import { getActivePersona } from '@/shared/voice-personas';

import { setOrchestratorController } from './orchestrator-watch';
import { setGlobalSessionId } from './state';
import { useGlobalAutoLaunch } from './use-global-auto-launch';

const useStyles = makeStyles({
  root: { position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', minHeight: 0 },
  center: {
    flex: '1 1 0',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: tokens.spacingVerticalM,
    padding: tokens.spacingHorizontalXXL,
    textAlign: 'center',
    color: tokens.colorNeutralForeground3,
  },
  error: { color: tokens.colorPaletteRedForeground1, fontSize: tokens.fontSizeBase200 },
  retry: {
    cursor: 'pointer',
    color: tokens.colorBrandForeground1,
    background: 'none',
    border: 'none',
    fontSize: tokens.fontSizeBase300,
  },
});

/**
 * Inner panel for the headless orchestrator. Boots the `"global"` Devbox
 * session on mount, then hosts an OmniAgentsApp wired with the superuser
 * client-tool handler, the `surface: 'global'` variables, and the global voice
 * scope so its mic targets `GLOBAL_VOICE_SCOPE`.
 */
export const GlobalAgentPanel = memo(() => {
  const styles = useStyles();
  const store = useStore(persistedStoreApi.$atom);
  const { phase, error, retry, launch, sessionId, status } = useGlobalAutoLaunch();

  // The panel only mounts after the user opens it, so auto-launch on idle.
  useEffect(() => {
    if (phase === 'idle') {
      launch();
    }
  }, [phase, launch]);

  const localVoice = store.localVoiceEnabled && isLocalVoiceCapable();
  const personaInstructions = getActivePersona(store).instructions;
  // The orchestrator is voice-first: arm the `speak` tool + persona on EVERY run
  // (not just mic-initiated ones), so a typed message or a background wakeup can
  // also reply by voice. Unlike a code-deck column — which stays speak-free on
  // typed runs so columns don't all talk at once — there's only one orchestrator.
  const variables = useMemo(
    () => buildSessionVariables({ surface: 'global', voice: localVoice, personaInstructions }),
    [localVoice, personaInstructions]
  );
  const toolHandler = useMemo(() => buildClientToolHandler({ superuser: true }), []);

  // Hide the omniagents chat header + session sidebar (the orchestrator panel
  // has its own thin header), same `minimal=true` treatment code-deck columns
  // use.
  const uiUrl = useMemo(() => {
    if (status.type !== 'running') {
      return null;
    }
    const url = new URL(status.data.uiUrl, serverOrigin());
    const theme = store.theme ?? 'teams-light';
    if (theme !== 'default') {
      url.searchParams.set('theme', theme);
    }
    url.searchParams.set('minimal', 'true');
    return url.toString();
  }, [status, store.theme]);

  if (!uiUrl) {
    return (
      <div className={styles.root}>
        <div className={styles.center}>
          {phase === 'error' ? (
            <>
              <span className={styles.error}>{error ?? 'The orchestrator failed to start.'}</span>
              <button type="button" className={styles.retry} onClick={retry}>
                Retry
              </button>
            </>
          ) : !store.workspaceDir ? (
            <span>Set a workspace in Settings to use the global agent.</span>
          ) : (
            <>
              <Spinner size="small" />
              <span>Waking the orchestrator…</span>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className={styles.root}>
      <VoiceScopeContext.Provider value={GLOBAL_VOICE_SCOPE}>
        <OmniAgentsApp
          uiUrl={uiUrl}
          sessionId={sessionId}
          onSessionChange={setGlobalSessionId}
          variables={variables}
          onClientToolCall={toolHandler}
          onController={setOrchestratorController}
          greeting="I can see your whole workspace — what do you need?"
        />
      </VoiceScopeContext.Provider>
    </div>
  );
});
GlobalAgentPanel.displayName = 'GlobalAgentPanel';
