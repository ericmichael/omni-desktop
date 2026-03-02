import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { PiArrowsClockwiseBold, PiGitDiffBold } from 'react-icons/pi';

import { cn, IconButton, Spinner } from '@/renderer/ds';
import type { DiffResponse, FileDiff, FleetTicketId } from '@/shared/types';

import { FleetTicketPROverview } from './FleetTicketPROverview';
import { fleetApi } from './state';

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

const DiffViewer = memo(({ file }: { file: FileDiff }) => {
  if (file.isBinary) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-fg-muted">
        Binary file — no diff available
      </div>
    );
  }

  if (!file.patch) {
    return <div className="flex items-center justify-center h-full text-sm text-fg-muted">No changes to display</div>;
  }

  const rows = buildPatchRows(file.patch);

  return (
    <div className="overflow-auto h-full font-mono text-xs leading-5">
      {rows.map((row, i) => {
        if (row.type === 'hunk') {
          return (
            <div
              key={i}
              className="bg-blue-500/10 text-blue-400 px-4 py-0.5 sticky top-0 z-10 border-y border-surface-border"
            >
              {row.text}
            </div>
          );
        }

        const bgClass = row.type === 'addition' ? 'bg-green-500/10' : row.type === 'deletion' ? 'bg-red-500/10' : '';

        const textClass =
          row.type === 'addition' ? 'text-green-300' : row.type === 'deletion' ? 'text-red-300' : 'text-fg-muted';

        const prefix = row.type === 'addition' ? '+' : row.type === 'deletion' ? '-' : ' ';
        const oldNum = row.type === 'addition' ? '' : 'oldLine' in row ? row.oldLine : '';
        const newNum = row.type === 'deletion' ? '' : 'newLine' in row ? row.newLine : '';

        return (
          <div key={i} className={cn('grid grid-cols-[3.5rem_3.5rem_1fr] min-w-fit', bgClass)}>
            <span className="text-right pr-2 text-fg-subtle/50 select-none border-r border-surface-border/50">
              {oldNum}
            </span>
            <span className="text-right pr-2 text-fg-subtle/50 select-none border-r border-surface-border/50">
              {newNum}
            </span>
            <span className={cn('pl-2 whitespace-pre', textClass)}>
              <span className="select-none">{prefix}</span>
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
    const fileName = file.path.split('/').pop() ?? file.path;
    const dirPath = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : '';

    const handleClick = useCallback(() => {
      onSelect(file.path);
    }, [onSelect, file.path]);

    return (
      <button
        onClick={handleClick}
        className={cn(
          'flex items-center gap-2 w-full px-3 py-1.5 text-left text-xs cursor-pointer transition-colors',
          isSelected ? 'bg-accent-500/20 text-fg' : 'text-fg-muted hover:bg-white/5'
        )}
      >
        <span
          className={cn(
            'shrink-0 w-4 h-4 rounded text-[10px] font-bold flex items-center justify-center',
            STATUS_COLORS[file.status],
            STATUS_BG_COLORS[file.status]
          )}
        >
          {STATUS_LABELS[file.status]}
        </span>
        <span className="truncate flex-1 min-w-0">
          <span className="text-fg">{fileName}</span>
          {dirPath && <span className="text-fg-subtle ml-1">{dirPath}</span>}
        </span>
        {(file.additions > 0 || file.deletions > 0) && (
          <span className="shrink-0 text-[10px] tabular-nums">
            {file.additions > 0 && <span className="text-green-400">+{file.additions}</span>}
            {file.additions > 0 && file.deletions > 0 && <span className="text-fg-subtle"> / </span>}
            {file.deletions > 0 && <span className="text-red-400">-{file.deletions}</span>}
          </span>
        )}
      </button>
    );
  }
);
FileListItem.displayName = 'FileListItem';

const FilesChangedContent = memo(({ ticketId }: { ticketId: FleetTicketId }) => {
  const [data, setData] = useState<DiffResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [listWidthPercent, setListWidthPercent] = useState(DEFAULT_LIST_PERCENT);
  const [isDragging, setIsDragging] = useState(false);
  const splitRef = useRef<HTMLDivElement>(null);

  const fetchData = useCallback(async () => {
    try {
      const resp = await fleetApi.getFilesChanged(ticketId);
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
      <div className="flex items-center justify-center h-full gap-2">
        <Spinner size="sm" />
        <span className="text-sm text-fg-muted">Loading changes...</span>
      </div>
    );
  }

  if (!data?.hasChanges) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3">
        <PiGitDiffBold size={32} className="text-fg-subtle" />
        <p className="text-sm text-fg-muted">No changes detected</p>
        <p className="text-xs text-fg-subtle">File changes will appear here when the agent modifies files</p>
        <IconButton aria-label="Refresh" icon={<PiArrowsClockwiseBold />} size="sm" onClick={handleRefresh} />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Summary bar */}
      <div className="flex items-center gap-3 px-4 py-1.5 border-b border-surface-border text-xs text-fg-muted shrink-0">
        <span>
          {data.totalFiles} file{data.totalFiles !== 1 ? 's' : ''} changed
        </span>
        {data.totalAdditions > 0 && <span className="text-green-400">+{data.totalAdditions}</span>}
        {data.totalDeletions > 0 && <span className="text-red-400">-{data.totalDeletions}</span>}
        <div className="flex-1" />
        <IconButton aria-label="Refresh" icon={<PiArrowsClockwiseBold />} size="sm" onClick={handleRefresh} />
      </div>

      {/* Split pane */}
      <div ref={splitRef} className={cn('relative flex flex-1 min-h-0', isDragging && 'select-none')}>
        {isDragging && <div className="absolute inset-0 z-20 cursor-col-resize" />}

        {/* File list */}
        <div
          className="min-w-0 overflow-y-auto border-r border-surface-border"
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
          className="w-1 shrink-0 cursor-col-resize hover:bg-accent-500/50 transition-colors bg-surface-border z-10"
          onMouseDown={handleDividerMouseDown}
        />

        {/* Diff pane */}
        <div className="flex-1 min-w-0 min-h-0">
          {selectedFile ? (
            <DiffViewer file={selectedFile} />
          ) : (
            <div className="flex items-center justify-center h-full text-sm text-fg-muted">
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

export const FleetTicketPRTab = memo(({ ticketId }: { ticketId: FleetTicketId }) => {
  const [activeSubTab, setActiveSubTab] = useState<PRSubTab>('Overview');

  return (
    <div className="flex flex-col h-full">
      {/* Sub-tab bar */}
      <div className="flex gap-1 px-4 py-1.5 border-b border-surface-border shrink-0">
        {PR_SUB_TABS.map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveSubTab(tab)}
            className={cn(
              'px-3 py-1 text-xs font-medium rounded-md cursor-pointer select-none transition-colors',
              activeSubTab === tab ? 'bg-white/10 text-fg' : 'text-fg-muted hover:text-fg hover:bg-white/5'
            )}
          >
            {tab}
          </button>
        ))}
      </div>

      {/* Sub-tab content */}
      <div className="flex-1 min-h-0">
        {activeSubTab === 'Overview' && <FleetTicketPROverview ticketId={ticketId} />}
        {activeSubTab === 'Files Changed' && <FilesChangedContent ticketId={ticketId} />}
      </div>
    </div>
  );
});
FleetTicketPRTab.displayName = 'FleetTicketPRTab';
