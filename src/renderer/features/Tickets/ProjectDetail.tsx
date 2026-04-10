import { useStore } from '@nanostores/react';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { Settings20Regular, BranchFork20Regular, Edit20Regular, Add20Regular, Delete20Filled } from '@fluentui/react-icons';
import { makeStyles, mergeClasses, tokens, shorthands } from '@fluentui/react-components';

import { Body1, Button, Caption1, ConfirmDialog, IconButton, SegmentedControl, Switch, Subtitle2, Tab, TabList } from '@/renderer/ds';
import { $initiatives, initiativeApi } from '@/renderer/features/Initiatives/state';
import { persistedStoreApi } from '@/renderer/services/store';
import type { InitiativeId, ProjectId } from '@/shared/types';

import { InitiativeForm } from './InitiativeForm';
import { KanbanBoard } from './KanbanBoard';
import { PipelineSettingsDialog } from './PipelineSettingsDialog';
import { ProjectBrief } from './ProjectBrief';
import { ProjectForm } from './ProjectForm';
import { TicketForm } from './TicketForm';
import { $activeInitiativeId, ticketApi } from './state';

type ProjectView = 'board' | 'brief';

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    width: '100%',
    height: '100%',
  },
  headerBar: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    paddingLeft: tokens.spacingHorizontalM,
    paddingRight: tokens.spacingHorizontalM,
    paddingTop: '6px',
    paddingBottom: '6px',
    ...shorthands.borderBottom('1px', 'solid', tokens.colorNeutralStroke1),
    flexShrink: 0,
    '@media (min-width: 640px)': {
      gap: tokens.spacingHorizontalS,
      paddingLeft: tokens.spacingHorizontalL,
      paddingRight: tokens.spacingHorizontalL,
      paddingTop: tokens.spacingVerticalS,
      paddingBottom: tokens.spacingVerticalS,
    },
  },
  projectTitle: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  createdDate: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
    display: 'none',
    '@media (min-width: 640px)': {
      display: 'inline',
    },
  },
  flex1: {
    flex: '1 1 0',
  },
  autoDispatchLabel: {
    display: 'none',
    '@media (min-width: 640px)': {
      display: 'flex',
      alignItems: 'center',
      gap: '6px',
      fontSize: tokens.fontSizeBase200,
      color: tokens.colorNeutralForeground2,
      cursor: 'pointer',
      userSelect: 'none',
    },
  },
  desktopOnly: {
    display: 'none',
    '@media (min-width: 640px)': {
      display: 'contents',
    },
  },
  branchBadge: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    borderRadius: '9999px',
    backgroundColor: tokens.colorPalettePurpleBackground2,
    paddingLeft: tokens.spacingHorizontalS,
    paddingRight: tokens.spacingHorizontalS,
    paddingTop: '4px',
    paddingBottom: '4px',
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightMedium,
    color: tokens.colorPalettePurpleForeground2,
  },
  formArea: {
    paddingLeft: tokens.spacingHorizontalM,
    paddingRight: tokens.spacingHorizontalM,
    paddingTop: tokens.spacingVerticalL,
    flexShrink: 0,
    '@media (min-width: 640px)': {
      paddingLeft: tokens.spacingHorizontalXXL,
      paddingRight: tokens.spacingHorizontalXXL,
    },
  },
  filterBar: {
    display: 'flex',
    alignItems: 'center',
    ...shorthands.borderBottom('1px', 'solid', tokens.colorNeutralStroke1),
    flexShrink: 0,
    overflowX: 'auto',
    paddingLeft: tokens.spacingHorizontalS,
    paddingRight: tokens.spacingHorizontalS,
  },
  initiativeBar: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    paddingLeft: tokens.spacingHorizontalM,
    paddingRight: tokens.spacingHorizontalM,
    paddingTop: '6px',
    paddingBottom: '6px',
    ...shorthands.borderBottom('1px', 'solid', tokens.colorNeutralStroke1),
    flexShrink: 0,
    overflowX: 'auto',
    '@media (min-width: 640px)': {
      paddingLeft: tokens.spacingHorizontalL,
      paddingRight: tokens.spacingHorizontalL,
    },
  },
  initiativeDesc: {
    fontSize: tokens.fontSizeBase300,
    color: tokens.colorNeutralForeground2,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    flex: '1 1 0',
    minWidth: 0,
    '@media (min-width: 640px)': {
      fontSize: tokens.fontSizeBase200,
    },
  },
  boardArea: {
    flex: '1 1 0',
    minHeight: 0,
  },
  filterBranchBadge: {
    marginLeft: '4px',
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    borderRadius: '9999px',
    backgroundColor: tokens.colorPalettePurpleBackground2,
    paddingLeft: tokens.spacingHorizontalS,
    paddingRight: tokens.spacingHorizontalS,
    paddingTop: '2px',
    paddingBottom: '2px',
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightMedium,
    color: tokens.colorPalettePurpleForeground2,
  },
});

