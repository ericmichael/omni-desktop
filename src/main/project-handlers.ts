/**
 * IPC handler registration for project / ticket / pipeline / artifacts /
 * context / files / session-history surfaces — everything PM still owns
 * after Sprint C3.
 *
 * Extracted from `createProjectManager` (Sprint C4). Supervisor / page /
 * milestone / inbox handlers live in their own modules. Returns the list of
 * channel names registered so the caller can clean them up at shutdown.
 */
import type { ProjectManager } from '@/main/project-manager';
import { checkGitRepo } from '@/main/worktree-ops';
import type { IIpcListener } from '@/shared/ipc-listener';

export function registerProjectHandlers(ipc: IIpcListener, projectManager: ProjectManager): string[] {
  // Project handlers
  ipc.handle('project:add-project', (_, project) => projectManager.addProject(project));
  ipc.handle('project:update-project', (_, id, patch) => projectManager.updateProject(id, patch));
  ipc.handle('project:remove-project', (_, id) => projectManager.removeProject(id));
  ipc.handle('project:check-git-repo', (_, workspaceDir) => checkGitRepo(workspaceDir));

  // Ticket handlers
  ipc.handle('project:add-ticket', (_, ticket) => projectManager.addTicket(ticket));
  ipc.handle('project:update-ticket', (_, id, patch) => projectManager.updateTicket(id, patch));
  ipc.handle('project:remove-ticket', (_, id) => projectManager.removeTicket(id));
  ipc.handle('project:get-tickets', (_, projectId) => projectManager.getTicketsByProject(projectId));
  ipc.handle('project:get-next-ticket', (_, projectId) => projectManager.getNextTicket(projectId));

  // Kanban
  ipc.handle('project:move-ticket-to-column', (_, ticketId, columnId) =>
    projectManager.moveTicketToColumn(ticketId, columnId)
  );
  ipc.handle('project:resolve-ticket', (_, ticketId, resolution) => projectManager.resolveTicket(ticketId, resolution));
  ipc.handle('project:get-pipeline', async (_, projectId) => {
    await projectManager.ensureWorkflowLoaded(projectId);
    return projectManager.getPipeline(projectId);
  });

  // Session history
  ipc.handle('project:get-session-history', (_, sessionId) => projectManager.getSessionHistory(sessionId));

  // Artifacts
  ipc.handle('project:list-artifacts', (_, ticketId, dirPath) => projectManager.listArtifacts(ticketId, dirPath));
  ipc.handle('project:read-artifact', (_, ticketId, relativePath) =>
    projectManager.readArtifact(ticketId, relativePath)
  );
  ipc.handle('project:open-artifact-external', (_, ticketId, relativePath) =>
    projectManager.openArtifactExternal(ticketId, relativePath)
  );
  ipc.handle('project:get-files-changed', (_, ticketId) => projectManager.getFilesChanged(ticketId));

  // Context + project files
  ipc.handle('project:read-context', (_, projectId) => projectManager.readContext(projectId));
  ipc.handle('project:write-context', (_, projectId, content) => projectManager.writeContext(projectId, content));
  ipc.handle('project:list-project-files', (_, projectId) => projectManager.listProjectFiles(projectId));
  ipc.handle('project:get-context-preview', (_, projectId) => projectManager.getContextPreview(projectId));
  ipc.handle('project:open-project-file', (_, projectId, relativePath) =>
    projectManager.openProjectFile(projectId, relativePath)
  );

  return [
    'project:add-project',
    'project:update-project',
    'project:remove-project',
    'project:check-git-repo',
    'project:add-ticket',
    'project:update-ticket',
    'project:remove-ticket',
    'project:get-tickets',
    'project:get-next-ticket',
    'project:move-ticket-to-column',
    'project:resolve-ticket',
    'project:get-pipeline',
    'project:get-session-history',
    'project:list-artifacts',
    'project:read-artifact',
    'project:open-artifact-external',
    'project:get-files-changed',
    'project:read-context',
    'project:write-context',
    'project:list-project-files',
    'project:get-context-preview',
    'project:open-project-file',
  ];
}
