import { useStore } from '@nanostores/react';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { PiGearSixBold, PiGitBranchBold, PiPencilSimpleBold, PiPlusBold, PiTrashFill } from 'react-icons/pi';

import { Button, ConfirmDialog, IconButton, SegmentedControl, Switch } from '@/renderer/ds';
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

export const ProjectDetail = memo(({ projectId }: { projectId: ProjectId }) => {
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
    <div className="flex flex-col w-full h-full">
      {/* Project header */}
      <div className="flex items-center gap-1.5 sm:gap-2 px-3 sm:px-4 py-1.5 sm:py-2 border-b border-surface-border shrink-0">
        <span className="text-base sm:text-sm font-semibold text-fg truncate">{project.label}</span>
        <span className="text-xs text-fg-subtle hidden sm:inline">
          Created {new Date(project.createdAt).toLocaleDateString()}
        </span>
        <SegmentedControl
          value={view}
          options={[{ value: 'board', label: 'Board' }, { value: 'brief', label: 'Brief' }]}
          onChange={setView}
          layoutId="project-view-toggle"
          className="ml-1 sm:ml-2 shrink-0"
        />
        <div className="flex-1" />
        <label className="hidden sm:flex items-center gap-1.5 text-xs text-fg-muted cursor-pointer select-none">
          <Switch checked={project.autoDispatch ?? false} onCheckedChange={handleToggleAutoDispatch} />
          Auto-dispatch
        </label>
        {!ticketFormOpen && (
          <Button size="sm" onClick={handleOpenTicketForm} className="shrink-0">
            <span className="hidden sm:inline">New Ticket</span>
            <span className="sm:hidden"><PiPlusBold size={13} /></span>
          </Button>
        )}
        <span className="hidden sm:contents">
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
            <span className="flex items-center gap-1 rounded-full bg-purple-400/10 px-2 py-1 text-xs font-medium text-purple-400">
              <PiGitBranchBold size={12} />
              {activeInitiative.branch}
            </span>
          )}
        </span>
        <IconButton aria-label="Edit project" icon={<PiPencilSimpleBold />} size="sm" onClick={handleOpenEditForm} />
        <IconButton
          aria-label="Pipeline settings"
          icon={<PiGearSixBold />}
          size="sm"
          onClick={handleOpenPipelineSettings}
        />
        <IconButton aria-label="Delete project" icon={<PiTrashFill />} size="sm" onClick={handleOpenDeleteConfirm} />
      </div>

      {ticketFormOpen && (
        <div className="px-3 sm:px-6 pt-4 shrink-0">
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
        <div className="px-3 sm:px-6 pt-4 shrink-0">
          <InitiativeForm projectId={projectId} onClose={handleCloseInitiativeForm} />
        </div>
      )}

      {editingInitiativeId && activeInitiative && (
        <div className="px-3 sm:px-6 pt-4 shrink-0">
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
        <div className="flex items-center gap-1.5 px-3 sm:px-4 py-1.5 border-b border-surface-border shrink-0 overflow-x-auto scrollbar-none">
          <button
            className={`px-3 sm:px-2 py-1.5 sm:py-0.5 rounded-lg sm:rounded text-sm sm:text-xs shrink-0 transition-colors ${
              activeInitiativeId === 'all'
                ? 'bg-surface-raised text-fg font-medium'
                : 'text-fg-muted hover:text-fg'
            }`}
            onClick={() => handleSelectInitiative('all')}
          >
            All
          </button>
          {projectInitiatives.map((init) => (
            <button
              key={init.id}
              className={`px-3 sm:px-2 py-1.5 sm:py-0.5 rounded-lg sm:rounded text-sm sm:text-xs shrink-0 transition-colors ${
                activeInitiativeId === init.id
                  ? 'bg-surface-raised text-fg font-medium'
                  : 'text-fg-muted hover:text-fg'
              }`}
              onClick={() => handleSelectInitiative(init.id)}
            >
              {init.title}
            </button>
          ))}
          {activeInitiative?.branch && (
            <span className="ml-1 flex items-center gap-1 rounded-full bg-purple-400/10 px-2 py-0.5 text-xs font-medium text-purple-400">
              <PiGitBranchBold size={10} />
              {activeInitiative.branch}
            </span>
          )}
          <button
            className="px-1 py-0.5 rounded text-xs text-fg-muted hover:text-fg transition-colors"
            onClick={handleOpenInitiativeForm}
            aria-label="New initiative"
          >
            <PiPlusBold />
          </button>
        </div>
      )}

      {activeInitiative && !activeInitiative.isDefault && (
        <div className="flex items-center gap-2 px-3 sm:px-4 py-1.5 border-b border-surface-border shrink-0 overflow-x-auto scrollbar-none">
          {activeInitiative.description && (
            <p className="text-sm sm:text-xs text-fg-muted truncate flex-1 min-w-0">{activeInitiative.description}</p>
          )}
          {!activeInitiative.description && <div className="flex-1" />}
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

      <div className="flex-1 min-h-0">
        {view === 'board' ? <KanbanBoard projectId={projectId} /> : <ProjectBrief projectId={projectId} />}
      </div>
    </div>
  );
});
ProjectDetail.displayName = 'ProjectDetail';
