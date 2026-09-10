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

/** Session-owned panel state. Every write is a plain set; a read applies
 * whatever the server answered last. */
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
  set = <K extends keyof SessionPanels>(
    key: K,
    update: SessionPanels[K] | ((previous: SessionPanels[K]) => SessionPanels[K])
  ) => {
    if (this.disposed) {
      return;
    }
    const previous = this.state.get();
    const value = typeof update === 'function' ? update(previous[key]) : update;
    this.state.set({ ...previous, [key]: value });
  };
  async refresh<K extends keyof SessionPanels>(key: K, read: () => Promise<SessionPanels[K]>) {
    this.set(key, await read());
  }
  dispose() {
    this.disposed = true;
  }
}
