import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { ArrowSync20Regular, BranchCompare20Regular } from '@fluentui/react-icons';
import { makeStyles, mergeClasses, tokens, shorthands } from '@fluentui/react-components';

import { IconButton, ListSkeleton, Spinner, Tab, TabList } from '@/renderer/ds';
import type { SelectTabData } from '@/renderer/ds';
import type { DiffResponse, FileDiff, TicketId } from '@/shared/types';

import { TicketPROverview } from './TicketPROverview';
import { ticketApi } from './state';

const POLL_INTERVAL_MS = 5_000;
const MIN_LIST_PERCENT = 20;
const MAX_LIST_PERCENT = 50;
const DEFAULT_LIST_PERCENT = 28;

const STATUS_COLORS: Record<FileDiff['status'], string> = {
  added: 'text-green-400',
  modified: 'text-yellow-400',
  deleted: 'text-red-400',
  renamed: 'text-blue-400',
  copied: 'text-blue-400',
  untracked: 'text-green-300',
};

const STATUS_BG_COLORS: Record<FileDiff['status'], string> = {
  added: 'bg-green-400/10',
  modified: 'bg-yellow-400/10',
  deleted: 'bg-red-400/10',
  renamed: 'bg-blue-400/10',
  copied: 'bg-blue-400/10',
  untracked: 'bg-green-300/10',
};

const STATUS_LABELS: Record<FileDiff['status'], string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
  copied: 'C',
  untracked: 'U',
};

type PatchRow =
  | { type: 'hunk'; text: string }
  | { type: 'context'; oldLine: number; newLine: number; text: string }
  | { type: 'addition'; newLine: number; text: string }
  | { type: 'deletion'; oldLine: number; text: string };

const buildPatchRows = (patch: string): PatchRow[] => {
  const rows: PatchRow[] = [];
  const lines = patch.split('\n');
  let oldLine = 0;
  let newLine = 0;
  let inHeader = true;

  for (const line of lines) {
    // Skip diff headers (---, +++, diff --git, index)
    if (inHeader) {
      if (line.startsWith('@@')) {
        inHeader = false;
      } else {
        continue;
      }
    }

    if (line.startsWith('@@')) {
      const match = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)/);
      if (match) {
        oldLine = parseInt(match[1]!, 10);
        newLine = parseInt(match[2]!, 10);
        rows.push({ type: 'hunk', text: `@@ -${match[1]} +${match[2]} @@${match[3] ?? ''}` });
      }
    } else if (line.startsWith('+')) {
      rows.push({ type: 'addition', newLine, text: line.slice(1) });
      newLine++;
    } else if (line.startsWith('-')) {
      rows.push({ type: 'deletion', oldLine, text: line.slice(1) });
      oldLine++;
    } else if (line.startsWith('\\')) {
      // "\ No newline at end of file" — skip
    } else {
      rows.push({ type: 'context', oldLine, newLine, text: line.startsWith(' ') ? line.slice(1) : line });
      oldLine++;
      newLine++;
    }
  }

  return rows;
};

