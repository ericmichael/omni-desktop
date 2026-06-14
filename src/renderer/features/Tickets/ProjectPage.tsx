import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import {
  Add20Regular,
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
import { AddSourceDialog } from '@/renderer/features/Projects/AddSourceDialog';
import { persistedStoreApi } from '@/renderer/services/store';
import { $glassEnabled } from '@/renderer/theme/use-glass';
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
  desktopHeaderGlass: {
    backgroundColor: tokens.colorNeutralBackground1,
    backdropFilter: 'var(--glass-blur-light)',
    WebkitBackdropFilter: 'var(--glass-blur-light)',
  },
  headerTitle: {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    minWidth: 0,
    flex: '1 1 0',
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
  const isGlass = useStore($glassEnabled);

  const project = useMemo(() => store.projects.find((p) => p.id === projectId), [store.projects, projectId]);
  const rootPage = useMemo(
    () => Object.values(pages).find((p) => p.projectId === projectId && p.isRoot),
    [pages, projectId]
  );

  const handleBack = useCallback(() => {
    ticketApi.goToDashboard();
  }, []);

  if (!project) {
    return null;
  }

  return (
    <div className={styles.root}>
      <div
        className={mergeClasses(styles.desktopHeader, isGlass && styles.desktopHeaderGlass)}
        data-slot="project-page-header"
      >
        <IconButton aria-label="Back to Home" icon={<ArrowLeft20Regular />} size="sm" onClick={handleBack} />
        <div className={styles.headerTitle}>
          <Caption1>Projects</Caption1>
          <Subtitle2>{project.label}</Subtitle2>
        </div>
        <ProjectActions projectId={projectId} />
      </div>

      <div className={styles.body}>
        {/* Full-bleed root page */}
        {rootPage && <PageView pageId={rootPage.id} projectId={projectId} />}
      </div>
    </div>
  );
});
ProjectPage.displayName = 'ProjectPage';

export const ProjectActions = memo(({ projectId }: { projectId: ProjectId }) => {
  const store = useStore(persistedStoreApi.$atom);
  const project = useMemo(() => store.projects.find((p) => p.id === projectId), [store.projects, projectId]);
  const [editFormOpen, setEditFormOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [pipelineSettingsOpen, setPipelineSettingsOpen] = useState(false);
  const [addSourceOpen, setAddSourceOpen] = useState(false);

  const handleOpenBoard = useCallback(() => ticketApi.goToBoard(projectId), [projectId]);
  const handleOpenAddSource = useCallback(() => setAddSourceOpen(true), []);
  const handleCloseAddSource = useCallback(() => setAddSourceOpen(false), []);
  const handleOpenEdit = useCallback(() => setEditFormOpen(true), []);
  const handleOpenPipelineSettings = useCallback(() => setPipelineSettingsOpen(true), []);
  const handleOpenDelete = useCallback(() => setDeleteConfirmOpen(true), []);
  const handleCloseEdit = useCallback(() => setEditFormOpen(false), []);
  const handleClosePipelineSettings = useCallback(() => setPipelineSettingsOpen(false), []);
  const handleCloseDelete = useCallback(() => setDeleteConfirmOpen(false), []);
  const handleRemoveProject = useCallback(async () => {
    await ticketApi.removeProject(projectId);
    ticketApi.goToDashboard();
  }, [projectId]);

  if (!project) {
    return null;
  }

  return (
    <>
      <Menu positioning={{ position: 'below', align: 'end' }}>
        <MenuTrigger>
          <IconButton aria-label="Project actions" icon={<MoreHorizontal20Regular />} size="sm" />
        </MenuTrigger>
        <MenuPopover>
          <MenuList>
            <MenuItem icon={<Board20Regular />} onClick={handleOpenBoard}>
              Board
            </MenuItem>
            <MenuDivider />
            <MenuItem icon={<Add20Regular />} onClick={handleOpenAddSource}>
              Add source…
            </MenuItem>
            <MenuItem icon={<Settings20Regular />} onClick={handleOpenEdit}>
              Project settings
            </MenuItem>
            {project.sources.length > 0 && (
              <MenuItem icon={<Settings20Regular />} onClick={handleOpenPipelineSettings}>
                Pipeline settings
              </MenuItem>
            )}
            {!project.isPersonal && (
              <>
                <MenuDivider />
                <MenuItem icon={<Delete20Regular />} onClick={handleOpenDelete}>
                  Delete project
                </MenuItem>
              </>
            )}
          </MenuList>
        </MenuPopover>
      </Menu>

      <AddSourceDialog open={addSourceOpen} onClose={handleCloseAddSource} project={project} />
      {editFormOpen && <ProjectForm open={editFormOpen} onClose={handleCloseEdit} editProject={project} />}
      <PipelineSettingsDialog projectId={projectId} open={pipelineSettingsOpen} onClose={handleClosePipelineSettings} />
      <ConfirmDialog
        open={deleteConfirmOpen}
        onClose={handleCloseDelete}
        onConfirm={handleRemoveProject}
        title="Delete project?"
        description="This will remove the project and all its tickets. Your workspace files will not be affected."
        confirmLabel="Delete"
        destructive
      />
    </>
  );
});
ProjectActions.displayName = 'ProjectActions';
