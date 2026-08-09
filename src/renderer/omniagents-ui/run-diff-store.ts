import { map } from 'nanostores';

import type { RunDiffItem } from '@/shared/chat-types';

/**
 * The run diff the Review sidecar app's "This turn" scope shows, keyed by
 * session. Published by the embedded chat app: automatically with the
 * newest ``run_diff`` transcript item (so opening Review from the dock
 * lands on the latest turn), and explicitly when the user clicks Review on
 * a specific run-diff card (so an older card reviews that run's record).
 * Same session-keyed-store pattern as ``activity-store`` — the sidecar
 * surface mounts outside the chat React tree.
 */
export const $runDiffBySession = map<Record<string, RunDiffItem | undefined>>({});

export function publishRunDiff(sessionId: string, item: RunDiffItem): void {
  $runDiffBySession.setKey(sessionId, item);
}