const useStyles = makeStyles({
  centerMessage: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    fontSize: tokens.fontSizeBase300,
    color: tokens.colorNeutralForeground2,
  },
  diffRoot: {
    overflowY: 'auto',
    height: '100%',
    fontFamily: 'monospace',
    fontSize: tokens.fontSizeBase200,
    lineHeight: '20px',
  },
  hunkRow: {
    backgroundColor: 'rgba(59, 130, 246, 0.1)',
    color: tokens.colorBrandForeground1,
    paddingLeft: tokens.spacingHorizontalL,
    paddingRight: tokens.spacingHorizontalL,
    paddingTop: '2px',
    paddingBottom: '2px',
    position: 'sticky',
    top: 0,
    zIndex: 10,
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    ...shorthands.borderBottom('1px', 'solid', tokens.colorNeutralStroke1),
  },
  diffLine: {
    display: 'grid',
    gridTemplateColumns: '3.5rem 3.5rem 1fr',
    minWidth: 'fit-content',
  },
  additionBg: {
    backgroundColor: 'rgba(34, 197, 94, 0.1)',
  },
  deletionBg: {
    backgroundColor: 'rgba(239, 68, 68, 0.1)',
  },
  lineNumber: {
    textAlign: 'right',
    paddingRight: tokens.spacingHorizontalS,
    color: 'rgba(var(--colorNeutralForeground3), 0.5)',
    userSelect: 'none',
    ...shorthands.borderRight('1px', 'solid', 'rgba(var(--colorNeutralStroke1), 0.5)'),
  },
  lineContent: {
    paddingLeft: tokens.spacingHorizontalS,
    whiteSpace: 'pre',
  },
  additionText: {
    color: tokens.colorPaletteGreenForeground1,
  },
  deletionText: {
    color: tokens.colorPaletteRedForeground1,
  },
  contextText: {
    color: tokens.colorNeutralForeground2,
  },
  selectNone: {
    userSelect: 'none',
  },
  fileListBtn: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    width: '100%',
    paddingLeft: tokens.spacingHorizontalM,
    paddingRight: tokens.spacingHorizontalM,
    paddingTop: '6px',
    paddingBottom: '6px',
    textAlign: 'left',
    fontSize: tokens.fontSizeBase200,
    cursor: 'pointer',
    transitionProperty: 'background-color',
    transitionDuration: '100ms',
    border: 'none',
    backgroundColor: 'transparent',
  },
  fileListSelected: {
    backgroundColor: tokens.colorBrandBackground2,
    color: tokens.colorNeutralForeground1,
  },
  fileListUnselected: {
    color: tokens.colorNeutralForeground2,
    ':hover': {
      backgroundColor: tokens.colorSubtleBackgroundHover,
    },
  },
  statusBadge: {
    flexShrink: 0,
    width: '16px',
    height: '16px',
    borderRadius: tokens.borderRadiusSmall,
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightBold,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  fileNameWrapper: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    flex: '1 1 0',
    minWidth: 0,
  },
  fileName: {
    color: tokens.colorNeutralForeground1,
  },
  dirPath: {
    color: tokens.colorNeutralForeground3,
    marginLeft: '4px',
  },
  statNumbers: {
    flexShrink: 0,
    fontSize: tokens.fontSizeBase200,
    fontVariantNumeric: 'tabular-nums',
  },
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
  columnLayout: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
  },
  summaryBar: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalM,
    paddingLeft: tokens.spacingHorizontalL,
    paddingRight: tokens.spacingHorizontalL,
    paddingTop: '6px',
    paddingBottom: '6px',
    ...shorthands.borderBottom('1px', 'solid', tokens.colorNeutralStroke1),
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground2,
    flexShrink: 0,
  },
  flex1: {
    flex: '1 1 0',
  },
  splitPane: {
    position: 'relative',
    display: 'flex',
    flex: '1 1 0',
    minHeight: 0,
  },
  selectNonePane: {
    userSelect: 'none',
  },
  dragOverlay: {
    position: 'absolute',
    inset: 0,
    zIndex: 20,
    cursor: 'col-resize',
  },
  fileListPane: {
    minWidth: 0,
    overflowY: 'auto',
    ...shorthands.borderRight('1px', 'solid', tokens.colorNeutralStroke1),
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
      backgroundColor: tokens.colorBrandStroke1,
    },
  },
  diffPane: {
    flex: '1 1 0',
    minWidth: 0,
    minHeight: 0,
  },
  tabBar: {
    ...shorthands.borderBottom('1px', 'solid', tokens.colorNeutralStroke1),
    flexShrink: 0,
  },
  tabContent: {
    flex: '1 1 0',
    minHeight: 0,
  },
  greenText: {
    color: tokens.colorPaletteGreenForeground1,
  },
  redText: {
    color: tokens.colorPaletteRedForeground1,
  },
});

