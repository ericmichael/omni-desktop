import { useStore } from '@nanostores/react';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { PiGearSixBold, PiGitBranchBold, PiPencilSimpleBold, PiPlusBold, PiTrashFill } from 'react-icons/pi';

import { Button, IconButton, Switch } from '@/renderer/ds';
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

  if (!project) {
    return null;
  }

  return (
    <div className="flex flex-col w-full h-full">
      {/* Project header */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-surface-border shrink-0">
        <span className="text-sm font-semibold text-fg truncate">{project.label}</span>
        <div className="flex items-center rounded-md border border-surface-border text-xs overflow-hidden ml-2">
          <button
            className={`px-2.5 py-1 transition-colors ${view === 'board' ? 'bg-surface-raised text-fg font-medium' : 'text-fg-muted hover:text-fg'}`}
            onClick={() => setView('board')}
          >
            Board
          </button>
          <button
            className={`px-2.5 py-1 transition-colors ${view === 'brief' ? 'bg-surface-raised text-fg font-medium' : 'text-fg-muted hover:text-fg'}`}
            onClick={() => setView('brief')}
          >
            Brief
          </button>
        </div>
        <div className="flex-1" />
        <label className="flex items-center gap-1.5 text-xs text-fg-muted cursor-pointer select-none">
          <Switch checked={project.autoDispatch ?? false} onCheckedChange={handleToggleAutoDispatch} />
          Auto-dispatch
        </label>
        {!ticketFormOpen && (
          <Button size="sm" onClick={handleOpenTicketForm}>
            New Ticket
          </Button>
        )}
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
        <IconButton aria-label="Edit project" icon={<PiPencilSimpleBold />} size="sm" onClick={handleOpenEditForm} />
        <IconButton
          aria-label="Pipeline settings"
          icon={<PiGearSixBold />}
          size="sm"
          onClick={handleOpenPipelineSettings}
        />
        <IconButton aria-label="Delete project" icon={<PiTrashFill />} size="sm" onClick={handleRemoveProject} />
      </div>

      {ticketFormOpen && (
        <div className="px-6 pt-4 shrink-0">
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
        <div className="px-6 pt-4 shrink-0">
          <InitiativeForm projectId={projectId} onClose={handleCloseInitiativeForm} />
        </div>
      )}

      {editingInitiativeId && activeInitiative && (
        <div className="px-6 pt-4 shrink-0">
          <InitiativeForm
            projectId={projectId}
            onClose={handleCloseInitiativeEdit}
            editInitiative={activeInitiative}
          />
        </div>
      )}

      {/* Initiative filter bar */}
      {view === 'board' && projectInitiatives.length > 1 && (
        <div className="flex items-center gap-1.5 px-4 py-1.5 border-b border-surface-border shrink-0">
          <button
            className={`px-2 py-0.5 rounded text-xs transition-colors ${
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
              className={`px-2 py-0.5 rounded text-xs transition-colors ${
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
            <span className="ml-1 flex items-center gap-1 rounded-full bg-purple-400/10 px-2 py-0.5 text-[10px] font-medium text-purple-400">
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

      <div className="flex-1 min-h-0">
        {view === 'board' ? <KanbanBoard projectId={projectId} /> : <ProjectBrief projectId={projectId} />}
      </div>
    </div>
  );
});
ProjectDetail.displayName = 'ProjectDetail';
