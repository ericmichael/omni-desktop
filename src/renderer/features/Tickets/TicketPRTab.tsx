import { makeStyles, mergeClasses, shorthands, tokens } from '@fluentui/react-components';
import { ArrowSync20Regular, BranchCompare20Regular, Document24Regular } from '@fluentui/react-icons';
import { useStore } from '@nanostores/react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { getMimeType } from '@/lib/mime-types';
import type { SelectTabData } from '@/renderer/ds';
import { Button, IconButton, ListSkeleton, Tab, TabList } from '@/renderer/ds';
import { persistedStoreApi } from '@/renderer/services/store';
import type {
  CodeTabId,
  ContainerPullRequest,
  DiffGroup,
  DiffResponse,
  FileDiff,
  ProjectSource,
  TicketId,
} from '@/shared/types';

import { PullRequestBadge } from './PullRequestBadge';
import { $tickets, ticketApi } from './state';

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

const GROUP_ORDER: DiffGroup[] = ['committed', 'staged', 'unstaged', 'untracked'];

const GROUP_LABELS: Record<DiffGroup, string> = {
  committed: 'Committed',
  staged: 'Staged',
  unstaged: 'Unstaged',
  untracked: 'Untracked',
};

const fileKey = (file: FileDiff): string => `${file.group}:${file.path}`;

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
  groupHeader: {
    display: 'flex',
    alignItems: 'baseline',
    gap: '6px',
    padding: '6px 10px 4px',
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightSemibold,
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    color: tokens.colorNeutralForeground2,
    backgroundColor: tokens.colorNeutralBackground2,
    position: 'sticky',
    top: 0,
    zIndex: 1,
    ...shorthands.borderTop('1px', 'solid', tokens.colorNeutralStroke1),
  },
  groupHeaderFirst: {
    borderTopWidth: 0,
  },
  groupHeaderCount: {
    fontWeight: tokens.fontWeightRegular,
    color: tokens.colorNeutralForeground3,
    textTransform: 'none',
    letterSpacing: 'normal',
  },
  groupHeaderStats: {
    marginLeft: 'auto',
    fontWeight: tokens.fontWeightRegular,
    textTransform: 'none',
    letterSpacing: 'normal',
    fontSize: tokens.fontSizeBase200,
    display: 'flex',
    gap: '6px',
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
  binaryCard: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    gap: tokens.spacingVerticalS,
  },
  binaryCardIcon: {
    width: '32px',
    height: '32px',
    color: tokens.colorNeutralForeground3,
  },
  binaryCardName: {
    fontSize: tokens.fontSizeBase400,
    fontWeight: tokens.fontWeightSemibold,
    color: tokens.colorNeutralForeground1,
    wordBreak: 'break-all',
    textAlign: 'center',
    paddingLeft: tokens.spacingHorizontalXXL,
    paddingRight: tokens.spacingHorizontalXXL,
  },
  binaryCardMeta: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
  },
});

const FILE_CARD_STATUS_TEXT: Record<FileDiff['status'], string> = {
  added: 'New file',
  untracked: 'New file',
  modified: 'Modified',
  deleted: 'Deleted',
  renamed: 'Renamed',
  copied: 'Copied',
};

/**
 * Card rendering for documents and other binaries — a patch view is meaningless
 * for a PPTX/XLSX/image, for developers and everyday users alike. Shows what
 * happened to the file in plain language instead of pretending there's a diff.
 */
const BinaryFileCard = memo(({ file }: { file: FileDiff }) => {
  const styles = useStyles();
  const fileName = file.path.split('/').pop() ?? file.path;
  const mime = getMimeType(fileName);
  return (
    <div className={styles.binaryCard}>
      <Document24Regular className={styles.binaryCardIcon} />
      <span className={styles.binaryCardName}>{fileName}</span>
      <span className={styles.binaryCardMeta}>
        {FILE_CARD_STATUS_TEXT[file.status]}
        {mime !== 'application/octet-stream' ? ` · ${mime}` : ''}
      </span>
    </div>
  );
});
BinaryFileCard.displayName = 'BinaryFileCard';

