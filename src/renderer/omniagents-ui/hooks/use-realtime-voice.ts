/**
 * Hook owning one hosted-voice session per agent surface (chat column / DM).
 *
 * Wraps `RealtimeVoiceController` with this surface's connection config from
 * UiConfig (`/ws/realtime` + token), so the same hook pairs correctly whether
 * it runs in the chat App or a resident's DM (`useUiConfig().session` is the
 * default pairing when the caller doesn't pass an explicit session id).
 */
import { useCallback, useEffect, useState } from 'react';

import { useUiConfig } from '@/renderer/omniagents-ui/ui-config';
import { RealtimeVoiceController } from '@/renderer/services/realtime-voice';

export type RealtimeVoice = {
  actor: RealtimeVoiceController['actor'];
  /** Open a session paired to `sessionId` (falls back to the surface's handoff session). */
  open: (sessionId?: string) => void;
  close: () => void;
  toggleMute: () => void;
  interrupt: () => void;
  /** Route a typed message into the live voice session. False when not live. */
  sendText: (text: string) => boolean;
};

export function useRealtimeVoice(): RealtimeVoice {
  const { wsRealtimeUrl, token, debug, session } = useUiConfig();
  const [controller] = useState(() => new RealtimeVoiceController());

  useEffect(() => () => controller.dispose(), [controller]);

  const open = useCallback(
    (sessionId?: string) => {
      // Audio prefs come from the persisted store; dynamic import keeps
      // services/store (→ ipc → WS transport) out of this module's eager
      // graph, same as the composer's other store consumers under jsdom.
      void import('@/renderer/services/store')
        .then(({ persistedStoreApi }) => {
          controller.open(
            {
              url: wsRealtimeUrl,
              token,
              debug,
              audioSettings: persistedStoreApi.$atom.get().audioSettings,
            },
            sessionId ?? session
          );
        })
        .catch((e: unknown) => {
          // Never let a mic click die silently — surface the failure so the
          // dock opens and shows it.
          console.error('[voice] open failed', e);
        });
    },
    [controller, wsRealtimeUrl, token, debug, session]
  );

  const close = useCallback(() => controller.close(), [controller]);
  const toggleMute = useCallback(() => controller.toggleMute(), [controller]);
  const interrupt = useCallback(() => controller.interrupt(), [controller]);
  const sendText = useCallback((text: string) => controller.sendText(text), [controller]);

  return { actor: controller.actor, open, close, toggleMute, interrupt, sendText };
}
