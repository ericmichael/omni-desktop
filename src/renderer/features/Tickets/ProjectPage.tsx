import { useStore } from '@nanostores/react';
import { memo, useCallback, useMemo, useState } from 'react';
import {
  Delete20Regular,
  MoreHorizontal20Regular,
  Settings20Regular,
  Board20Regular,
} from '@fluentui/react-icons';
import { makeStyles, tokens } from '@fluentui/react-components';

import {
  ConfirmDialog,
  IconButton,
  Menu,
  MenuDivider,
  MenuItem,
  MenuList,
  MenuPopover,
  MenuTrigger,
} from '@/renderer/ds';
import { $pages } from '@/renderer/features/Pages/state';
import { PageView } from '@/renderer/features/Pages/PageView';
import { persistedStoreApi } from '@/renderer/services/store';
import type { ProjectId } from '@/shared/types';

import { PipelineSettingsDialog } from './PipelineSettingsDialog';
import { ProjectForm } from './ProjectForm';
import { ticketApi } from './state';

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    width: '100%',
    height: '100%',
  },
  overflowBtn: {
    position: 'absolute',
    top: tokens.spacingVerticalM,
    right: tokens.spacingHorizontalL,
    zIndex: 1,
  },
});

export const ProjectPage = memo(({ projectId }: { projectId: ProjectId }) => {
  const styles = useStyles();
  const store = useStore(persistedStoreApi.$atom);
  const pages = useStore($pages);

  const project = useMemo(() => store.projects.find((p) => p.id === projectId), [store.projects, projectId]);
  const rootPage = useMemo(
    () => Object.values(pages).find((p) => p.projectId === projectId && p.isRoot),
    [pages, projectId]
  );

  const [editFormOpen, setEditFormOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [pipelineSettingsOpen, setPipelineSettingsOpen] = useState(false);

  const handleRemoveProject = useCallback(async () => {
    await ticketApi.removeProject(projectId);
    ticketApi.goToDashboard();
  }, [projectId]);

  if (!project) return null;

  return (
    <div className={styles.root} style={{ position: 'relative' }}>
      {/* Overflow menu — floating top-right */}
      <div className={styles.overflowBtn}>
        <Menu positioning={{ position: 'below', align: 'end' }}>
          <MenuTrigger>
            <IconButton aria-label="Project actions" icon={<MoreHorizontal20Regular />} size="sm" />
          </MenuTrigger>
          <MenuPopover>
            <MenuList>
              <MenuItem icon={<Board20Regular />} onClick={() => ticketApi.goToBoard(projectId)}>
                Board
              </MenuItem>
              <MenuDivider />
              <MenuItem icon={<Settings20Regular />} onClick={() => setEditFormOpen(true)}>
                Project settings
              </MenuItem>
              {project?.source != null && (
                <MenuItem icon={<Settings20Regular />} onClick={() => setPipelineSettingsOpen(true)}>
                  Pipeline settings
                </MenuItem>
              )}
              {!project.isPersonal && (
                <>
                  <MenuDivider />
                  <MenuItem icon={<Delete20Regular />} onClick={() => setDeleteConfirmOpen(true)}>
                    Delete project
                  </MenuItem>
                </>
              )}
            </MenuList>
          </MenuPopover>
        </Menu>
      </div>

      {/* Full-bleed root page */}
      {rootPage && <PageView pageId={rootPage.id} projectId={projectId} />}

      {/* Dialogs */}
      {editFormOpen && <ProjectForm open={editFormOpen} onClose={() => setEditFormOpen(false)} editProject={project} />}
      <PipelineSettingsDialog
        projectId={projectId}
        open={pipelineSettingsOpen}
        onClose={() => setPipelineSettingsOpen(false)}
      />
      <ConfirmDialog
        open={deleteConfirmOpen}
        onClose={() => setDeleteConfirmOpen(false)}
        onConfirm={handleRemoveProject}
        title="Delete project?"
        description="This will remove the project and all its tickets. Your workspace files will not be affected."
        confirmLabel="Delete"
        destructive
      />
    </div>
  );
});
ProjectPage.displayName = 'ProjectPage';
