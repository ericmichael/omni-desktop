/**
 * Glanceability beyond the window (UI/UX gameplan Phase 8): the deck's whole
 * premise is "parallel agents you can see working" — this keeps that signal
 * alive when the app is backgrounded.
 *
 * - App badge: the count of columns waiting on an approval, via the Badging
 *   API where available (installed PWA; harmless no-op elsewhere).
 * - System notifications (opt-in via `notifyOnAgentAttention`): fired when a
 *   column starts waiting for approval or finishes a run while the document
 *   is hidden. Clicking one focuses the window and jumps to that column.
 */
import { codeApi } from '@/renderer/features/Code/state';
import { $columnActivity, type ColumnActivity } from '@/renderer/services/column-activity';
import { persistedStoreApi } from '@/renderer/services/store';
import { CHAT_TAB_ID, type CodeTabId } from '@/shared/types';

const updateBadge = (activity: Record<string, ColumnActivity>): void => {
  if (typeof navigator.setAppBadge !== 'function') {
    return;
  }
  const pending = Object.values(activity).filter((a) => a?.pendingApproval).length;
  void (pending > 0 ? navigator.setAppBadge(pending) : navigator.clearAppBadge?.());
};

/** Human label for a column-activity scope — shared with the SR status center. */
export const columnLabelFor = (scope: string): string => {
  if (scope === CHAT_TAB_ID) {
    return 'Chat';
  }
  const store = persistedStoreApi.get();
  const tab = (store.codeTabs ?? []).find((t) => t.id === scope);
  const project = store.projects.find((p) => p.id === tab?.projectId);
  return project?.label ?? 'Agent session';
};

const focusScope = (scope: string): void => {
  window.focus();
  if (scope === CHAT_TAB_ID) {
    void persistedStoreApi.setKey('layoutMode', 'chat');
    return;
  }
  void codeApi.setActiveTab(scope as CodeTabId);
  void persistedStoreApi.setKey('layoutMode', 'spaces');
};

const canNotify = (): boolean =>
  persistedStoreApi.get().notifyOnAgentAttention &&
  typeof Notification !== 'undefined' &&
  Notification.permission === 'granted' &&
  document.hidden;

const notify = (scope: string, body: string): void => {
  try {
    // tag dedupes per column: a newer state replaces the stale notification.
    const n = new Notification(columnLabelFor(scope), { body, tag: `omni-column-${scope}` });
    n.onclick = () => focusScope(scope);
  } catch {
    // Notification construction can throw (e.g. service-worker-only
    // platforms); the in-app surfaces still carry the state.
  }
};

const announceTransitions = (prev: Record<string, ColumnActivity>, next: Record<string, ColumnActivity>): void => {
  if (!canNotify()) {
    return;
  }
  for (const [scope, activity] of Object.entries(next)) {
    if (!activity) {
      continue;
    }
    const before = prev[scope];
    if (activity.pendingApproval && !before?.pendingApproval) {
      notify(scope, 'Waiting for your approval');
    } else if (before?.thinking && !activity.thinking && !activity.pendingApproval) {
      notify(scope, 'Finished working');
    }
  }
};

let started = false;

/** Idempotent; wired from the App shell. */
export const initAgentAttention = (): void => {
  if (started) {
    return;
  }
  started = true;
  let prev: Record<string, ColumnActivity> = {};
  $columnActivity.listen((activity) => {
    updateBadge(activity);
    announceTransitions(prev, activity);
    prev = { ...activity };
  });
};

/**
 * Ask for notification permission (no-op when already decided). Called from
 * the Settings toggle — inside a user gesture, as platforms require.
 */
export const requestNotificationPermission = async (): Promise<boolean> => {
  if (typeof Notification === 'undefined') {
    return false;
  }
  if (Notification.permission === 'granted') {
    return true;
  }
  if (Notification.permission === 'denied') {
    return false;
  }
  try {
    return (await Notification.requestPermission()) === 'granted';
  } catch {
    return false;
  }
};
