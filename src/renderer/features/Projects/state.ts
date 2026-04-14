import { emitter } from '@/renderer/services/ipc';
import type { GitRepoInfo,Project, ProjectId } from '@/shared/types';

export const projectsApi = {
  addProject: (project: Omit<Project, 'id' | 'createdAt'>): Promise<Project> => {
    return emitter.invoke('project:add-project', project);
  },
  updateProject: (id: ProjectId, patch: Partial<Omit<Project, 'id' | 'createdAt'>>): Promise<void> => {
    return emitter.invoke('project:update-project', id, patch);
  },
  removeProject: (id: ProjectId): Promise<void> => {
    return emitter.invoke('project:remove-project', id);
  },
  checkGitRepo: (workspaceDir: string): Promise<GitRepoInfo> => {
    return emitter.invoke('project:check-git-repo', workspaceDir);
  },
};