const DiffViewer = memo(({ file }: { file: FileDiff }) => {
  const styles = useStyles();

  if (file.isBinary) {
    return <BinaryFileCard file={file} />;
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

        const bgClass =
          row.type === 'addition' ? styles.additionBg : row.type === 'deletion' ? styles.deletionBg : undefined;

        const textClass =
          row.type === 'addition'
            ? styles.additionText
            : row.type === 'deletion'
              ? styles.deletionText
              : styles.contextText;

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
  ({ file, isSelected, onSelect }: { file: FileDiff; isSelected: boolean; onSelect: (key: string) => void }) => {
    const styles = useStyles();
    const fileName = file.path.split('/').pop() ?? file.path;
    const dirPath = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : '';

    const handleClick = useCallback(() => {
      onSelect(fileKey(file));
    }, [onSelect, file]);

    return (
      <button
        onClick={handleClick}
        className={mergeClasses(styles.fileListBtn, isSelected ? styles.fileListSelected : styles.fileListUnselected)}
      >
        <span className={mergeClasses(styles.statusBadge, STATUS_COLORS[file.status], STATUS_BG_COLORS[file.status])}>
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

/**
 * Per-source files-changed view. Diffs one ProjectSource's container
 * subdir against its ``omni/seed`` baseline. The parent component
 * (FilesChangedPane) picks which source is active.
 */
const FilesChangedContent = memo(({ scope, sourceId }: { scope: ChangesScope; sourceId: string }) => {
  const styles = useStyles();
  const [data, setData] = useState<DiffResponse | null>(null);
  const [loading, setLoading] = useState(true);
  // Selection is keyed by `<group>:<path>` so the same path can be selected
  // independently across groups (staged vs. unstaged vs. committed).
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [listWidthPercent, setListWidthPercent] = useState(DEFAULT_LIST_PERCENT);
  const [isDragging, setIsDragging] = useState(false);
  const [applyBusy, setApplyBusy] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [pullRequest, setPullRequest] = useState<ContainerPullRequest | null>(null);
  const splitRef = useRef<HTMLDivElement>(null);

  // Reset file selection + PR badge when the active source switches.
  useEffect(() => {
    setSelectedKey(null);
    setData(null);
    setPullRequest(null);
    setLoading(true);
  }, [sourceId]);

  const fetchData = useCallback(async () => {
    try {
      const [resp, pr] = await Promise.all([
        scope.kind === 'ticket'
          ? ticketApi.getFilesChanged(scope.ticketId, sourceId)
          : ticketApi.getCodeTabFilesChanged(scope.tabId, sourceId),
        (scope.kind === 'ticket'
          ? ticketApi.detectPullRequest(scope.ticketId, sourceId)
          : ticketApi.detectCodeTabPullRequest(scope.tabId, sourceId)
        ).catch(() => null),
      ]);
      setData(resp);
      // Main gated `pr` against the persisted PullRequestLinks (ticket links
      // or the scoped store), so anything non-null is display-worthy — a
      // MERGED result is a watched merge. A null keeps a merged badge sticky
      // (acknowledgement) but clears a stale open one (closed unmerged).
      if (pr !== null) {
        setPullRequest(pr);
      } else {
        setPullRequest((prev) => (prev?.state === 'MERGED' ? prev : null));
      }
      if (resp.files.length > 0 && !selectedKey) {
        setSelectedKey(fileKey(resp.files[0]!));
      }
    } catch {
      // Silently fail on poll errors
    } finally {
      setLoading(false);
    }
  }, [scope, sourceId, selectedKey]);

  // Fetch on mount + poll
  useEffect(() => {
    void fetchData();
    const interval = setInterval(() => void fetchData(), POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [fetchData]);

  const handleRefresh = useCallback(() => {
    void fetchData();
  }, [fetchData]);

  const handleApply = useCallback(async () => {
    setApplyBusy(true);
    setApplyError(null);
    try {
      const result =
        scope.kind === 'code-tab'
          ? await ticketApi.applyCodeTabSourceChanges(scope.tabId, sourceId)
          : await ticketApi.mergeTicket(scope.ticketId, sourceId);
      if (!result.ok) {
        setApplyError(result.error ?? 'Apply failed');
        return;
      }
      await fetchData();
    } finally {
      setApplyBusy(false);
    }
  }, [fetchData, scope, sourceId]);

  const handleSelectFile = useCallback((key: string) => {
    setSelectedKey(key);
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

  const selectedFile = data?.files.find((f) => fileKey(f) === selectedKey) ?? null;

  if (loading && !data) {
    return <ListSkeleton rows={6} />;
  }

  if (!data?.hasChanges) {
    return (
      <div className={styles.emptyState}>
        <BranchCompare20Regular style={{ width: 32, height: 32 }} className={styles.emptyIcon} />
        <p className={styles.emptyText}>No changes detected</p>
        <p className={styles.emptySubText}>File changes will appear here when the agent modifies files</p>
        {pullRequest && <PullRequestBadge pr={pullRequest} />}
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
        {pullRequest && <PullRequestBadge pr={pullRequest} />}
        {applyError && <span className={styles.emptySubText}>{applyError}</span>}
        <Button size="sm" onClick={handleApply} isDisabled={applyBusy}>
          {applyBusy ? 'Applying…' : 'Apply to my folder'}
        </Button>
        <IconButton aria-label="Refresh" icon={<ArrowSync20Regular />} size="sm" onClick={handleRefresh} />
      </div>

      {/* Split pane */}
      <div ref={splitRef} className={mergeClasses(styles.splitPane, isDragging && styles.selectNonePane)}>
        {isDragging && <div className={styles.dragOverlay} />}

        {/* File list, grouped by source */}
        <div className={styles.fileListPane} style={{ width: `${listWidthPercent}%` }}>
          {GROUP_ORDER.map((group, groupIdx) => {
            const groupFiles = data.files.filter((f) => f.group === group);
            if (groupFiles.length === 0) {
              return null;
            }
            const adds = groupFiles.reduce((n, f) => n + f.additions, 0);
            const dels = groupFiles.reduce((n, f) => n + f.deletions, 0);
            return (
              <div key={group}>
                <div className={mergeClasses(styles.groupHeader, groupIdx === 0 && styles.groupHeaderFirst)}>
                  <span>{GROUP_LABELS[group]}</span>
                  <span className={styles.groupHeaderCount}>{groupFiles.length}</span>
                  {(adds > 0 || dels > 0) && (
                    <span className={styles.groupHeaderStats}>
                      {adds > 0 && <span className={styles.greenText}>+{adds}</span>}
                      {dels > 0 && <span className={styles.redText}>-{dels}</span>}
                    </span>
                  )}
                </div>
                {groupFiles.map((file) => {
                  const key = fileKey(file);
                  return (
                    <FileListItem key={key} file={file} isSelected={key === selectedKey} onSelect={handleSelectFile} />
                  );
                })}
              </div>
            );
          })}
        </div>

        {/* Draggable divider */}
        <div className={styles.divider} onMouseDown={handleDividerMouseDown} />

        {/* Diff pane */}
        <div className={styles.diffPane}>
          {selectedFile ? (
            <DiffViewer file={selectedFile} />
          ) : (
            <div className={styles.centerMessage}>Select a file to view its diff</div>
          )}
        </div>
      </div>
    </div>
  );
});
FilesChangedContent.displayName = 'FilesChangedContent';

type ChangesScope = { kind: 'ticket'; ticketId: TicketId } | { kind: 'code-tab'; tabId: CodeTabId };

const useSourcesForChanges = (scope: ChangesScope): ProjectSource[] => {
  const tickets = useStore($tickets);
  const store = useStore(persistedStoreApi.$atom);
  return useMemo(() => {
    if (scope.kind === 'ticket') {
      const ticket = tickets[scope.ticketId];
      if (!ticket) {
        return [];
      }
      const project = store.projects.find((p) => p.id === ticket.projectId);
      return project?.sources ?? [];
    }
    const tab = store.codeTabs.find((t) => t.id === scope.tabId);
    const project = tab?.projectId ? store.projects.find((p) => p.id === tab.projectId) : undefined;
    return project?.sources ?? [];
  }, [scope, store.codeTabs, store.projects, tickets]);
};

/**
 * Source-picker shell for the Files Changed sub-tab. Renders one
 * TabList row across project.sources and shows the active source's
 * file-diff pane below. Single-source projects skip the picker.
 */
const FilesChangedPane = memo(({ scope }: { scope: ChangesScope }) => {
  const styles = useStyles();
  const sources = useSourcesForChanges(scope);

  const [activeSourceId, setActiveSourceId] = useState<string | null>(null);
  // Track the previous sources signature so we can reset the active id
  // when sources are added/removed but keep it stable otherwise.
  const sig = sources.map((s) => s.id).join('|');
  useEffect(() => {
    if (sources.length === 0) {
      setActiveSourceId(null);
      return;
    }
    if (!activeSourceId || !sources.some((s) => s.id === activeSourceId)) {
      setActiveSourceId(sources[0]!.id);
    }
    // activeSourceId intentionally omitted: we only want to flip it when
    // the sources set itself changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);

  const handleSourceTabSelect = useCallback((_e: unknown, data: SelectTabData) => {
    setActiveSourceId(data.value as string);
  }, []);

  if (sources.length === 0 || !activeSourceId) {
    // No user-attached sources means the workspace is a launcher-managed
    // folder (chat scratch / managed project dir): container changes mirror
    // back to it automatically, so there is nothing to review-and-apply here.
    return (
      <div className={styles.centerMessage}>
        Files the agent creates or edits land in this project&apos;s folder automatically.
      </div>
    );
  }

  return (
    <div className={styles.columnLayout}>
      {sources.length > 1 && (
        <div className={styles.tabBar}>
          <TabList size="small" selectedValue={activeSourceId} onTabSelect={handleSourceTabSelect}>
            {sources.map((s) => (
              <Tab key={s.id} value={s.id}>
                {s.mountName}
              </Tab>
            ))}
          </TabList>
        </div>
      )}
      <div className={styles.tabContent}>
        <FilesChangedContent scope={scope} sourceId={activeSourceId} />
      </div>
    </div>
  );
});
FilesChangedPane.displayName = 'FilesChangedPane';

export const TicketPRTab = memo(({ ticketId }: { ticketId: TicketId }) => (
  <FilesChangedPane scope={{ kind: 'ticket', ticketId }} />
));
TicketPRTab.displayName = 'TicketPRTab';

export const ChangesTab = memo(({ tabId }: { tabId: CodeTabId }) => (
  <FilesChangedPane scope={{ kind: 'code-tab', tabId }} />
));
ChangesTab.displayName = 'ChangesTab';
