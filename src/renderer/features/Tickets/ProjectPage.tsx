import { makeStyles, tokens } from '@fluentui/react-components';
import {
  ArrowLeft20Regular,
  Board20Regular,
  Delete20Regular,
  MoreHorizontal20Regular,
  Settings20Regular,
} from '@fluentui/react-icons';
import { useStore } from '@nanostores/react';
import { memo, useCallback, useMemo, useState } from 'react';

import {
  Caption1,
  ConfirmDialog,
  IconButton,
  Menu,
  MenuDivider,
  MenuItem,
  MenuList,
  MenuPopover,
  MenuTrigger,
  Subtitle2,
} from '@/renderer/ds';
import { PageView } from '@/renderer/features/Pages/PageView';
import { $pages } from '@/renderer/features/Pages/state';
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
  desktopHeader: {
    display: 'none',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    paddingLeft: tokens.spacingHorizontalL,
    paddingRight: tokens.spacingHorizontalL,
    paddingTop: tokens.spacingVerticalS,
    paddingBottom: tokens.spacingVerticalS,
    borderBottom: `1px solid ${tokens.colorNeutralStroke1}`,
    '@media (min-width: 640px)': {
      display: 'flex',
    },
  },
  headerTitle: {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    minWidth: 0,
    flex: '1 1 0',
  },
  mobileOverflowBtn: {
    position: 'absolute',
    top: tokens.spacingVerticalM,
    right: tokens.spacingHorizontalL,
    zIndex: 1,
    '@media (min-width: 640px)': {
      display: 'none',
    },
  },
  body: {
    flex: '1 1 0',
    minHeight: 0,
    position: 'relative',
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

  const handleBack = useCallback(() => {
    ticketApi.goToDashboard();
  }, []);

  if (!project) {
return null;
}

  return (
    <div className={styles.root}>
      <div className={styles.desktopHeader}>
        <IconButton aria-label="Back to Home" icon={<ArrowLeft20Regular />} size="sm" onClick={handleBack} />
        <div className={styles.headerTitle}>
          <Caption1>Projects</Caption1>
          <Subtitle2>{project.label}</Subtitle2>
        </div>
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

      <div className={styles.body}>
        <div className={styles.mobileOverflowBtn}>
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
      </div>

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
