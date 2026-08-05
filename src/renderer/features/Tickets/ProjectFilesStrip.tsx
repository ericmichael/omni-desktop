import { File, Folder } from 'lucide-react';
import { memo, useEffect, useState } from 'react';

import { cn } from '@/renderer/ds/cn';
import { Button } from '@/renderer/ds/ui/button';
import { persistedStoreApi } from '@/renderer/services/store';
import type { ArtifactFileEntry, ProjectId } from '@/shared/types';

import { ticketApi } from './state';

function formatSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(0)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const ProjectFilesStrip = memo(({ projectId }: { projectId: ProjectId }) => {
  const [files, setFiles] = useState<ArtifactFileEntry[]>([]);

  useEffect(() => {
    void ticketApi.listProjectFiles(projectId).then(setFiles);
  }, [projectId]);

  const project = persistedStoreApi.$atom.get().projects.find((p) => p.id === projectId);
  const slug = project?.slug ?? '';

  if (files.length === 0) {
    return (
      <div className="flex items-stretch gap-2 pl-5 pr-5 pt-2 pb-2 overflow-x-auto flex-nowrap h-20 shrink-0">
        <span className="flex items-center text-muted-foreground italic text-xs whitespace-nowrap">
          Add files to ~/Omni/Workspace/Projects/{slug}/
        </span>
      </div>
    );
  }

  return (
    <div className="flex items-stretch gap-2 pl-5 pr-5 pt-2 pb-2 overflow-x-auto flex-nowrap h-20 shrink-0">
      {files.map((entry) => (
        <Button
          key={entry.relativePath}
          type="button"
          variant="secondary"
          className="flex flex-col items-center justify-center gap-1 min-w-25 max-w-25 p-2 bg-muted rounded-lg cursor-pointer border-0 text-muted-foreground transition-colors duration-100 hover:bg-accent"
          onClick={() => void ticketApi.openProjectFile(projectId, entry.relativePath)}
        >
          {entry.isDirectory ? <Folder className="size-5" /> : <File className="size-5" />}
          <span
            className={cn(
              'text-xs text-muted-foreground',
              'overflow-hidden text-ellipsis whitespace-nowrap w-full text-center text-muted-foreground'
            )}
          >
            {entry.name}
          </span>
          {!entry.isDirectory && (
            <span className={cn('text-xs text-muted-foreground', 'text-muted-foreground')}>
              {formatSize(entry.size)}
            </span>
          )}
        </Button>
      ))}
    </div>
  );
});
ProjectFilesStrip.displayName = 'ProjectFilesStrip';
