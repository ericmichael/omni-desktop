/**
 * IPC handler registration for project / ticket / pipeline / artifacts /
 * context / files / session-history surfaces — everything PM still owns
 * after Sprint C3.
 *
 * Takes a `resolve(event)` callback (see registerMilestoneHandlers) so the same
 * registration serves the single-manager Electron app and the per-tenant
 * server. Returns the channel names registered for cleanup.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { ProjectManager } from '@/main/project-manager';
import { checkGitRepo } from '@/main/worktree-ops';
import type { IIpcListener } from '@/shared/ipc-listener';

export function registerProjectHandlers(ipc: IIpcListener, resolve: (event: unknown) => ProjectManager): string[] {
  const channels: string[] = [];
  const h = (ch: string, fn: (pm: ProjectManager, ...args: any[]) => unknown): void => {
    ipc.handle(ch, (event: unknown, ...args: any[]) => fn(resolve(event), ...args));
    channels.push(ch);
  };

  // Project handlers
  h('project:add-project', (pm, project) => pm.addProject(project));
  h('project:update-project', (pm, id, patch) => pm.updateProject(id, patch));
  h('project:remove-project', (pm, id) => pm.removeProject(id));
  h('project:get-dir', (pm, id) => pm.getProjectDir(id));
  h('project:check-git-repo', (_pm, workspaceDir) => checkGitRepo(workspaceDir));

  // Ticket handlers
  h('project:add-ticket', (pm, ticket) => pm.addTicket(ticket));
  h('project:update-ticket', (pm, id, patch) => pm.updateTicket(id, patch));
  h('project:remove-ticket', (pm, id) => pm.removeTicket(id));
  h('project:get-tickets', (pm, projectId) => pm.getTicketsByProject(projectId));
  h('project:get-next-ticket', (pm, projectId) => pm.getNextTicket(projectId));

  // Kanban
  h('project:move-ticket-to-column', (pm, ticketId, columnId) => pm.moveTicketToColumn(ticketId, columnId));
  h('project:resolve-ticket', (pm, ticketId, resolution) => pm.resolveTicket(ticketId, resolution));
  h('project:assign-ticket', (pm, ticketId, assignee) => pm.assignTicket(ticketId, assignee));
  h('project:get-pipeline', async (pm, projectId) => {
    await pm.ensureWorkflowLoaded(projectId);
    return pm.getPipeline(projectId);
  });

  // Artifacts
  h('project:list-artifacts', (pm, ticketId, dirPath) => pm.listArtifacts(ticketId, dirPath));
  h('project:read-artifact', (pm, ticketId, relativePath) => pm.readArtifact(ticketId, relativePath));
  h('project:open-artifact-external', (pm, ticketId, relativePath) => pm.openArtifactExternal(ticketId, relativePath));
  h('project:get-files-changed', (pm, ticketId, sourceId) => pm.getFilesChanged(ticketId, sourceId));
  h('project:get-code-tab-files-changed', (pm, tabId, sourceId) => pm.getCodeTabFilesChanged(tabId, sourceId));
  h('project:apply-code-tab-source-changes', (pm, tabId, sourceId) => pm.applyCodeTabSourceChanges(tabId, sourceId));

  // Local PR flow (per-source — sourceId is one of the project's ProjectSource ids)
  h('project:set-pr-review', (pm, ticketId, sourceId, review) => pm.setPrReview(ticketId, sourceId, review));
  h('project:check-merge', (pm, ticketId, sourceId) => pm.checkPrMerge(ticketId, sourceId));
  h('project:merge-ticket', (pm, ticketId, sourceId) => pm.mergePrTicket(ticketId, sourceId));

  // Context + project files
  h('project:read-context', (pm, projectId) => pm.readContext(projectId));
  h('project:write-context', (pm, projectId, content) => pm.writeContext(projectId, content));
  h('project:list-project-files', (pm, projectId) => pm.listProjectFiles(projectId));
  h('project:get-context-preview', (pm, projectId) => pm.getContextPreview(projectId));
  h('project:open-project-file', (pm, projectId, relativePath) => pm.openProjectFile(projectId, relativePath));

  return channels;
}
