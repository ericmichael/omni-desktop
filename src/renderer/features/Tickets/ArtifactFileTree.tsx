import { memo, useCallback, useState } from 'react';
import { PiCaretRightBold, PiFileBold, PiFileImageBold, PiFolderBold, PiFolderOpenBold } from 'react-icons/pi';

import { cn } from '@/renderer/ds';
import type { ArtifactFileEntry, TicketId } from '@/shared/types';

import { ticketApi } from './state';

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico']);

const getFileIcon = (entry: ArtifactFileEntry, isExpanded: boolean) => {
  if (entry.isDirectory) {
    return isExpanded ? <PiFolderOpenBold size={14} className="text-yellow-400" /> : <PiFolderBold size={14} className="text-yellow-400" />;
  }
  const ext = entry.name.slice(entry.name.lastIndexOf('.')).toLowerCase();
  if (IMAGE_EXTENSIONS.has(ext)) {
    return <PiFileImageBold size={14} className="text-purple-400" />;
  }
  return <PiFileBold size={14} className="text-fg-muted" />;
};

const formatSize = (bytes: number): string => {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

type FileTreeNodeProps = {
  entry: ArtifactFileEntry;
  ticketId: TicketId;
  selectedPath: string | null;
  onSelect: (entry: ArtifactFileEntry) => void;
  depth: number;
};

const FileTreeNode = memo(({ entry, ticketId, selectedPath, onSelect, depth }: FileTreeNodeProps) => {
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<ArtifactFileEntry[] | null>(null);

  const handleClick = useCallback(() => {
    if (entry.isDirectory) {
      if (!expanded && children === null) {
        void ticketApi.listArtifacts(ticketId, entry.relativePath).then(setChildren);
      }
      setExpanded((prev) => !prev);
    } else {
      onSelect(entry);
    }
  }, [entry, ticketId, expanded, children, onSelect]);

  const isSelected = !entry.isDirectory && selectedPath === entry.relativePath;

  return (
    <>
      <button
        type="button"
        onClick={handleClick}
        className={cn(
          'flex items-center gap-1.5 w-full text-left py-1 px-2 rounded text-sm hover:bg-surface-raised cursor-pointer transition-colors',
          isSelected && 'bg-accent-500/15 text-accent-400'
        )}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
      >
        {entry.isDirectory && (
          <PiCaretRightBold
            size={10}
            className={cn('shrink-0 text-fg-subtle transition-transform', expanded && 'rotate-90')}
          />
        )}
        {!entry.isDirectory && <span className="w-[10px] shrink-0" />}
        {getFileIcon(entry, expanded)}
        <span className="flex-1 truncate">{entry.name}</span>
        {!entry.isDirectory && <span className="text-[10px] text-fg-subtle shrink-0">{formatSize(entry.size)}</span>}
      </button>
      {expanded && children && (
        <div>
          {children.map((child) => (
            <FileTreeNode
              key={child.relativePath}
              entry={child}
              ticketId={ticketId}
              selectedPath={selectedPath}
              onSelect={onSelect}
              depth={depth + 1}
            />
          ))}
        </div>
      )}
    </>
  );
});
FileTreeNode.displayName = 'FileTreeNode';

type ArtifactFileTreeProps = {
  entries: ArtifactFileEntry[];
  ticketId: TicketId;
  selectedPath: string | null;
  onSelect: (entry: ArtifactFileEntry) => void;
};

export const ArtifactFileTree = memo(({ entries, ticketId, selectedPath, onSelect }: ArtifactFileTreeProps) => {
  return (
    <div className="flex flex-col py-1">
      {entries.map((entry) => (
        <FileTreeNode
          key={entry.relativePath}
          entry={entry}
          ticketId={ticketId}
          selectedPath={selectedPath}
          onSelect={onSelect}
          depth={0}
        />
      ))}
    </div>
  );
});
ArtifactFileTree.displayName = 'ArtifactFileTree';
