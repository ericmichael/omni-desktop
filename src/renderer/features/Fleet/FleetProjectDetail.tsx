import { useStore } from '@nanostores/react';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { PiGearSixBold, PiPencilSimpleBold, PiTrashFill } from 'react-icons/pi';

import { Button, IconButton, Switch } from '@/renderer/ds';
import { persistedStoreApi } from '@/renderer/services/store';
import type { FleetProjectId } from '@/shared/types';

import { FleetKanbanBoard } from './FleetKanbanBoard';
import { FleetPipelineSettingsDialog } from './FleetPipelineSettingsDialog';
import { FleetProjectForm } from './FleetProjectForm';
import { FleetTicketForm } from './FleetTicketForm';
import { fleetApi } from './state';

export const FleetProjectDetail = memo(({ projectId }: { projectId: FleetProjectId }) => {
  const store = useStore(persistedStoreApi.$atom);
  const [ticketFormOpen, setTicketFormOpen] = useState(false);
  const [pipelineSettingsOpen, setPipelineSettingsOpen] = useState(false);
  const [editFormOpen, setEditFormOpen] = useState(false);

  const project = useMemo(() => store.fleetProjects.find((p) => p.id === projectId), [store.fleetProjects, projectId]);

  useEffect(() => {
    if (!project) {
      return;
    }
    fleetApi.fetchTickets(projectId);
    fleetApi.getPipeline(projectId);
  }, [project, projectId]);

  const handleOpenTicketForm = useCallback(() => setTicketFormOpen(true), []);
  const handleCloseTicketForm = useCallback(() => setTicketFormOpen(false), []);
  const handleOpenPipelineSettings = useCallback(() => setPipelineSettingsOpen(true), []);
  const handleClosePipelineSettings = useCallback(() => setPipelineSettingsOpen(false), []);
  const handleOpenEditForm = useCallback(() => setEditFormOpen(true), []);
  const handleCloseEditForm = useCallback(() => setEditFormOpen(false), []);

  const handleRemoveProject = useCallback(async () => {
    await fleetApi.removeProject(projectId);
    fleetApi.goToDashboard();
  }, [projectId]);

  const handleToggleAutoDispatch = useCallback(
    (checked: boolean) => {
      void fleetApi.setAutoDispatch(projectId, checked);
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
          <FleetTicketForm projectId={projectId} onClose={handleCloseTicketForm} />
        </div>
      )}

      <FleetPipelineSettingsDialog
        projectId={projectId}
        open={pipelineSettingsOpen}
        onClose={handleClosePipelineSettings}
      />

      {editFormOpen && <FleetProjectForm open={editFormOpen} onClose={handleCloseEditForm} editProject={project} />}

      <div className="flex-1 min-h-0">
        <FleetKanbanBoard projectId={projectId} />
      </div>
    </div>
  );
});
FleetProjectDetail.displayName = 'FleetProjectDetail';
