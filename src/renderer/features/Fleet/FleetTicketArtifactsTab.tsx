import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { PiArrowsClockwiseBold, PiFolderOpenBold } from 'react-icons/pi';

import { IconButton } from '@/renderer/ds';
import type { ArtifactFileEntry, FleetTicketId } from '@/shared/types';

import { FleetArtifactFileTree } from './FleetArtifactFileTree';
import { FleetArtifactPreview } from './FleetArtifactPreview';
import { fleetApi } from './state';

const MIN_TREE_PERCENT = 20;
const MAX_TREE_PERCENT = 50;
const DEFAULT_TREE_PERCENT = 30;

type FleetTicketArtifactsTabProps = {
  ticketId: FleetTicketId;
};

export const FleetTicketArtifactsTab = memo(({ ticketId }: FleetTicketArtifactsTabProps) => {
  const [entries, setEntries] = useState<ArtifactFileEntry[]>([]);
  const [selectedFile, setSelectedFile] = useState<ArtifactFileEntry | null>(null);
  const [treeWidthPercent, setTreeWidthPercent] = useState(DEFAULT_TREE_PERCENT);
  const [isDragging, setIsDragging] = useState(false);
  const splitRef = useRef<HTMLDivElement>(null);

  const fetchEntries = useCallback(() => {
    void fleetApi.listArtifacts(ticketId).then(setEntries);
  }, [ticketId]);

  useEffect(() => {
    fetchEntries();
  }, [fetchEntries]);

  const handleSelect = useCallback((entry: ArtifactFileEntry) => {
    if (!entry.isDirectory) {
      setSelectedFile(entry);
    }
  }, []);

  const handleDividerMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setIsDragging(true);

      const handleMouseMove = (ev: MouseEvent) => {
        const rect = splitRef.current?.getBoundingClientRect();
        if (!rect) {
          return;
        }
        const pct = ((ev.clientX - rect.left) / rect.width) * 100;
        setTreeWidthPercent(Math.min(MAX_TREE_PERCENT, Math.max(MIN_TREE_PERCENT, pct)));
      };

      const handleMouseUp = () => {
        setIsDragging(false);
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
      };

      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
    },
    []
  );

  if (entries.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3">
        <PiFolderOpenBold size={32} className="text-fg-subtle" />
        <p className="text-sm text-fg-muted">No artifacts yet</p>
        <p className="text-xs text-fg-subtle">Agent-produced files will appear here</p>
        <IconButton
          aria-label="Refresh"
          icon={<PiArrowsClockwiseBold />}
          size="sm"
          onClick={fetchEntries}
        />
      </div>
    );
  }

  return (
    <div ref={splitRef} className={`relative flex w-full h-full ${isDragging ? 'select-none' : ''}`}>
      {isDragging && <div className="absolute inset-0 z-20 cursor-col-resize" />}

      {/* File tree pane */}
      <div className="min-w-0 overflow-y-auto border-r border-surface-border" style={{ width: `${treeWidthPercent}%` }}>
        <div className="flex items-center gap-2 px-3 py-2 border-b border-surface-border">
          <span className="text-xs font-medium text-fg flex-1">Files</span>
          <IconButton
            aria-label="Refresh"
            icon={<PiArrowsClockwiseBold />}
            size="sm"
            onClick={fetchEntries}
          />
        </div>
        <FleetArtifactFileTree
          entries={entries}
          ticketId={ticketId}
          selectedPath={selectedFile?.relativePath ?? null}
          onSelect={handleSelect}
        />
      </div>

      {/* Draggable divider */}
      <div
        className="w-1 shrink-0 cursor-col-resize hover:bg-accent-500/50 transition-colors bg-surface-border z-10"
        onMouseDown={handleDividerMouseDown}
      />

      {/* Preview pane */}
      <div className="flex-1 min-w-0 min-h-0">
        <FleetArtifactPreview ticketId={ticketId} selectedFile={selectedFile} />
      </div>
    </div>
  );
});
FleetTicketArtifactsTab.displayName = 'FleetTicketArtifactsTab';
