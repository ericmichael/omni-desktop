import { makeStyles, mergeClasses, shorthands,tokens } from '@fluentui/react-components';
import { ArrowSync20Regular, FolderOpen20Regular } from '@fluentui/react-icons';
import { memo, useCallback, useEffect, useRef, useState } from 'react';

import { IconButton } from '@/renderer/ds';
import type { ArtifactFileEntry, TicketId } from '@/shared/types';

import { ArtifactFileTree } from './ArtifactFileTree';
import { ArtifactPreview } from './ArtifactPreview';
import { ticketApi } from './state';

const MIN_TREE_PERCENT = 20;
const MAX_TREE_PERCENT = 50;
const DEFAULT_TREE_PERCENT = 30;

const useStyles = makeStyles({
  emptyState: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    gap: tokens.spacingVerticalM,
  },
  emptyIcon: {
    color: tokens.colorNeutralForeground3,
  },
  emptyText: {
    fontSize: tokens.fontSizeBase300,
    color: tokens.colorNeutralForeground2,
  },
  emptySubText: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
  },
  splitRoot: {
    position: 'relative',
    display: 'flex',
    width: '100%',
    height: '100%',
  },
  selectNone: {
    userSelect: 'none',
  },
  dragOverlay: {
    position: 'absolute',
    inset: 0,
    zIndex: 20,
    cursor: 'col-resize',
  },
  treePane: {
    minWidth: 0,
    overflowY: 'auto',
    ...shorthands.borderRight('1px', 'solid', tokens.colorNeutralStroke1),
  },
  treeHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    paddingLeft: tokens.spacingHorizontalM,
    paddingRight: tokens.spacingHorizontalM,
    paddingTop: tokens.spacingVerticalS,
    paddingBottom: tokens.spacingVerticalS,
    ...shorthands.borderBottom('1px', 'solid', tokens.colorNeutralStroke1),
  },
  treeLabel: {
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightMedium,
    color: tokens.colorNeutralForeground1,
    flex: '1 1 0',
  },
  divider: {
    width: '4px',
    flexShrink: 0,
    cursor: 'col-resize',
    transitionProperty: 'background-color',
    transitionDuration: '100ms',
    backgroundColor: tokens.colorNeutralStroke1,
    zIndex: 10,
    ':hover': {
      backgroundColor: 'rgba(99, 102, 241, 0.5)',
    },
  },
  previewPane: {
    flex: '1 1 0',
    minWidth: 0,
    minHeight: 0,
  },
});

type TicketArtifactsTabProps = {
  ticketId: TicketId;
};

export const TicketArtifactsTab = memo(({ ticketId }: TicketArtifactsTabProps) => {
  const styles = useStyles();
  const [entries, setEntries] = useState<ArtifactFileEntry[]>([]);
  const [selectedFile, setSelectedFile] = useState<ArtifactFileEntry | null>(null);
  const [treeWidthPercent, setTreeWidthPercent] = useState(DEFAULT_TREE_PERCENT);
  const [isDragging, setIsDragging] = useState(false);
  const splitRef = useRef<HTMLDivElement>(null);

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
      <div className={styles.emptyState}>
        <FolderOpen20Regular style={{ width: 32, height: 32 }} className={styles.emptyIcon} />
        <p className={styles.emptyText}>No artifacts yet</p>
        <p className={styles.emptySubText}>Agent-produced files will appear here</p>
        <IconButton
          aria-label="Refresh"
          icon={<ArrowSync20Regular />}
          size="sm"
          onClick={fetchEntries}
        />
      </div>
    );
  }

  return (
    <div ref={splitRef} className={mergeClasses(styles.splitRoot, isDragging && styles.selectNone)}>
      {isDragging && <div className={styles.dragOverlay} />}

      {/* File tree pane */}
      <div className={styles.treePane} style={{ width: `${treeWidthPercent}%` }}>
        <div className={styles.treeHeader}>
          <span className={styles.treeLabel}>Files</span>
          <IconButton
            aria-label="Refresh"
            icon={<ArrowSync20Regular />}
            size="sm"
            onClick={fetchEntries}
          />
        </div>
        <ArtifactFileTree
          entries={entries}
          ticketId={ticketId}
          selectedPath={selectedFile?.relativePath ?? null}
          onSelect={handleSelect}
        />
      </div>

      {/* Draggable divider */}
      <div
        className={styles.divider}
        onMouseDown={handleDividerMouseDown}
      />

      {/* Preview pane */}
      <div className={styles.previewPane}>
        <ArtifactPreview ticketId={ticketId} selectedFile={selectedFile} />
      </div>
    </div>
  );
});
TicketArtifactsTab.displayName = 'TicketArtifactsTab';
