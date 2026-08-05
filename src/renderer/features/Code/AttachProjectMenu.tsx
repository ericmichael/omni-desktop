import { useStore } from '@nanostores/react';
import { FolderOpen } from 'lucide-react';
import { memo, useCallback, useState } from 'react';

import { Button } from '@/renderer/ds/ui/button';
/**
 * "Attach project" affordance for a chat (projectless) column. A project is
 * deferrable context here, not an admission gate: picking one binds
 * ``tab.projectId``, which swaps the workspace from the conversation's
 * scratch dir to the project dir (auto-launch handles the restart; the
 * conversation's ``sessionId`` is untouched, so the transcript continues).
 *
 * Renders its own trigger by default (greeting-shell extras row); pass
 * ``trigger`` to embed it behind existing chrome (e.g. a header icon button).
 */ import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/renderer/ds/ui/dropdown-menu';
import { ProjectCreateDialog } from '@/renderer/features/Projects/ProjectCreateDialog';
import { persistedStoreApi } from '@/renderer/services/store';
import type { CodeTabId, Project } from '@/shared/types';

import { codeApi } from './state';
export const AttachProjectMenu = memo(({ tabId, trigger }: { tabId: CodeTabId; trigger?: React.ReactElement }) => {
  const store = useStore(persistedStoreApi.$atom);
  const [showNewProject, setShowNewProject] = useState(false);

  const handlePick = useCallback(
    (projectId: string) => {
      void codeApi.setTabProject(tabId, projectId);
    },
    [tabId]
  );
  const handleCreated = useCallback(
    (project: Project) => {
      void codeApi.setTabProject(tabId, project.id);
    },
    [tabId]
  );
  const handleOpenNewProject = useCallback(() => setShowNewProject(true), []);
  const handleCloseNewProject = useCallback(() => setShowNewProject(false), []);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          {trigger ?? (
            <Button size="sm" variant="ghost">
              <FolderOpen className="size-4" />
              Attach project
            </Button>
          )}
        </DropdownMenuTrigger>
        <>
          <DropdownMenuContent>
            {store.projects.map((project) => (
              <DropdownMenuItem key={project.id} onClick={() => handlePick(project.id)}>
                {project.label}
              </DropdownMenuItem>
            ))}
            {store.projects.length > 0 && <DropdownMenuSeparator />}
            <DropdownMenuItem onClick={handleOpenNewProject}>New project…</DropdownMenuItem>
          </DropdownMenuContent>
        </>
      </DropdownMenu>
      <ProjectCreateDialog
        open={showNewProject}
        onClose={handleCloseNewProject}
        showSandboxProfile
        submitLabel="Create and attach"
        onCreated={handleCreated}
      />
    </>
  );
});
AttachProjectMenu.displayName = 'AttachProjectMenu';
