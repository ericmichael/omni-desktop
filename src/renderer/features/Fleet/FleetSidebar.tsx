import { useStore } from '@nanostores/react';
import { memo, useCallback, useMemo, useState } from 'react';
import { PiPlusBold } from 'react-icons/pi';

import { cn, IconButton } from '@/renderer/ds';
import { persistedStoreApi } from '@/renderer/services/store';
import type { FleetProject, FleetTask } from '@/shared/types';

import { STATUS_COLORS } from './fleet-constants';
import { FleetProjectForm } from './FleetProjectForm';
import { $fleetTasks, $fleetView, fleetApi } from './state';

const SidebarProjectItem = memo(
  ({ project, isActive, taskCount }: { project: FleetProject; isActive: boolean; taskCount: number }) => {
    const handleClick = useCallback(() => {
      fleetApi.goToProject(project.id);
    }, [project.id]);

    const shortPath = useMemo(() => {
      const segments = project.workspaceDir.split('/').filter(Boolean);
      return segments.slice(-2).join('/');
    }, [project.workspaceDir]);

    return (
      <button
        onClick={handleClick}
        className={cn(
          'flex items-center gap-2 w-full px-3 py-1.5 text-left transition-colors cursor-pointer',
          isActive ? 'bg-accent-600/20 text-fg' : 'text-fg-muted hover:bg-white/5 hover:text-fg'
        )}
      >
        <div className="flex flex-col flex-1 min-w-0">
          <span className="text-sm truncate">{project.label}</span>
          <span className="text-[10px] text-fg-subtle truncate">{shortPath}</span>
        </div>
        {taskCount > 0 && (
          <span className="shrink-0 px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-green-400/10 text-green-400">
            {taskCount}
          </span>
        )}
      </button>
    );
  }
);
SidebarProjectItem.displayName = 'SidebarProjectItem';

const SidebarTaskItem = memo(
  ({ task, isActive, projectPath }: { task: FleetTask; isActive: boolean; projectPath: string }) => {
    const handleClick = useCallback(() => {
      if (task.status.type === 'running') {
        fleetApi.goToTask(task.id);
      } else {
        fleetApi.goToProject(task.projectId);
      }
    }, [task.id, task.projectId, task.status.type]);

    const shortPath = useMemo(() => {
      const segments = projectPath.split('/').filter(Boolean);
      return segments.slice(-2).join('/');
    }, [projectPath]);

    return (
      <button
        onClick={handleClick}
        className={cn(
          'flex items-center gap-2 w-full px-3 py-1.5 text-left transition-colors cursor-pointer',
          isActive ? 'bg-accent-600/20 text-fg' : 'text-fg-muted hover:bg-white/5 hover:text-fg'
        )}
      >
        <div className={cn('size-2 rounded-full shrink-0 mt-1 self-start', STATUS_COLORS[task.status.type])} />
        <div className="flex flex-col flex-1 min-w-0">
          <span className="text-sm truncate">{task.taskDescription}</span>
          <span className="text-[10px] text-fg-subtle truncate">{shortPath}</span>
        </div>
      </button>
    );
  }
);
SidebarTaskItem.displayName = 'SidebarTaskItem';

export const FleetSidebar = memo(() => {
  const store = useStore(persistedStoreApi.$atom);
  const tasks = useStore($fleetTasks);
  const view = useStore($fleetView);
  const [formOpen, setFormOpen] = useState(false);

  const projects = store.fleetProjects;
  const allTasks = useMemo(() => Object.values(tasks), [tasks]);

  const projectPathMap = useMemo(() => {
    const map: Record<string, string> = {};
    for (const p of projects) {
      map[p.id] = p.workspaceDir;
    }
    return map;
  }, [projects]);

  const activeTaskCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const task of allTasks) {
      if (task.status.type === 'running' || task.status.type === 'starting') {
        counts[task.projectId] = (counts[task.projectId] ?? 0) + 1;
      }
    }
    return counts;
  }, [allTasks]);

  const handleOpenForm = useCallback(() => {
    setFormOpen(true);
  }, []);

  const handleCloseForm = useCallback(() => {
    setFormOpen(false);
  }, []);

  return (
    <div className="flex flex-col h-full w-60 border-r border-surface-border bg-surface shrink-0">
      {/* Projects section */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-surface-border">
        <span className="text-xs font-semibold text-fg-muted uppercase tracking-wider">Projects</span>
        <IconButton aria-label="New project" icon={<PiPlusBold />} size="sm" onClick={handleOpenForm} />
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto py-1">
        {projects.length === 0 ? (
          <p className="px-3 py-2 text-xs text-fg-subtle">No projects yet</p>
        ) : (
          projects.map((project) => (
            <SidebarProjectItem
              key={project.id}
              project={project}
              isActive={view.type === 'project' && view.projectId === project.id}
              taskCount={activeTaskCounts[project.id] ?? 0}
            />
          ))
        )}
      </div>

      {/* Tasks section */}
      <div className="flex items-center justify-between px-3 py-2 border-t border-b border-surface-border">
        <span className="text-xs font-semibold text-fg-muted uppercase tracking-wider">Tasks</span>
        {allTasks.length > 0 && <span className="text-xs text-fg-subtle">{allTasks.length}</span>}
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto py-1">
        {allTasks.length === 0 ? (
          <p className="px-3 py-2 text-xs text-fg-subtle">No tasks yet</p>
        ) : (
          allTasks.map((task) => (
            <SidebarTaskItem
              key={task.id}
              task={task}
              isActive={view.type === 'task' && view.taskId === task.id}
              projectPath={projectPathMap[task.projectId] ?? ''}
            />
          ))
        )}
      </div>

      <FleetProjectForm open={formOpen} onClose={handleCloseForm} />
    </div>
  );
});
FleetSidebar.displayName = 'FleetSidebar';
