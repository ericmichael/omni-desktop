import { useEffect, useState } from 'react';

import { emitter } from '@/renderer/services/ipc';

/**
 * Resolve (and create) a per-session scratch workspace at
 * `<baseDir>/Sessions/<sessionId>` via the main process. Used by ambient
 * surfaces (Chat, Orchestrator) that aren't bound to a project, so each gets an
 * isolated dir instead of mounting the whole workspace tree.
 *
 * Returns `null` until resolved (or when `baseDir` is empty), which keeps
 * `useAutoLaunch` from launching with a half-formed path.
 */
export function useSessionWorkspaceDir(
  baseDir: string | null | undefined,
  sessionId: string
): string | null {
  const [dir, setDir] = useState<string | null>(null);
  useEffect(() => {
    if (!baseDir) {
      setDir(null);
      return;
    }
    let cancelled = false;
    void emitter.invoke('util:session-workspace-dir', baseDir, sessionId).then((resolved) => {
      if (!cancelled) {
        setDir(resolved);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [baseDir, sessionId]);
  return dir;
}
