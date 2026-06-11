import { useCallback, useEffect, useRef } from 'react';

import { agentProcessApi } from '@/renderer/services/agent-process';

const DEFAULT_THROTTLE_MS = 60_000;

/**
 * Returns an HTMLElement-ref-friendly bundle that pings the sandbox's idle
 * watcher on user activity (mousemove / keydown / scroll), throttled to
 * once per minute. The 15-min idle threshold gives 15× headroom, so a
 * dropped ping never starves the timer.
 *
 * Wire on whatever container element scopes "the user is engaging with
 * this sandbox surface" — chat shell root, code tab content root, etc.
 */
export function useSandboxActivityPing(processId: string, throttleMs = DEFAULT_THROTTLE_MS) {
  const lastPingRef = useRef(0);

  const ping = useCallback(() => {
    const now = Date.now();
    if (now - lastPingRef.current < throttleMs) return;
    lastPingRef.current = now;
    agentProcessApi.notifyActivity(processId);
  }, [processId, throttleMs]);

  // Document-level listeners catch interactions anywhere — the throttle
  // bounds the cost. Cheaper than threading refs through every surface
  // that wants to participate.
  useEffect(() => {
    const handler = () => ping();
    window.addEventListener('mousemove', handler, { passive: true });
    window.addEventListener('keydown', handler, { passive: true });
    window.addEventListener('scroll', handler, { passive: true, capture: true });
    return () => {
      window.removeEventListener('mousemove', handler);
      window.removeEventListener('keydown', handler);
      window.removeEventListener('scroll', handler, true);
    };
  }, [ping]);
}