const DiffViewer = memo(({ file }: { file: FileDiff }) => {
  const styles = useStyles();

  if (file.isBinary) {
    return (
      <div className={styles.centerMessage}>
        Binary file — no diff available
      </div>
    );
  }

  if (!file.patch) {
    return <div className={styles.centerMessage}>No changes to display</div>;
  }

  const rows = buildPatchRows(file.patch);

  return (
    <div className={styles.diffRoot}>
      {rows.map((row, i) => {
        if (row.type === 'hunk') {
          return (
            <div key={i} className={styles.hunkRow}>
              {row.text}
            </div>
          );
        }

        const bgClass = row.type === 'addition' ? styles.additionBg : row.type === 'deletion' ? styles.deletionBg : undefined;

        const textClass =
          row.type === 'addition' ? styles.additionText : row.type === 'deletion' ? styles.deletionText : styles.contextText;

        const prefix = row.type === 'addition' ? '+' : row.type === 'deletion' ? '-' : ' ';
        const oldNum = row.type === 'addition' ? '' : 'oldLine' in row ? row.oldLine : '';
        const newNum = row.type === 'deletion' ? '' : 'newLine' in row ? row.newLine : '';

        return (
          <div key={i} className={mergeClasses(styles.diffLine, bgClass)}>
            <span className="text-right pr-2 text-fg-subtle/50 select-none border-r border-surface-border/50">
              {oldNum}
            </span>
            <span className="text-right pr-2 text-fg-subtle/50 select-none border-r border-surface-border/50">
              {newNum}
            </span>
            <span className={mergeClasses(styles.lineContent, textClass)}>
              <span className={styles.selectNone}>{prefix}</span>
              {row.text}
            </span>
          </div>
        );
      })}
    </div>
  );
});
DiffViewer.displayName = 'DiffViewer';

const FileListItem = memo(
  ({ file, isSelected, onSelect }: { file: FileDiff; isSelected: boolean; onSelect: (path: string) => void }) => {
    const styles = useStyles();
    const fileName = file.path.split('/').pop() ?? file.path;
    const dirPath = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : '';

    const handleClick = useCallback(() => {
      onSelect(file.path);
    }, [onSelect, file.path]);

    return (
      <button
        onClick={handleClick}
        className={mergeClasses(
          styles.fileListBtn,
          isSelected ? styles.fileListSelected : styles.fileListUnselected
        )}
      >
        <span
          className={mergeClasses(
            styles.statusBadge,
            STATUS_COLORS[file.status],
            STATUS_BG_COLORS[file.status]
          )}
        >
          {STATUS_LABELS[file.status]}
        </span>
        <span className={styles.fileNameWrapper}>
          <span className={styles.fileName}>{fileName}</span>
          {dirPath && <span className={styles.dirPath}>{dirPath}</span>}
        </span>
        {(file.additions > 0 || file.deletions > 0) && (
          <span className={styles.statNumbers}>
            {file.additions > 0 && <span className={styles.greenText}>+{file.additions}</span>}
            {file.additions > 0 && file.deletions > 0 && <span className="text-fg-subtle"> / </span>}
            {file.deletions > 0 && <span className={styles.redText}>-{file.deletions}</span>}
          </span>
        )}
      </button>
    );
  }
);
FileListItem.displayName = 'FileListItem';

