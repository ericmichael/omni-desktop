/**
 * Automations: user-defined event rules — when <trigger> fires, wake a
 * resident with a standing instruction (`docs` idiom: the resident IS the
 * workflow engine, so there are no steps, and its day session is the trace).
 *
 * Trigger sources, all funneled through {@link fire}:
 *  - PR watch events: the entry points forward `PullRequestWatcher` events
 *    into {@link onPullRequestEvent}.
 *  - Chat messages: subscribes to the resident manager's chat-event stream
 *    and matches `chat.message_added`. Human posts only + a per-rule cooldown
 *    (the loop guards — see src/lib/automations.ts).
 *  - Schedules: a 60s tick reusing the routines schedule vocabulary and
 *    `nextScheduledTaskRun`. No catch-up on missed slots: an automation wake
 *    is a nudge, not a ledger — a missed morning slot shouldn't fire at 3pm.
 *
 * Storage is the settings store (`StoreData.automations`), same as routines:
 * per-user in server mode, shared local file on desktop.
 */
import { randomUUID } from 'node:crypto';

import type Store from 'electron-store';

import {
  automationFireDetail,
  describeTrigger,
  matchesChannelMessage,
  matchesPrEvent,
  messageCooldownActive,
} from '@/lib/automations';
import type { PullRequestWatchEvent } from '@/lib/pull-request-watch';
import { nextScheduledTaskRun } from '@/lib/scheduled-task-schedule';
import type { IIpcListener } from '@/shared/ipc-listener';
import type {
  Automation,
  AutomationInput,
  AutomationUpdate,
  ChatEvent,
  IpcRendererEvents,
  StoreData,
} from '@/shared/types';

const TICK_MS = 60_000;

type AutomationStore = Pick<Store<StoreData>, 'get' | 'set'>;

type ManagerDeps = {
  store: AutomationStore;
  /** Wake a resident with a fired rule's detail (ResidentAgentManager.deliverAutomation). */
  deliver: (agentId: string, detail: string) => void;
  /** Chat-event stream to match `channel_message` triggers against
   *  (ResidentAgentManager.subscribeChatEvents). Returns the unsubscribe. */
  subscribeChatEvents: (cb: (event: ChatEvent) => void) => () => void;
  sendToWindow?: <T extends keyof IpcRendererEvents>(channel: T, ...args: IpcRendererEvents[T]) => void;
  /** Composed snapshot for `store:changed` broadcasts (same contract as ScheduledTaskManager). */
  getSnapshot?: () => StoreData | undefined;
  now?: () => number;
};

export class AutomationManager {
  private store: AutomationStore;
  private deps: ManagerDeps;
  private now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private chatUnsub: (() => void) | null = null;

  constructor(deps: ManagerDeps) {
    this.store = deps.store;
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }

  start(): void {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.timer.unref?.();
    this.chatUnsub = this.deps.subscribeChatEvents((event) => this.onChatEvent(event));
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.chatUnsub?.();
    this.chatUnsub = null;
  }

  // ------------------------------------------------------------------ CRUD

  list = (): Automation[] => this.automations();

  create = (input: AutomationInput): Automation => {
    const name = input.name.trim();
    if (!name) {
      throw new Error('Automation name is required');
    }
    if (!input.agentId) {
      throw new Error('Automation must target an agent');
    }
    if (!input.instruction.trim()) {
      throw new Error('Automation instruction is required');
    }
    const now = this.now();
    const automation: Automation = {
      id: randomUUID(),
      name,
      enabled: input.enabled ?? true,
      trigger: input.trigger,
      agentId: input.agentId,
      instruction: input.instruction.trim(),
      createdAt: now,
      updatedAt: now,
      ...(input.trigger.kind === 'schedule' ? { nextRunAt: nextScheduledTaskRun(input.trigger.schedule, now) } : {}),
    };
    this.write([...this.automations(), automation]);
    return automation;
  };

  update = (automationId: string, patch: AutomationUpdate): Automation => {
    const existing = this.automations().find((a) => a.id === automationId);
    if (!existing) {
      throw new Error(`Unknown automation: ${automationId}`);
    }
    const next: Automation = {
      ...existing,
      ...patch,
      ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
      ...(patch.instruction !== undefined ? { instruction: patch.instruction.trim() } : {}),
      updatedAt: this.now(),
    };
    // A trigger change (or re-enable) recomputes the schedule cursor so a
    // stale nextRunAt from a prior shape can't fire immediately.
    if (patch.trigger !== undefined || patch.enabled === true) {
      next.nextRunAt =
        next.trigger.kind === 'schedule' ? nextScheduledTaskRun(next.trigger.schedule, this.now()) : null;
    }
    this.patch(automationId, next);
    return next;
  };

