import { useStore } from '@nanostores/react';
import { Ellipsis, Folder, Globe, Plus } from 'lucide-react';
import { memo, useCallback, useMemo, useState } from 'react';

import { sourceLabel, sourceLocation } from '@/lib/source-label';
import { Button } from '@/renderer/ds/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/renderer/ds/ui/dropdown-menu';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from '@/renderer/ds/ui/item';
import { AddSourceDialog } from '@/renderer/features/Projects/AddSourceDialog';
import { CredentialStatus } from '@/renderer/features/Projects/CredentialStatus';
import { EditSourceDialog } from '@/renderer/features/Projects/EditSourceDialog';
import { SourceDetailDialog } from '@/renderer/features/Projects/SourceDetailDialog';
import { GitCredentialDialog } from '@/renderer/features/SettingsModal/GitCredentialDialog';
import { persistedStoreApi } from '@/renderer/services/store';
import type { ProjectId } from '@/shared/types';

import { $tickets, ticketApi } from './state';

export const ProjectSourcesSettings = memo(({ projectId }: { projectId: ProjectId }) => {
  const store = useStore(persistedStoreApi.$atom);
  const ticketMap = useStore($tickets);
  const project = useMemo(
    () => store.projects.find((candidate) => candidate.id === projectId),
    [projectId, store.projects]
  );
  const [addOpen, setAddOpen] = useState(false);
  const [detailSourceId, setDetailSourceId] = useState<string | null>(null);
  const [editSourceId, setEditSourceId] = useState<string | null>(null);
  const [addTokenHost, setAddTokenHost] = useState<string | null>(null);

  const handleRemove = useCallback(
    (sourceId: string) => {
      const current = persistedStoreApi.$atom.get().projects.find((candidate) => candidate.id === projectId);
      if (current) {
        void ticketApi.updateProject(projectId, {
          sources: current.sources.filter((source) => source.id !== sourceId),
        });
      }
    },
    [projectId]
  );

  const handleEditFromDetail = useCallback(() => {
    setEditSourceId(detailSourceId);
    setDetailSourceId(null);
  }, [detailSourceId]);

  const handleRemoveFromDetail = useCallback(() => {
    if (detailSourceId) {
      handleRemove(detailSourceId);
    }
    setDetailSourceId(null);
  }, [detailSourceId, handleRemove]);

  if (!project) {
    return null;
  }

  const detailSource = detailSourceId ? project.sources.find((source) => source.id === detailSourceId) : undefined;
  const editSource = editSourceId ? project.sources.find((source) => source.id === editSourceId) : undefined;

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium">Connected files</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">Folders or services you want to use with this project.</p>
        </div>
        <Button size="sm" variant="outline" onClick={() => setAddOpen(true)}>
          <Plus />
          Add files
        </Button>
      </div>

      {project.sources.length > 0 ? (
        <ItemGroup className="gap-1">
          {project.sources.map((source) => (
            <Item key={source.id} size="sm" variant="outline">
              <ItemMedia variant="icon">{source.kind === 'local' ? <Folder /> : <Globe />}</ItemMedia>
              <ItemContent>
                <ItemTitle>{source.mountName}</ItemTitle>
                <ItemDescription title={sourceLocation(source)}>{sourceLabel(source)}</ItemDescription>
                {source.kind === 'git-remote' && (
                  <CredentialStatus
                    repoUrl={source.repoUrl}
                    credentials={store.gitCredentials ?? []}
                    onAddToken={setAddTokenHost}
                  />
                )}
              </ItemContent>
              <ItemActions>
                <Button size="sm" variant="ghost" onClick={() => setDetailSourceId(source.id)}>
                  Open
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button type="button" variant="ghost" size="icon-sm" aria-label={`${source.mountName} actions`}>
                      <Ellipsis />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => setEditSourceId(source.id)}>Edit connection</DropdownMenuItem>
                    <DropdownMenuItem onClick={() => handleRemove(source.id)}>Remove connection</DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </ItemActions>
            </Item>
          ))}
        </ItemGroup>
      ) : (
        <div className="rounded-lg border border-dashed px-4 py-5 text-sm text-muted-foreground">
          Nothing connected. You can still use Pages, Tasks, and Ask Omni without attaching files.
        </div>
      )}

      <AddSourceDialog open={addOpen} onClose={() => setAddOpen(false)} project={project} />
      {detailSource && (
        <SourceDetailDialog
          open
          onClose={() => setDetailSourceId(null)}
          project={project}
          source={detailSource}
          tickets={Object.values(ticketMap)}
          onEdit={handleEditFromDetail}
          onRemove={handleRemoveFromDetail}
        />
      )}
      {editSource && (
        <EditSourceDialog open onClose={() => setEditSourceId(null)} project={project} source={editSource} />
      )}
      <GitCredentialDialog
        open={addTokenHost !== null}
        onClose={() => setAddTokenHost(null)}
        initialHost={addTokenHost ?? ''}
      />
    </section>
  );
});
ProjectSourcesSettings.displayName = 'ProjectSourcesSettings';
