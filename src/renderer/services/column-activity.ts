/**
 * Per-column live activity, published by the embedded chat UI (omniagents-ui
 * App) and consumed by deck chrome (column headers, Focus session list) so a
 * column's state is glanceable without reading its transcript.
 *
 * Keyed by the same scope string as voice recording (the Code tab id, or
 * CHAT_VOICE_SCOPE for the Chat tab — published there too, harmlessly: the
 * Chat surface has no consumer). Same pattern as `$recordingScope` in
 * `voice-recording.ts`.
 */
import { map } from 'nanostores';

export type ColumnActivity = {
  /** Agent is mid-run (streaming / executing tools). */
  thinking: boolean;
  /** Latest tool/status line from the run, e.g. "Running execute_bash…". */
  text: string | null;
  /** A tool/MCP approval request is waiting on the user. */
  pendingApproval: boolean;
};

export const $columnActivity = map<Record<string, ColumnActivity>>({});

export const publishColumnActivity = (scope: string, activity: ColumnActivity): void => {
  const prev = $columnActivity.get()[scope];
  if (
    prev &&
    prev.thinking === activity.thinking &&
    prev.text === activity.text &&
    prev.pendingApproval === activity.pendingApproval
  ) {
    return;
  }
  $columnActivity.setKey(scope, activity);
};

export const clearColumnActivity = (scope: string): void => {
  $columnActivity.setKey(scope, undefined as unknown as ColumnActivity);
};

/**
 * One line for the header: what is this column doing right now?
 * Returns null when there is nothing live to say (idle columns stay quiet).
 */
export const activityStatusText = (activity: ColumnActivity | undefined): string | null => {
  if (!activity) {
    return null;
  }
  if (activity.pendingApproval) {
    return 'Waiting for approval';
  }
  if (activity.thinking) {
    return activity.text || 'Working…';
  }
  return null;
};