const FilesChangedContent = memo(({ ticketId }: { ticketId: TicketId }) => {
  const styles = useStyles();
  const [data, setData] = useState<DiffResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [listWidthPercent, setListWidthPercent] = useState(DEFAULT_LIST_PERCENT);
  const [isDragging, setIsDragging] = useState(false);
  const splitRef = useRef<HTMLDivElement>(null);

  const fetchData = useCallback(async () => {
    try {
      const resp = await ticketApi.getFilesChanged(ticketId);
      setData(resp);
      // Auto-select first file if none selected
      if (resp.files.length > 0 && !selectedPath) {
        setSelectedPath(resp.files[0]!.path);
      }
    } catch {
      // Silently fail on poll errors
    } finally {
      setLoading(false);
    }
  }, [ticketId, selectedPath]);

  // Fetch on mount + poll
  useEffect(() => {
    void fetchData();
    const interval = setInterval(() => void fetchData(), POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [fetchData]);

  const handleRefresh = useCallback(() => {
    void fetchData();
  }, [fetchData]);

  const handleSelectFile = useCallback((filePath: string) => {
    setSelectedPath(filePath);
  }, []);

  const handleDividerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);

    const handleMouseMove = (ev: MouseEvent) => {
      const rect = splitRef.current?.getBoundingClientRect();
      if (!rect) {
        return;
      }
      const pct = ((ev.clientX - rect.left) / rect.width) * 100;
      setListWidthPercent(Math.min(MAX_LIST_PERCENT, Math.max(MIN_LIST_PERCENT, pct)));
    };

    const handleMouseUp = () => {
      setIsDragging(false);
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, []);

  const selectedFile = data?.files.find((f) => f.path === selectedPath) ?? null;

  if (loading && !data) {
    return (
      <ListSkeleton rows={6} />
    );
  }

  if (!data?.hasChanges) {
    return (
      <div className={styles.emptyState}>
        <BranchCompare20Regular style={{ width: 32, height: 32 }} className={styles.emptyIcon} />
        <p className={styles.emptyText}>No changes detected</p>
        <p className={styles.emptySubText}>File changes will appear here when the agent modifies files</p>
        <IconButton aria-label="Refresh" icon={<ArrowSync20Regular />} size="sm" onClick={handleRefresh} />
      </div>
    );
  }

  return (
    <div className={styles.columnLayout}>
      {/* Summary bar */}
      <div className={styles.summaryBar}>
        <span>
          {data.totalFiles} file{data.totalFiles !== 1 ? 's' : ''} changed
        </span>
        {data.totalAdditions > 0 && <span className={styles.greenText}>+{data.totalAdditions}</span>}
        {data.totalDeletions > 0 && <span className={styles.redText}>-{data.totalDeletions}</span>}
        <div className={styles.flex1} />
        <IconButton aria-label="Refresh" icon={<ArrowSync20Regular />} size="sm" onClick={handleRefresh} />
      </div>

      {/* Split pane */}
      <div ref={splitRef} className={mergeClasses(styles.splitPane, isDragging && styles.selectNonePane)}>
        {isDragging && <div className={styles.dragOverlay} />}

        {/* File list */}
        <div
          className={styles.fileListPane}
          style={{ width: `${listWidthPercent}%` }}
        >
          {data.files.map((file) => (
            <FileListItem
              key={file.path}
              file={file}
              isSelected={file.path === selectedPath}
              onSelect={handleSelectFile}
            />
          ))}
        </div>

        {/* Draggable divider */}
        <div
          className={styles.divider}
          onMouseDown={handleDividerMouseDown}
        />

        {/* Diff pane */}
        <div className={styles.diffPane}>
          {selectedFile ? (
            <DiffViewer file={selectedFile} />
          ) : (
            <div className={styles.centerMessage}>
              Select a file to view its diff
            </div>
          )}
        </div>
      </div>
    </div>
  );
});
FilesChangedContent.displayName = 'FilesChangedContent';

type PRSubTab = 'Overview' | 'Files Changed';
const PR_SUB_TABS: PRSubTab[] = ['Overview', 'Files Changed'];

export const TicketPRTab = memo(({ ticketId }: { ticketId: TicketId }) => {
  const styles = useStyles();
  const [activeSubTab, setActiveSubTab] = useState<PRSubTab>('Overview');

  const handleTabSelect = useCallback((_e: unknown, data: SelectTabData) => {
    setActiveSubTab(data.value as PRSubTab);
  }, []);

  return (
    <div className={styles.columnLayout}>
      {/* Sub-tab bar */}
      <div className={styles.tabBar}>
        <TabList size="small" selectedValue={activeSubTab} onTabSelect={handleTabSelect}>
          {PR_SUB_TABS.map((tab) => (
            <Tab key={tab} value={tab}>{tab}</Tab>
          ))}
        </TabList>
      </div>

      {/* Sub-tab content */}
      <div className={styles.tabContent}>
        {activeSubTab === 'Overview' && <TicketPROverview ticketId={ticketId} />}
        {activeSubTab === 'Files Changed' && <FilesChangedContent ticketId={ticketId} />}
      </div>
    </div>
  );
});
TicketPRTab.displayName = 'TicketPRTab';
