import { emitter } from '@/renderer/services/ipc';
import type { Automation, AutomationInput, AutomationUpdate } from '@/shared/types';

export const automationApi = {
  list: (): Promise<Automation[]> => emitter.invoke('automation:list'),
  create: (input: AutomationInput): Promise<Automation> => emitter.invoke('automation:create', input),
  update: (automationId: string, patch: AutomationUpdate): Promise<Automation> =>
    emitter.invoke('automation:update', automationId, patch),
  delete: (automationId: string): Promise<void> => emitter.invoke('automation:delete', automationId),
  runNow: (automationId: string): Promise<Automation> => emitter.invoke('automation:run-now', automationId),
};
