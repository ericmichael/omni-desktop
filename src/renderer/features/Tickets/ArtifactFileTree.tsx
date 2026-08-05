import { File, Folder, FolderOpen, Image } from 'lucide-react';
import { memo, useCallback, useRef, useState } from 'react';

import { Tree, TreeItem, TreeItemLayout, type TreeItemOpenChangeData } from '@/renderer/ds/Tree';
import type { ArtifactFileEntry, TicketId } from '@/shared/types';

import { ticketApi } from './state';

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico']);

const getFileIcon = (entry: ArtifactFileEntry, isExpanded: boolean) => {
  if (entry.isDirectory) {
    return isExpanded ? <FolderOpen className="size-4 text-warning" /> : <Folder className="size-4 text-warning" />;
  }
  const ext = entry.name.slice(entry.name.lastIndexOf('.')).toLowerCase();
  if (IMAGE_EXTENSIONS.has(ext)) {
    return <Image className="size-4 text-primary" />;
  }
  return <File className="size-4 text-muted-foreground" />;
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
  openItems: Set<string>;
  childrenMap: Map<string, ArtifactFileEntry[]>;
};

const FileTreeNode = memo(({ entry, ticketId, selectedPath, onSelect, openItems, childrenMap }: FileTreeNodeProps) => {
  const isExpanded = openItems.has(entry.relativePath);
  const children = childrenMap.get(entry.relativePath);

  const handleClick = useCallback(() => {
    if (!entry.isDirectory) {
      onSelect(entry);
    }
  }, [entry, onSelect]);

  if (entry.isDirectory) {
    return (
      <TreeItem itemType="branch" value={entry.relativePath}>
        <TreeItemLayout iconBefore={getFileIcon(entry, isExpanded)}>{entry.name}</TreeItemLayout>
        {isExpanded && children && (
          <Tree>
            {children.map((child) => (
              <FileTreeNode
                key={child.relativePath}
                entry={child}
                ticketId={ticketId}
                selectedPath={selectedPath}
                onSelect={onSelect}
                openItems={openItems}
                childrenMap={childrenMap}
              />
            ))}
          </Tree>
        )}
      </TreeItem>
    );
  }

  const isSelected = selectedPath === entry.relativePath;

  return (
    <TreeItem itemType="leaf" value={entry.relativePath} onClick={handleClick} aria-selected={isSelected}>
      <TreeItemLayout
        className={isSelected ? 'bg-accent text-accent-foreground' : undefined}
        iconBefore={getFileIcon(entry, false)}
        aside={<span className="text-xs text-muted-foreground">{formatSize(entry.size)}</span>}
      >
        {entry.name}
      </TreeItemLayout>
    </TreeItem>
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
  const [openItems, setOpenItems] = useState<Set<string>>(new Set());
  const [childrenMap, setChildrenMap] = useState<Map<string, ArtifactFileEntry[]>>(new Map());
  const loadingRef = useRef<Set<string>>(new Set());

  const handleOpenChange = useCallback(
    (data: TreeItemOpenChangeData) => {
      const path = data.value as string;
      const willOpen = data.open;

      setOpenItems((prev) => {
        const next = new Set(prev);
        if (willOpen) {
          next.add(path);
        } else {
          next.delete(path);
        }
        return next;
      });

      // Lazy-load children on first expand
      if (willOpen && !childrenMap.has(path) && !loadingRef.current.has(path)) {
        loadingRef.current.add(path);
        void ticketApi.listArtifacts(ticketId, path).then((children) => {
          setChildrenMap((prev) => new Map(prev).set(path, children));
          loadingRef.current.delete(path);
        });
      }
    },
    [ticketId, childrenMap]
  );

  return (
    <Tree aria-label="Artifact files" onOpenChange={handleOpenChange} openItems={openItems}>
      {entries.map((entry) => (
        <FileTreeNode
          key={entry.relativePath}
          entry={entry}
          ticketId={ticketId}
          selectedPath={selectedPath}
          onSelect={onSelect}
          openItems={openItems}
          childrenMap={childrenMap}
        />
      ))}
    </Tree>
  );
});
ArtifactFileTree.displayName = 'ArtifactFileTree';
