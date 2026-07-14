import { FolderOpen20Regular } from '@fluentui/react-icons';
import { useStore } from '@nanostores/react';
import { memo, useCallback, useState } from 'react';

import { Button, Menu, MenuDivider, MenuItem, MenuList, MenuPopover, MenuTrigger } from '@/renderer/ds';
import { ProjectCreateDialog } from '@/renderer/features/Projects/ProjectCreateDialog';
import { persistedStoreApi } from '@/renderer/services/store';
import type { CodeTabId, Project } from '@/shared/types';

import { codeApi } from './state';

/**
 * "Attach project" affordance for a chat (projectless) column. A project is
 * deferrable context here, not an admission gate: picking one binds
 * ``tab.projectId``, which swaps the workspace from the conversation's
 * scratch dir to the project dir (auto-launch handles the restart; the
 * conversation's ``sessionId`` is untouched, so the transcript continues).
 *
 * Renders its own trigger by default (greeting-shell extras row); pass
 * ``trigger`` to embed it behind existing chrome (e.g. a header icon button).
 */
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
      <Menu positioning={{ position: 'below', align: 'start' }}>
        <MenuTrigger>
          {trigger ?? (
            <Button size="sm" variant="ghost" leftIcon={<FolderOpen20Regular style={{ width: 14, height: 14 }} />}>
              Attach project
            </Button>
          )}
        </MenuTrigger>
        <MenuPopover>
          <MenuList>
            {store.projects.map((project) => (
              <MenuItem key={project.id} onClick={() => handlePick(project.id)}>
                {project.label}
              </MenuItem>
            ))}
            {store.projects.length > 0 && <MenuDivider />}
            <MenuItem onClick={handleOpenNewProject}>New project…</MenuItem>
          </MenuList>
        </MenuPopover>
      </Menu>
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