  delete = (automationId: string): void => {
    this.write(this.automations().filter((a) => a.id !== automationId));
  };

  /** Manual fire from the card — validates the rule end-to-end. */
  runNow = (automationId: string): Automation => {
    const automation = this.automations().find((a) => a.id === automationId);
    if (!automation) {
      throw new Error(`Unknown automation: ${automationId}`);
    }
    return this.fire(automation, 'run manually');
  };

  // -------------------------------------------------------------- triggers

  /** Entry points forward every PR watch event here (after their own wiring). */
  onPullRequestEvent = (ev: PullRequestWatchEvent): void => {
    for (const automation of this.automations()) {
      if (automation.enabled && automation.trigger.kind === 'pr_event' && matchesPrEvent(automation.trigger, ev)) {
        this.fire(automation, `${ev.kind.replace('_', ' ')} on PR #${ev.number} in ${ev.repo}`);
      }
    }
  };

  private onChatEvent(event: ChatEvent): void {
    if (event.method !== 'chat.message_added') {
      return;
    }
    const msg = event.params.message;
    for (const automation of this.automations()) {
      if (!automation.enabled || automation.trigger.kind !== 'channel_message') {
        continue;
      }
      if (!matchesChannelMessage(automation.trigger, msg)) {
        continue;
      }
      if (messageCooldownActive(automation.lastFiredAt, this.now())) {
        continue;
      }
      const who = msg.fromName ?? (msg.from === 'user' ? 'the user' : msg.from);
      this.fire(automation, `${who} posted in #${msg.channel}: "${msg.text.slice(0, 120)}"`);
    }
  }

  private tick(): void {
    const now = this.now();
    for (const automation of this.automations()) {
      if (!automation.enabled || automation.trigger.kind !== 'schedule') {
        continue;
      }
      if (automation.nextRunAt == null || automation.nextRunAt > now) {
        continue;
      }
      // Advance the cursor past NOW before firing — a nudge, not a ledger:
      // missed slots (app closed) collapse into at most this one firing.
      const fired = this.fire(automation, describeTrigger(automation.trigger));
      this.patch(automation.id, { ...fired, nextRunAt: nextScheduledTaskRun(automation.trigger.schedule, now) });
    }
  }

  // ------------------------------------------------------------------ fire

  private fire(automation: Automation, cause: string): Automation {
    this.deps.deliver(automation.agentId, automationFireDetail(automation, cause));
    const next: Automation = {
      ...automation,
      lastFiredAt: this.now(),
      lastFiredSummary: cause,
      fireCount: (automation.fireCount ?? 0) + 1,
    };
    this.patch(automation.id, next);
    return next;
  }

  // ----------------------------------------------------------- persistence

  private automations(): Automation[] {
    return this.store.get('automations') ?? [];
  }

  private patch(automationId: string, next: Automation): void {
    const all = this.automations();
    const index = all.findIndex((a) => a.id === automationId);
    if (index < 0) {
      return;
    }
    const updated = [...all];
    updated[index] = next;
    this.write(updated);
  }

  private write(automations: Automation[]): void {
    this.store.set('automations', automations);
    // Same broadcast contract as ScheduledTaskManager.writeTasks: composed
    // snapshot when wired, raw store payload otherwise (tests).
    this.deps.sendToWindow?.(
      'store:changed',
      this.deps.getSnapshot
        ? this.deps.getSnapshot()
        : ((this.store as Store<StoreData>).store as StoreData | undefined)
    );
  }
}

export function registerAutomationHandlers(
  ipc: IIpcListener,
  resolve: (event: unknown) => AutomationManager
): string[] {
  ipc.handle('automation:list', (event: unknown) => resolve(event).list());
  ipc.handle('automation:create', (event: unknown, input: AutomationInput) => resolve(event).create(input));
  ipc.handle('automation:update', (event: unknown, automationId: string, patch: AutomationUpdate) =>
    resolve(event).update(automationId, patch)
  );
  ipc.handle('automation:delete', (event: unknown, automationId: string) => resolve(event).delete(automationId));
  ipc.handle('automation:run-now', (event: unknown, automationId: string) => resolve(event).runNow(automationId));
  return ['automation:list', 'automation:create', 'automation:update', 'automation:delete', 'automation:run-now'];
}
