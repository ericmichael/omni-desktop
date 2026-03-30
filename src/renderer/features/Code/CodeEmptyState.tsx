import { useStore } from '@nanostores/react';
import { memo, useCallback, useState } from 'react';
import { PiFolderOpenBold, PiPlusBold } from 'react-icons/pi';

import { Button, Heading } from '@/renderer/ds';
import { ProjectForm } from '@/renderer/features/Projects/ProjectForm';
import { persistedStoreApi } from '@/renderer/services/store';
import type { CodeTabId, Project } from '@/shared/types';

import { codeApi } from './state';

type CodeEmptyStateProps = {
  tabId: CodeTabId;
  embedded?: boolean;
};

const ProjectCard = memo(
  ({ project, onSelect }: { project: Project; onSelect: (project: Project) => void }) => {
    const handleClick = useCallback(() => {
      onSelect(project);
    }, [project, onSelect]);

    return (
      <button
        onClick={handleClick}
        className="flex items-center gap-3 rounded-lg border border-surface-border bg-surface p-4 text-left hover:border-accent-500 hover:bg-surface-overlay transition-colors cursor-pointer"
      >
        <PiFolderOpenBold className="text-fg-muted shrink-0" size={20} />
        <div className="min-w-0">
          <div className="text-sm font-medium text-fg truncate">{project.label}</div>
          <div className="text-xs text-fg-muted truncate">{project.workspaceDir}</div>
        </div>
      </button>
    );
  }
);
ProjectCard.displayName = 'ProjectCard';

export const CodeEmptyState = memo(({ tabId, embedded = false }: CodeEmptyStateProps) => {
  const store = useStore(persistedStoreApi.$atom);
  const [showNewProject, setShowNewProject] = useState(false);

  const projects = store.projects;

  const handleSelectProject = useCallback(
    (project: Project) => {
      codeApi.setTabProject(tabId, project.id);
    },
    [tabId]
  );

  const handleOpenNewProject = useCallback(() => {
    setShowNewProject(true);
  }, []);

  const handleCloseNewProject = useCallback(() => {
    setShowNewProject(false);
  }, []);

  return (
    <div className={embedded ? 'flex flex-col items-center gap-6 w-full' : 'flex flex-col items-center justify-center h-full w-full gap-6 p-8'}>
      {!embedded && <Heading size="md">Select a Project</Heading>}
      {!embedded && (
        <p className="text-sm text-fg-muted text-center max-w-md">
          Choose an existing project to open in this tab, or create a new one.
        </p>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 max-w-lg w-full max-h-[400px] overflow-y-auto">
        {projects.map((project) => (
          <ProjectCard key={project.id} project={project} onSelect={handleSelectProject} />
        ))}
      </div>

      <Button variant="ghost" onClick={handleOpenNewProject}>
        <PiPlusBold className="mr-1.5" size={14} />
        Create new project
      </Button>

      <ProjectForm open={showNewProject} onClose={handleCloseNewProject} />
    </div>
  );
});
CodeEmptyState.displayName = 'CodeEmptyState';
