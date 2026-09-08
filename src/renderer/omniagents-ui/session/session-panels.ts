import { atom } from 'nanostores';

import type { BashJobSummary } from '@/renderer/omniagents-ui/activity-store';
import type { EscalationInfo } from '@/renderer/omniagents-ui/components/EscalationBanner';
import type { GoalSnapshot } from '@/renderer/omniagents-ui/components/GoalPanel';
import type { LoopTaskSnapshot } from '@/renderer/omniagents-ui/components/LoopPanel';
import type { NotificationInfo } from '@/renderer/omniagents-ui/components/Notifications';
import type { RecapInfo } from '@/renderer/omniagents-ui/components/RecapPanel';
import type { WakeupSnapshot } from '@/renderer/omniagents-ui/components/WakeupPanel';
import type { QueuedMessage } from '@/renderer/omniagents-ui/rpc/client';
import type { ModelDescriptor } from '@/renderer/omniagents-ui/rpc/model-catalog';

export type SessionPanels = {
  models: ModelDescriptor[];
  activeModel: string | null;
  reasoningEffort: string | null;
  approvalsReviewer: 'user' | 'auto';
  workflowReviewer: 'off' | 'guardian';
  modelLoading: boolean;
  modelMutating: boolean;
  modelError: string | null;
  networkEnabled: boolean | null;
  networkMutating: boolean;
  workspacePath: string | null;
  workspaceLocked: boolean;
  liveBashJobs: BashJobSummary[] | null;
  goalSnapshot: GoalSnapshot | null;
  wakeupSnapshot: WakeupSnapshot | null;
  loopTasks: LoopTaskSnapshot[];
  notifications: NotificationInfo[];
  recap: RecapInfo | null;
  escalation: EscalationInfo | null;
  queuedMessages: QueuedMessage[];
  dismissedWorkerIds: Set<string>;
  dismissedJobIds: Set<string>;
  dismissedTaskIds: Set<string>;
};

/** Both live events and mutations advance the revision. A read may only
 * publish if nothing newer has touched its field since the read started. */
export class SessionPanelStore {
  private disposed = false;
  readonly state = atom<SessionPanels>({
    models: [],
    activeModel: null,
    reasoningEffort: null,
    approvalsReviewer: 'user',
    workflowReviewer: 'guardian',
    modelLoading: true,
    modelMutating: false,
    modelError: null,
    networkEnabled: null,
    networkMutating: false,
    workspacePath: null,
    workspaceLocked: false,
    liveBashJobs: null,
    goalSnapshot: null,
    wakeupSnapshot: null,
    loopTasks: [],
    notifications: [],
    recap: null,
    escalation: null,
    queuedMessages: [],
    dismissedWorkerIds: new Set(),
    dismissedJobIds: new Set(),
    dismissedTaskIds: new Set(),
  });
  private revisions = new Map<keyof SessionPanels, number>();
  private reads = new Map<keyof SessionPanels, number>();
  guardRead(keys: Array<keyof SessionPanels>) {
    const revisions = keys.map((key) => this.revisions.get(key) ?? 0);
    const reads = keys.map((key) => {
      const read = (this.reads.get(key) ?? 0) + 1;
      this.reads.set(key, read);
      return read;
    });
    return () =>
      !this.disposed &&
      keys.every(
        (key, index) => (this.revisions.get(key) ?? 0) === revisions[index] && this.reads.get(key) === reads[index]
      );
  }
  set = <K extends keyof SessionPanels>(
    key: K,
    update: SessionPanels[K] | ((previous: SessionPanels[K]) => SessionPanels[K])
  ) => {
    if (this.disposed) {
      return;
    }
    const previous = this.state.get();
    const value = typeof update === 'function' ? update(previous[key]) : update;
    this.revisions.set(key, (this.revisions.get(key) ?? 0) + 1);
    this.state.set({ ...previous, [key]: value });
  };
  async refresh<K extends keyof SessionPanels>(key: K, read: () => Promise<SessionPanels[K]>) {
    const revision = this.revisions.get(key) ?? 0;
    const request = (this.reads.get(key) ?? 0) + 1;
    this.reads.set(key, request);
    const value = await read();
    if (request === this.reads.get(key) && revision === (this.revisions.get(key) ?? 0)) {
      this.set(key, value);
    }
  }
  dispose() {
    this.disposed = true;
  }
}
