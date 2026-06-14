import { emitter } from '@/renderer/services/ipc';
import type {
  ScheduledTask,
  ScheduledTaskAllowedMcpTool,
  ScheduledTaskInput,
  ScheduledTaskUpdate,
} from '@/shared/types';

export const scheduledTaskApi = {
  list: (): Promise<ScheduledTask[]> => emitter.invoke('scheduled-task:list'),
  create: (input: ScheduledTaskInput): Promise<ScheduledTask> => emitter.invoke('scheduled-task:create', input),
  update: (taskId: string, patch: ScheduledTaskUpdate): Promise<ScheduledTask> =>
    emitter.invoke('scheduled-task:update', taskId, patch),
  delete: (taskId: string): Promise<void> => emitter.invoke('scheduled-task:delete', taskId),
  runNow: (taskId: string): Promise<ScheduledTask> => emitter.invoke('scheduled-task:run-now', taskId),
  allowTool: (taskId: string, toolName: string): Promise<ScheduledTask> =>
    emitter.invoke('scheduled-task:allow-tool', taskId, toolName),
  revokeTool: (taskId: string, toolName: string): Promise<ScheduledTask> =>
    emitter.invoke('scheduled-task:revoke-tool', taskId, toolName),
  allowMcpTool: (taskId: string, tool: ScheduledTaskAllowedMcpTool): Promise<ScheduledTask> =>
    emitter.invoke('scheduled-task:allow-mcp-tool', taskId, tool),
  revokeMcpTool: (taskId: string, tool: ScheduledTaskAllowedMcpTool): Promise<ScheduledTask> =>
    emitter.invoke('scheduled-task:revoke-mcp-tool', taskId, tool),
};