export const ProjectDetail = memo(({ projectId }: { projectId: ProjectId }) => {
  const styles = useStyles();
  const store = useStore(persistedStoreApi.$atom);
  const [view, setView] = useState<ProjectView>('board');
  const [ticketFormOpen, setTicketFormOpen] = useState(false);
  const [pipelineSettingsOpen, setPipelineSettingsOpen] = useState(false);
  const [editFormOpen, setEditFormOpen] = useState(false);
  const [initiativeFormOpen, setInitiativeFormOpen] = useState(false);
  const [editingInitiativeId, setEditingInitiativeId] = useState<InitiativeId | null>(null);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const initiatives = useStore($initiatives);
  const activeInitiativeId = useStore($activeInitiativeId);

  const project = useMemo(() => store.projects.find((p) => p.id === projectId), [store.projects, projectId]);
  const projectInitiatives = useMemo(
    () => Object.values(initiatives).filter((i) => i.projectId === projectId),
    [initiatives, projectId]
  );
  const activeInitiative = useMemo(
    () => (activeInitiativeId === 'all' ? null : projectInitiatives.find((i) => i.id === activeInitiativeId) ?? null),
    [activeInitiativeId, projectInitiatives]
  );

  useEffect(() => {
    if (!project) {
      return;
    }
    ticketApi.fetchTickets(projectId);
    ticketApi.getPipeline(projectId);
  }, [project, projectId]);

  useEffect(() => {
    if (activeInitiativeId === 'all') {
      setEditingInitiativeId(null);
    }
  }, [activeInitiativeId]);

  const handleOpenTicketForm = useCallback(() => setTicketFormOpen(true), []);
  const handleCloseTicketForm = useCallback(() => setTicketFormOpen(false), []);
  const handleOpenPipelineSettings = useCallback(() => setPipelineSettingsOpen(true), []);
  const handleClosePipelineSettings = useCallback(() => setPipelineSettingsOpen(false), []);
  const handleOpenEditForm = useCallback(() => setEditFormOpen(true), []);
  const handleCloseEditForm = useCallback(() => setEditFormOpen(false), []);
  const handleOpenInitiativeForm = useCallback(() => setInitiativeFormOpen(true), []);
  const handleCloseInitiativeForm = useCallback(() => setInitiativeFormOpen(false), []);
  const handleOpenInitiativeEdit = useCallback(() => {
    if (activeInitiative) {
      setEditingInitiativeId(activeInitiative.id);
    }
  }, [activeInitiative]);
  const handleCloseInitiativeEdit = useCallback(() => setEditingInitiativeId(null), []);
  const handleSelectInitiative = useCallback((id: InitiativeId | 'all') => $activeInitiativeId.set(id), []);

  const handleOpenDeleteConfirm = useCallback(() => setDeleteConfirmOpen(true), []);
  const handleCloseDeleteConfirm = useCallback(() => setDeleteConfirmOpen(false), []);
  const handleRemoveProject = useCallback(async () => {
    await ticketApi.removeProject(projectId);
    ticketApi.goToDashboard();
  }, [projectId]);

  const handleToggleAutoDispatch = useCallback(
    (checked: boolean) => {
      void ticketApi.setAutoDispatch(projectId, checked);
    },
    [projectId]
  );

  const handleCompleteInitiative = useCallback(() => {
    if (activeInitiative) {
      void initiativeApi.updateInitiative(activeInitiative.id, { status: 'completed' });
    }
  }, [activeInitiative]);

  const handleArchiveInitiative = useCallback(() => {
    if (activeInitiative) {
      void initiativeApi.updateInitiative(activeInitiative.id, { status: 'archived' });
    }
  }, [activeInitiative]);

  const handleReactivateInitiative = useCallback(() => {
    if (activeInitiative) {
      void initiativeApi.updateInitiative(activeInitiative.id, { status: 'active' });
    }
  }, [activeInitiative]);

  if (!project) {
    return null;
  }

  return (
    <div className={styles.root}>
      {/* Project header */}
      <div className={styles.headerBar}>
        <Subtitle2 className={styles.projectTitle}>{project.label}</Subtitle2>
        <Caption1 className={styles.createdDate}>
          Created {new Date(project.createdAt).toLocaleDateString()}
        </Caption1>
        <SegmentedControl
          value={view}
          options={[{ value: 'board', label: 'Board' }, { value: 'brief', label: 'Brief' }]}
          onChange={setView}
          layoutId="project-view-toggle"
          className="ml-1 sm:ml-2 shrink-0"
        />
        <div className={styles.flex1} />
        <label className={styles.autoDispatchLabel}>
          <Switch checked={project.autoDispatch ?? false} onCheckedChange={handleToggleAutoDispatch} />
          Auto-dispatch
        </label>
        {!ticketFormOpen && (
          <Button size="sm" onClick={handleOpenTicketForm} className="shrink-0">
            <span className="hidden sm:inline">New Ticket</span>
            <span className="sm:hidden"><Add20Regular style={{ width: 13, height: 13 }} /></span>
          </Button>
        )}
        <span className={styles.desktopOnly}>
          {!initiativeFormOpen && projectInitiatives.length <= 1 && (
            <Button size="sm" variant="ghost" onClick={handleOpenInitiativeForm}>
              New Initiative
            </Button>
          )}
          {activeInitiative && !editingInitiativeId && (
            <Button size="sm" variant="ghost" onClick={handleOpenInitiativeEdit}>
              Edit Initiative
            </Button>
          )}
          {activeInitiative?.branch && (
            <span className={styles.branchBadge}>
              <BranchFork20Regular style={{ width: 16, height: 16 }} />
              {activeInitiative.branch}
            </span>
          )}
        </span>
        <IconButton aria-label="Edit project" icon={<Edit20Regular />} size="sm" onClick={handleOpenEditForm} />
        <IconButton
          aria-label="Pipeline settings"
          icon={<Settings20Regular />}
          size="sm"
          onClick={handleOpenPipelineSettings}
        />
        <IconButton aria-label="Delete project" icon={<Delete20Filled />} size="sm" onClick={handleOpenDeleteConfirm} />
      </div>

      {ticketFormOpen && (
        <div className={styles.formArea}>
          <TicketForm projectId={projectId} onClose={handleCloseTicketForm} />
        </div>
      )}

      <PipelineSettingsDialog
        projectId={projectId}
        open={pipelineSettingsOpen}
        onClose={handleClosePipelineSettings}
      />

      {editFormOpen && <ProjectForm open={editFormOpen} onClose={handleCloseEditForm} editProject={project} />}

      {initiativeFormOpen && (
        <div className={styles.formArea}>
          <InitiativeForm projectId={projectId} onClose={handleCloseInitiativeForm} />
        </div>
      )}

      {editingInitiativeId && activeInitiative && (
        <div className={styles.formArea}>
          <InitiativeForm
            projectId={projectId}
            onClose={handleCloseInitiativeEdit}
            editInitiative={activeInitiative}
          />
        </div>
      )}

      <ConfirmDialog
        open={deleteConfirmOpen}
        onClose={handleCloseDeleteConfirm}
        onConfirm={handleRemoveProject}
        title="Delete project?"
        description="This will remove the project and all its tickets. Your workspace files will not be affected."
        confirmLabel="Delete"
        destructive
      />

      {/* Initiative filter bar */}
      {view === 'board' && projectInitiatives.length > 1 && (
        <div className={styles.filterBar}>
          <TabList
            selectedValue={activeInitiativeId}
            onTabSelect={(_e, data) => handleSelectInitiative(data.value as InitiativeId | 'all')}
            size="small"
            appearance="subtle"
          >
            <Tab value="all">All</Tab>
            {projectInitiatives.map((init) => (
              <Tab key={init.id} value={init.id}>{init.title}</Tab>
            ))}
          </TabList>
          {activeInitiative?.branch && (
            <span className={styles.filterBranchBadge}>
              <BranchFork20Regular style={{ width: 16, height: 16 }} />
              {activeInitiative.branch}
            </span>
          )}
          <IconButton
            aria-label="New initiative"
            icon={<Add20Regular />}
            size="sm"
            onClick={handleOpenInitiativeForm}
          />
        </div>
      )}

      {activeInitiative && !activeInitiative.isDefault && (
        <div className={styles.initiativeBar}>
          {activeInitiative.description && (
            <p className={styles.initiativeDesc}>{activeInitiative.description}</p>
          )}
          {!activeInitiative.description && <div className={styles.flex1} />}
          {activeInitiative.status === 'active' && (
            <>
              <Button size="sm" variant="ghost" onClick={handleCompleteInitiative} className="shrink-0">
                Complete
              </Button>
              <Button size="sm" variant="ghost" onClick={handleArchiveInitiative} className="shrink-0">
                Archive
              </Button>
            </>
          )}
          {(activeInitiative.status === 'completed' || activeInitiative.status === 'archived') && (
            <Button size="sm" variant="ghost" onClick={handleReactivateInitiative} className="shrink-0">
              Reactivate
            </Button>
          )}
        </div>
      )}

      <div className={styles.boardArea}>
        {view === 'board' ? <KanbanBoard projectId={projectId} /> : <ProjectBrief projectId={projectId} />}
      </div>
    </div>
  );
});
ProjectDetail.displayName = 'ProjectDetail';
