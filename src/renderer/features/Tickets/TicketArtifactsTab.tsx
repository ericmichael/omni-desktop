import { FolderOpen, RefreshCw } from 'lucide-react';
import { memo, useCallback, useEffect, useState } from 'react';

import { Button } from '@/renderer/ds/ui/button';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/renderer/ds/ui/empty';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/renderer/ds/ui/resizable';
import type { ArtifactFileEntry, TicketId } from '@/shared/types';

import { ArtifactFileTree } from './ArtifactFileTree';
import { ArtifactPreview } from './ArtifactPreview';
import { ticketApi } from './state';

type TicketArtifactsTabProps = {
  ticketId: TicketId;
};

export const TicketArtifactsTab = memo(({ ticketId }: TicketArtifactsTabProps) => {
  const [entries, setEntries] = useState<ArtifactFileEntry[]>([]);
  const [selectedFile, setSelectedFile] = useState<ArtifactFileEntry | null>(null);

  const fetchEntries = useCallback(() => {
    void ticketApi.listArtifacts(ticketId).then(setEntries);
  }, [ticketId]);

  useEffect(() => {
    fetchEntries();
  }, [fetchEntries]);

  const handleSelect = useCallback((entry: ArtifactFileEntry) => {
    if (!entry.isDirectory) {
      setSelectedFile(entry);
    }
  }, []);

  if (entries.length === 0) {
    return (
      <Empty className="h-full border-0">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <FolderOpen />
          </EmptyMedia>
          <EmptyTitle>No results yet</EmptyTitle>
          <EmptyDescription>Files Omni creates for this task will appear here.</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button type="button" variant="ghost" size="icon-sm" aria-label="Refresh" onClick={fetchEntries}>
            <RefreshCw />
          </Button>
        </EmptyContent>
      </Empty>
    );
  }

  return (
    <ResizablePanelGroup orientation="horizontal">
      <ResizablePanel defaultSize="30%" minSize="20%" maxSize="50%">
        <div className="h-full min-w-0 overflow-y-auto">
          <div className="flex items-center gap-2 pl-4 pr-4 pt-2 pb-2 border-b border-border">
            <span className="text-xs font-medium text-foreground flex-1">Files</span>
            <Button type="button" variant="ghost" size="icon-sm" aria-label="Refresh" onClick={fetchEntries}>
              <RefreshCw />
            </Button>
          </div>
          <ArtifactFileTree
            entries={entries}
            ticketId={ticketId}
            selectedPath={selectedFile?.relativePath ?? null}
            onSelect={handleSelect}
          />
        </div>
      </ResizablePanel>
      <ResizableHandle withHandle />
      <ResizablePanel defaultSize="70%" minSize="50%">
        <div className="h-full min-w-0 min-h-0">
          <ArtifactPreview ticketId={ticketId} selectedFile={selectedFile} />
        </div>
      </ResizablePanel>
    </ResizablePanelGroup>
  );
});
TicketArtifactsTab.displayName = 'TicketArtifactsTab';
